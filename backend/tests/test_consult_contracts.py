"""Contract and end-to-end tests over the shared fixtures in /contracts."""
import json

from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS, build_all

SYN = CONTRACTS / "fixtures" / "synthetic-respiratory"


def test_committed_contract_files_match_what_the_code_generates():
    """Drift guard: if the schema, validation or a scenario changes, regenerate with scripts/export_contracts.py."""
    for path, content in build_all().items():
        committed = json.loads(path.read_text(encoding="utf-8"))
        assert committed == json.loads(json.dumps(content)), f"{path.name} is stale: run scripts/export_contracts.py"


def test_replay_fixture_is_honestly_labelled_as_hand_authored():
    doc = json.loads((SYN / "replay.json").read_text())
    assert "HAND-AUTHORED" in doc["provenance"] and "NOT recordings" in doc["provenance"]


def test_transcript_fixture_is_labelled_synthetic_and_has_explicit_speakers():
    doc = json.loads((SYN / "transcript.json").read_text())
    assert doc["provenance"].startswith("SYNTHETIC")
    for b in doc["batches"]:
        for u in b["utterances"]:
            assert u["speaker"] in ("DOCTOR", "PATIENT") and u["speaker_basis"] == "SCRIPTED"


def test_synthetic_consultation_end_to_end_yields_the_expected_observations():
    r1, r2, r3 = (json.loads((SYN / f"response-{i}.json").read_text()) for i in (1, 2, 3))
    s.ExtractResponse.model_validate(r1)
    obs = {p["observation"]["symptom"]: p["observation"] for r in (r1, r2, r3) for p in r["proposals"]}
    assert set(obs) == {"COUGH", "FEVER", "DYSPNOEA", "CHEST_PAIN"}

    cough = obs["COUGH"]
    assert (cough["status"], cough["source"]) == ("PRESENT", "PATIENT_REPORTED")
    assert (cough["attributes"]["duration"]["value"], cough["attributes"]["duration"]["unit"], cough["attributes"]["duration"]["approximate"]) == (5, "DAYS", True)
    assert [(q["phase"], q["character"]) for q in cough["attributes"]["character_over_time"]] == [("INITIAL", "DRY"), ("CURRENT", "PRODUCTIVE")]

    fever = obs["FEVER"]
    assert (fever["status"], fever["attributes"]["duration"]["value"], fever["attributes"]["duration"]["unit"]) == ("PRESENT", 2, "DAYS")

    dysp = obs["DYSPNOEA"]
    assert dysp["status"] == "PRESENT" and dysp["attributes"]["context"] == ["EXERTION"]

    pain = obs["CHEST_PAIN"]
    assert pain["status"] == "ABSENT" and pain["source"] == "PATIENT_REPORTED"

    # nothing was invented: no severity, no onset anywhere, and no diagnosis-like observation
    assert all(o["attributes"]["severity"] is None and o["attributes"]["onset"] is None for o in obs.values())
    assert all(o["kind"] == "SYMPTOM" for o in obs.values())


def test_every_evidence_quote_in_every_fixture_is_verbatim_from_a_real_utterance():
    transcript = json.loads((SYN / "transcript.json").read_text())
    texts = {u["id"]: u["text"] for b in transcript["batches"] for u in b["utterances"]}
    for i in (1, 2, 3):
        for p in json.loads((SYN / f"response-{i}.json").read_text())["proposals"]:
            for e in p["observation"]["evidence"]:
                assert texts[e["utterance_id"]][e["char_start"] : e["char_end"]] == e["quote"]
                assert e["role"] in ("STATEMENT", "QUESTION_CONTEXT")
            # at least one first-hand statement, and the speaker of that statement is the patient
            statements = [e for e in p["observation"]["evidence"] if e["role"] == "STATEMENT"]
            assert statements and all(next(u for b in transcript["batches"] for u in b["utterances"] if u["id"] == e["utterance_id"])["speaker"] == "PATIENT" for e in statements)


def test_replay_responses_are_flagged_as_replay_everywhere():
    for i in (1, 2, 3):
        r = json.loads((SYN / f"response-{i}.json").read_text())
        assert r["extractor"]["is_replay"] is True and r["warnings"][0].startswith("REPLAY_FIXTURE")
        assert all(p["observation"]["extractor"]["is_replay"] for p in r["proposals"])
