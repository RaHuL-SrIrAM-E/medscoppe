"""Run the synthetic respiratory consultation through the REAL HTTP extraction path and print the result.

    .venv/bin/python scripts/demo_extract.py

Uses Gemini when GEMINI_API_KEY and GEMINI_MODEL are set (see .env), otherwise the clearly labelled
hand-authored replay fixture. The banner says which one ran. Nothing is stored.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.consult.contract_fixtures import CONTRACTS, refs_after  # noqa: E402
from app.consult.schema import ObservationRef  # noqa: E402
from app.main import app  # noqa: E402

settings = get_settings()
transcript = json.loads((CONTRACTS / "fixtures" / "synthetic-respiratory" / "transcript.json").read_text())
client = TestClient(app)

health = client.get("/health").json()
print("=" * 100)
if health["extraction_is_replay"]:
    print("EXTRACTION: RECORDED REPLAY (hand-authored fixture). This is NOT a live model call.")
else:
    print(f"EXTRACTION: live Gemini, model from environment: {settings.gemini_model}")
print(f"DATA: {transcript['provenance']}")
print("=" * 100)

known: list[ObservationRef] = []
seen: list[dict] = []
store: dict[str, dict] = {}
for n, batch in enumerate(transcript["batches"], start=1):
    print(f"\n--- batch {n}: {batch['label']}")
    for u in batch["utterances"]:
        print(f"  [{u['speaker']:7}] ({u['speaker_basis']}) {u['text']}")
    r = client.post(
        "/v1/consultation/extract",
        json={"schema_version": "1.0", "consultation_id": transcript["consultation_id"], "data_classification": "SYNTHETIC",
              "utterances": batch["utterances"], "context_utterances": seen[-6:],
              "known_observations": [json.loads(k.model_dump_json()) for k in known]},
    )
    if r.status_code != 200:
        print("  EXTRACTION FAILED:", r.status_code, r.json())
        sys.exit(1)
    resp = r.json()
    for p in resp["proposals"]:
        o = p.get("observation")
        if o:
            store[o["id"]] = o
        print(f"  -> {p['action']:10}", f"{o['symptom']} {o['status']} ({o['source']})" if o else f"target {p['target_id']}")
    for h in resp["held_for_review"]:
        print("  -> HELD for speaker review:", h["symptom"], h["reason"])
    for x in resp["rejected"]:
        print("  -> REJECTED:", x["reason_code"], x.get("symptom"))
    for w in resp["warnings"]:
        print("  ! warning:", w)
    known = refs_after(known, resp)
    seen += batch["utterances"]

print("\n" + "=" * 100)
print("CONSULTATION CONTEXT (patient-reported; not a diagnosis)")
print("=" * 100)
for o in store.values():
    a = o["attributes"]
    bits = []
    if a["duration"]:
        d = a["duration"]
        bits.append(f"duration {'~' if d['approximate'] else ''}{d['value']} {d['unit'].lower()}")
    if a["character_over_time"]:
        bits.append("character " + " -> ".join(f"{q['character'].lower()} ({q['phase'].lower()})" for q in a["character_over_time"]))
    if a["context"]:
        bits.append("context " + ", ".join(c.lower() for c in a["context"]))
    print(f"\n{o['symptom']:11} {o['status']:8} source={o['source']}  review={o['review']['state']}  confidence={o['confidence']}")
    print(f"            {'; '.join(bits) if bits else 'no attributes stated'}")
    for e in o["evidence"]:
        print(f"            evidence[{e['role'][:4]}] {e['utterance_id']}: “{e['quote']}”")
print()
