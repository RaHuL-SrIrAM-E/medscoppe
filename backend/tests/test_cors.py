"""Development CORS: the IWSDK dev server (https://localhost:8081) may call the API from the browser; other origins may not."""
from fastapi.testclient import TestClient

from app.main import app

PREFLIGHT = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}


def test_dev_server_origin_is_allowed_for_the_extract_preflight():
    r = TestClient(app).options("/v1/consultation/extract", headers={"Origin": "https://localhost:8081", **PREFLIGHT})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://localhost:8081"


def test_health_is_readable_from_the_dev_server_origin():
    r = TestClient(app).get("/health", headers={"Origin": "https://localhost:8081"})
    assert r.headers["access-control-allow-origin"] == "https://localhost:8081"


def test_other_origins_get_no_cors_grant():
    c = TestClient(app)
    pre = c.options("/v1/consultation/extract", headers={"Origin": "https://evil.example", **PREFLIGHT})
    assert pre.status_code == 400
    assert "access-control-allow-origin" not in pre.headers
    assert "access-control-allow-origin" not in c.get("/health", headers={"Origin": "https://evil.example"}).headers
