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

Dev keys (desktop adapter): `1` skeletal, `3` respiratory, `5` body shell (`2` muscular and `4` nervous are
ignored until those systems are loaded).

## Verify

```bash
cd app && npm run typecheck && npm test && npm run build
cd app && npm run verify:hands      # needs `dev up`; hands-only emulator checks (controllers disconnected)
cd app && npm run verify:anatomy    # needs `dev up`; select -> card -> isolate -> layers -> reset, all by hand ray
cd backend && .venv/bin/python -m pytest
cd tools/anatomy-pipeline && .venv/bin/python -m pytest
```

## Anatomy

Anatomy is generated from BodyParts3D by `tools/anatomy-pipeline` (see its README). Licences and
required attribution: `docs/asset-licenses.md`.

> **Do not publish or push the BodyParts3D-derived assets (`app/public/anatomy/`) until the licence is
> confirmed.** The licensor's statements conflict; a confirmation request is drafted in
> `docs/dbcls-licence-inquiry-draft.md` and has not been sent.

**Limitations (as of Phase 1):** hand interaction is validated only in the IWER emulator, not on a
physical Meta Quest. Lung lobe shapes are generated approximations. Structure text is unreviewed
educational content. Muscular and nervous systems are not loaded.
