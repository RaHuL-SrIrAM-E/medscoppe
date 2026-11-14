import json

import pytest
from pydantic import ValidationError

from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS

SCENARIOS = sorted((CONTRACTS / "fixtures" / "scenarios").glob("*.json"))
INPUTS = [p for p in SCENARIOS if not p.name.endswith(".response.json")]


def utt(**over):
    base = {"id": "u1", "speaker": "PATIENT", "speaker_basis": "SCRIPTED", "text": "I have a cough."}
    return {**base, **over}


def test_unknown_fields_are_rejected_not_ignored():
    with pytest.raises(ValidationError):
        s.Utterance.model_validate(utt(diagnosis="asthma"))
    with pytest.raises(ValidationError):
        s.ModelOutput.model_validate({"proposals": [], "medication": "x"})


@pytest.mark.parametrize("bad", [
    {"speaker": "UNATTRIBUTED", "speaker_basis": "SCRIPTED"},       # an unattributed speaker cannot have a verified basis
    {"speaker": "PATIENT", "speaker_basis": "UNVERIFIED"},          # and a verified speaker cannot be marked unverified
    {"id": "has space"}, {"text": ""}, {"text": "x" * 1001}, {"start_ms": 100, "end_ms": 50},
])
def test_utterance_rejects_inconsistent_or_malformed_values(bad):
    with pytest.raises(ValidationError):
        s.Utterance.model_validate(utt(**bad))


def test_there_is_no_automatic_diarisation_basis_and_no_diagnosis_kind():
    assert {b.value for b in s.SpeakerBasis} == {"SCRIPTED", "MANUAL_SELECTION", "UNVERIFIED"}
    assert {k.value for k in s.ObservationKind} == {"SYMPTOM", "PATIENT_STATED_CONDITION"}


def test_source_and_status_vocabularies_match_the_contract():
    assert {x.value for x in s.Source} == {"PATIENT_REPORTED", "DOCTOR_CONFIRMED", "DOCTOR_OBSERVED", "SYSTEM_DERIVED"}
    assert {x.value for x in s.Status} == {"PRESENT", "ABSENT", "UNKNOWN", "UNRESOLVED"}


def test_no_schema_field_can_carry_a_medication_dose_or_diagnosis():
    names = json.dumps(s.schema_bundle()).lower()
    for forbidden in ("medication", "dosage", "prescription", "diagnosis"):
        assert f'"{forbidden}"' not in names


def test_request_requires_unique_utterance_ids_and_bounded_sizes():
    base = {"schema_version": "1.0", "consultation_id": "c1", "data_classification": "SYNTHETIC"}
    with pytest.raises(ValidationError):
        s.ExtractRequest.model_validate({**base, "utterances": [utt(), utt()]})
    with pytest.raises(ValidationError):
        s.ExtractRequest.model_validate({**base, "utterances": []})
    with pytest.raises(ValidationError):
        s.ExtractRequest.model_validate({**base, "utterances": [utt(id=f"u{i}") for i in range(13)]})


def test_evidence_span_must_be_ordered():
    with pytest.raises(ValidationError):
        s.Evidence(utterance_id="u1", role="STATEMENT", quote="x", char_start=5, char_end=5)


@pytest.mark.parametrize("kwargs", [
    {"action": "ADD"},                                                              # needs an observation
    {"action": "REINFORCE", "target_id": "o1"},                                     # needs evidence
    {"action": "REFINE", "target_id": "o1", "added_evidence": [{"utterance_id": "u1", "role": "STATEMENT", "quote": "ab", "char_start": 0, "char_end": 2}]},  # needs a patch
    {"action": "CONTRADICT", "observation": None, "target_id": "o1"},
])
def test_proposal_shape_must_match_its_action(kwargs):
    with pytest.raises(ValidationError):
        s.Proposal.model_validate(kwargs)


def test_label_must_be_plain_words():
    obs = json.loads((CONTRACTS / "fixtures" / "scenarios" / "patient-belief.response.json").read_text())["proposals"][0]["observation"]
    s.Observation.model_validate(obs)
    with pytest.raises(ValidationError):
        s.Observation.model_validate({**obs, "label": "ibuprofen 400mg"})


@pytest.mark.parametrize("path", INPUTS, ids=lambda p: p.stem)
def test_every_scenario_input_is_a_valid_request_and_model_output(path):
    doc = json.loads(path.read_text())
    s.ExtractRequest.model_validate(doc["request"])
    s.ModelOutput.model_validate(doc["model_output"])
