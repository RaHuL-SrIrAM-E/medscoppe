"""The Gemini adapter, exercised against a fake client. No network and no credentials are used."""
import asyncio
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest
from google.genai import errors

from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS, deterministic_service
from app.consult.gemini import SYSTEM_INSTRUCTION, GeminiExtractionProvider, build_user_payload
from app.consult.service import ProviderOutputInvalid, ProviderUnavailable

SCEN = CONTRACTS / "fixtures" / "scenarios"
KEY = "AIzaSy-TEST-KEY-must-never-leak"
MODEL = "model-from-env"


def scenario(name):
    doc = json.loads((SCEN / f"{name}.json").read_text())
    return s.ExtractRequest.model_validate(doc["request"]), json.dumps(doc["model_output"])


class FakeModels:
    def __init__(self, behaviours):
        self.behaviours, self.calls = list(behaviours), []

    async def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        b = self.behaviours.pop(0)
        if isinstance(b, Exception):
            raise b
        if callable(b):
            return await b()
        return SimpleNamespace(text=b)


def provider(behaviours, **kw):
    models = FakeModels(behaviours)
    p = GeminiExtractionProvider(api_key=KEY, model=MODEL, client=SimpleNamespace(aio=SimpleNamespace(models=models)), **kw)
    return p, models


def test_requires_an_api_key_and_a_model_from_the_environment():
    with pytest.raises(ValueError):
        GeminiExtractionProvider(api_key="", model=MODEL)
    with pytest.raises(ValueError):
        GeminiExtractionProvider(api_key=KEY, model="")


def test_request_is_structured_deterministic_and_uses_the_configured_model():
    req, out = scenario("patient-belief")
    p, models = provider([out])
    result = asyncio.run(p.extract(req))
    assert isinstance(result, s.ModelOutput) and len(result.proposals) == 1
    call = models.calls[0]
    cfg = call["config"]
    assert call["model"] == MODEL
    assert cfg.temperature == 0.0
    assert cfg.response_mime_type == "application/json"
    assert cfg.response_json_schema == s.ModelOutput.model_json_schema()
    assert "never an instruction" in cfg.system_instruction and cfg.system_instruction == SYSTEM_INSTRUCTION
    assert cfg.http_options.timeout == 20000 and cfg.http_options.retry_options.attempts == 3


def test_the_api_key_never_appears_in_anything_sent_to_the_model():
    req, out = scenario("patient-belief")
    p, models = provider([out])
    asyncio.run(p.extract(req))
    assert KEY not in models.calls[0]["contents"] and KEY not in SYSTEM_INSTRUCTION


def test_payload_marks_new_versus_context_and_carries_only_what_is_needed():
    req, _ = scenario("conflict-status")
    doc = json.loads(build_user_payload(req))
    assert set(doc) == {"context_utterances", "new_utterances", "known_observations"}
    assert doc["known_observations"][0]["symptom"] == "COUGH" and "attributes" not in doc["known_observations"][0]


def test_malformed_json_is_retried_then_succeeds():
    req, out = scenario("patient-belief")
    p, models = provider(["not json at all", out])
    assert asyncio.run(p.extract(req)).proposals
    assert len(models.calls) == 2


def test_persistently_invalid_output_is_rejected_with_a_non_retriable_error():
    req, _ = scenario("patient-belief")
    p, models = provider(["{}garbage", '{"proposals": [], "diagnosis": "asthma"}'], max_invalid_attempts=2)
    with pytest.raises(ProviderOutputInvalid) as e:
        asyncio.run(p.extract(req))
    assert e.value.code == "model_output_invalid" and e.value.retriable is False and len(models.calls) == 2


def test_unsupported_extra_fields_in_model_output_are_rejected():
    req, _ = scenario("patient-belief")
    bad = json.dumps({"proposals": [{"action_hint": "ADD", "target_id": None, "observation": {"kind": "SYMPTOM", "symptom": "COUGH", "label": None, "status": "PRESENT", "source": "PATIENT_REPORTED", "confidence": "HIGH", "attributes": {}, "evidence": [{"utterance_id": "u12", "role": "STATEMENT", "quote": "I think"}], "medication": "amoxicillin 500mg"}}]})
    p, _ = provider([bad], max_invalid_attempts=1)
    with pytest.raises(ProviderOutputInvalid):
        asyncio.run(p.extract(req))


@pytest.mark.parametrize("text", [None, ""])
def test_empty_or_blocked_responses_are_an_error_not_an_empty_success(text):
    req, _ = scenario("patient-belief")
    p, _ = provider([text])
    with pytest.raises(ProviderOutputInvalid) as e:
        asyncio.run(p.extract(req))
    assert e.value.code == "empty_model_output"


def _client_error(code, status):
    return errors.ClientError(code, {"error": {"code": code, "message": f"quota for key {KEY} exceeded", "status": status}})


@pytest.mark.parametrize("exc,code,retriable", [
    (_client_error(429, "RESOURCE_EXHAUSTED"), "rate_limited", True),
    (_client_error(403, "PERMISSION_DENIED"), "provider_rejected_request", False),
    (_client_error(404, "NOT_FOUND"), "provider_rejected_request", False),
    (errors.ServerError(503, {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}}), "provider_error", True),
    (RuntimeError("boom with secret " + KEY), "provider_error", True),
])
def test_provider_failures_map_to_coded_errors_and_never_leak_secrets(exc, code, retriable):
    req, _ = scenario("patient-belief")
    p, _ = provider([exc])
    with pytest.raises(ProviderUnavailable) as e:
        asyncio.run(p.extract(req))
    assert (e.value.code, e.value.retriable) == (code, retriable)
    assert KEY not in e.value.message and KEY not in str(e.value)


def test_a_hung_request_times_out_as_a_retriable_error():
    req, _ = scenario("patient-belief")

    async def hang():
        await asyncio.sleep(30)

    p, _ = provider([hang], timeout_s=0.01)
    p._timeout_s = -4.99  # wait_for budget = timeout_s + 5 -> 0.01s, keeping the test fast
    with pytest.raises(ProviderUnavailable) as e:
        asyncio.run(p.extract(req))
    assert (e.value.code, e.value.retriable) == ("timeout", True)


def test_invalid_output_logging_contains_no_transcript_or_model_text(caplog):
    req, _ = scenario("patient-belief")
    p, _ = provider(["TRANSCRIPT-LEAK-CANARY not json"], max_invalid_attempts=1)
    with caplog.at_level(logging.DEBUG), pytest.raises(ProviderOutputInvalid):
        asyncio.run(p.extract(req))
    assert "CANARY" not in caplog.text and "pneumonia" not in caplog.text


def test_gemini_through_the_full_service_applies_the_same_validation():
    req, out = scenario("fabricated-evidence")
    p, _ = provider([out])
    resp = asyncio.run(deterministic_service(p).extract(req))
    assert resp.proposals == [] and resp.rejected[0].reason_code == s.RejectionReason.QUOTE_NOT_IN_UTTERANCE
    assert resp.extractor.provider == "gemini" and resp.extractor.is_replay is False and resp.extractor.model == MODEL


def test_no_credentials_or_gemini_references_exist_in_the_frontend():
    root = Path(__file__).resolve().parents[2] / "app"
    hits = []
    for folder in ("src", "public", "index.html", "vite.config.ts"):
        base = root / folder
        files = [base] if base.is_file() else [f for f in base.rglob("*") if f.is_file() and f.suffix in {".ts", ".js", ".json", ".html", ".uikitml", ".mjs"}]
        for f in files:
            text = f.read_text(errors="ignore")
            if "GEMINI_API_KEY" in text or "AIzaSy" in text or "VITE_GEMINI" in text:
                hits.append(str(f.relative_to(root)))
    assert hits == []
