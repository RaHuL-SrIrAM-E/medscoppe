# Shared contracts

The data contracts shared by the backend (Pydantic) and the frontend (Zod). Both are tested against the files here, so a
change to one side that is not mirrored on the other fails a test.

```
schema/consultation.schema.json     JSON Schema bundle generated from the Pydantic models
fixtures/synthetic-respiratory/     the primary synthetic consultation (SYNTHETIC, not a real patient)
  transcript.json                   explicit doctor/patient utterances with realistic timing, in three batches
  replay.json                       HAND-AUTHORED model outputs used by the labelled recorded-replay fallback
  response-1..3.json                what the real service returns for each batch (generated)
fixtures/scenarios/                 one file per safety rule: conflicts, refinement, held speaker, patient belief,
  <name>.json                       fabricated evidence, model-emitted confirmation, dose text, ...
  <name>.response.json              the real service's output for it (generated)
```

`*.response.json`, `response-*.json` and the schema are **generated** by the real validation and reconciliation code with
fixed ids, clock and timer. Regenerate after changing the schema, the validation rules or a scenario input:

```bash
cd backend && .venv/bin/python scripts/export_contracts.py
```

Backend tests fail if the committed files drift from the code; frontend tests consume the same files.

All fixtures are synthetic. `replay.json` is hand-authored (no Gemini credentials were available) and says so in its
`provenance` field; `backend/scripts/record_replay.py` replaces it with real recordings once a key exists.
