"""Clinical consultation data contracts (schema version 1.0).

These Pydantic models are the single source of truth for the contract. The Zod schemas in
app/src/consult/contracts mirror them and are checked against the shared fixtures in /contracts.

Two layers on purpose:
  * ``Model*`` types describe what the language model is ASKED to return. They contain no
    cross-field validators, so one bad item never fails the whole response.
  * The remaining types are what the application stores and sends to the client. Semantic checks
    (verbatim evidence, speaker rules, no doses, ...) happen in validation.py, item by item.

There is deliberately no diagnosis field, no medication field and no dosage field anywhere.
"""
from __future__ import annotations

import re
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0"

ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
Id = Annotated[str, Field(pattern=ID_PATTERN)]


class StrictModel(BaseModel):
    """Unknown fields are errors: unsupported model output must be rejected, not ignored."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# --------------------------------------------------------------------------- vocabularies
class Speaker(StrEnum):
    DOCTOR = "DOCTOR"
    PATIENT = "PATIENT"
    UNATTRIBUTED = "UNATTRIBUTED"


class SpeakerBasis(StrEnum):
    """How the speaker label was obtained. There is deliberately no automatic-diarisation value."""

    SCRIPTED = "SCRIPTED"
    MANUAL_SELECTION = "MANUAL_SELECTION"
    UNVERIFIED = "UNVERIFIED"


class ObservationKind(StrEnum):
    SYMPTOM = "SYMPTOM"
    PATIENT_STATED_CONDITION = "PATIENT_STATED_CONDITION"


class Source(StrEnum):
    PATIENT_REPORTED = "PATIENT_REPORTED"
    DOCTOR_CONFIRMED = "DOCTOR_CONFIRMED"
    DOCTOR_OBSERVED = "DOCTOR_OBSERVED"
    SYSTEM_DERIVED = "SYSTEM_DERIVED"


class Status(StrEnum):
    PRESENT = "PRESENT"
    ABSENT = "ABSENT"
    UNKNOWN = "UNKNOWN"
    UNRESOLVED = "UNRESOLVED"


class Confidence(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class SymptomCode(StrEnum):
    COUGH = "COUGH"
    FEVER = "FEVER"
    DYSPNOEA = "DYSPNOEA"
    CHEST_PAIN = "CHEST_PAIN"
    WHEEZE = "WHEEZE"
    HAEMOPTYSIS = "HAEMOPTYSIS"
    SORE_THROAT = "SORE_THROAT"
    FATIGUE = "FATIGUE"
    NASAL_CONGESTION = "NASAL_CONGESTION"
    HEADACHE = "HEADACHE"
    OTHER = "OTHER"


class DurationUnit(StrEnum):
    HOURS = "HOURS"
    DAYS = "DAYS"
    WEEKS = "WEEKS"
    MONTHS = "MONTHS"


class Severity(StrEnum):
    MILD = "MILD"
    MODERATE = "MODERATE"
    SEVERE = "SEVERE"


class Onset(StrEnum):
    SUDDEN = "SUDDEN"
    GRADUAL = "GRADUAL"


class Character(StrEnum):
    DRY = "DRY"
    PRODUCTIVE = "PRODUCTIVE"


class Phase(StrEnum):
    INITIAL = "INITIAL"
    CURRENT = "CURRENT"


class Context(StrEnum):
    EXERTION = "EXERTION"
    REST = "REST"
    NIGHT = "NIGHT"


class EvidenceRole(StrEnum):
    STATEMENT = "STATEMENT"  # the speaker's own words that support the observation
    QUESTION_CONTEXT = "QUESTION_CONTEXT"  # the question an elliptical answer ("No, I don't.") responds to


class Action(StrEnum):
    ADD = "ADD"
    REINFORCE = "REINFORCE"
    REFINE = "REFINE"
    CONTRADICT = "CONTRADICT"


class ReviewState(StrEnum):
    UNREVIEWED = "UNREVIEWED"
    CONFIRMED = "CONFIRMED"
    CORRECTED = "CORRECTED"
    REJECTED = "REJECTED"


class RejectionReason(StrEnum):
    UNKNOWN_UTTERANCE = "UNKNOWN_UTTERANCE"
    STATEMENT_NOT_IN_NEW_UTTERANCES = "STATEMENT_NOT_IN_NEW_UTTERANCES"
    QUOTE_NOT_IN_UTTERANCE = "QUOTE_NOT_IN_UTTERANCE"
    MISSING_STATEMENT_EVIDENCE = "MISSING_STATEMENT_EVIDENCE"
    SOURCE_NOT_ALLOWED = "SOURCE_NOT_ALLOWED"
    SPEAKER_MISMATCH = "SPEAKER_MISMATCH"
    DOSE_OR_PRESCRIPTION_TEXT = "DOSE_OR_PRESCRIPTION_TEXT"
    DIAGNOSIS_NOT_SUPPORTED = "DIAGNOSIS_NOT_SUPPORTED"
    INVALID_SYMPTOM_OR_LABEL = "INVALID_SYMPTOM_OR_LABEL"
    INVALID_STATUS = "INVALID_STATUS"
    UNKNOWN_TARGET = "UNKNOWN_TARGET"
    NO_NEW_INFORMATION = "NO_NEW_INFORMATION"


class HeldReason(StrEnum):
    UNATTRIBUTED_SPEAKER = "UNATTRIBUTED_SPEAKER"


LABEL_PATTERN = r"^[A-Za-z][A-Za-z \-']{1,38}$"


# --------------------------------------------------------------------------- shared pieces
class Utterance(StrictModel):
    id: Id
    speaker: Speaker
    speaker_basis: SpeakerBasis
    text: str = Field(min_length=1, max_length=1000)
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _speaker_matches_basis(self) -> Utterance:
        unattributed = self.speaker == Speaker.UNATTRIBUTED
        if unattributed != (self.speaker_basis == SpeakerBasis.UNVERIFIED):
            raise ValueError("speaker UNATTRIBUTED if and only if speaker_basis is UNVERIFIED")
        if self.start_ms is not None and self.end_ms is not None and self.end_ms < self.start_ms:
            raise ValueError("end_ms must not precede start_ms")
        return self


class Duration(StrictModel):
    value: int = Field(ge=1, le=365)
    unit: DurationUnit
    approximate: bool
    text: str = Field(min_length=1, max_length=60, description="The words the speaker used, verbatim.")


class QualityPhase(StrictModel):
    phase: Phase
    character: Character


class Attributes(StrictModel):
    """Everything here is null/empty unless the speaker actually said it. Null means NOT STATED."""

    onset: Onset | None = None
    duration: Duration | None = None
    severity: Severity | None = None
    character_over_time: list[QualityPhase] = Field(default_factory=list, max_length=4)
    context: list[Context] = Field(default_factory=list, max_length=3)


# --------------------------------------------------------------------------- model output layer
class ModelEvidence(StrictModel):
    utterance_id: Id
    role: EvidenceRole
    quote: str = Field(min_length=1, max_length=300, description="Copied exactly from the utterance text.")


class ModelObservation(StrictModel):
    kind: ObservationKind
    symptom: SymptomCode | None = Field(default=None, description="Required for SYMPTOM; null for PATIENT_STATED_CONDITION.")
    label: str | None = Field(default=None, max_length=40, description="Only for OTHER symptoms and stated conditions.")
    status: Status
    source: Source
    confidence: Confidence
    attributes: Attributes
    evidence: list[ModelEvidence] = Field(min_length=1, max_length=4)


class ModelProposal(StrictModel):
    action_hint: Action = Field(description="A hint only. The application decides the real action.")
    target_id: Id | None = None
    observation: ModelObservation


class ModelOutput(StrictModel):
    proposals: list[ModelProposal] = Field(max_length=12)


# --------------------------------------------------------------------------- stored / API layer
class Evidence(StrictModel):
    utterance_id: Id
    role: EvidenceRole
    quote: str = Field(min_length=1, max_length=300)
    char_start: int = Field(ge=0)
    char_end: int = Field(gt=0)

    @model_validator(mode="after")
    def _span_is_ordered(self) -> Evidence:
        if self.char_end <= self.char_start:
            raise ValueError("char_end must exceed char_start")
        return self


class ExtractorInfo(StrictModel):
    provider: str
    model: str
    is_replay: bool
    schema_version: Literal["1.0"] = SCHEMA_VERSION  # type: ignore[assignment]


class Review(StrictModel):
    state: ReviewState = ReviewState.UNREVIEWED
    at: str | None = None
    corrected_fields: list[str] = Field(default_factory=list, max_length=8)
    note: str | None = Field(default=None, max_length=200)


class Observation(StrictModel):
    id: Id
    kind: ObservationKind
    symptom: SymptomCode | None
    label: str | None = Field(default=None, max_length=40)
    status: Status
    source: Source
    originated_as: Source = Field(description="Immutable across revisions: who first reported it.")
    confidence: Confidence
    attributes: Attributes
    evidence: list[Evidence] = Field(min_length=1, max_length=12)
    revision: int = Field(ge=1)
    conflicts_with: list[Id] = Field(default_factory=list, max_length=8)
    review: Review = Field(default_factory=Review)
    extractor: ExtractorInfo
    created_at: str

    @field_validator("label")
    @classmethod
    def _label_shape(cls, v: str | None) -> str | None:
        if v is not None and not re.match(LABEL_PATTERN, v):
            raise ValueError("label must be 2-39 letters, spaces, hyphens or apostrophes")
        return v


class ObservationRef(StrictModel):
    """What the client tells the server about observations it already holds (no quotes)."""

    id: Id
    kind: ObservationKind
    symptom: SymptomCode | None
    label: str | None = Field(default=None, max_length=40)
    status: Status
    source: Source
    revision: int = Field(ge=1)
    attributes: Attributes


class Proposal(StrictModel):
    action: Action
    target_id: Id | None = None
    observation: Observation | None = Field(default=None, description="ADD and CONTRADICT: the new observation.")
    attributes_patch: Attributes | None = Field(default=None, description="REFINE: only fields that were null.")
    added_evidence: list[Evidence] = Field(default_factory=list, max_length=4, description="REINFORCE and REFINE.")

    @model_validator(mode="after")
    def _shape_matches_action(self) -> Proposal:
        a = self.action
        if a in (Action.ADD, Action.CONTRADICT):
            if self.observation is None:
                raise ValueError(f"{a} requires an observation")
        elif self.observation is not None:
            raise ValueError(f"{a} must not carry a new observation")
        if a != Action.ADD and self.target_id is None:
            raise ValueError(f"{a} requires target_id")
        if a == Action.ADD and self.target_id is not None:
            raise ValueError("ADD must not carry target_id")
        if a == Action.REFINE and self.attributes_patch is None:
            raise ValueError("REFINE requires attributes_patch")
        if a in (Action.REINFORCE, Action.REFINE) and not self.added_evidence:
            raise ValueError(f"{a} requires added_evidence")
        return self


class HeldObservation(StrictModel):
    """Extracted from a speaker that is not attributed. Not a claim until the doctor assigns a speaker."""

    utterance_id: Id
    kind: ObservationKind
    symptom: SymptomCode | None
    label: str | None = None
    status: Status
    reason: HeldReason = HeldReason.UNATTRIBUTED_SPEAKER
    evidence: list[Evidence] = Field(min_length=1, max_length=4)


class Rejection(StrictModel):
    reason_code: RejectionReason
    utterance_id: Id | None = None
    symptom: SymptomCode | None = None


# --------------------------------------------------------------------------- request / response
class ExtractRequest(StrictModel):
    schema_version: Literal["1.0"]
    consultation_id: Id
    data_classification: str = Field(description='Must be "SYNTHETIC". Anything else is refused.')
    utterances: list[Utterance] = Field(min_length=1, max_length=12)
    context_utterances: list[Utterance] = Field(default_factory=list, max_length=30)
    known_observations: list[ObservationRef] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _ids_unique(self) -> ExtractRequest:
        ids = [u.id for u in self.utterances] + [u.id for u in self.context_utterances]
        if len(ids) != len(set(ids)):
            raise ValueError("utterance ids must be unique across utterances and context_utterances")
        return self


class ExtractorReport(StrictModel):
    provider: str
    model: str
    is_replay: bool
    latency_ms: int = Field(ge=0)


class ExtractResponse(StrictModel):
    extraction_id: Id
    schema_version: Literal["1.0"] = SCHEMA_VERSION  # type: ignore[assignment]
    proposals: list[Proposal]
    held_for_review: list[HeldObservation]
    rejected: list[Rejection]
    extractor: ExtractorReport
    warnings: list[str]


class ApiError(StrictModel):
    code: str
    message: str
    retriable: bool


def schema_bundle() -> dict[str, object]:
    """JSON Schema for the contract types. Exported to /contracts/schema and served at /v1/consultation/schema."""
    return {
        "schema_version": SCHEMA_VERSION,
        "extract_request": ExtractRequest.model_json_schema(),
        "extract_response": ExtractResponse.model_json_schema(),
        "model_output": ModelOutput.model_json_schema(),
        "observation": Observation.model_json_schema(),
    }
