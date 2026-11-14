"""Record REAL Gemini output for the synthetic consultation, to replace the hand-authored replay fixture.

    .venv/bin/python scripts/record_replay.py            # writes replay.recorded.json next to the fixture
    .venv/bin/python scripts/record_replay.py --install  # also replaces replay.json (then run export_contracts.py)

Requires GEMINI_API_KEY and GEMINI_MODEL. NOT exercised in this repository's tests: no credentials were available
when it was written. Only synthetic text is sent. Review the recorded file before installing it.
"""
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.consult.contract_fixtures import CONTRACTS, StaticProvider, deterministic_service, refs_after  # noqa: E402
from app.consult.gemini import PROMPT_VERSION, GeminiExtractionProvider  # noqa: E402
from app.consult.schema import ExtractRequest  # noqa: E402

settings = get_settings()
if not settings.gemini_configured:
    sys.exit("GEMINI_API_KEY and GEMINI_MODEL must both be set. Nothing recorded.")

base = CONTRACTS / "fixtures" / "synthetic-respiratory"
transcript = json.loads((base / "transcript.json").read_text())
gemini = GeminiExtractionProvider(api_key=settings.gemini_api_key, model=settings.gemini_model, timeout_s=settings.gemini_timeout_s)

entries, known, seen = [], [], []
for batch in transcript["batches"]:
    request = ExtractRequest.model_validate({
        "schema_version": "1.0", "consultation_id": transcript["consultation_id"], "data_classification": "SYNTHETIC",
        "utterances": batch["utterances"], "context_utterances": seen[-6:], "known_observations": [json.loads(k.model_dump_json()) for k in known],
    })
    output = asyncio.run(gemini.extract(request))
    entries.append({"label": batch["label"], "match": [{"speaker": u["speaker"], "text": u["text"]} for u in batch["utterances"]],
                    "model_output": json.loads(output.model_dump_json())})
    response = json.loads(asyncio.run(deterministic_service(StaticProvider(output)).extract(request)).model_dump_json())
    known = refs_after(known, response)
    seen += batch["utterances"]

doc = {"provenance": f"RECORDED from a real Gemini call. model={settings.gemini_model}, prompt_version={PROMPT_VERSION}, "
                     f"recorded_at={datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}. Synthetic input only.", "entries": entries}
out = base / ("replay.json" if "--install" in sys.argv else "replay.recorded.json")
out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print("wrote", out)
