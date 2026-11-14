from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, get_settings
from .consult.routes import install_error_handlers, router as consultation_router
from .consult.schema import SCHEMA_VERSION

settings = get_settings()

app = FastAPI(title="MEDSCOPE API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(consultation_router)
install_error_handlers(app)


@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    """Liveness plus capability flags. Never echoes secrets."""
    provider = settings.resolved_extraction_provider
    return {
        "status": "ok",
        "gemini_configured": settings.gemini_configured,
        "extraction_provider": provider,
        "extraction_is_replay": provider == "replay",
        "schema_version": SCHEMA_VERSION,
    }
