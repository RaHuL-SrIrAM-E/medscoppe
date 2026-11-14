/**
 * Consultation data contracts (schema version 1.0). Mirrors backend/app/consult/schema.py field for field.
 * Drift is caught by contracts.test.ts, which validates the shared fixtures in /contracts and compares every
 * enumeration with the generated JSON Schema. Pure TypeScript: no Three.js, no DOM.
 *
 * There is deliberately no diagnosis, medication or dosage field, and no automatic-diarisation speaker basis.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = '1.0' as const;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const label = z.string().regex(/^[A-Za-z][A-Za-z \-']{1,38}$/);

// --- vocabularies -------------------------------------------------------------------------------
export const Speaker = z.enum(['DOCTOR', 'PATIENT', 'UNATTRIBUTED']);
export const SpeakerBasis = z.enum(['SCRIPTED', 'MANUAL_SELECTION', 'UNVERIFIED']);
export const ObservationKind = z.enum(['SYMPTOM', 'PATIENT_STATED_CONDITION']);
export const Source = z.enum(['PATIENT_REPORTED', 'DOCTOR_CONFIRMED', 'DOCTOR_OBSERVED', 'SYSTEM_DERIVED']);
export const Status = z.enum(['PRESENT', 'ABSENT', 'UNKNOWN', 'UNRESOLVED']);
export const Confidence = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const SymptomCode = z.enum([
  'COUGH', 'FEVER', 'DYSPNOEA', 'CHEST_PAIN', 'WHEEZE', 'HAEMOPTYSIS', 'SORE_THROAT', 'FATIGUE',
  'NASAL_CONGESTION', 'HEADACHE', 'OTHER',
]);
export const DurationUnit = z.enum(['HOURS', 'DAYS', 'WEEKS', 'MONTHS']);
export const Severity = z.enum(['MILD', 'MODERATE', 'SEVERE']);
export const Onset = z.enum(['SUDDEN', 'GRADUAL']);
export const Character = z.enum(['DRY', 'PRODUCTIVE']);
export const Phase = z.enum(['INITIAL', 'CURRENT']);
export const Context = z.enum(['EXERTION', 'REST', 'NIGHT']);
export const EvidenceRole = z.enum(['STATEMENT', 'QUESTION_CONTEXT']);
export const Action = z.enum(['ADD', 'REINFORCE', 'REFINE', 'CONTRADICT', 'REVISE']);
export const ReviewState = z.enum(['UNREVIEWED', 'CONFIRMED', 'CORRECTED', 'REJECTED']);
export const RejectionReason = z.enum([
  'UNKNOWN_UTTERANCE', 'STATEMENT_NOT_IN_NEW_UTTERANCES', 'QUOTE_NOT_IN_UTTERANCE', 'MISSING_STATEMENT_EVIDENCE',
  'SOURCE_NOT_ALLOWED', 'SPEAKER_MISMATCH', 'DOSE_OR_PRESCRIPTION_TEXT', 'DIAGNOSIS_NOT_SUPPORTED',
  'INVALID_SYMPTOM_OR_LABEL', 'INVALID_STATUS', 'UNKNOWN_TARGET', 'NO_NEW_INFORMATION',
]);
export const HeldReason = z.enum(['UNATTRIBUTED_SPEAKER']);

export type Speaker = z.infer<typeof Speaker>;
export type Source = z.infer<typeof Source>;
export type Status = z.infer<typeof Status>;

// --- pieces --------------------------------------------------------------------------------------
export const Utterance = z
  .strictObject({
    id,
    speaker: Speaker,
    speaker_basis: SpeakerBasis,
    text: z.string().min(1).max(1000),
    start_ms: z.number().int().min(0).nullish(),
    end_ms: z.number().int().min(0).nullish(),
  })
  .superRefine((u, ctx) => {
    if ((u.speaker === 'UNATTRIBUTED') !== (u.speaker_basis === 'UNVERIFIED')) {
      ctx.addIssue({ code: 'custom', message: 'speaker UNATTRIBUTED if and only if speaker_basis is UNVERIFIED' });
    }
    if (u.start_ms != null && u.end_ms != null && u.end_ms < u.start_ms) {
      ctx.addIssue({ code: 'custom', message: 'end_ms must not precede start_ms' });
    }
  });
export type Utterance = z.infer<typeof Utterance>;

export const Duration = z.strictObject({
  value: z.number().int().min(1).max(365),
  unit: DurationUnit,
  approximate: z.boolean(),
  text: z.string().min(1).max(60),
});
export type Duration = z.infer<typeof Duration>;

export const QualityPhase = z.strictObject({ phase: Phase, character: Character });

/** Null / empty means NOT STATED. Nothing here is ever guessed. */
export const Attributes = z.strictObject({
  onset: Onset.nullable().default(null),
  duration: Duration.nullable().default(null),
  severity: Severity.nullable().default(null),
  character_over_time: z.array(QualityPhase).max(4).default([]),
  context: z.array(Context).max(3).default([]),
});
export type Attributes = z.infer<typeof Attributes>;

export const ModelEvidence = z.strictObject({ utterance_id: id, role: EvidenceRole, quote: z.string().min(1).max(300) });
export const ModelObservation = z.strictObject({
  kind: ObservationKind,
  symptom: SymptomCode.nullable().default(null),
  label: z.string().max(40).nullable().default(null),
  status: Status,
  source: Source,
  confidence: Confidence,
  attributes: Attributes,
  evidence: z.array(ModelEvidence).min(1).max(4),
});
export const ModelProposal = z.strictObject({
  action_hint: Action,
  target_id: id.nullable().default(null),
  observation: ModelObservation,
});
export const ModelOutput = z.strictObject({ proposals: z.array(ModelProposal).max(12) });

export const Evidence = z
  .strictObject({
    utterance_id: id,
    role: EvidenceRole,
    quote: z.string().min(1).max(300),
    char_start: z.number().int().min(0),
    char_end: z.number().int().min(1),
  })
  .superRefine((e, ctx) => {
    if (e.char_end <= e.char_start) ctx.addIssue({ code: 'custom', message: 'char_end must exceed char_start' });
  });
export type Evidence = z.infer<typeof Evidence>;

export const ExtractorInfo = z.strictObject({
  provider: z.string(),
  model: z.string(),
  is_replay: z.boolean(),
  schema_version: z.literal('1.0'),
});

export const Review = z.strictObject({
  state: ReviewState.default('UNREVIEWED'),
  at: z.string().nullable().default(null),
  corrected_fields: z.array(z.string()).max(8).default([]),
  note: z.string().max(200).nullable().default(null),
});
export type Review = z.infer<typeof Review>;

export const Observation = z.strictObject({
  id,
  kind: ObservationKind,
  symptom: SymptomCode.nullable(),
  label: label.nullable().default(null),
  status: Status,
  source: Source,
  /** Immutable across revisions: who first reported it. */
  originated_as: Source,
  confidence: Confidence,
  attributes: Attributes,
  evidence: z.array(Evidence).min(1).max(12),
  revision: z.number().int().min(1),
  conflicts_with: z.array(id).max(8).default([]),
  review: Review,
  extractor: ExtractorInfo,
  created_at: z.string(),
});
export type Observation = z.infer<typeof Observation>;

/** What the client tells the server about observations it already holds (no quotes). */
export const ObservationRef = z.strictObject({
  id,
  kind: ObservationKind,
  symptom: SymptomCode.nullable(),
  label: z.string().max(40).nullable().default(null),
  status: Status,
  source: Source,
  revision: z.number().int().min(1),
  attributes: Attributes,
});
export type ObservationRef = z.infer<typeof ObservationRef>;

export const Proposal = z
  .strictObject({
    action: Action,
    target_id: id.nullable().default(null),
    observation: Observation.nullable().default(null),
    attributes_patch: Attributes.nullable().default(null),
    added_evidence: z.array(Evidence).max(4).default([]),
    new_status: Status.nullable().default(null),
  })
  .superRefine((p, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (p.action === 'ADD' || p.action === 'CONTRADICT') {
      if (p.observation === null) bad(`${p.action} requires an observation`);
    } else if (p.observation !== null) bad(`${p.action} must not carry a new observation`);
    if (p.action === 'REVISE') {
      if (p.new_status !== 'PRESENT' && p.new_status !== 'ABSENT') bad('REVISE requires new_status PRESENT or ABSENT');
    } else if (p.new_status !== null) bad(`${p.action} must not carry new_status`);
    if (p.action !== 'ADD' && p.target_id === null) bad(`${p.action} requires target_id`);
    if (p.action === 'ADD' && p.target_id !== null) bad('ADD must not carry target_id');
    if (p.action === 'REFINE' && p.attributes_patch === null) bad('REFINE requires attributes_patch');
    if ((p.action === 'REINFORCE' || p.action === 'REFINE' || p.action === 'REVISE') && p.added_evidence.length === 0) bad(`${p.action} requires added_evidence`);
  });
export type Proposal = z.infer<typeof Proposal>;

export const HeldObservation = z.strictObject({
  utterance_id: id,
  kind: ObservationKind,
  symptom: SymptomCode.nullable(),
  label: z.string().nullable().default(null),
  status: Status,
  reason: HeldReason.default('UNATTRIBUTED_SPEAKER'),
  evidence: z.array(Evidence).min(1).max(4),
});
export type HeldObservation = z.infer<typeof HeldObservation>;

export const Rejection = z.strictObject({
  reason_code: RejectionReason,
  utterance_id: id.nullable().default(null),
  symptom: SymptomCode.nullable().default(null),
});
export type Rejection = z.infer<typeof Rejection>;

// --- request / response ---------------------------------------------------------------------------
export const ExtractRequest = z
  .strictObject({
    schema_version: z.literal(SCHEMA_VERSION),
    consultation_id: id,
    data_classification: z.string(),
    utterances: z.array(Utterance).min(1).max(12),
    context_utterances: z.array(Utterance).max(30).default([]),
    known_observations: z.array(ObservationRef).max(50).default([]),
  })
  .superRefine((r, ctx) => {
    const ids = [...r.utterances, ...r.context_utterances].map((u) => u.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'utterance ids must be unique' });
  });
export type ExtractRequest = z.infer<typeof ExtractRequest>;

export const ExtractResponse = z.strictObject({
  extraction_id: id,
  schema_version: z.literal(SCHEMA_VERSION),
  proposals: z.array(Proposal),
  held_for_review: z.array(HeldObservation),
  rejected: z.array(Rejection),
  extractor: z.strictObject({ provider: z.string(), model: z.string(), is_replay: z.boolean(), latency_ms: z.number().int().min(0) }),
  warnings: z.array(z.string()),
});
export type ExtractResponse = z.infer<typeof ExtractResponse>;

export const ApiError = z.object({ code: z.string(), message: z.string(), retriable: z.boolean() });
export type ApiError = z.infer<typeof ApiError>;

/** Enumerations by their JSON Schema definition name, so tests can prove parity with the backend. */
export const ENUMS_BY_SCHEMA_NAME = {
  Speaker, SpeakerBasis, ObservationKind, Source, Status, Confidence, SymptomCode, DurationUnit, Severity, Onset,
  Character, Phase, Context, EvidenceRole, Action, ReviewState, RejectionReason, HeldReason,
} as const;
