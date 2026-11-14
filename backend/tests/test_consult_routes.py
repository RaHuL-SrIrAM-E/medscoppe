import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS
from app.consult.routes import get_service
from app.consult.service import ExtractionService, ProviderOutputInvalid, ProviderUnavailable
from app.main import app

SYN = CONTRACTS / "fixtures" / "synthetic-respiratory"
FIRST_BATCH = json.loads((SYN / "transcript.json").read_text())["batches"][0]["utterances"]


def make_client(**settings):
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, **settings)
    app.state.extraction_service = None
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    app.dependency_overrides.clear()
    app.state.extraction_service = None


def body(utterances=None, **over):
    return {"schema_version": "1.0", "consultation_id": "c1", "data_classification": "SYNTHETIC",
            "utterances": utterances or FIRST_BATCH, "context_utterances": [], "known_observations": [], **over}


def test_health_reports_the_provider_and_flags_replay_without_secrets():
    h = make_client(extraction_provider="replay").get("/health").json()
    assert h["extraction_provider"] == "replay" and h["extraction_is_replay"] is True and h["schema_version"] == "1.0"
    g = make_client(extraction_provider="auto", gemini_api_key="AIzaSy-secret", gemini_model="m").get("/health").json()
    assert g["extraction_provider"] == "gemini" and g["extraction_is_replay"] is False
    assert "AIzaSy-secret" not in json.dumps(g)


def test_auto_falls_back_to_replay_only_when_gemini_is_not_configured():
    assert make_client().get("/health").json()["extraction_provider"] == "replay"


def test_extract_with_the_labelled_replay_fixture():
    r = make_client(extraction_provider="replay").post("/v1/consultation/extract", json=body())
    assert r.status_code == 200
    resp = s.ExtractResponse.model_validate(r.json())
    assert {p.observation.symptom for p in resp.proposals} == {s.SymptomCode.COUGH, s.SymptomCode.FEVER}
    assert resp.extractor.is_replay and resp.warnings[0].startswith("REPLAY_FIXTURE")


def test_non_synthetic_data_is_refused():
    r = make_client(extraction_provider="replay").post("/v1/consultation/extract", json=body(data_classification="REAL"))
    assert r.status_code == 403 and r.json() == {"code": "real_data_not_allowed", "message": r.json()["message"], "retriable": False}


def test_oversized_requests_are_refused():
    big = [{"id": f"c{i}", "speaker": "PATIENT", "speaker_basis": "SCRIPTED", "text": "x" * 1000} for i in range(25)]
    r = make_client(extraction_provider="replay").post("/v1/consultation/extract", json=body(context_utterances=big))
    assert r.status_code == 413 and r.json()["code"] == "request_too_large"


def test_validation_errors_never_echo_transcript_text():
    secret = "SECRET-TRANSCRIPT-CANARY"
    bad = [{"id": "u1", "speaker": "NOT_A_SPEAKER", "speaker_basis": "SCRIPTED", "text": secret}]
    r = make_client(extraction_provider="replay").post("/v1/consultation/extract", json=body(bad))
    assert r.status_code == 422 and r.json()["code"] == "invalid_request"
    assert secret not in r.text


def test_logs_never_contain_transcript_text(caplog):
    with caplog.at_level(logging.DEBUG):
        make_client(extraction_provider="replay").post("/v1/consultation/extract", json=body())
    assert "coughing" not in caplog.text and "fever" not in caplog.text


def test_unknown_replay_input_fails_loudly_instead_of_guessing():
    other = [{"id": "x1", "speaker": "PATIENT", "speaker_basis": "SCRIPTED", "text": "Something never recorded."}]
    r = make_client(extraction_provider="replay").post("/v1/consultation/extract", json=body(other))
    assert r.status_code == 503 and r.json()["code"] == "replay_no_match" and r.json()["retriable"] is False


def test_gemini_selected_without_credentials_is_a_clear_non_retriable_error():
    r = make_client(extraction_provider="gemini").post("/v1/consultation/extract", json=body())
    assert r.status_code == 503 and r.json()["code"] == "not_configured" and r.json()["retriable"] is False


class _Failing:
    name, model, is_replay = "gemini", "m", False

    def __init__(self, exc):
        self.exc = exc

    async def extract(self, request):
        raise self.exc


@pytest.mark.parametrize("exc,status,retriable", [
    (ProviderUnavailable("timeout", "The extraction service timed out.", True), 503, True),
    (ProviderOutputInvalid("model_output_invalid", "The model returned output that failed validation.", False), 502, False),
])
def test_provider_failures_surface_as_coded_http_errors(exc, status, retriable):
    c = make_client(extraction_provider="replay")
    app.dependency_overrides[get_service] = lambda: ExtractionService(_Failing(exc))
    r = c.post("/v1/consultation/extract", json=body())
    assert r.status_code == status and r.json()["retriable"] is retriable and r.json()["code"] == exc.code


def test_schema_endpoint_serves_the_contract():
    d = make_client().get("/v1/consultation/schema").json()
    assert d["schema_version"] == "1.0" and {"extract_request", "extract_response", "model_output", "observation"} <= set(d)
