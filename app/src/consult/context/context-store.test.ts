import { describe, expect, it } from 'vitest';
import {
  annotateObservation, applyExtraction, clearHeld, confirmObservation, correctObservation, createConsultation, current, gaps, history,
  knownRefs, mergeAttributes, rejectObservation, resolveConflict, visibleObservations, type ConsultationState,
} from './context-store.js';
import { Attributes, ExtractResponse, Observation, ObservationRef } from '../contracts/schema.js';
import r1 from '../../../../contracts/fixtures/synthetic-respiratory/response-1.json';
import r2 from '../../../../contracts/fixtures/synthetic-respiratory/response-2.json';
import r3 from '../../../../contracts/fixtures/synthetic-respiratory/response-3.json';

const scen = import.meta.glob('../../../../contracts/fixtures/scenarios/*.response.json', { eager: true, import: 'default' }) as Record<string, any>;
const scenarioResponse = (name: string) => ExtractResponse.parse(scen[`../../../../contracts/fixtures/scenarios/${name}.response.json`]);

const lastEvent = (s: ConsultationState) => s.log[s.log.length - 1]!;
const AT = '2026-11-15T10:00:00Z';
const LATER = '2026-11-15T10:05:00Z';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

const emptyAttrs = (): Attributes => Attributes.parse({});

/** A one-observation response, used to put a known observation into the store before a scenario is applied. */
function seeded(id: string, symptom: string, status: string, attrs: Partial<Attributes> = {}): ConsultationState {
  const response = ExtractResponse.parse({
    extraction_id: `seed_${id}`, schema_version: '1.0', held_for_review: [], rejected: [], warnings: [],
    extractor: { provider: 'fixture', model: 'static', is_replay: false, latency_ms: 0 },
    proposals: [{
      action: 'ADD', target_id: null, attributes_patch: null, added_evidence: [],
      observation: {
        id, kind: 'SYMPTOM', symptom, label: null, status, source: 'PATIENT_REPORTED', originated_as: 'PATIENT_REPORTED', confidence: 'HIGH',
        attributes: { ...emptyAttrs(), ...attrs },
        evidence: [{ utterance_id: 'u0', role: 'STATEMENT', quote: 'I have a cough', char_start: 0, char_end: 14 }],
        revision: 1, conflicts_with: [], review: { state: 'UNREVIEWED', at: null, corrected_fields: [], note: null },
        extractor: { provider: 'fixture', model: 'static', is_replay: false, schema_version: '1.0' }, created_at: AT,
      },
    }],
  });
  return applyExtraction(createConsultation('c1'), response, AT);
}

function assertEveryRevisionIsValid(state: ConsultationState) {
  for (const id of state.order) for (const rev of history(state, id)) expect(Observation.safeParse(rev).success).toBe(true);
}

const synthetic = (): ConsultationState => {
  let s = createConsultation('demo-resp-001');
  for (const r of [r1, r2, r3]) s = applyExtraction(s, ExtractResponse.parse(r), AT);
  return s;
};

describe('the synthetic respiratory consultation builds the expected context', () => {
  it('holds four patient-reported observations with provenance', () => {
    const s = synthetic();
    const obs = visibleObservations(s);
    expect(obs.map((o) => [o.symptom, o.status, o.source])).toEqual([
      ['COUGH', 'PRESENT', 'PATIENT_REPORTED'],
      ['FEVER', 'PRESENT', 'PATIENT_REPORTED'],
      ['DYSPNOEA', 'PRESENT', 'PATIENT_REPORTED'],
      ['CHEST_PAIN', 'ABSENT', 'PATIENT_REPORTED'],
    ]);
    expect(obs.every((o) => o.review.state === 'UNREVIEWED' && o.evidence.length >= 1)).toBe(true);
    expect(obs.every((o) => o.extractor.is_replay)).toBe(true); // the replay label travels with every observation
    assertEveryRevisionIsValid(s);
  });

  it('never contains a doctor-confirmed observation until the doctor confirms one', () => {
    const s = synthetic();
    expect(visibleObservations(s).some((o) => o.source === 'DOCTOR_CONFIRMED')).toBe(false);
  });

  it('applying the same extraction twice changes nothing', () => {
    const s = synthetic();
    expect(applyExtraction(s, ExtractResponse.parse(r1), LATER)).toBe(s);
  });

  it('derives what is not yet stated, without inventing it', () => {
    const g = gaps(synthetic());
    const cough = visibleObservations(synthetic())[0]!.id;
    expect(g.filter((x) => x.observationId === cough).map((x) => x.field).sort()).toEqual(['onset', 'severity']);
    expect(g.some((x) => x.observationId === cough && x.field === 'duration')).toBe(false);
  });

  it('exposes known observations for the next extraction request, in the contract shape', () => {
    for (const ref of knownRefs(synthetic())) expect(ObservationRef.safeParse(ref).success).toBe(true);
    expect(knownRefs(synthetic())).toHaveLength(4);
  });

  it('does not mutate its inputs', () => {
    let s = deepFreeze(createConsultation('c1'));
    for (const r of [r1, r2, r3]) s = deepFreeze(applyExtraction(s, deepFreeze(ExtractResponse.parse(JSON.parse(JSON.stringify(r)))), AT));
    expect(visibleObservations(s)).toHaveLength(4);
  });
});

describe('doctor confirmation is explicit and keeps provenance', () => {
  it('confirm creates a DOCTOR_CONFIRMED revision and remembers who first reported it', () => {
    const s = synthetic();
    const id = visibleObservations(s)[0]!.id;
    const { state, error } = confirmObservation(s, id, LATER);
    expect(error).toBeNull();
    const now = current(state, id)!;
    expect(now).toMatchObject({ source: 'DOCTOR_CONFIRMED', originated_as: 'PATIENT_REPORTED', revision: 2 });
    expect(now.review).toMatchObject({ state: 'CONFIRMED', at: LATER });
    expect(history(state, id)[0]).toMatchObject({ source: 'PATIENT_REPORTED', revision: 1 }); // the original is retained
    expect(history(s, id)).toHaveLength(1); // and the previous state object was not changed
    assertEveryRevisionIsValid(state);
  });

  it('confirming twice does not add a revision', () => {
    const s = synthetic();
    const id = visibleObservations(s)[0]!.id;
    const once = confirmObservation(s, id, LATER).state;
    expect(confirmObservation(once, id, LATER).state).toBe(once);
  });

  it('only confirmation, correction and conflict resolution can produce DOCTOR_CONFIRMED', () => {
    for (const name of Object.keys(scen).map((p) => p.split('/').pop()!.replace('.response.json', ''))) {
      const s = applyExtraction(createConsultation('c'), scenarioResponse(name), AT);
      expect(visibleObservations(s).some((o) => o.source === 'DOCTOR_CONFIRMED'), name).toBe(false);
    }
  });

  it('a doctor-observed finding stays distinct until the doctor confirms it', () => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse('doctor-observed'), AT);
    const o = visibleObservations(s)[0]!;
    expect(o.source).toBe('DOCTOR_OBSERVED');
    const confirmed = current(confirmObservation(s, o.id, LATER).state, o.id)!;
    expect(confirmed).toMatchObject({ source: 'DOCTOR_CONFIRMED', originated_as: 'DOCTOR_OBSERVED' });
  });

  it('a patient-stated condition can be dismissed but never confirmed or corrected', () => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse('patient-belief'), AT);
    const o = visibleObservations(s)[0]!;
    expect(o).toMatchObject({ kind: 'PATIENT_STATED_CONDITION', status: 'UNRESOLVED', source: 'PATIENT_REPORTED' });
    expect(confirmObservation(s, o.id, LATER).error).toBe('CONDITION_NOT_CONFIRMABLE');
    expect(correctObservation(s, o.id, { status: 'PRESENT' }, LATER).error).toBe('CONDITION_NOT_CONFIRMABLE');
    expect(rejectObservation(s, o.id, LATER).error).toBeNull();
  });

  it('reports errors for unknown or already rejected observations instead of throwing', () => {
    const s = synthetic();
    expect(confirmObservation(s, 'nope', LATER).error).toBe('UNKNOWN_OBSERVATION');
    const id = visibleObservations(s)[0]!.id;
    const rejected = rejectObservation(s, id, LATER).state;
    expect(confirmObservation(rejected, id, LATER).error).toBe('ALREADY_REJECTED');
  });
});

describe('review and correction never overwrite silently', () => {
  it('a correction adds a revision, lists the corrected fields, and keeps the original readable', () => {
    const s = synthetic();
    const id = visibleObservations(s)[0]!.id;
    const patch = { attributes: { duration: { value: 7, unit: 'DAYS' as const, approximate: false, text: 'a week' } } };
    const { state, error } = correctObservation(s, id, patch, LATER);
    expect(error).toBeNull();
    const now = current(state, id)!;
    expect(now.attributes.duration).toMatchObject({ value: 7 });
    expect(now).toMatchObject({ source: 'DOCTOR_CONFIRMED', originated_as: 'PATIENT_REPORTED' });
    expect(now.review).toMatchObject({ state: 'CORRECTED', corrected_fields: ['duration'] });
    expect(history(state, id)[0]!.attributes.duration).toMatchObject({ value: 5 }); // the patient's statement is still on record
    assertEveryRevisionIsValid(state);
  });

  it('a doctor can correct a status (for example present to absent)', () => {
    const s = synthetic();
    const fever = visibleObservations(s)[1]!.id;
    const next = correctObservation(s, fever, { status: 'ABSENT' }, LATER).state;
    expect(current(next, fever)).toMatchObject({ status: 'ABSENT', review: { corrected_fields: ['status'] } });
  });

  it('rejects empty and invalid corrections', () => {
    const s = synthetic();
    const id = visibleObservations(s)[0]!.id;
    expect(correctObservation(s, id, {}, LATER).error).toBe('NO_CHANGE');
    expect(correctObservation(s, id, { attributes: { severity: 'EXTREME' as never } }, LATER).error).toBe('INVALID_PATCH');
  });

  it('a rejected observation disappears from the view and from known observations but stays in history', () => {
    const s = synthetic();
    const id = visibleObservations(s)[0]!.id;
    const next = rejectObservation(s, id, LATER, 'Not what the patient said').state;
    expect(visibleObservations(next).map((o) => o.id)).not.toContain(id);
    expect(knownRefs(next).map((r) => r.id)).not.toContain(id);
    expect(history(next, id)).toHaveLength(2);
    expect(current(next, id)!.review).toMatchObject({ state: 'REJECTED', note: 'Not what the patient said' });
  });

  it('every action is recorded in an append-only log', () => {
    let s = synthetic();
    const id = visibleObservations(s)[0]!.id;
    const before = s.log.length;
    s = confirmObservation(s, id, LATER).state;
    s = rejectObservation(s, visibleObservations(s)[1]!.id, LATER).state;
    expect(s.log.slice(before).map((e) => e.type)).toEqual(['DOCTOR_CONFIRMED', 'DOCTOR_REJECTED']);
    expect(s.log.map((e) => e.seq)).toEqual(s.log.map((_, i) => i + 1));
  });
});

describe('refinement, reinforcement and conflicts', () => {
  it('REFINE fills attributes that were not stated and leaves everything else alone', () => {
    const s = applyExtraction(seeded('obs_known1', 'COUGH', 'PRESENT'), scenarioResponse('refine-attributes'), LATER);
    const o = current(s, 'obs_known1')!;
    expect(o.attributes.duration).toMatchObject({ value: 4, unit: 'DAYS' });
    expect(o.attributes.context).toEqual(['NIGHT']);
    expect(o.revision).toBe(2);
    expect(o.evidence.length).toBe(3);
    expect(history(s, 'obs_known1')[0]!.attributes.duration).toBeNull();
  });

  it('a refinement can never overwrite an attribute that already has a value', () => {
    const existing = Attributes.parse({ duration: { value: 5, unit: 'DAYS', approximate: true, text: 'about five days' } });
    const patch = Attributes.parse({ duration: { value: 9, unit: 'DAYS', approximate: false, text: 'nine days' }, severity: 'MILD' });
    const { merged, ignored } = mergeAttributes(existing, patch);
    expect(merged.duration).toMatchObject({ value: 5 });
    expect(merged.severity).toBe('MILD');
    expect(ignored).toEqual(['duration']);
  });

  it('REINFORCE adds evidence without changing the observation', () => {
    const s = applyExtraction(seeded('obs_known1', 'COUGH', 'PRESENT'), scenarioResponse('reinforce-same-fact'), LATER);
    const o = current(s, 'obs_known1')!;
    expect(o.evidence).toHaveLength(2);
    expect(o).toMatchObject({ status: 'PRESENT', revision: 2 });
  });

  it('opposed statements both stay and both become UNRESOLVED; the stated status is kept in history', () => {
    const s = applyExtraction(seeded('obs_known1', 'COUGH', 'PRESENT'), scenarioResponse('conflict-status'), LATER);
    const [a, b] = visibleObservations(s);
    expect([a!.status, b!.status]).toEqual(['UNRESOLVED', 'UNRESOLVED']);
    expect(a!.conflicts_with).toEqual([b!.id]);
    expect(b!.conflicts_with).toEqual([a!.id]);
    expect(history(s, b!.id)[0]!.status).toBe('ABSENT');
    expect(history(s, a!.id)[0]!.status).toBe('PRESENT');
    assertEveryRevisionIsValid(s);
  });

  it('a conflicted observation cannot be confirmed or corrected until the doctor resolves it', () => {
    const s = applyExtraction(seeded('obs_known1', 'COUGH', 'PRESENT'), scenarioResponse('conflict-status'), LATER);
    const [a] = visibleObservations(s);
    expect(confirmObservation(s, a!.id, LATER).error).toBe('RESOLVE_CONFLICT_FIRST');
    expect(correctObservation(s, a!.id, { status: 'PRESENT' }, LATER).error).toBe('RESOLVE_CONFLICT_FIRST');
  });

  it('the doctor resolves a conflict explicitly: one is confirmed, the other rejected, nothing deleted', () => {
    const s = applyExtraction(seeded('obs_known1', 'COUGH', 'PRESENT'), scenarioResponse('conflict-status'), LATER);
    const [a, b] = visibleObservations(s);
    const { state, error } = resolveConflict(s, b!.id, LATER);
    expect(error).toBeNull();
    expect(current(state, b!.id)).toMatchObject({ status: 'ABSENT', source: 'DOCTOR_CONFIRMED', conflicts_with: [] });
    expect(current(state, a!.id)!.review.state).toBe('REJECTED');
    expect(visibleObservations(state).map((o) => o.id)).toEqual([b!.id]);
    expect(history(state, a!.id).length).toBeGreaterThanOrEqual(2);
    expect(lastEvent(state).type).toBe('CONFLICT_RESOLVED');
    expect(resolveConflict(state, b!.id, LATER).error).toBe('NOT_IN_CONFLICT');
  });

  it('a duration disagreement is also an explicit conflict', () => {
    const attrs = { duration: { value: 5, unit: 'DAYS' as const, approximate: true, text: 'about five days' } };
    const s = applyExtraction(seeded('obs_known1', 'COUGH', 'PRESENT', attrs), scenarioResponse('conflict-duration'), LATER);
    expect(visibleObservations(s).map((o) => o.status)).toEqual(['UNRESOLVED', 'UNRESOLVED']);
  });

  it('an unknown target is ignored and reported, not fatal', () => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse('reinforce-same-fact'), LATER);
    expect(visibleObservations(s)).toEqual([]);
    expect((lastEvent(s).detail as any).notes).toContain('IGNORED_UNKNOWN_TARGET');
  });
});

describe('held, rejected and unsupported output', () => {
  it('unattributed speech is held, is not a claim, and clears after speaker review', () => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse('unattributed-held'), AT);
    expect(visibleObservations(s)).toEqual([]);
    expect(s.held).toHaveLength(1);
    expect(s.held[0]).toMatchObject({ symptom: 'CHEST_PAIN', reason: 'UNATTRIBUTED_SPEAKER' });
    expect(clearHeld(s, 'u11', LATER).held).toEqual([]);
  });

  it.each(['fabricated-evidence', 'model-emits-confirmed', 'doctor-restatement-mismatch'])('%s stores nothing', (name) => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse(name), AT);
    expect(visibleObservations(s)).toEqual([]);
    expect(lastEvent(s).detail).toMatchObject({ rejected: 1 });
  });

  it('negative findings are kept as ABSENT with no attributes', () => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse('absent-drops-attributes'), AT);
    const o = visibleObservations(s)[0]!;
    expect(o).toMatchObject({ symptom: 'FEVER', status: 'ABSENT' });
    expect(o.attributes).toEqual(emptyAttrs());
  });
});

describe('approved refinements', () => {
  // ---------------------------------------------------------------- 1. "last two days" is two days
  it('keeps "the last two days" as a two-day duration without adding "about"', () => {
    const obs = visibleObservations(synthetic());
    const fever = obs.find((o) => o.symptom === 'FEVER')!;
    expect(fever.attributes.duration).toEqual({ value: 2, unit: 'DAYS', approximate: false, text: 'the last two days' });
    expect(fever.evidence.map((e) => e.quote.toLowerCase()).join(' ')).not.toContain('about');
    const cough = obs.find((o) => o.symptom === 'COUGH')!;
    expect(cough.attributes.duration!.approximate).toBe(true); // the patient said "about five days"
    const single = applyExtraction(createConsultation('c'), scenarioResponse('last-two-days'), AT);
    expect(visibleObservations(single)[0]!.attributes.duration).toMatchObject({ value: 2, approximate: false });
  });

  // ---------------------------------------------------------------- 2. dose content
  it('keeps an independently supported symptom and drops the dose from the evidence', () => {
    const s = applyExtraction(createConsultation('c'), scenarioResponse('dose-in-quote'), AT);
    const [o] = visibleObservations(s);
    expect(o).toMatchObject({ symptom: 'FEVER', status: 'PRESENT' });
    expect(o!.evidence.map((e) => e.quote)).toEqual(['I have a fever']);
  });

  it('never stores dose text anywhere, and dose-only evidence stores nothing', () => {
    const dose = /\b\d+\s?(mg|mcg|ml)\b|tablet|paracetamol|dose/i;
    for (const name of ['dose-in-quote', 'dose-text', 'dose-only-evidence']) {
      const s = applyExtraction(createConsultation('c'), scenarioResponse(name), AT);
      for (const id of s.order) for (const rev of history(s, id)) {
        expect(JSON.stringify([rev.label, rev.evidence.map((e) => e.quote), rev.attributes.duration?.text]), name).not.toMatch(dose);
      }
    }
    expect(visibleObservations(applyExtraction(createConsultation('c'), scenarioResponse('dose-only-evidence'), AT))).toEqual([]);
  });

  // ---------------------------------------------------------------- 3. patient-stated conditions
  describe('patient-stated conditions', () => {
    const belief = () => {
      const s = applyExtraction(createConsultation('c'), scenarioResponse('patient-belief'), AT);
      return { s, id: visibleObservations(s)[0]!.id };
    };

    it('can be annotated without changing status, source or attributes, and the original stays in history', () => {
      const { s, id } = belief();
      const { state, error } = annotateObservation(s, id, 'Not supported by findings so far', LATER);
      expect(error).toBeNull();
      const now = current(state, id)!;
      expect(now).toMatchObject({ status: 'UNRESOLVED', source: 'PATIENT_REPORTED', kind: 'PATIENT_STATED_CONDITION', revision: 2 });
      expect(now.review.note).toBe('Not supported by findings so far');
      expect(history(state, id)[0]!.review.note).toBeNull();
      expect(lastEvent(state).type).toBe('DOCTOR_ANNOTATED');
      assertEveryRevisionIsValid(state);
    });

    it('can never be promoted: not confirmed, not corrected, even after annotation', () => {
      const { s, id } = belief();
      const annotated = annotateObservation(s, id, 'Doctor note', LATER).state;
      expect(confirmObservation(annotated, id, LATER).error).toBe('CONDITION_NOT_CONFIRMABLE');
      expect(correctObservation(annotated, id, { status: 'PRESENT' }, LATER).error).toBe('CONDITION_NOT_CONFIRMABLE');
      expect(visibleObservations(annotated).some((o) => o.source === 'DOCTOR_CONFIRMED')).toBe(false);
    });

    it('can be dismissed, and dismissal keeps the history', () => {
      const { s, id } = belief();
      const dismissed = rejectObservation(s, id, LATER, 'Dismissed by doctor').state;
      expect(visibleObservations(dismissed)).toEqual([]);
      expect(current(dismissed, id)!.review).toMatchObject({ state: 'REJECTED', note: 'Dismissed by doctor' });
      expect(history(dismissed, id)).toHaveLength(2);
    });

    it('rejects empty or oversized notes and does not add a revision for an unchanged note', () => {
      const { s, id } = belief();
      expect(annotateObservation(s, id, '   ', LATER).error).toBe('INVALID_PATCH');
      expect(annotateObservation(s, id, 'x'.repeat(201), LATER).error).toBe('INVALID_PATCH');
      const once = annotateObservation(s, id, 'same', LATER).state;
      expect(annotateObservation(once, id, 'same', LATER).state).toBe(once);
    });
  });

  // ---------------------------------------------------------------- 4. held, then speaker assignment and re-extraction
  it('holds an unattributed claim, then accepts it after speaker assignment and re-extraction', () => {
    let s = applyExtraction(createConsultation('c'), scenarioResponse('unattributed-held'), AT);
    expect(visibleObservations(s)).toEqual([]);
    expect(s.held).toHaveLength(1);
    const heldQuote = s.held[0]!.evidence[0]!.quote;
    s = applyExtraction(s, scenarioResponse('unattributed-reassigned'), LATER);
    expect(visibleObservations(s).map((o) => [o.symptom, o.source, o.evidence[0]!.quote])).toEqual([['CHEST_PAIN', 'PATIENT_REPORTED', heldQuote]]);
    s = clearHeld(s, 'u11', LATER);
    expect(s.held).toEqual([]);
    expect(visibleObservations(s)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 5. UNKNOWN is revised, not duplicated
  describe('a definite statement after UNKNOWN', () => {
    const withUnknown = () => seeded('obs_known_unk', 'FEVER', 'UNKNOWN');

    it('revises the active observation in place and preserves history', () => {
      const s = applyExtraction(withUnknown(), scenarioResponse('unknown-then-definite'), LATER);
      expect(visibleObservations(s)).toHaveLength(1); // not duplicated
      const now = current(s, 'obs_known_unk')!;
      expect(now).toMatchObject({ status: 'PRESENT', revision: 2, source: 'PATIENT_REPORTED' });
      expect(now.attributes.duration).toMatchObject({ value: 2, unit: 'DAYS' });
      expect(now.evidence).toHaveLength(2);
      expect(history(s, 'obs_known_unk').map((r) => r.status)).toEqual(['UNKNOWN', 'PRESENT']);
      assertEveryRevisionIsValid(s);
    });

    it('can revise to ABSENT', () => {
      const s = applyExtraction(withUnknown(), scenarioResponse('unknown-then-absent'), LATER);
      expect(current(s, 'obs_known_unk')).toMatchObject({ status: 'ABSENT', revision: 2 });
    });

    it('never merges observations from different sources', () => {
      const s = applyExtraction(seeded('obs_known_unk', 'WHEEZE', 'UNKNOWN'), scenarioResponse('unknown-different-source'), LATER);
      expect(visibleObservations(s).map((o) => [o.symptom, o.status, o.source])).toEqual([['WHEEZE', 'UNKNOWN', 'PATIENT_REPORTED'], ['WHEEZE', 'PRESENT', 'DOCTOR_OBSERVED']]);
    });

    it('is idempotent and ignores a revision aimed at an observation that is not UNKNOWN', () => {
      const s = applyExtraction(withUnknown(), scenarioResponse('unknown-then-definite'), LATER);
      expect(applyExtraction(s, scenarioResponse('unknown-then-definite'), LATER)).toBe(s);
      const present = applyExtraction(seeded('obs_known_unk', 'FEVER', 'PRESENT'), scenarioResponse('unknown-then-definite'), LATER);
      expect(current(present, 'obs_known_unk')).toMatchObject({ status: 'PRESENT', revision: 1 });
      expect((lastEvent(present).detail as any).notes).toContain('REVISE_TARGET_NOT_UNKNOWN');
    });
  });

  // ---------------------------------------------------------------- doctor confirmation is never inferred
  it('does not turn a doctor utterance into a confirmation', () => {
    for (const name of ['doctor-observed', 'unknown-different-source', 'model-emits-confirmed']) {
      const s = applyExtraction(createConsultation('c'), scenarioResponse(name), AT);
      expect(visibleObservations(s).some((o) => o.source === 'DOCTOR_CONFIRMED'), name).toBe(false);
    }
  });
});
