import { describe, expect, it } from 'vitest';
import { ExtractResponse } from '../contracts/schema.js';
import { applyExtraction, confirmObservation, createConsultation, visibleObservations } from '../context/context-store.js';
import { LABELS, toUiText } from './consult-labels.js';
import { beadLabel, deriveBeads, deriveCard, deriveControls, observationName } from './consult-view-model.js';
import { syntheticResponses } from '../testing/synthetic-fixtures.js';
import patientBelief from '../../../../contracts/fixtures/scenarios/patient-belief.response.json';

const at = '2026-11-14T10:00:00.000Z';
const full = () => {
  let s = createConsultation('c');
  for (const r of syntheticResponses().values()) s = applyExtraction(s, r, at);
  return s;
};

describe('labels', () => {
  it('use the specified wording', () => {
    expect(LABELS.data).toBe('SCRIPTED CONSULTATION — SYNTHETIC DATA');
    expect(LABELS.replay).toBe('RECORDED REPLAY — NOT A LIVE GEMINI RESPONSE');
  });
  it('are painted without the em dash, which the UI font cannot draw', () => {
    expect(toUiText(LABELS.data)).toBe('SCRIPTED CONSULTATION - SYNTHETIC DATA');
    expect(toUiText(LABELS.replay)).not.toContain('—');
    expect(toUiText(LABELS.replay)).toBe('RECORDED REPLAY - NOT A LIVE GEMINI RESPONSE');
  });
});

describe('beads', () => {
  it('one per visible observation, in arrival order, with honest anchors', () => {
    const beads = deriveBeads(full());
    expect(beads.map((b) => b.label)).toEqual(['Cough', 'Fever', 'Dyspnoea', 'No chest pain']);
    expect(beads.map((b) => b.anchor)).toEqual(['CHEST_REGION', 'SYSTEMIC', 'CHEST_REGION', 'CHEST_REGION']);
    expect(beads.every((b) => b.origin === 'PATIENT')).toBe(true);
    expect(deriveBeads(createConsultation('c'))).toEqual([]);
  });

  it('names carry the status in words so colour is never the only cue', () => {
    const [cough, , , noPain] = visibleObservations(full());
    expect(beadLabel(cough!)).toBe('Cough');
    expect(beadLabel(noPain!)).toBe('No chest pain');
    expect(observationName(noPain!)).toBe('Chest pain');
  });

  it('an explicit confirmation changes the origin, and only for that observation', () => {
    let s = full();
    const id = visibleObservations(s)[0]!.id;
    s = confirmObservation(s, id, at).state;
    const beads = deriveBeads(s);
    expect(beads.map((b) => b.origin)).toEqual(['DOCTOR_CONFIRMED', 'PATIENT', 'PATIENT', 'PATIENT']);
  });

  it('a patient-stated condition is labelled as the patient\'s statement and never as a finding', () => {
    const s = applyExtraction(createConsultation('c'), ExtractResponse.parse(patientBelief), at);
    const [bead] = deriveBeads(s);
    expect(bead).toMatchObject({ label: 'Pneumonia (patient says)', presence: 'MENTIONED', isCondition: true, anchor: 'SYSTEMIC' });
  });
});

describe('card', () => {
  it('is null without a selection or for an unknown id', () => {
    expect(deriveCard(full(), [], null)).toBeNull();
    expect(deriveCard(full(), [], 'nope')).toBeNull();
  });

  it('shows name, status, source, duration and the exact quote; never claims confirmation', () => {
    const s = full();
    const card = deriveCard(s, [{ id: 'u1', speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: 'x' }], visibleObservations(s)[0]!.id)!;
    expect(card).toMatchObject({
      title: 'Cough',
      presenceLine: 'Reported present',
      sourceLine: 'Source: patient-reported',
      confirmed: false,
      confirmLine: 'Not confirmed by a doctor',
      durationLine: 'Duration: about five days (approximate)',
      evidenceLabel: 'Patient said',
    });
    expect(card.evidenceQuote).toBe('"I\'ve been coughing for about five days"');
    expect(card.actions).toEqual({ confirm: true, reject: true, resolve: false });
  });

  it('a confirmed observation no longer offers Confirm and says it was an explicit action', () => {
    let s = full();
    const id = visibleObservations(s)[0]!.id;
    s = confirmObservation(s, id, at).state;
    const card = deriveCard(s, [], id)!;
    expect(card).toMatchObject({ confirmed: true, confirmLine: 'Confirmed by a doctor (explicit action)', sourceLine: 'Source: doctor-confirmed' });
    expect(card.actions.confirm).toBe(false);
  });

  it('a patient-stated condition offers no confirm and no resolve, and says it is not a diagnosis', () => {
    const s = applyExtraction(createConsultation('c'), ExtractResponse.parse(patientBelief), at);
    const card = deriveCard(s, [], visibleObservations(s)[0]!.id)!;
    expect(card.actions).toEqual({ confirm: false, reject: true, resolve: false });
    expect(card.notice).toMatch(/not a diagnosis/);
    expect(card.presenceLine).toBe('Mentioned by the patient');
  });

  it('systemic observations are not given an anatomical location', () => {
    const s = full();
    const fever = visibleObservations(s).find((o) => o.symptom === 'FEVER')!;
    expect(deriveCard(s, [], fever.id)!.placementNote).toMatch(/Not tied to an anatomical location/);
  });
});

describe('controls', () => {
  const none = { state: 'UNKNOWN' as const };
  it('before any session: READY, Start, both labels, no end button', () => {
    const c = deriveControls(null, none, null);
    expect(c).toMatchObject({ lifecycle: 'READY', primary: { action: 'START_CONSULTATION', label: 'Start' }, end: false, retry: false, dataLabel: LABELS.data });
    expect(c.extractionLabel).toBe(LABELS.checking);
  });
  it('never says live before anything proved it', () => {
    for (const state of ['UNKNOWN', 'UNREACHABLE', 'BACKEND_REPLAY'] as const) {
      expect(deriveControls(null, { state }, null).extractionLabel).not.toMatch(/LIVE MODEL/);
    }
    expect(deriveControls(null, { state: 'UNREACHABLE' }, null).extractionLabel).toBe(LABELS.replay);
    expect(deriveControls(null, { state: 'UNREACHABLE' }, null).extractionDetail).toMatch(/offline recorded replay/);
  });
});
