"""Regression tests for the approved judgement-call refinements."""
import asyncio
import json

import pytest
from pydantic import ValidationError

from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS, StaticProvider, deterministic_service, refs_after
from app.consult.validation import (
    _APPROX_CUE, clean_clause, contains_dose_text, parse_duration_text, validate_observation,
)

SCEN = CONTRACTS / "fixtures" / "scenarios"
SYN = CONTRACTS / "fixtures" / "synthetic-respiratory"


def run(name, **override):
    doc = json.loads((SCEN / f"{name}.json").read_text())
    svc = deterministic_service(StaticProvider(s.ModelOutput.model_validate(doc["model_output"])))
    return asyncio.run(svc.extract(s.ExtractRequest.model_validate(doc["request"])))


def mo(utt_id, quote, **over):
    base = {"kind": "SYMPTOM", "symptom": "FEVER", "label": None, "status": "PRESENT", "source": "PATIENT_REPORTED",
            "confidence": "HIGH", "attributes": {}, "evidence": [{"utterance_id": utt_id, "role": "STATEMENT", "quote": quote}]}
    return {**base, **over}


def check(text, observation, speaker="PATIENT"):
    u = {"id": "u1", "speaker": speaker, "speaker_basis": "SCRIPTED", "text": text}
    return validate_observation(s.ModelObservation.model_validate(observation), {"u1": s.Utterance.model_validate(u)}, {"u1"})


# ============================================================ 1. "last two days" is a two-day duration
def test_last_two_days_is_two_days_and_not_approximate():
    (p,) = run("last-two-days").proposals
    d = p.observation.attributes.duration
    assert (d.value, d.unit, d.approximate) == (2, s.DurationUnit.DAYS, False)


def test_the_word_about_is_never_added_to_the_evidence_or_the_duration_text():
    (p,) = run("last-two-days").proposals
    assert "about" not in " ".join(e.quote.lower() for e in p.observation.evidence)
    assert "about" not in p.observation.attributes.duration.text.lower()


@pytest.mark.parametrize("text,approximate", [("the last two days", False), ("the past three days", False), ("two days", False),
                                              ("about five days", True), ("around a week", True), ("roughly 3 days", True), ("a couple of days", True)])
def test_only_explicit_hedging_words_make_a_duration_approximate(text, approximate):
    assert bool(_APPROX_CUE.search(text)) is approximate


def test_the_synthetic_fever_is_exactly_two_days_not_approximate():
    r = json.loads((SYN / "response-1.json").read_text())
    fever = next(p["observation"] for p in r["proposals"] if p["observation"]["symptom"] == "FEVER")
    assert fever["attributes"]["duration"] == {"value": 2, "unit": "DAYS", "approximate": False, "text": "the last two days"}
    assert fever["evidence"][0]["quote"] == "I've also had a fever for the last two days"


def test_the_cough_still_says_about_five_days_because_the_patient_did():
    r = json.loads((SYN / "response-1.json").read_text())
    cough = next(p["observation"] for p in r["proposals"] if p["observation"]["symptom"] == "COUGH")
    assert cough["attributes"]["duration"]["approximate"] is True and parse_duration_text("about five days")[0] == 5


# ============================================================ 2. dose content never becomes an observation, symptoms survive
def test_a_fever_survives_with_its_own_clean_quote_when_the_model_quotes_a_dose_sentence():
    (p,) = run("dose-in-quote").proposals
    (e,) = p.observation.evidence
    assert p.observation.symptom == s.SymptomCode.FEVER and e.quote == "I have a fever"
    text = "I took 500 mg of paracetamol and I have a fever."
    assert text[e.char_start : e.char_end] == e.quote


def test_dose_only_evidence_yields_no_observation():
    r = run("dose-only-evidence")
    assert r.proposals == [] and [x.reason_code for x in r.rejected] == [s.RejectionReason.DOSE_OR_PRESCRIPTION_TEXT]


def test_no_evidence_quote_anywhere_contains_dose_text():
    for path in [*SCEN.glob("*.response.json"), *SYN.glob("response-*.json")]:
        for p in json.loads(path.read_text())["proposals"]:
            for e in [*((p.get("observation") or {}).get("evidence", [])), *p.get("added_evidence", [])]:
                assert not contains_dose_text(e["quote"]), path.name


def test_dose_content_still_cannot_be_the_subject_of_an_observation():
    out = check("I took ibuprofen.", mo("u1", "I took ibuprofen", symptom="OTHER", label="ibuprofen dose"))
    assert out.rejection and out.rejection.reason_code in (s.RejectionReason.DOSE_OR_PRESCRIPTION_TEXT, s.RejectionReason.INVALID_SYMPTOM_OR_LABEL)


def test_a_dose_in_a_duration_phrase_drops_the_attribute_not_the_observation():
    out = check("I have had a fever for 2 mg days.", mo("u1", "I have had a fever", attributes={"duration": {"value": 2, "unit": "DAYS", "approximate": False, "text": "2 mg days"}}))
    assert out.accepted and out.accepted.attributes.duration is None and "DURATION_DROPPED_DOSE_TEXT" in out.accepted.warnings


def test_a_question_context_quote_with_dose_text_is_dropped_but_the_observation_survives():
    texts = {"u0": {"id": "u0", "speaker": "DOCTOR", "speaker_basis": "SCRIPTED", "text": "Did the 500 mg tablets help your fever?"},
             "u1": {"id": "u1", "speaker": "PATIENT", "speaker_basis": "SCRIPTED", "text": "Yes, I have a fever."}}
    obs = mo("u1", "I have a fever", evidence=[{"utterance_id": "u1", "role": "STATEMENT", "quote": "I have a fever"},
                                              {"utterance_id": "u0", "role": "QUESTION_CONTEXT", "quote": "500 mg tablets help your fever"}])
    out = validate_observation(s.ModelObservation.model_validate(obs), {k: s.Utterance.model_validate(v) for k, v in texts.items()}, {"u1"})
    assert out.accepted and [e.role for e in out.accepted.evidence] == [s.EvidenceRole.STATEMENT]


@pytest.mark.parametrize("text,symptom,expected", [
    ("I took 500 mg of paracetamol and I have a fever.", s.SymptomCode.FEVER, "I have a fever"),
    ("I have a cough, and I took two tablets.", s.SymptomCode.COUGH, "I have a cough"),
    ("I took 500 mg of paracetamol.", s.SymptomCode.FEVER, None),
    ("I took 500 mg of paracetamol and I have a fever.", s.SymptomCode.OTHER, None),   # no keyword list for OTHER: never guessed
])
def test_clause_trimming(text, symptom, expected):
    span = clean_clause(text, (0, len(text) - 1), symptom)
    assert (text[span[0] : span[1]] if span else None) == expected


def test_the_symptom_and_the_dose_item_from_one_utterance_are_split_correctly():
    r = run("dose-text")
    assert [p.observation.symptom for p in r.proposals] == [s.SymptomCode.FEVER]
    assert [x.reason_code for x in r.rejected] == [s.RejectionReason.DOSE_OR_PRESCRIPTION_TEXT]


# ============================================================ 4. held until speaker assignment, then re-extraction
def test_unattributed_is_held_then_reextracted_after_assignment_with_the_same_evidence():
    held = run("unattributed-held")
    assert held.proposals == [] and len(held.held_for_review) == 1
    redo = run("unattributed-reassigned")
    (p,) = redo.proposals
    assert p.action == s.Action.ADD and p.observation.symptom == held.held_for_review[0].symptom
    assert p.observation.evidence[0].quote == held.held_for_review[0].evidence[0].quote
    assert p.observation.source == s.Source.PATIENT_REPORTED


def test_a_wrong_assignment_cannot_smuggle_a_patient_claim_through_a_doctor_utterance():
    doc = json.loads((SCEN / "unattributed-reassigned.json").read_text())
    doc["request"]["utterances"][0]["speaker"] = "DOCTOR"
    svc = deterministic_service(StaticProvider(s.ModelOutput.model_validate(doc["model_output"])))
    r = asyncio.run(svc.extract(s.ExtractRequest.model_validate(doc["request"])))
    assert r.proposals == [] and r.rejected[0].reason_code == s.RejectionReason.SPEAKER_MISMATCH


def test_an_utterance_cannot_claim_a_verified_basis_while_unattributed():
    with pytest.raises(ValidationError):
        s.Utterance(id="u1", speaker="UNATTRIBUTED", speaker_basis="MANUAL_SELECTION", text="x y")


# ============================================================ 5. a definite statement after UNKNOWN revises, never duplicates
def test_definite_after_unknown_revises_the_active_observation():
    (p,) = run("unknown-then-definite").proposals
    assert p.action == s.Action.REVISE and p.target_id == "obs_known_unk" and p.new_status == s.Status.PRESENT
    assert p.attributes_patch.duration.value == 2 and p.added_evidence and p.observation is None


def test_unknown_then_absent_is_also_a_revision():
    (p,) = run("unknown-then-absent").proposals
    assert (p.action, p.new_status) == (s.Action.REVISE, s.Status.ABSENT)


def test_observations_from_different_sources_are_never_merged():
    (p,) = run("unknown-different-source").proposals
    assert p.action == s.Action.ADD and p.observation.source == s.Source.DOCTOR_OBSERVED


def test_a_repeat_after_the_revision_reinforces_instead_of_duplicating():
    doc = json.loads((SCEN / "unknown-then-definite.json").read_text())
    first = run("unknown-then-definite")
    known = refs_after([s.ObservationRef.model_validate(k) for k in doc["request"]["known_observations"]], json.loads(first.model_dump_json()))
    assert [(k.status, k.revision) for k in known] == [(s.Status.PRESENT, 2)]  # revised in place, still one observation
    request = s.ExtractRequest.model_validate({
        "schema_version": "1.0", "consultation_id": "c", "data_classification": "SYNTHETIC",
        "utterances": [{"id": "u30", "speaker": "PATIENT", "speaker_basis": "SCRIPTED", "text": "Yes, I do have a fever."}],
        "known_observations": [json.loads(k.model_dump_json()) for k in known],
    })
    output = s.ModelOutput.model_validate({"proposals": [{"action_hint": "ADD", "target_id": None, "observation": mo("u30", "I do have a fever")}]})
    r = asyncio.run(deterministic_service(StaticProvider(output)).extract(request))
    assert [p.action for p in r.proposals] == [s.Action.REINFORCE]


@pytest.mark.parametrize("kwargs", [
    {"action": "REVISE", "target_id": "o1", "new_status": "UNKNOWN"},
    {"action": "REVISE", "target_id": "o1", "new_status": "PRESENT"},                      # needs evidence
    {"action": "REVISE", "new_status": "PRESENT", "added_evidence": [{"utterance_id": "u1", "role": "STATEMENT", "quote": "ab", "char_start": 0, "char_end": 2}]},  # needs a target
    {"action": "REINFORCE", "target_id": "o1", "new_status": "PRESENT", "added_evidence": [{"utterance_id": "u1", "role": "STATEMENT", "quote": "ab", "char_start": 0, "char_end": 2}]},
])
def test_revise_proposal_shape(kwargs):
    with pytest.raises(ValidationError):
        s.Proposal.model_validate(kwargs)


# ============================================================ doctor confirmation is never inferred from an utterance
def test_a_doctor_saying_confirmed_does_not_create_doctor_confirmed():
    doc = {"kind": "SYMPTOM", "symptom": "WHEEZE", "label": None, "status": "PRESENT", "source": "DOCTOR_CONFIRMED", "confidence": "HIGH",
           "attributes": {}, "evidence": [{"utterance_id": "u1", "role": "STATEMENT", "quote": "I confirm the wheeze"}]}
    out = check("I confirm the wheeze on the right.", doc, speaker="DOCTOR")
    assert out.rejection.reason_code == s.RejectionReason.SOURCE_NOT_ALLOWED
    # and even as a doctor *observation* the result is DOCTOR_OBSERVED, a distinct source
    ok = check("I confirm the wheeze on the right.", {**doc, "source": "DOCTOR_OBSERVED"}, speaker="DOCTOR")
    assert ok.accepted.source == s.Source.DOCTOR_OBSERVED != s.Source.DOCTOR_CONFIRMED
