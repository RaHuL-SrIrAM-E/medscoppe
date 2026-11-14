from fastapi.testclient import TestClient

from app.main import app


def test_health_reports_status_without_secrets():
    body = TestClient(app).get("/health").json()
    assert body["status"] == "ok"
    assert isinstance(body["gemini_configured"], bool)
    assert "key" not in str(body).lower().replace("gemini_configured", "")
