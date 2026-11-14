import json

import pytest

from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS
from app.consult.validation import contains_dose_text, locate_quote, parse_duration_text, validate_observation

SCEN = CONTRACTS / "fixtures" / "scenarios"


def outcome_for(utterances, observation, new=None):
    u = {x["id"]: s.Utterance.model_validate(x) for x in utterances}
    return validate_observation(s.ModelObservation.model_validate(observation), u, set(u) if new is None else set(new))


def mo(**over):
    base = {"kind": "SYMPTOM", "symptom": "COUGH", "label": None, "status": "PRESENT", "source": "PATIENT_REPORTED",
            "confidence": "HIGH", "attributes": {}, "evidence": [{"utterance_id": "u1", "role": "STATEMENT", "quote": "I have a cough"}]}
    return {**base, **over}


PATIENT = {"id": "u1", "speaker": "PATIENT", "speaker_basis": "SCRIPTED", "text": "I have a cough, and it is dry."}
DOCTOR = {"id": "u1", "speaker": "DOCTOR", "speaker_basis": "SCRIPTED", "text": "I have a cough, and it is dry."}
UNATTR = {"id": "u1", "speaker": "UNATTRIBUTED", "speaker_basis": "UNVERIFIED", "text": "I have a cough, and it is dry."}


# ---------------------------------------------------------------- transcript provenance
def test_quote_is_recut_from_the_source_so_it_is_verbatim_by_construction():
    out = outcome_for([PATIENT], mo(evidence=[{"utterance_id": "u1", "role": "STATEMENT", "quote": "i  have a   COUGH"}]))
    e = out.accepted.evidence[0]
    assert e.quote == "I have a cough"
    assert PATIENT["text"][e.char_start : e.char_end] == e.quote


@pytest.mark.parametrize("quote", ["I have a severe cough", "paraphrased words", "x", ""])
def test_fabricated_or_reworded_quotes_are_rejected(quote):
    if not quote:
        pytest.skip("empty quote is rejected by the schema itself")
    out = outcome_for([PATIENT], mo(evidence=[{"utterance_id": "u1", "role": "STATEMENT", "quote": quote}]))
    assert out.rejection and out.rejection.reason_code == s.RejectionReason.QUOTE_NOT_IN_UTTERANCE


def test_evidence_must_cite_a_known_utterance():
    out = outcome_for([PATIENT], mo(evidence=[{"utterance_id": "nope", "role": "STATEMENT", "quote": "I have a cough"}]))
    assert out.rejection.reason_code == s.RejectionReason.UNKNOWN_UTTERANCE


def test_a_statement_must_come_from_a_new_utterance_not_context():
    out = outcome_for([PATIENT], mo(), new=set())
    assert out.rejection.reason_code == s.RejectionReason.STATEMENT_NOT_IN_NEW_UTTERANCES


def test_question_context_alone_is_not_evidence():
    out = outcome_for([PATIENT], mo(evidence=[{"utterance_id": "u1", "role": "QUESTION_CONTEXT", "quote": "I have a cough"}]))
    assert out.rejection.reason_code == s.RejectionReason.MISSING_STATEMENT_EVIDENCE


def test_curly_apostrophes_still_match():
    assert locate_quote("No, I don’t.", "No, I don't") == (0, 11)


# ---------------------------------------------------------------- patient reported vs doctor confirmed
def test_the_model_can_never_create_doctor_confirmed():
    out = outcome_for([DOCTOR], mo(source="DOCTOR_CONFIRMED"))
    assert out.rejection.reason_code == s.RejectionReason.SOURCE_NOT_ALLOWED


def test_system_derived_is_not_model_producible_either():
    assert outcome_for([PATIENT], mo(source="SYSTEM_DERIVED")).rejection.reason_code == s.RejectionReason.SOURCE_NOT_ALLOWED


def test_doctor_observed_is_accepted_only_from_a_doctor_statement_and_stays_distinct():
    ok = outcome_for([DOCTOR], mo(source="DOCTOR_OBSERVED"))
    assert ok.accepted.source == s.Source.DOCTOR_OBSERVED
    assert outcome_for([PATIENT], mo(source="DOCTOR_OBSERVED")).rejection.reason_code == s.RejectionReason.SPEAKER_MISMATCH


def test_a_doctor_sentence_cannot_become_a_patient_claim():
    assert outcome_for([DOCTOR], mo(source="PATIENT_REPORTED")).rejection.reason_code == s.RejectionReason.SPEAKER_MISMATCH


def test_unattributed_speech_is_held_for_speaker_review_never_a_patient_claim():
    out = outcome_for([UNATTR], mo())
    assert out.accepted is None and out.rejection is None
    assert out.held.reason == s.HeldReason.UNATTRIBUTED_SPEAKER and out.held.symptom == s.SymptomCode.COUGH


# ---------------------------------------------------------------- diagnosis and medication
def test_patient_stated_condition_is_forced_to_unresolved_and_is_never_a_diagnosis():
    out = outcome_for([PATIENT], mo(kind="PATIENT_STATED_CONDITION", symptom=None, label="pneumonia", status="PRESENT",
                                    evidence=[{"utterance_id": "u1", "role": "STATEMENT", "quote": "I have a cough"}]))
    assert out.accepted.status == s.Status.UNRESOLVED and out.accepted.source == s.Source.PATIENT_REPORTED


def test_a_doctor_cannot_state_a_condition():
    out = outcome_for([DOCTOR], mo(kind="PATIENT_STATED_CONDITION", symptom=None, label="pneumonia", source="DOCTOR_OBSERVED"))
    assert out.rejection.reason_code == s.RejectionReason.DIAGNOSIS_NOT_SUPPORTED


@pytest.mark.parametrize("text", ["500 mg of paracetamol", "two tablets", "10ml twice", "the dose was high", "prescribed antibiotics", "5 mcg"])
def test_dose_and_prescription_text_is_detected(text):
    assert contains_dose_text(text)


@pytest.mark.parametrize("text", ["five days", "a dry cough", "worse at night", "two days"])
def test_ordinary_symptom_text_is_not_mistaken_for_a_dose(text):
    assert not contains_dose_text(text)


def test_a_quote_containing_dose_text_is_rejected():
    p = {**PATIENT, "text": "I took 500 mg of paracetamol."}
    out = outcome_for([p], mo(evidence=[{"utterance_id": "u1", "role": "STATEMENT", "quote": "500 mg of paracetamol"}]))
    assert out.rejection.reason_code == s.RejectionReason.DOSE_OR_PRESCRIPTION_TEXT


def test_label_rules():
    assert outcome_for([PATIENT], mo(symptom="OTHER", label="ibuprofen dose")).rejection.reason_code in (
        s.RejectionReason.DOSE_OR_PRESCRIPTION_TEXT, s.RejectionReason.INVALID_SYMPTOM_OR_LABEL)
    assert outcome_for([PATIENT], mo(symptom="COUGH", label="extra")).rejection.reason_code == s.RejectionReason.INVALID_SYMPTOM_OR_LABEL
    assert outcome_for([PATIENT], mo(symptom=None)).rejection.reason_code == s.RejectionReason.INVALID_SYMPTOM_OR_LABEL


def test_the_model_may_not_mark_a_symptom_unresolved_itself():
    assert outcome_for([PATIENT], mo(status="UNRESOLVED")).rejection.reason_code == s.RejectionReason.INVALID_STATUS


# ---------------------------------------------------------------- negative findings and missing information
def test_negative_findings_are_kept_as_absent_and_carry_no_invented_attributes():
    out = outcome_for([PATIENT], mo(status="ABSENT", attributes={"severity": "MILD", "duration": {"value": 2, "unit": "DAYS", "approximate": False, "text": "two days"}}))
    assert out.accepted.status == s.Status.ABSENT
    assert out.accepted.attributes == s.Attributes()
    assert "ATTRIBUTES_DROPPED_FOR_NON_PRESENT" in out.accepted.warnings


def test_missing_attributes_stay_null_and_are_never_invented():
    out = outcome_for([PATIENT], mo())
    a = out.accepted.attributes
    assert (a.onset, a.duration, a.severity, a.character_over_time, a.context) == (None, None, None, [], [])


def test_a_duration_that_is_not_in_the_speakers_words_is_dropped():
    out = outcome_for([PATIENT], mo(attributes={"duration": {"value": 5, "unit": "DAYS", "approximate": False, "text": "five days"}}))
    assert out.accepted.attributes.duration is None and "DURATION_NOT_IN_STATEMENT" in out.accepted.warnings


def test_a_wrong_number_is_corrected_from_the_speakers_own_words():
    p = {**PATIENT, "text": "I have had a cough for about three days."}
    out = outcome_for([p], mo(evidence=[{"utterance_id": "u1", "role": "STATEMENT", "quote": "a cough for about three days"}],
                              attributes={"duration": {"value": 9, "unit": "DAYS", "approximate": False, "text": "about three days"}}))
    d = out.accepted.attributes.duration
    assert (d.value, d.unit, d.approximate) == (3, s.DurationUnit.DAYS, True)


@pytest.mark.parametrize("text,expected", [("about five days", (5, "DAYS")), ("2 weeks", (2, "WEEKS")), ("a couple of days", (2, "DAYS")), ("the last two days", (2, "DAYS")), ("a while", None)])
def test_duration_parsing(text, expected):
    got = parse_duration_text(text)
    assert (got and (got[0], got[1].value)) == expected
