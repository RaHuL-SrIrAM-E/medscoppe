import json

import pytest

from app.consult import schema as s
from app.consult.contract_fixtures import CONTRACTS, StaticProvider, deterministic_service
from app.consult.validation import contains_dose_text
import asyncio

SCEN = CONTRACTS / "fixtures" / "scenarios"


def run(name):
    doc = json.loads((SCEN / f"{name}.json").read_text())
    svc = deterministic_service(StaticProvider(s.ModelOutput.model_validate(doc["model_output"])))
    return asyncio.run(svc.extract(s.ExtractRequest.model_validate(doc["request"])))


def test_conflicting_status_is_contradicted_and_never_overwritten():
    r = run("conflict-status")
    (p,) = r.proposals
    assert p.action == s.Action.CONTRADICT and p.target_id == "obs_known1"
    assert p.observation.status == s.Status.ABSENT and p.observation.conflicts_with == ["obs_known1"]
    assert p.attributes_patch is None  # the earlier observation is not edited by this proposal


def test_conflicting_duration_is_a_conflict_not_a_refinement():
    (p,) = run("conflict-duration").proposals
    assert p.action == s.Action.CONTRADICT  # the model hinted REFINE; the application decided otherwise


def test_new_information_only_fills_attributes_that_were_null():
    (p,) = run("refine-attributes").proposals
    assert p.action == s.Action.REFINE and p.target_id == "obs_known1"
    assert p.attributes_patch.duration.value == 4 and p.attributes_patch.context == [s.Context.NIGHT]
    assert p.added_evidence


def test_restating_the_same_fact_adds_evidence_only():
    (p,) = run("reinforce-same-fact").proposals
    assert p.action == s.Action.REINFORCE and p.attributes_patch is None and len(p.added_evidence) == 1


def test_the_models_action_hint_is_ignored():
    # every scenario hints ADD/REFINE/REINFORCE loosely; the decided action follows the data
    assert run("conflict-status").proposals[0].action == s.Action.CONTRADICT
    assert run("reinforce-same-fact").proposals[0].action == s.Action.REINFORCE


def test_unattributed_observations_are_held_and_produce_no_proposal():
    r = run("unattributed-held")
    assert r.proposals == [] and len(r.held_for_review) == 1
    assert r.held_for_review[0].evidence[0].quote.startswith("I have had chest pain")


def test_patient_belief_is_unresolved_and_labelled_a_patient_report():
    (p,) = run("patient-belief").proposals
    o = p.observation
    assert o.kind == s.ObservationKind.PATIENT_STATED_CONDITION and o.status == s.Status.UNRESOLVED
    assert o.source == o.originated_as == s.Source.PATIENT_REPORTED


@pytest.mark.parametrize("name,reason", [
    ("fabricated-evidence", s.RejectionReason.QUOTE_NOT_IN_UTTERANCE),
    ("model-emits-confirmed", s.RejectionReason.SOURCE_NOT_ALLOWED),
    ("doctor-restatement-mismatch", s.RejectionReason.SPEAKER_MISMATCH),
])
def test_unsupported_model_output_is_rejected_with_a_reason_and_stores_nothing(name, reason):
    r = run(name)
    assert r.proposals == [] and [x.reason_code for x in r.rejected] == [reason]


def test_one_bad_item_does_not_discard_a_good_one():
    r = run("dose-text")
    assert [p.observation.symptom for p in r.proposals] == [s.SymptomCode.FEVER]
    assert [x.reason_code for x in r.rejected] == [s.RejectionReason.DOSE_OR_PRESCRIPTION_TEXT]


def test_doctor_observed_is_not_doctor_confirmed():
    (p,) = run("doctor-observed").proposals
    assert p.observation.source == s.Source.DOCTOR_OBSERVED


def test_nothing_the_service_returns_is_ever_doctor_confirmed_or_carries_dose_text():
    for f in SCEN.glob("*.json"):
        if f.name.endswith(".response.json"):
            continue
        r = run(f.stem)
        for p in r.proposals:
            if p.observation:
                assert p.observation.source != s.Source.DOCTOR_CONFIRMED
                assert not contains_dose_text(p.observation.label)
                assert not any(contains_dose_text(e.quote) for e in p.observation.evidence)


def test_duplicate_findings_in_one_batch_reconcile_against_each_other():
    doc = json.loads((SCEN / "reinforce-same-fact.json").read_text())
    doc["request"]["known_observations"] = []
    out = doc["model_output"]["proposals"][0]
    doc["model_output"]["proposals"] = [out, out]
    svc = deterministic_service(StaticProvider(s.ModelOutput.model_validate(doc["model_output"])))
    r = asyncio.run(svc.extract(s.ExtractRequest.model_validate(doc["request"])))
    assert [p.action for p in r.proposals] == [s.Action.ADD, s.Action.REINFORCE]
