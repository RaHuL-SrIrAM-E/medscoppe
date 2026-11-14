/**
 * Consultation context store: the structured, continuously updated state of one consultation.
 * Pure TypeScript (no Three.js, no DOM). Every function returns a NEW state and never mutates its inputs.
 *
 * Rules enforced here (the backend enforces the extraction-side rules; this enforces the review side):
 *  - Append-only: every change adds a revision. Nothing is overwritten and earlier revisions stay readable.
 *  - The model/extractor can never create DOCTOR_CONFIRMED. Only confirmObservation, correctObservation and
 *    resolveConflict do, and they are explicit doctor actions.
 *  - DOCTOR_OBSERVED (a doctor-stated finding) and DOCTOR_CONFIRMED (a doctor's explicit confirmation) stay distinct;
 *    `originated_as` keeps who first reported an observation across all revisions.
 *  - Conflicting statements stay UNRESOLVED until the doctor resolves them explicitly.
 *  - A patient-stated condition is never confirmable: there is no diagnosis support.
 *  - Applying the same extraction response twice is a no-op.
 */
import {
  Attributes,
  type ExtractResponse,
  type Evidence,
  type HeldObservation,
  type Observation,
  type ObservationRef,
  type Proposal,
  type Status,
} from '../contracts/schema.js';

export type EventType =
  | 'EXTRACTION_APPLIED'
  | 'DOCTOR_CONFIRMED'
  | 'DOCTOR_CORRECTED'
  | 'DOCTOR_REJECTED'
  | 'CONFLICT_RESOLVED'
  | 'HELD_CLEARED';

export interface ContextEvent {
  readonly seq: number;
  readonly at: string;
  readonly type: EventType;
  readonly observationIds: readonly string[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ConsultationState {
  readonly consultationId: string;
  /** id -> revisions, oldest first. The last entry is the current revision. */
  readonly records: Readonly<Record<string, readonly Observation[]>>;
  /** Creation order of observation ids. */
  readonly order: readonly string[];
  /** Candidates from unattributed speech. They are NOT claims until the doctor assigns a speaker. */
  readonly held: readonly HeldObservation[];
  readonly appliedExtractions: readonly string[];
  readonly log: readonly ContextEvent[];
}

export type ActionError =
  | 'UNKNOWN_OBSERVATION'
  | 'ALREADY_REJECTED'
  | 'RESOLVE_CONFLICT_FIRST'
  | 'CONDITION_NOT_CONFIRMABLE'
  | 'NO_CHANGE'
  | 'INVALID_PATCH'
  | 'NOT_IN_CONFLICT';

export interface ActionResult {
  readonly state: ConsultationState;
  readonly error: ActionError | null;
}

export function createConsultation(consultationId: string): ConsultationState {
  return { consultationId, records: {}, order: [], held: [], appliedExtractions: [], log: [] };
}

// ---------------------------------------------------------------------------------------------- reads
export function current(state: ConsultationState, id: string): Observation | undefined {
  const revisions = state.records[id];
  return revisions?.[revisions.length - 1];
}

export function history(state: ConsultationState, id: string): readonly Observation[] {
  return state.records[id] ?? [];
}

/** Current revision of every observation that has not been rejected, in creation order. */
export function visibleObservations(state: ConsultationState): Observation[] {
  const out: Observation[] = [];
  for (const id of state.order) {
    const o = current(state, id);
    if (o && o.review.state !== 'REJECTED') out.push(o);
  }
  return out;
}

/** What to send to the extraction service as `known_observations`. Rejected observations are excluded. */
export function knownRefs(state: ConsultationState): ObservationRef[] {
  return visibleObservations(state).map((o) => ({
    id: o.id,
    kind: o.kind,
    symptom: o.symptom,
    label: o.label,
    status: o.status,
    source: o.source,
    revision: o.revision,
    attributes: o.attributes,
  }));
}

export interface Gap {
  readonly observationId: string;
  readonly field: 'duration' | 'severity' | 'onset';
}

/** Information not yet stated for symptoms reported as present. Derived by code, never guessed, never stored as an observation. */
export function gaps(state: ConsultationState): Gap[] {
  const out: Gap[] = [];
  for (const o of visibleObservations(state)) {
    if (o.kind !== 'SYMPTOM' || o.status !== 'PRESENT') continue;
    if (o.attributes.duration === null) out.push({ observationId: o.id, field: 'duration' });
    if (o.attributes.severity === null) out.push({ observationId: o.id, field: 'severity' });
    if (o.attributes.onset === null) out.push({ observationId: o.id, field: 'onset' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- internals
function log(state: ConsultationState, at: string, type: EventType, observationIds: string[], detail?: Record<string, unknown>): ConsultationState {
  const event: ContextEvent = { seq: state.log.length + 1, at, type, observationIds, ...(detail ? { detail } : {}) };
  return { ...state, log: [...state.log, event] };
}

function appendRevision(state: ConsultationState, next: Observation): ConsultationState {
  return { ...state, records: { ...state.records, [next.id]: [...(state.records[next.id] ?? []), next] } };
}

function revise(prev: Observation, changes: Partial<Observation>): Observation {
  return { ...prev, ...changes, revision: prev.revision + 1 };
}

function mergeEvidence(existing: readonly Evidence[], added: readonly Evidence[]): Evidence[] {
  const seen = new Set(existing.map((e) => `${e.utterance_id}:${e.char_start}:${e.char_end}`));
  const out = [...existing];
  for (const e of added) {
    const key = `${e.utterance_id}:${e.char_start}:${e.char_end}`;
    if (!seen.has(key) && out.length < 12) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** New information fills only attributes that were not stated. Anything that would overwrite is ignored and reported. */
export function mergeAttributes(existing: Attributes, patch: Attributes): { merged: Attributes; ignored: string[] } {
  const ignored: string[] = [];
  const pick = <T>(field: string, old: T | null, add: T | null): T | null => {
    if (add === null) return old;
    if (old === null) return add;
    ignored.push(field);
    return old;
  };
  const known = new Set(existing.character_over_time.map((q) => q.phase));
  const merged: Attributes = {
    onset: pick('onset', existing.onset, patch.onset),
    duration: pick('duration', existing.duration, patch.duration),
    severity: pick('severity', existing.severity, patch.severity),
    character_over_time: [...existing.character_over_time, ...patch.character_over_time.filter((q) => !known.has(q.phase))],
    context: [...existing.context, ...patch.context.filter((c) => !existing.context.includes(c))],
  };
  return { merged, ignored };
}

function markUnresolved(state: ConsultationState, id: string, conflictsWith: string[]): ConsultationState {
  const o = current(state, id);
  if (!o) return state;
  const union = [...new Set([...o.conflicts_with, ...conflictsWith])].slice(0, 8);
  if (o.status === 'UNRESOLVED' && union.length === o.conflicts_with.length) return state;
  return appendRevision(state, revise(o, { status: 'UNRESOLVED', conflicts_with: union }));
}

// ---------------------------------------------------------------------------------------------- extraction
function applyProposal(state: ConsultationState, p: Proposal, notes: string[]): ConsultationState {
  switch (p.action) {
    case 'ADD':
    case 'CONTRADICT': {
      const o = p.observation;
      if (!o || state.records[o.id]) return state;
      let next: ConsultationState = { ...state, records: { ...state.records, [o.id]: [o] }, order: [...state.order, o.id] };
      const others = p.action === 'CONTRADICT' && p.target_id ? [p.target_id] : [...o.conflicts_with];
      if (others.length > 0) {
        // directly opposed statements: both are recorded as stated, then both become UNRESOLVED
        next = markUnresolved(next, o.id, others);
        for (const other of others) next = markUnresolved(next, other, [o.id]);
      }
      return next;
    }
    case 'REINFORCE': {
      const t = p.target_id ? current(state, p.target_id) : undefined;
      if (!t) {
        notes.push('IGNORED_UNKNOWN_TARGET');
        return state;
      }
      return appendRevision(state, revise(t, { evidence: mergeEvidence(t.evidence, p.added_evidence) }));
    }
    case 'REFINE': {
      const t = p.target_id ? current(state, p.target_id) : undefined;
      if (!t || !p.attributes_patch) {
        notes.push('IGNORED_UNKNOWN_TARGET');
        return state;
      }
      const { merged, ignored } = mergeAttributes(t.attributes, p.attributes_patch);
      if (ignored.length > 0) notes.push(`REFINE_WOULD_OVERWRITE:${ignored.join(',')}`);
      return appendRevision(state, revise(t, { attributes: merged, evidence: mergeEvidence(t.evidence, p.added_evidence) }));
    }
  }
}

/** Apply a validated extraction response. Idempotent: the same ``extraction_id`` is applied once. */
export function applyExtraction(state: ConsultationState, response: ExtractResponse, at: string): ConsultationState {
  if (state.appliedExtractions.includes(response.extraction_id)) return state;
  const notes: string[] = [];
  let next = state;
  for (const p of response.proposals) next = applyProposal(next, p, notes);

  const heldKey = (h: HeldObservation) => `${h.utterance_id}:${h.symptom ?? h.label}:${h.status}`;
  const known = new Set(next.held.map(heldKey));
  const held = [...next.held, ...response.held_for_review.filter((h) => !known.has(heldKey(h)))];

  next = { ...next, held, appliedExtractions: [...next.appliedExtractions, response.extraction_id] };
  return log(next, at, 'EXTRACTION_APPLIED', response.proposals.flatMap((p) => (p.observation ? [p.observation.id] : p.target_id ? [p.target_id] : [])), {
    extraction_id: response.extraction_id,
    proposals: response.proposals.length,
    held: response.held_for_review.length,
    rejected: response.rejected.length,
    replay: response.extractor.is_replay,
    notes,
  });
}

/** After the doctor assigns a speaker and the utterance is re-extracted, drop the held candidates for it. */
export function clearHeld(state: ConsultationState, utteranceId: string, at: string): ConsultationState {
  if (!state.held.some((h) => h.utterance_id === utteranceId)) return state;
  const next = { ...state, held: state.held.filter((h) => h.utterance_id !== utteranceId) };
  return log(next, at, 'HELD_CLEARED', [], { utterance_id: utteranceId });
}

// ---------------------------------------------------------------------------------------------- doctor actions
const fail = (state: ConsultationState, error: ActionError): ActionResult => ({ state, error });
const ok = (state: ConsultationState): ActionResult => ({ state, error: null });

function actionable(state: ConsultationState, id: string): { o: Observation } | { error: ActionError } {
  const o = current(state, id);
  if (!o) return { error: 'UNKNOWN_OBSERVATION' };
  if (o.review.state === 'REJECTED') return { error: 'ALREADY_REJECTED' };
  return { o };
}

/** The doctor explicitly confirms an observation. This is the ONLY way an observation becomes DOCTOR_CONFIRMED (besides correct/resolve). */
export function confirmObservation(state: ConsultationState, id: string, at: string): ActionResult {
  const a = actionable(state, id);
  if ('error' in a) return fail(state, a.error);
  const o = a.o;
  if (o.kind === 'PATIENT_STATED_CONDITION') return fail(state, 'CONDITION_NOT_CONFIRMABLE');
  if (o.status === 'UNRESOLVED') return fail(state, 'RESOLVE_CONFLICT_FIRST');
  if (o.source === 'DOCTOR_CONFIRMED' && o.review.state === 'CONFIRMED') return ok(state); // idempotent
  const next = appendRevision(state, revise(o, { source: 'DOCTOR_CONFIRMED', review: { state: 'CONFIRMED', at, corrected_fields: [], note: null } }));
  return ok(log(next, at, 'DOCTOR_CONFIRMED', [id]));
}

export interface CorrectionPatch {
  readonly status?: Exclude<Status, 'UNRESOLVED'>;
  /** Fields present here replace the stored value; ``null`` clears a field back to "not stated". */
  readonly attributes?: Partial<Attributes>;
}

/** The doctor corrects an observation. The original revision remains in history. */
export function correctObservation(state: ConsultationState, id: string, patch: CorrectionPatch, at: string): ActionResult {
  const a = actionable(state, id);
  if ('error' in a) return fail(state, a.error);
  const o = a.o;
  if (o.kind === 'PATIENT_STATED_CONDITION') return fail(state, 'CONDITION_NOT_CONFIRMABLE');
  if (o.status === 'UNRESOLVED') return fail(state, 'RESOLVE_CONFLICT_FIRST');

  const parsed = Attributes.safeParse({ ...o.attributes, ...(patch.attributes ?? {}) });
  if (!parsed.success) return fail(state, 'INVALID_PATCH');
  const corrected: string[] = [];
  if (patch.status !== undefined && patch.status !== o.status) corrected.push('status');
  for (const key of Object.keys(parsed.data) as (keyof Attributes)[]) {
    if (JSON.stringify(parsed.data[key]) !== JSON.stringify(o.attributes[key])) corrected.push(key);
  }
  if (corrected.length === 0) return fail(state, 'NO_CHANGE');

  const next = appendRevision(
    state,
    revise(o, {
      status: patch.status ?? o.status,
      attributes: parsed.data,
      source: 'DOCTOR_CONFIRMED',
      review: { state: 'CORRECTED', at, corrected_fields: corrected.slice(0, 8), note: null },
    }),
  );
  return ok(log(next, at, 'DOCTOR_CORRECTED', [id], { fields: corrected }));
}

/** The doctor rejects an observation. It is hidden from the view but kept in history. */
export function rejectObservation(state: ConsultationState, id: string, at: string, note?: string): ActionResult {
  const a = actionable(state, id);
  if ('error' in a) return fail(state, a.error);
  const o = a.o;
  const next = appendRevision(state, revise(o, { review: { state: 'REJECTED', at, corrected_fields: [], note: note?.slice(0, 200) ?? null } }));
  return ok(log(next, at, 'DOCTOR_REJECTED', [id]));
}

/** The doctor resolves a conflict in favour of one observation. The others are rejected with a note; nothing is deleted. */
export function resolveConflict(state: ConsultationState, keepId: string, at: string): ActionResult {
  const a = actionable(state, keepId);
  if ('error' in a) return fail(state, a.error);
  const kept = a.o;
  if (kept.status !== 'UNRESOLVED' || kept.conflicts_with.length === 0) return fail(state, 'NOT_IN_CONFLICT');
  const statedStatus = [...history(state, keepId)].reverse().find((r) => r.status !== 'UNRESOLVED')?.status;
  if (!statedStatus) return fail(state, 'NOT_IN_CONFLICT');

  let next = state;
  const others = kept.conflicts_with.filter((id) => current(next, id)?.review.state !== 'REJECTED');
  for (const id of others) {
    const o = current(next, id);
    if (o) next = appendRevision(next, revise(o, { review: { state: 'REJECTED', at, corrected_fields: [], note: `Superseded: doctor resolved the conflict in favour of ${keepId}` } }));
  }
  next = appendRevision(
    next,
    revise(kept, { status: statedStatus, source: 'DOCTOR_CONFIRMED', conflicts_with: [], review: { state: 'CONFIRMED', at, corrected_fields: [], note: null } }),
  );
  return ok(log(next, at, 'CONFLICT_RESOLVED', [keepId, ...others], { kept: keepId }));
}
