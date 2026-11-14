# MEDSCOPE

Spatial medical copilot (clinician-support and educational prototype; synthetic data only).

## Run

```bash
# Frontend (IWSDK + IWER desktop XR emulation) - https://localhost:8081
cd app && npm install && npm run dev            # headed managed browser
cd app && npx @iwsdk/cli dev up --headless      # headless, for automation/screenshots
cd app && npm run typecheck && npm run build

# Backend (Python 3.12) - http://localhost:8000
cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                            # Gemini vars optional
.venv/bin/uvicorn app.main:app --reload --port 8000
.venv/bin/python -m pytest
```

Dev keys (desktop adapter): `1` skeletal, `2` muscular, `3` respiratory, `4` nervous.
