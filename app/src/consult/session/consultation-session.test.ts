import { describe, expect, it } from 'vitest';
import scenHeld from '../../../../contracts/fixtures/scenarios/unattributed-held.response.json';
import scenReassigned from '../../../../contracts/fixtures/scenarios/unattributed-reassigned.response.json';
import { ExtractResponse, type Utterance } from '../contracts/schema.js';
import { visibleObservations } from '../context/context-store.js';
import { ExtractionError } from '../extraction/extraction-client.js';
import { FakeScheduler } from '../testing/fake-scheduler.js';
import { FixtureExtractionClient } from '../testing/fixture-extraction-client.js';
import { syntheticResponses, syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';
import type { ProviderCapabilities, ProviderEvent, ProviderListener, TranscriptionProvider } from '../transcription/transcription-provider.js';
import { ConsultationSession, LIVE_CAPTION_MAX, type SessionOptions } from './consultation-session.js';

const now = () => '2026-11-14T10:00:00.000Z';

function scripted(opts: { client?: Partial<ConstructorParameters<typeof FixtureExtractionClient>[2]>; session?: SessionOptions; speed?: number } = {}) {
  const sched = new FakeScheduler();
  const provider = new ScriptedProvider(syntheticTranscript, sched, { speed: opts.speed });
  const client = new FixtureExtractionClient(syntheticResponses(), sched, opts.client);
  const session = new ConsultationSession({ consultationId: syntheticTranscript.consultation_id, provider, extraction: client, scheduler: sched, now, options: opts.session });
  return { sched, provider, client, session };
}
const symptoms = (s: ConsultationSession) => visibleObservations(s.getSnapshot().context).map((o: any) => `${o.symptom}:${o.status}`).sort();
const batches = (c: FixtureExtractionClient) => c.calls.map((r) => r.utterances.map((u) => u.id).join(','));

/** A provider the test drives by hand, so it can deliver things the script never would (UNATTRIBUTED, duplicates). */
class ManualProvider implements TranscriptionProvider {
  readonly id = 'manual';
  readonly kind = 'SCRIPTED' as const;
  readonly capabilities: ProviderCapabilities = { live: false, partialResults: true, timestamps: 'NONE', speakerAttribution: 'NONE', audioLeavesDevice: false, description: 'manual' };
  private l = new Set<ProviderListener>();
  stopped = false;
  async start() { this.emit({ type: 'started' }); }
  pause() {}
  resume() {}
  stop() { this.stopped = true; }
  subscribe(f: ProviderListener) { this.l.add(f); return () => this.l.delete(f); }
  emit(e: ProviderEvent) { for (const f of this.l) f(e); }
}
const utt = (o: Partial<Utterance> & { id: string }): Utterance => ({ speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: 'I have had chest pain since yesterday.', start_ms: 1000, end_ms: 3500, ...o }) as Utterance;
function manual(responses: Record<string, unknown>) {
  const sched = new FakeScheduler();
  const provider = new ManualProvider();
  const map = new Map(Object.entries(responses).map(([k, v]) => [k, ExtractResponse.parse(v)]));
  const client = new FixtureExtractionClient(map, sched);
  const session = new ConsultationSession({ consultationId: 'c', provider, extraction: client, scheduler: sched, now });
  return { sched, provider, client, session };
}

describe('scripted consultation, end to end through the real machine, client and store', () => {
  it('starts empty: nothing is pre-populated', () => {
    const { session } = scripted();
    const s = session.getSnapshot();
    expect(s.session.lifecycle).toBe('IDLE');
    expect(visibleObservations(s.context)).toHaveLength(0);
    expect(s.utterances).toHaveLength(0);
  });

  it('replays the consultation and builds the four observations batch by batch', async () => {
    const { sched, client, session } = scripted();
    await session.start();
    expect(session.getSnapshot().session.lifecycle).toBe('LISTENING');
    await sched.advance(14000); // after u1 final
    await sched.advance(500);
    expect(symptoms(session)).toEqual(['COUGH:PRESENT', 'FEVER:PRESENT']);
    await sched.runAll();
    await session.whenIdle();
    expect(batches(client)).toEqual(['u1', 'u2,u3', 'u4,u5']);
    expect(symptoms(session)).toEqual(['CHEST_PAIN:ABSENT', 'COUGH:PRESENT', 'DYSPNOEA:PRESENT', 'FEVER:PRESENT']);
    const s = session.getSnapshot();
    expect(s.session.inputExhausted).toBe(true);
    expect(s.utterances.map((u) => u.id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(s.session.extraction).toMatchObject({ inFlight: 0, succeeded: 3, failed: 0 });
    expect(s.failedBatches).toHaveLength(0);
  });

  it('sends only synthetic data, with fresh known observations and context utterances', async () => {
    const { sched, client, session } = scripted();
    await session.start();
    await sched.runAll();
    await session.whenIdle();
    for (const r of client.calls) expect(r.data_classification).toBe('SYNTHETIC');
    expect(client.calls[0]!.known_observations).toHaveLength(0);
    expect(client.calls[1]!.known_observations.length).toBe(2);
    expect(client.calls[1]!.context_utterances.map((u) => u.id)).toEqual(['u1']);
    expect(client.calls[2]!.known_observations.length).toBe(3);
  });

  it('never claims confirmation: everything extracted is unconfirmed', async () => {
    const { sched, session } = scripted();
    await session.start();
    await sched.runAll();
    await session.whenIdle();
    for (const o of visibleObservations(session.getSnapshot().context) as any[]) expect(o.source).not.toBe('DOCTOR_CONFIRMED');
    expect(JSON.stringify(session.getSnapshot().context)).not.toContain('DOCTOR_CONFIRMED');
  });

  it('the live caption never exceeds 60 characters', async () => {
    const { sched, session } = scripted();
    const seen: string[] = [];
    session.subscribe((s) => s.livePartial && seen.push(s.livePartial.text));
    await session.start();
    await sched.runAll();
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen.map((t) => t.length))).toBeLessThanOrEqual(LIVE_CAPTION_MAX);
    expect(session.getSnapshot().livePartial).toBeNull();
  });
});

describe('lifecycle: pause, resume, end', () => {
  it('pausing stops the script, keeps extraction going, and resume completes the same result', async () => {
    const { sched, client, session } = scripted();
    await session.start();
    await sched.advance(13000);
    expect(session.getSnapshot().utterances).toHaveLength(0);
    await sched.advance(900); // u1 final at 13800 -> extraction request in flight (latency 400)
    expect(client.calls).toHaveLength(1);
    session.pause();
    expect(session.getSnapshot().session.lifecycle).toBe('PAUSED');
    expect(session.getSnapshot().session.extraction.inFlight).toBe(1);
    await sched.advance(1000); // extraction completes while paused
    expect(symptoms(session)).toEqual(['COUGH:PRESENT', 'FEVER:PRESENT']);
    await sched.advance(120000);
    expect(session.getSnapshot().utterances.map((u) => u.id)).toEqual(['u1']); // script frozen
    session.resume();
    await sched.runAll();
    await session.whenIdle();
    expect(symptoms(session)).toEqual(['CHEST_PAIN:ABSENT', 'COUGH:PRESENT', 'DYSPNOEA:PRESENT', 'FEVER:PRESENT']);
    expect(session.getSnapshot().transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['IDLE>STARTING', 'STARTING>LISTENING', 'LISTENING>PAUSED', 'PAUSED>LISTENING']);
  });

  it('ending mid-script flushes what was heard and drains extraction', async () => {
    const { sched, provider, client, session } = scripted();
    await session.start();
    await sched.advance(19000); // u1, u2 heard (u2 is doctor, pending)
    session.end();
    expect(session.getSnapshot().session.lifecycle).toBe('ENDED');
    await sched.runAll();
    await session.whenIdle();
    expect(batches(client)).toEqual(['u1', 'u2']);
    expect(session.getSnapshot().utterances.map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(sched.pending).toBe(0); // the provider is stopped, nothing more is scheduled
    expect(provider).toBeDefined();
  });

  it('invalid lifecycle calls return errors and change nothing', async () => {
    const { session } = scripted();
    expect(session.pause().error?.code).toBe('INVALID_TRANSITION');
    expect(session.resume().error).not.toBeNull();
    expect(session.end().error).not.toBeNull();
    await session.start();
    expect((await session.start()).error).not.toBeNull();
    expect(session.resume().error).not.toBeNull();
    session.end();
    expect(session.pause().error).not.toBeNull();
    expect((await session.start()).error).not.toBeNull();
    expect(session.getSnapshot().session.lifecycle).toBe('ENDED');
  });

  it('a provider that cannot start fails the session, which can then be ended', async () => {
    const sched = new FakeScheduler();
    const provider = new ManualProvider();
    provider.start = async () => { throw new Error('no microphone'); };
    const session = new ConsultationSession({ consultationId: 'c', provider, extraction: new FixtureExtractionClient(new Map(), sched), scheduler: sched, now });
    await session.start();
    expect(session.getSnapshot().session.lifecycle).toBe('FAILED');
    expect(session.getSnapshot().session.failure?.reason).toBe('no microphone');
    expect(session.end().error).toBeNull();
  });

  it('a non-fatal provider error pauses; a fatal one fails', async () => {
    const { provider, session } = manual({});
    await session.start();
    provider.emit({ type: 'error', reason: 'network blip', fatal: false });
    expect(session.getSnapshot().session.lifecycle).toBe('PAUSED');
    provider.emit({ type: 'error', reason: 'gone', fatal: true });
    expect(session.getSnapshot().session.lifecycle).toBe('FAILED');
  });

  it('speech region is independent of listening and extraction', async () => {
    const { sched, session } = scripted();
    await session.start();
    expect(session.speechStarted().error).toBeNull();
    session.pause();
    expect(session.getSnapshot().session.speaking).toBe('SPEAKING');
    expect(session.speechInterrupted().error).toBeNull();
    expect(session.speechEnded().error).not.toBeNull();
    expect(session.getSnapshot().session.lifecycle).toBe('PAUSED');
    expect(sched).toBeDefined();
  });
});

describe('idempotence: repeated events never duplicate observations', () => {
  it('duplicate finals create one utterance and one extraction', async () => {
    const { provider, client, sched, session } = manual({ u1: syntheticResponses().get('u1')! });
    await session.start();
    const u1 = syntheticTranscript.batches[0]!.utterances[0] as Utterance;
    provider.emit({ type: 'final', utterance: u1 });
    provider.emit({ type: 'final', utterance: u1 });
    provider.emit({ type: 'final', utterance: { ...u1 } });
    await sched.runAll();
    await session.whenIdle();
    expect(client.calls).toHaveLength(1);
    expect(session.getSnapshot().diagnostics.duplicateUtterancesIgnored).toBe(2);
    expect(symptoms(session)).toEqual(['COUGH:PRESENT', 'FEVER:PRESENT']);
  });

  it('a repeated extraction response is applied once', async () => {
    const same = syntheticResponses().get('u1')!;
    const { provider, sched, session } = manual({ 'u1': same, 'u1b': same });
    await session.start();
    const u1 = syntheticTranscript.batches[0]!.utterances[0] as Utterance;
    provider.emit({ type: 'final', utterance: u1 });
    provider.emit({ type: 'final', utterance: utt({ id: 'u1b', text: u1.text }) });
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().diagnostics.duplicateExtractionsIgnored).toBe(1);
    expect(symptoms(session)).toEqual(['COUGH:PRESENT', 'FEVER:PRESENT']);
    expect(session.getSnapshot().context.appliedExtractions).toEqual([same.extraction_id]);
  });

  it('invalid utterances are ignored, and finals before listening are dropped', async () => {
    const { provider, client, sched, session } = manual({});
    provider.emit({ type: 'final', utterance: utt({ id: 'early' }) });
    await session.start();
    provider.emit({ type: 'final', utterance: { id: '', text: '' } as unknown as Utterance });
    await sched.runAll();
    expect(client.calls).toHaveLength(0);
    expect(session.getSnapshot().utterances).toHaveLength(0);
    expect(session.getSnapshot().diagnostics.invalidUtterancesIgnored).toBe(1);
  });
});

describe('extraction failures', () => {
  it('retries a retriable failure with backoff and ends up with no duplicates', async () => {
    const { sched, client, session } = scripted();
    client.failNext(new ExtractionError('provider_unavailable', 'x', true, 503), new ExtractionError('network_error', 'x', true));
    await session.start();
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().diagnostics.extractionRetries).toBe(2);
    expect(session.getSnapshot().session.extraction.failed).toBe(2);
    expect(batches(client)).toEqual(['u1', 'u1', 'u1', 'u2,u3', 'u4,u5']);
    expect(symptoms(session)).toEqual(['CHEST_PAIN:ABSENT', 'COUGH:PRESENT', 'DYSPNOEA:PRESENT', 'FEVER:PRESENT']);
    expect(session.getSnapshot().failedBatches).toHaveLength(0);
  });

  it('a non-retriable failure is recorded, later batches still run, and retryFailed recovers without duplicates', async () => {
    const { sched, client, session } = scripted();
    client.failNext(new ExtractionError('invalid_response', 'bad', false));
    await session.start();
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().failedBatches).toEqual([{ utteranceIds: ['u1'], error: 'invalid_response' }]);
    expect(symptoms(session)).toEqual(['CHEST_PAIN:ABSENT', 'DYSPNOEA:PRESENT']); // u1 missing, nothing invented
    expect(session.retryFailed()).toBe(1);
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().failedBatches).toHaveLength(0);
    expect(symptoms(session)).toEqual(['CHEST_PAIN:ABSENT', 'COUGH:PRESENT', 'DYSPNOEA:PRESENT', 'FEVER:PRESENT']);
    expect(session.retryFailed()).toBe(0);
  });

  it('exhausting retries fails the batch instead of looping forever', async () => {
    const { sched, client, session } = scripted({ session: { maxAttempts: 2 } });
    client.failNext(...Array.from({ length: 5 }, () => new ExtractionError('provider_unavailable', 'x', true, 503)));
    await session.start();
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().failedBatches[0]!.utteranceIds).toEqual(['u1']);
  });
});

describe('unattributed speech is held until the doctor assigns a speaker', () => {
  it('holds, then re-extracts as a patient claim and clears the held item', async () => {
    const { provider, client, sched, session } = manual({ u11: scenHeld });
    await session.start();
    provider.emit({ type: 'final', utterance: utt({ id: 'u11', speaker: 'UNATTRIBUTED', speaker_basis: 'UNVERIFIED' }) });
    session.end(); // flush
    await sched.runAll();
    await session.whenIdle();
    let s = session.getSnapshot();
    expect(visibleObservations(s.context)).toHaveLength(0);
    expect(s.context.held.map((h) => h.utterance_id)).toEqual(['u11']);

    // the held candidate is not a claim; assigning a speaker (still allowed after the session ended) re-extracts
    client.calls.length = 0;
    (client as any).responses.set('u11', ExtractResponse.parse(scenReassigned));
    expect(session.assignSpeaker('u11', 'PATIENT')).toBeNull();
    await sched.runAll();
    await session.whenIdle();
    s = session.getSnapshot();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.utterances[0]).toMatchObject({ id: 'u11', speaker: 'PATIENT', speaker_basis: 'MANUAL_SELECTION' });
    expect(symptoms(session)).toEqual(['CHEST_PAIN:PRESENT']);
    expect(s.context.held).toHaveLength(0);
  });

  it('assignment is validated', async () => {
    const { provider, session } = manual({});
    expect(session.assignSpeaker('u11', 'PATIENT')).toBe('NOT_ACTIVE');
    await session.start();
    provider.emit({ type: 'final', utterance: utt({ id: 'p1' }) });
    expect(session.assignSpeaker('nope', 'PATIENT')).toBe('UNKNOWN_UTTERANCE');
    expect(session.assignSpeaker('p1', 'PATIENT')).toBe('NOT_UNATTRIBUTED');
    expect(session.assignSpeaker('p1', 'NURSE' as never)).toBe('INVALID_SPEAKER');
  });
});

describe('replay status is unmistakable and never reported as live', () => {
  it('says scripted and replay from the first moment, and replay stays sticky', async () => {
    const { sched, session } = scripted();
    expect(session.getSnapshot().banner.join(' ')).toMatch(/SCRIPTED CONSULTATION/);
    expect(session.getSnapshot().banner.join(' ')).toMatch(/not contacted/i);
    await session.start();
    expect(session.getSnapshot().provenance.extraction.mode).toBe('REPLAY_FIXTURE'); // from the health preflight
    await sched.runAll();
    await session.whenIdle();
    const b = session.getSnapshot().banner.join(' ');
    expect(b).toMatch(/RECORDED REPLAY/);
    expect(b).toMatch(/not from a live model/);
    expect(b).not.toMatch(/LIVE MODEL/);
    expect(session.getSnapshot().provenance.input.kind).toBe('SCRIPTED');
  });

  it('reports a live model only when responses say so, and MIXED when both occur', async () => {
    const live = { ...syntheticResponses().get('u1')!, extraction_id: 'ext_live_1', extractor: { provider: 'gemini', model: 'm', is_replay: false, latency_ms: 5 } };
    const replay = syntheticResponses().get('u2,u3')!;
    const { provider, sched, session } = manual({ p1: live, p2: replay });
    await session.start();
    provider.emit({ type: 'final', utterance: utt({ id: 'p1' }) });
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().provenance.extraction.mode).toBe('LIVE_MODEL');
    expect(session.getSnapshot().banner.join(' ')).toMatch(/LIVE MODEL/);
    provider.emit({ type: 'final', utterance: utt({ id: 'p2' }) });
    await sched.runAll();
    await session.whenIdle();
    expect(session.getSnapshot().provenance.extraction.mode).toBe('MIXED');
    expect(session.getSnapshot().banner.join(' ')).toMatch(/MIXED/);
  });

  it('an unreachable backend is reported as not contacted, never as live', async () => {
    const { sched, session } = scripted({ client: { healthFails: true } });
    await session.start();
    expect(session.getSnapshot().diagnostics.backendReachable).toBe(false);
    expect(session.getSnapshot().provenance.extraction.mode).toBe('NOT_CONTACTED');
    await sched.runAll();
  });
});

describe('doctor actions go through the session', () => {
  it('confirm is explicit; speaking or extraction never confirms', async () => {
    const { sched, session } = scripted();
    await session.start();
    await sched.runAll();
    await session.whenIdle();
    const cough: any = (visibleObservations(session.getSnapshot().context) as any[]).find((o) => o.symptom === 'COUGH');
    expect(cough.source).not.toBe('DOCTOR_CONFIRMED');
    expect(session.confirm(cough.id)).toBeNull();
    const after: any = (visibleObservations(session.getSnapshot().context) as any[]).find((o) => o.symptom === 'COUGH');
    expect(after.source).toBe('DOCTOR_CONFIRMED');
    expect(session.confirm('missing')).toBe('UNKNOWN_OBSERVATION');
  });
});
