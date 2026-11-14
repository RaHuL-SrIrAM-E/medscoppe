"""HTTP surface for consultation extraction. Stateless: nothing is stored and transcript text is never logged."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..config import Settings, get_settings
from .gemini import GeminiExtractionProvider
from .replay import ReplayExtractionProvider
from .schema import ApiError, ExtractRequest, ExtractResponse, schema_bundle
from .service import ExtractionProvider, ExtractionService, ProviderError, ProviderUnavailable

log = logging.getLogger("medscope.consult")
router = APIRouter(prefix="/v1/consultation", tags=["consultation"])

MAX_TOTAL_CHARS = 20_000


def build_provider(settings: Settings) -> ExtractionProvider:
    if settings.resolved_extraction_provider == "replay":
        return ReplayExtractionProvider(settings.replay_fixture)
    if not settings.gemini_configured:
        raise ProviderUnavailable("not_configured", "Gemini is selected but GEMINI_API_KEY or GEMINI_MODEL is not set.", False)
    return GeminiExtractionProvider(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        timeout_s=settings.gemini_timeout_s,
        max_invalid_attempts=settings.gemini_max_invalid_attempts,
    )


def get_service(request: Request, settings: Settings = Depends(get_settings)) -> ExtractionService:
    service = getattr(request.app.state, "extraction_service", None)
    if service is None:
        service = ExtractionService(build_provider(settings))
        request.app.state.extraction_service = service
    return service


def _error(status: int, code: str, message: str, retriable: bool) -> JSONResponse:
    return JSONResponse(status_code=status, content=ApiError(code=code, message=message, retriable=retriable).model_dump())


@router.get("/schema")
def schema() -> dict[str, object]:
    """JSON Schema bundle for contract tests and code generation."""
    return schema_bundle()


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    body: ExtractRequest,
    service: ExtractionService = Depends(get_service),
    settings: Settings = Depends(get_settings),
):
    if body.data_classification != "SYNTHETIC" and not settings.allow_real_data:
        return _error(403, "real_data_not_allowed", 'This prototype accepts synthetic data only (data_classification "SYNTHETIC").', False)
    total = sum(len(u.text) for u in [*body.utterances, *body.context_utterances])
    if total > MAX_TOTAL_CHARS:
        return _error(413, "request_too_large", "Too much transcript text in one request.", False)
    # counts only: never transcript text
    log.info("extract: %d new utterances, %d known observations", len(body.utterances), len(body.known_observations))
    return await service.extract(body)


def install_error_handlers(app) -> None:
    @app.exception_handler(ProviderError)
    async def _provider_error(_: Request, e: ProviderError) -> JSONResponse:
        log.warning("extraction failed: %s", e.code)
        return _error(e.status_code, e.code, e.message, e.retriable)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, e: RequestValidationError) -> JSONResponse:
        # FastAPI's default body echoes the offending input, which here would be transcript text. Return locations only.
        details = [{"loc": [str(x) for x in err["loc"]], "type": err["type"]} for err in e.errors()]
        return JSONResponse(
            status_code=422,
            content={"code": "invalid_request", "message": "The request did not match the schema.", "retriable": False, "details": details},
        )
