import { afterEach, describe, expect, it, vi } from 'vitest';
import patientBelief from '../../../../contracts/fixtures/scenarios/patient-belief.response.json';
import type { Intent, IntentSource } from '../../core/intents.js';
import { ExtractResponse } from '../contracts/schema.js';
import { history, visibleObservations } from '../context/context-store.js';
import { FakeScheduler } from '../testing/fake-scheduler.js';
import { FixtureExtractionClient } from '../testing/fixture-extraction-client.js';
import { ManualProvider } from '../testing/manual-provider.js';
import { applyFailure, conflictResponses, conflictTranscript } from '../testing/scenario-fixtures.js';
import { syntheticResponses, syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';
import { LABELS } from '../ui/consult-labels.js';
import { CAPTION_CLEAR_AFTER_MS, CAPTION_FADE_AFTER_MS, CAPTION_MAX_CHARS, ConsultApp } from './consult-app.js';
import { configuredBackend, createConsultRuntime } from './consult-runtime.js';

const now = () => '2026-11-15T10:00:00.000Z';

function rig(opts: { transcript?: typeof syntheticTranscript; responses?: Map<string, ExtractResponse>; fail?: boolean; provider?: () => ManualProvider } = {}) {
  const sched = new FakeScheduler();
  const client = new FixtureExtractionClient(opts.responses ?? syntheticResponses(), sched);
  if (opts.fail) applyFailure(client);
  const app = new ConsultApp({
    consultationId: 'demo',
    scheduler: sched,
    now,
    createProvider: () => (opts.provider ? opts.provider() : new ScriptedProvider(opts.transcript ?? syntheticTranscript, sched)),
    resolveExtraction: async () => ({ client, source: 'OFFLINE_FIXTURE', backend: 'NOT_CONFIGURED' }),
    emit: () => undefined,
  });
  const send = (i: Intent, s: IntentSource = 'desktop') => app.handle(i, s);
  const run = async () => { await sched.advance(0); await sched.runAll(); };
  return { sched, client, app, send, run };
}
const obs = (app: ConsultApp, symptom: string) => (visibleObservations(app.getSnapshot().session!.context) as any[]).find((o) => o.symptom === symptom);
async function withCough() {
  const r = rig();
  r.send({ type: 'START_CONSULTATION' });
  await r.run();
  const id = obs(r.app, 'COUGH').id as string;
  r.send({ type: 'SELECT_OBSERVATION', observationId: id });
  return { ...r, id };
}

describe('correction and annotation', () => {
  it('offers present/absent and severity options only through the open Correct row', async () => {
    const { app, send } = await withCough();
    expect(app.getSnapshot().card!.options).toEqual([]);
    send({ type: 'SET_REVIEW_PANEL', panel: 'CORRECT' });
    expect(app.getSnapshot().card!.options.map((o) => o.label)).toEqual(['Mark absent', 'Severity: Mild', 'Severity: Moderate', 'Severity: Severe']);
    send({ type: 'SET_REVIEW_PANEL', panel: 'CORRECT' }); // pressing again closes it
    expect(app.getSnapshot().card!.options).toEqual([]);
  });

  it('marks present observation absent: new revision, explicit action, original quote and history kept', async () => {
    const { app, send, id } = await withCough();
    send({ type: 'CORRECT_OBSERVATION', observationId: id, status: 'ABSENT' }, 'hand');
    const o = obs(app, 'COUGH');
    expect(o).toMatchObject({ status: 'ABSENT', source: 'DOCTOR_CONFIRMED', revision: 2 });
    expect(o.review).toMatchObject({ state: 'CORRECTED', corrected_fields: ['status'] });
    const revs = history(app.getSnapshot().session!.context, id);
    expect(revs.map((r) => r.status)).toEqual(['PRESENT', 'ABSENT']);
    expect(revs[0]!.source).toBe('PATIENT_REPORTED');
    expect(revs[1]!.evidence[0]!.quote).toBe(revs[0]!.evidence[0]!.quote);
    const card = app.getSnapshot().card!;
    expect(card.confirmLine).toBe('Corrected by a doctor (explicit action)');
    expect(card.revisionLine).toMatch(/Revision 2.*kept/);
    expect(card.evidenceQuote).toContain("I've been coughing for about five days");
    expect(app.getSnapshot().beads.find((b) => b.observationId === id)).toMatchObject({ presence: 'ABSENT', origin: 'DOCTOR_CONFIRMED' });
  });

  it('sets severity, which is shown and does not remove the duration', async () => {
    const { app, send, id } = await withCough();
    send({ type: 'CORRECT_OBSERVATION', observationId: id, severity: 'MODERATE' }, 'desktop');
    expect(obs(app, 'COUGH').attributes).toMatchObject({ severity: 'MODERATE', duration: { value: 5 } });
    expect(app.getSnapshot().card).toMatchObject({ severityLine: 'Severity: Moderate', durationLine: 'Duration: about five days (approximate)' });
    expect(app.getSnapshot().card!.panel).toBeNull(); // the option row closes after an action
  });

  it('presets annotate without changing status, source or evidence', async () => {
    const { app, send, id } = await withCough();
    send({ type: 'SET_REVIEW_PANEL', panel: 'NOTE' });
    expect(app.getSnapshot().card!.options.map((o) => o.label)).toEqual(['Needs follow-up', 'Patient unsure', 'Clarified with patient']);
    send({ type: 'ANNOTATE_OBSERVATION', observationId: id, note: 'Patient unsure' }, 'hand');
    expect(obs(app, 'COUGH')).toMatchObject({ status: 'PRESENT', source: 'PATIENT_REPORTED' });
    expect(app.getSnapshot().card!.noteLine).toBe("Doctor's note: Patient unsure");
    expect(app.getSnapshot().card!.confirmLine).toBe('Not confirmed by a doctor'); // a note is not a confirmation
    expect(history(app.getSnapshot().session!.context, id)).toHaveLength(2);
  });

  it('refuses correction and annotation from voice or script sources', async () => {
    const { app, send, id } = await withCough();
    for (const source of ['voice', 'script'] as const) {
      send({ type: 'CORRECT_OBSERVATION', observationId: id, status: 'ABSENT' }, source);
      send({ type: 'ANNOTATE_OBSERVATION', observationId: id, note: 'Needs follow-up' }, source);
    }
    expect(history(app.getSnapshot().session!.context, id)).toHaveLength(1);
    expect(app.getSnapshot().notice).toMatch(/explicit press/);
  });

  it('a patient-stated condition: no correction, annotation allowed, never a diagnosis', async () => {
    const manual = new ManualProvider();
    const r = rig({ provider: () => manual, responses: new Map([['u12', ExtractResponse.parse(patientBelief)]]) });
    r.send({ type: 'START_CONSULTATION' });
    await r.sched.advance(0);
    manual.say({ id: 'u12', text: 'I think I have pneumonia.' });
    await r.sched.runAll();
    const id = r.app.getSnapshot().beads[0]!.observationId;
    r.send({ type: 'SELECT_OBSERVATION', observationId: id });
    r.send({ type: 'SET_REVIEW_PANEL', panel: 'CORRECT' });
    expect(r.app.getSnapshot().card).toMatchObject({ panel: null, options: [], actions: { correct: false, confirm: false } });
    r.send({ type: 'CORRECT_OBSERVATION', observationId: id, status: 'PRESENT' }, 'hand');
    expect(r.app.getSnapshot().notice).toMatch(/cannot be confirmed/);
    r.send({ type: 'ANNOTATE_OBSERVATION', observationId: id, note: 'Needs follow-up' }, 'hand');
    expect(r.app.getSnapshot().card!.noteLine).toBe("Doctor's note: Needs follow-up");
    expect(r.app.getSnapshot().beads[0]).toMatchObject({ origin: 'PATIENT', presence: 'MENTIONED', isCondition: true });
    expect(JSON.stringify(r.app.getSnapshot().session!.context)).not.toContain('DOCTOR_CONFIRMED');
  });

  it('changing the selection closes the review row', async () => {
    const { app, send } = await withCough();
    send({ type: 'SET_REVIEW_PANEL', panel: 'NOTE' });
    send({ type: 'SELECT_OBSERVATION', observationId: obs(app, 'FEVER').id });
    expect(app.getSnapshot().card!.panel).toBeNull();
  });
});

describe('one-line caption', () => {
  const captionAt = (app: ConsultApp) => ({ text: app.getSnapshot().controls.caption, fading: app.getSnapshot().controls.captionFading });

  it('holds a finished line, dims it, then clears it (no later speech in the way)', async () => {
    const manual = new ManualProvider();
    const { app, send, sched } = rig({ provider: () => manual });
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    manual.say({ id: 'u1', text: 'I have had a cough for five days.' });
    expect(captionAt(app)).toEqual({ text: 'Patient: I have had a cough for five days.', fading: false });
    await sched.advance(CAPTION_FADE_AFTER_MS - 100);
    expect(captionAt(app).fading).toBe(false);
    await sched.advance(200);
    expect(captionAt(app)).toMatchObject({ fading: true });
    expect(captionAt(app).text).not.toBeNull();
    await sched.advance(CAPTION_CLEAR_AFTER_MS - CAPTION_FADE_AFTER_MS);
    expect(captionAt(app).text).toBeNull();
  });

  it('never exceeds 60 characters across the whole scripted replay', async () => {
    const { app, send, sched } = rig();
    const seen: string[] = [];
    app.subscribe((s) => s.controls.caption && seen.push(s.controls.caption));
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    await sched.runAll();
    expect(seen.length).toBeGreaterThan(5);
    expect(Math.max(...seen.map((t) => t.length))).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
  });

  it('shows the end of a long utterance, with the speaker, in 60 characters', async () => {
    const { app, send, sched } = rig();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    await sched.advance(13800);
    const text = app.getSnapshot().controls.caption!;
    expect(text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(text.endsWith('fever for the last two days.')).toBe(true);
  });

  it('a new utterance replaces the line and restarts the hold', async () => {
    const { app, send, sched } = rig();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    await sched.advance(13800 + 1600); // u1 dimmed
    expect(captionAt(app).fading).toBe(true);
    await sched.advance(15200 + 20 - 15400 + 0); // no-op guard
    await sched.advance(18400 - 15400 + 50); // u2 final (doctor)
    expect(captionAt(app)).toMatchObject({ fading: false });
    expect(captionAt(app).text).toMatch(/^Doctor: /);
  });

  it('clears when a new session starts', async () => {
    const { app, send, sched, run } = rig();
    send({ type: 'START_CONSULTATION' });
    await run();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    expect(captionAt(app).text).toBeNull();
  });
});

describe('backend probing is opt-in', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves the configuration', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(configuredBackend(q(''), undefined)).toBeNull();
    expect(configuredBackend(q('consultBackend=on'), undefined)).toBe('http://localhost:8000');
    expect(configuredBackend(q('consultBackend=http://127.0.0.1:9000'), undefined)).toBe('http://127.0.0.1:9000');
    expect(configuredBackend(q('consultBackend=off'), 'http://x')).toBeNull();
    expect(configuredBackend(q(''), 'https://api.example')).toBe('https://api.example');
    expect(configuredBackend(q('consultBackend=javascript:alert(1)'), undefined)).toBeNull();
  });

  it('makes no network request at all when no backend is configured, and labels the offline replay', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('location', { search: '' });
    const app = createConsultRuntime();
    await app.prepare();
    expect(fetchSpy).not.toHaveBeenCalled();
    const c = app.getSnapshot().controls;
    expect(c.extractionLabel).toBe(LABELS.replay);
    expect(c.extractionDetail).toBe('Offline recorded replay. No backend configured.');
    app.dispose();
  });

  it('probes only when asked, and falls back to the labelled offline replay when unreachable', async () => {
    const fetchSpy = vi.fn(async (_url: string) => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('location', { search: '?consultBackend=http://127.0.0.1:9' });
    const app = createConsultRuntime();
    await app.prepare();
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://127.0.0.1:9/health');
    expect(app.getSnapshot().controls.extractionLabel).toBe(LABELS.replay);
    expect(app.getSnapshot().controls.extractionDetail).toMatch(/Backend unreachable/);
    app.dispose();
  });

  it('a controlled test fixture never contacts a backend, even if one is configured', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('location', { search: '?consultBackend=on&consultFixture=failure' });
    const app = createConsultRuntime();
    await app.prepare();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(app.getSnapshot().controls.fixtureLine).toBe('TEST FIXTURE: failure');
    app.dispose();
  });
});

describe('test fixtures', () => {
  it('failure: the first part fails, nothing is invented, Retry recovers without duplicates', async () => {
    const { app, send, run, sched } = rig({ fail: true });
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.getSnapshot().controls).toMatchObject({ retry: true });
    expect(app.getSnapshot().controls.errorLine).toMatch(/Extraction failed for 1 part/);
    expect(app.getSnapshot().beads.map((b) => b.label).sort()).toEqual(['Dyspnoea', 'No chest pain']);
    send({ type: 'RETRY_EXTRACTION' });
    await sched.runAll();
    expect(app.getSnapshot().controls).toMatchObject({ retry: false, errorLine: null });
    expect(app.getSnapshot().beads.map((b) => b.label).sort()).toEqual(['Cough', 'Dyspnoea', 'Fever', 'No chest pain']);
  });

  it('conflict: the contradiction leaves cough unresolved, with resolve but no confirm; resolving is explicit', async () => {
    const { app, send, run } = rig({ transcript: conflictTranscript(), responses: conflictResponses() });
    send({ type: 'START_CONSULTATION' });
    await run();
    const unresolved = app.getSnapshot().beads.filter((b) => b.presence === 'UNRESOLVED');
    expect(unresolved).toHaveLength(2);
    expect(unresolved.every((b) => b.label === 'Cough: conflict')).toBe(true);
    expect(app.getSnapshot().controls.extractionLabel).toBe(LABELS.replay); // fixture responses are replay, never live
    const keep = unresolved[0]!.observationId;
    send({ type: 'SELECT_OBSERVATION', observationId: keep });
    expect(app.getSnapshot().card!.actions).toMatchObject({ confirm: false, correct: false, resolve: true });
    send({ type: 'RESOLVE_CONFLICT', observationId: keep }, 'script');
    expect(app.getSnapshot().beads.filter((b) => b.presence === 'UNRESOLVED')).toHaveLength(2);
    send({ type: 'RESOLVE_CONFLICT', observationId: keep }, 'hand');
    expect(app.getSnapshot().beads.filter((b) => b.presence === 'UNRESOLVED')).toHaveLength(0);
    expect(app.getSnapshot().beads.filter((b) => b.label.toLowerCase().includes('cough'))).toHaveLength(1);
  });
});
