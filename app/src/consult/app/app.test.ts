import { describe, expect, it } from 'vitest';
import { ExtractResponse } from '../contracts/schema.js';
import type { Intent, IntentSource } from '../../core/intents.js';
import { visibleObservations } from '../context/context-store.js';
import { ExtractionError, type BackendHealth, type ExtractionClient } from '../extraction/extraction-client.js';
import { FakeScheduler } from '../testing/fake-scheduler.js';
import { FixtureExtractionClient } from '../testing/fixture-extraction-client.js';
import { syntheticResponses, syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ManualProvider } from '../testing/manual-provider.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';
import { LABELS } from '../ui/consult-labels.js';
import { ConsultApp, type ExtractionResolution } from './consult-app.js';
import conflictStatus from '../../../../contracts/fixtures/scenarios/conflict-status.response.json';
import patientBelief from '../../../../contracts/fixtures/scenarios/patient-belief.response.json';

const now = () => '2026-11-14T10:00:00.000Z';

interface Rig {
  sched: FakeScheduler;
  app: ConsultApp;
  emitted: Array<{ intent: Intent; source: IntentSource }>;
  client: FixtureExtractionClient;
  send: (intent: Intent, source?: IntentSource) => void;
  run: () => Promise<void>;
}

function rig(opts: { backend?: 'up' | 'down'; responses?: Map<string, ExtractResponse>; tweak?: (c: FixtureExtractionClient) => void; provider?: () => ManualProvider } = {}): Rig {
  const sched = new FakeScheduler();
  const client = new FixtureExtractionClient(opts.responses ?? syntheticResponses(), sched);
  opts.tweak?.(client);
  const emitted: Rig['emitted'] = [];
  const resolution = async (): Promise<ExtractionResolution> =>
    opts.backend === 'down' ? { client, source: 'OFFLINE_FIXTURE', backend: 'UNREACHABLE' } : { client, source: 'BACKEND', backend: 'BACKEND_REPLAY' };
  const app = new ConsultApp({
    consultationId: 'demo',
    scheduler: sched,
    now,
    createProvider: () => (opts.provider ? opts.provider() : new ScriptedProvider(syntheticTranscript, sched)),
    resolveExtraction: resolution,
    emit: (intent, source) => emitted.push({ intent, source }),
  });
  const send = (intent: Intent, source: IntentSource = 'desktop') => app.handle(intent, source);
  return { sched, app, emitted, client, send, run: async () => { await sched.advance(0); await sched.runAll(); } };
}

const labels = (app: ConsultApp) => app.getSnapshot().beads.map((b) => b.label);
const obsByName = (app: ConsultApp, symptom: string) => (visibleObservations(app.getSnapshot().session!.context) as any[]).find((o) => o.symptom === symptom);

describe('consultation controls and lifecycle through intents', () => {
  it('starts READY with nothing in the scene and no session', () => {
    const { app } = rig();
    const s = app.getSnapshot();
    expect(s.controls.lifecycle).toBe('READY');
    expect(s.controls.primary).toEqual({ action: 'START_CONSULTATION', label: 'Start' });
    expect(s.beads).toHaveLength(0);
    expect(s.session).toBeNull();
    expect(s.controls.dataLabel).toBe(LABELS.data);
  });

  it('start, pause, resume and end drive the real session', async () => {
    const { app, send, sched } = rig();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    expect(app.getSnapshot().controls.lifecycle).toBe('LISTENING');
    expect(app.getSnapshot().controls.primary.action).toBe('PAUSE_LISTENING');
    expect(app.getSnapshot().controls.end).toBe(true);

    await sched.advance(5000);
    send({ type: 'PAUSE_LISTENING' });
    expect(app.getSnapshot().controls.lifecycle).toBe('PAUSED');
    expect(app.getSnapshot().controls.primary).toEqual({ action: 'RESUME_LISTENING', label: 'Resume' });
    await sched.advance(60000);
    expect(app.getSnapshot().session!.utterances).toHaveLength(0); // the script is frozen while paused

    send({ type: 'RESUME_LISTENING' });
    expect(app.getSnapshot().controls.lifecycle).toBe('LISTENING');
    send({ type: 'END_CONSULTATION' });
    expect(app.getSnapshot().controls.lifecycle).toBe('ENDED');
    expect(app.getSnapshot().controls.end).toBe(false);
    expect(app.getSnapshot().controls.primary.label).toBe('New session');
  });

  it('invalid and repeated controls are harmless', async () => {
    const { app, send, sched } = rig();
    send({ type: 'PAUSE_LISTENING' }); // no session yet
    send({ type: 'END_CONSULTATION' });
    expect(app.getSnapshot().session).toBeNull();
    send({ type: 'START_CONSULTATION' });
    send({ type: 'START_CONSULTATION' }); // double press while starting
    await sched.advance(0);
    send({ type: 'START_CONSULTATION' }); // press while listening
    expect(app.runCount).toBe(1);
    send({ type: 'RESUME_LISTENING' });
    expect(app.getSnapshot().notice).not.toBeNull();
    expect(app.getSnapshot().controls.lifecycle).toBe('LISTENING');
  });

  it('completes on its own once the script has been delivered and extraction has drained', async () => {
    const { app, send, run } = rig();
    send({ type: 'START_CONSULTATION' });
    await run();
    const s = app.getSnapshot();
    expect(s.controls.lifecycle).toBe('COMPLETE');
    expect(s.controls.lifecycleText).toBe('COMPLETE');
    expect(s.session!.pendingBatches).toBe(0);
  });
});

describe('observations appear progressively from the real store', () => {
  it('none at the start, cough and fever after the first answer, then the rest', async () => {
    const { app, send, sched } = rig();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    expect(labels(app)).toEqual([]);
    await sched.advance(13000);
    expect(labels(app)).toEqual([]); // nothing is invented ahead of the speech
    await sched.advance(1500);
    expect(labels(app).sort()).toEqual(['Cough', 'Fever']);
    await sched.advance(10000);
    expect(labels(app)).toContain('Dyspnoea');
    expect(labels(app)).not.toContain('No chest pain');
    await sched.runAll();
    expect(labels(app).sort()).toEqual(['Cough', 'Dyspnoea', 'Fever', 'No chest pain']);
  });

  it('bead treatments: patient-reported, absent, and systemic versus chest-associated', async () => {
    const { app, send, run } = rig();
    send({ type: 'START_CONSULTATION' });
    await run();
    const byLabel = Object.fromEntries(app.getSnapshot().beads.map((b) => [b.label, b]));
    expect(byLabel['Cough']).toMatchObject({ origin: 'PATIENT', presence: 'PRESENT', anchor: 'CHEST_REGION' });
    expect(byLabel['No chest pain']).toMatchObject({ origin: 'PATIENT', presence: 'ABSENT' });
    expect(byLabel['Fever']!.anchor).toBe('SYSTEMIC'); // no invented anatomical location
  });

  it('nothing is pre-populated: the beads are exactly the store contents', async () => {
    const { app, send, run } = rig();
    send({ type: 'START_CONSULTATION' });
    await run();
    const fromStore = visibleObservations(app.getSnapshot().session!.context).map((o) => o.id);
    expect(app.getSnapshot().beads.map((b) => b.observationId)).toEqual(fromStore);
  });
});

describe('selecting and dismissing observation cards', () => {
  async function ready() {
    const r = rig();
    r.send({ type: 'START_CONSULTATION' });
    await r.run();
    return r;
  }

  it('selecting a bead opens one card with the evidence quote, source and duration', async () => {
    const { app, send, emitted } = await ready();
    const cough = obsByName(app, 'COUGH');
    send({ type: 'SELECT_OBSERVATION', observationId: cough.id }, 'hand');
    const card = app.getSnapshot().card!;
    expect(card.title).toBe('Cough');
    expect(card.sourceLine).toMatch(/patient-reported/);
    expect(card.confirmLine).toBe('Not confirmed by a doctor');
    expect(card.durationLine).toBe('Duration: about five days (approximate)');
    expect(card.evidenceLabel).toBe('Patient said');
    expect(card.evidenceQuote).toContain("I've been coughing for about five days");
    expect(card.placementNote).toMatch(/orientation only/);
    expect(emitted.map((e) => e.intent.type)).toContain('CLEAR_SELECTION'); // closes the anatomy card
  });

  it('there is only ever one card: selecting another replaces it, selecting again closes it', async () => {
    const { app, send } = await ready();
    const [cough, fever] = [obsByName(app, 'COUGH'), obsByName(app, 'FEVER')];
    send({ type: 'SELECT_OBSERVATION', observationId: cough.id });
    send({ type: 'SELECT_OBSERVATION', observationId: fever.id });
    expect(app.getSnapshot().card!.title).toBe('Fever');
    expect(app.getSnapshot().card!.placementNote).toMatch(/Not tied to an anatomical location/);
    send({ type: 'SELECT_OBSERVATION', observationId: fever.id });
    expect(app.getSnapshot().card).toBeNull();
  });

  it('dismiss with CLEAR_OBSERVATION_SELECTION, or by selecting an anatomical structure', async () => {
    const { app, send } = await ready();
    const cough = obsByName(app, 'COUGH');
    send({ type: 'SELECT_OBSERVATION', observationId: cough.id });
    send({ type: 'CLEAR_OBSERVATION_SELECTION' });
    expect(app.getSnapshot().card).toBeNull();
    send({ type: 'SELECT_OBSERVATION', observationId: cough.id });
    send({ type: 'SELECT_STRUCTURE', structureId: 'respiratory.airway.trachea' }, 'hand');
    expect(app.getSnapshot().card).toBeNull();
  });

  it('unknown observation ids are ignored', async () => {
    const { app, send } = await ready();
    send({ type: 'SELECT_OBSERVATION', observationId: 'nope' });
    expect(app.getSnapshot().selectedObservationId).toBeNull();
  });
});

describe('explicit doctor review', () => {
  async function ready(extra?: Parameters<typeof rig>[0]) {
    const r = rig(extra);
    r.send({ type: 'START_CONSULTATION' });
    await r.run();
    return r;
  }

  it('nothing is confirmed by extraction, replay or selection', async () => {
    const { app, send } = await ready();
    send({ type: 'SELECT_OBSERVATION', observationId: obsByName(app, 'COUGH').id });
    for (const o of visibleObservations(app.getSnapshot().session!.context)) expect(o.source).not.toBe('DOCTOR_CONFIRMED');
    expect(JSON.stringify(app.getSnapshot().session!.context)).not.toContain('DOCTOR_CONFIRMED');
    expect(app.getSnapshot().beads.every((b) => b.origin !== 'DOCTOR_CONFIRMED')).toBe(true);
  });

  it('confirm works only from an explicit hand or desktop press', async () => {
    const { app, send } = await ready();
    const id = obsByName(app, 'COUGH').id;
    for (const source of ['voice', 'script'] as const) {
      send({ type: 'CONFIRM_OBSERVATION', observationId: id }, source);
      expect(obsByName(app, 'COUGH').source).toBe('PATIENT_REPORTED');
      expect(app.getSnapshot().notice).toMatch(/explicit press/);
    }
    send({ type: 'SELECT_OBSERVATION', observationId: id }, 'hand');
    send({ type: 'CONFIRM_OBSERVATION', observationId: id }, 'hand');
    expect(obsByName(app, 'COUGH').source).toBe('DOCTOR_CONFIRMED');
    expect(app.getSnapshot().beads.find((b) => b.observationId === id)!.origin).toBe('DOCTOR_CONFIRMED');
    expect(app.getSnapshot().card).toMatchObject({ confirmed: true, confirmLine: 'Confirmed by a doctor (explicit action)', actions: { confirm: false } });
  });

  it('confirming one observation never confirms another', async () => {
    const { app, send } = await ready();
    send({ type: 'CONFIRM_OBSERVATION', observationId: obsByName(app, 'COUGH').id }, 'desktop');
    expect(obsByName(app, 'FEVER').source).toBe('PATIENT_REPORTED');
    expect(obsByName(app, 'DYSPNOEA').source).toBe('PATIENT_REPORTED');
  });

  it('dismissing removes the bead and closes its card, keeping history in the store', async () => {
    const { app, send } = await ready();
    const id = obsByName(app, 'FEVER').id;
    send({ type: 'SELECT_OBSERVATION', observationId: id });
    send({ type: 'REJECT_OBSERVATION', observationId: id }, 'hand');
    expect(labels(app)).not.toContain('Fever');
    expect(app.getSnapshot().card).toBeNull();
    expect(app.getSnapshot().session!.context.records[id]!.length).toBeGreaterThan(1);
  });

  it('a patient-stated condition has no confirm action, and the store refuses it anyway', async () => {
    const manual = new ManualProvider();
    const { app, send, sched } = rig({ provider: () => manual, responses: new Map([['u12', ExtractResponse.parse(patientBelief)]]) });
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    manual.say({ id: 'u12', text: 'I think I have pneumonia.' });
    await sched.runAll();
    const bead = app.getSnapshot().beads[0]!;
    expect(bead).toMatchObject({ label: 'Pneumonia (patient says)', presence: 'MENTIONED', isCondition: true, origin: 'PATIENT' });
    send({ type: 'SELECT_OBSERVATION', observationId: bead.observationId }, 'hand');
    const card = app.getSnapshot().card!;
    expect(card.actions.confirm).toBe(false);
    expect(card.actions.resolve).toBe(false);
    expect(card.notice).toMatch(/not a diagnosis and cannot be confirmed/);
    send({ type: 'CONFIRM_OBSERVATION', observationId: bead.observationId }, 'hand'); // even if sent anyway
    expect(app.getSnapshot().notice).toMatch(/cannot be confirmed/);
    expect(app.getSnapshot().beads[0]!.origin).toBe('PATIENT');
    expect(JSON.stringify(app.getSnapshot().session!.context)).not.toContain('DOCTOR_CONFIRMED');
    send({ type: 'RESOLVE_CONFLICT', observationId: bead.observationId }, 'hand');
    expect(app.getSnapshot().beads[0]!.origin).toBe('PATIENT');
  });
});

describe('conflicting and unresolved observations', () => {
  const conflictResponse = () => {
    const raw = JSON.parse(JSON.stringify(conflictStatus).split('obs_known1').join('obs_syn_001'));
    return ExtractResponse.parse(raw);
  };
  async function conflicted() {
    const manual = new ManualProvider();
    const responses = syntheticResponses();
    responses.set('u7', conflictResponse());
    const r = rig({ provider: () => manual, responses });
    r.send({ type: 'START_CONSULTATION' });
    await r.sched.advance(0);
    manual.say({ ...(syntheticTranscript.batches[0]!.utterances[0] as object), id: 'u1' } as never);
    await r.sched.runAll();
    manual.say({ id: 'u7', text: "Actually, I don't have a cough." });
    await r.sched.runAll();
    return r;
  }

  it('shows the conflicting pair as unresolved beads', async () => {
    const { app } = await conflicted();
    const unresolved = app.getSnapshot().beads.filter((b) => b.presence === 'UNRESOLVED');
    expect(unresolved).toHaveLength(2);
    expect(unresolved.every((b) => b.label === 'Cough: conflict')).toBe(true);
  });

  it('the card offers resolve and dismiss but never confirm, and confirm is refused', async () => {
    const { app, send } = await conflicted();
    const id = app.getSnapshot().beads.find((b) => b.presence === 'UNRESOLVED')!.observationId;
    send({ type: 'SELECT_OBSERVATION', observationId: id });
    const card = app.getSnapshot().card!;
    expect(card.presenceLine).toMatch(/Unresolved/);
    expect(card.actions).toMatchObject({ confirm: false, resolve: true, reject: true });
    expect(card.notice).toMatch(/Choose which/);
    send({ type: 'CONFIRM_OBSERVATION', observationId: id }, 'hand');
    expect(app.getSnapshot().notice).toMatch(/Resolve the conflict first/);
    expect(app.getSnapshot().beads.find((b) => b.observationId === id)!.presence).toBe('UNRESOLVED');
  });

  it('resolving keeps one, dismisses the other, and is the explicit doctor action', async () => {
    const { app, send } = await conflicted();
    const keep = app.getSnapshot().beads.find((b) => b.presence === 'UNRESOLVED')!.observationId;
    send({ type: 'RESOLVE_CONFLICT', observationId: keep }, 'voice');
    expect(app.getSnapshot().beads.filter((b) => b.presence === 'UNRESOLVED')).toHaveLength(2); // refused: not explicit
    send({ type: 'RESOLVE_CONFLICT', observationId: keep }, 'desktop');
    const after = app.getSnapshot().beads;
    expect(after.filter((b) => b.presence === 'UNRESOLVED')).toHaveLength(0);
    expect(after.filter((b) => b.observationId === keep)[0]!.origin).toBe('DOCTOR_CONFIRMED');
    expect(after.filter((b) => b.label.toLowerCase().includes('cough'))).toHaveLength(1);
  });
});

describe('repeated cycles and duplicate events', () => {
  it('start, end and start again creates a fresh session with no leftover beads', async () => {
    const { app, send, run } = rig();
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.getSnapshot().beads).toHaveLength(4);
    send({ type: 'SELECT_OBSERVATION', observationId: app.getSnapshot().beads[0]!.observationId });
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.runCount).toBe(2);
    expect(app.getSnapshot().beads).toHaveLength(4); // the full replay again, not 8
    expect(app.getSnapshot().session!.context.consultationId).toBe('demo-run2');
    expect(app.getSnapshot().selectedObservationId).toBeNull();
    expect(app.getSnapshot().controls.lifecycle).toBe('COMPLETE');
  });

  it('ending mid-run then starting again does not leak the old run into the new one', async () => {
    const { app, send, sched, run } = rig();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(20000);
    send({ type: 'END_CONSULTATION' });
    await sched.runAll();
    const first = app.getSnapshot().beads.length;
    expect(first).toBeGreaterThan(0);
    expect(app.getSnapshot().controls.lifecycle).toBe('ENDED'); // ended early: not COMPLETE
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.getSnapshot().beads).toHaveLength(4);
  });

  it('duplicate extraction responses and utterances never create a second bead', async () => {
    const manual = new ManualProvider();
    const { app, send, sched } = rig({ provider: () => manual });
    send({ type: 'START_CONSULTATION' });
    await sched.advance(0);
    const u1 = syntheticTranscript.batches[0]!.utterances[0] as never;
    manual.emit({ type: 'final', utterance: u1 });
    manual.emit({ type: 'final', utterance: u1 });
    await sched.runAll();
    expect(app.getSnapshot().beads.map((b) => b.label).sort()).toEqual(['Cough', 'Fever']);
    expect(app.getSnapshot().session!.diagnostics.duplicateUtterancesIgnored).toBe(1);
  });
});

describe('backend unavailable and extraction failure', () => {
  it('falls back to the labelled offline replay and never presents it as live', async () => {
    const { app, send, run } = rig({ backend: 'down' });
    expect(app.getSnapshot().controls.extractionLabel).toBe(LABELS.checking);
    await app.prepare();
    expect(app.getSnapshot().controls.extractionLabel).toBe(LABELS.replay);
    expect(app.getSnapshot().controls.extractionDetail).toMatch(/Backend unreachable/);
    send({ type: 'START_CONSULTATION' });
    await run();
    const c = app.getSnapshot().controls;
    expect(c.extractionLabel).toBe(LABELS.replay);
    expect(c.extractionLabel).not.toMatch(/LIVE MODEL/);
    expect(app.getSnapshot().extractionSource).toBe('OFFLINE_FIXTURE');
    expect(app.getSnapshot().beads).toHaveLength(4);
  });

  it('a reachable replay backend is labelled as replay, not live', async () => {
    const { app, send, run } = rig();
    await app.prepare();
    expect(app.getSnapshot().controls.extractionLabel).toBe(LABELS.replay);
    expect(app.getSnapshot().controls.extractionDetail).toMatch(/backend replay/);
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.getSnapshot().controls.extractionLabel).toBe(LABELS.replay);
  });

  it('an extraction failure is reported honestly, adds nothing for that part, and can be retried', async () => {
    const { app, send, run, client, sched } = rig({ tweak: (c) => c.failNext(new ExtractionError('invalid_response', 'bad', false)) });
    send({ type: 'START_CONSULTATION' });
    await run();
    let c = app.getSnapshot().controls;
    expect(c.retry).toBe(true);
    expect(c.errorLine).toMatch(/Extraction failed for 1 part/);
    expect(app.getSnapshot().beads.map((b) => b.label).sort()).toEqual(['Dyspnoea', 'No chest pain']); // nothing invented for the failed part
    send({ type: 'RETRY_EXTRACTION' });
    await sched.runAll();
    c = app.getSnapshot().controls;
    expect(c.retry).toBe(false);
    expect(c.errorLine).toBeNull();
    expect(app.getSnapshot().beads).toHaveLength(4);
    expect(client.calls.length).toBeGreaterThan(3);
  });

  it('a backend that goes down mid-run shows the failure and is never relabelled live', async () => {
    const down = new ExtractionError('network_error', 'x', true);
    const { app, send, run } = rig({ tweak: (c) => c.failNext(down, down, down, down, down, down, down, down, down) });
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.getSnapshot().controls.errorLine).toMatch(/Extraction failed/);
    expect(app.getSnapshot().controls.extractionLabel).not.toMatch(/LIVE MODEL/);
    expect(app.getSnapshot().controls.extractionIsReplay).toBe(true);
  });

  it('a live-model backend is labelled live only because the responses say so', async () => {
    const live: Record<string, ExtractResponse> = {};
    for (const [k, v] of syntheticResponses()) live[k] = { ...v, extractor: { ...v.extractor, provider: 'gemini', model: 'm', is_replay: false } };
    const { app, send, run } = rig({ responses: new Map(Object.entries(live)) });
    send({ type: 'START_CONSULTATION' });
    await run();
    expect(app.getSnapshot().controls.extractionLabel).toMatch(/^LIVE MODEL RESPONSE/);
    expect(app.getSnapshot().controls.extractionIsReplay).toBe(false);
  });
});

describe('the fixed labels', () => {
  it('say exactly what the product owner specified', () => {
    expect(LABELS.data).toBe('SCRIPTED CONSULTATION \u2014 SYNTHETIC DATA');
    expect(LABELS.replay).toBe('RECORDED REPLAY \u2014 NOT A LIVE GEMINI RESPONSE');
  });
  it('stay visible in every lifecycle state', async () => {
    const { app, send, sched } = rig();
    const seen = new Set<string>();
    app.subscribe((s) => { seen.add(s.controls.dataLabel); seen.add(s.controls.extractionLabel); });
    await app.prepare();
    send({ type: 'START_CONSULTATION' });
    await sched.advance(5000);
    send({ type: 'PAUSE_LISTENING' });
    send({ type: 'END_CONSULTATION' });
    expect([...seen].some((l) => /LIVE MODEL/.test(l))).toBe(false);
    expect(app.getSnapshot().controls.dataLabel).toBe(LABELS.data);
  });
});
