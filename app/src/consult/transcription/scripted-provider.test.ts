import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../testing/fake-scheduler.js';
import { syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from './scripted-provider.js';
import type { ProviderEvent } from './transcription-provider.js';

function run(opts = {}) {
  const sched = new FakeScheduler();
  const p = new ScriptedProvider(syntheticTranscript, sched, opts);
  const events: Array<ProviderEvent & { at: number }> = [];
  p.subscribe((e) => events.push({ ...e, at: sched.now() }));
  return { sched, p, events };
}
const finals = (ev: ProviderEvent[]) => ev.filter((e) => e.type === 'final') as Extract<ProviderEvent, { type: 'final' }>[];

describe('ScriptedProvider', () => {
  it('declares itself scripted, not live', () => {
    const { p } = run();
    expect(p.kind).toBe('SCRIPTED');
    expect(p.capabilities.live).toBe(false);
    expect(p.capabilities.audioLeavesDevice).toBe(false);
  });

  it('emits started, then finals at the fixture end times, then exhausted once', async () => {
    const { sched, p, events } = run();
    await p.start();
    await sched.advance(40000);
    expect(events[0]!.type).toBe('started');
    const f = finals(events);
    expect(f.map((e) => e.utterance.id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    for (const e of f) expect(events.find((x) => x === e)!.at).toBe(e.utterance.end_ms);
    expect(events.filter((e) => e.type === 'exhausted')).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe('exhausted');
  });

  it('partials are growing prefixes of the final text, before the final', async () => {
    const { sched, p, events } = run();
    await p.start();
    await sched.advance(40000);
    const partials = events.filter((e) => e.type === 'partial') as Extract<ProviderEvent, { type: 'partial' }>[];
    expect(partials.length).toBeGreaterThan(0);
    for (const e of partials) {
      const u = p.utterances.find((x) => x.id === e.utteranceId)!;
      expect(u.text.startsWith(e.text)).toBe(true);
      expect(e.text.length).toBeLessThan(u.text.length);
    }
  });

  it('pause freezes the script clock and resume continues exactly', async () => {
    const a = run();
    await a.p.start();
    await a.sched.advance(40000);
    const baseline = finals(a.events).map((e) => a.events.find((x) => x === e)!.at);

    const b = run();
    await b.p.start();
    await b.sched.advance(5000);
    b.p.pause();
    const n = b.events.length;
    await b.sched.advance(60000);
    expect(b.events.length).toBe(n); // silent while paused
    b.p.resume();
    await b.sched.advance(40000);
    const shifted = finals(b.events).map((e) => b.events.find((x) => x === e)!.at);
    expect(shifted.map((t) => t - 60000)).toEqual(baseline);
  });

  it('stop ends emission permanently; start twice throws', async () => {
    const { sched, p, events } = run();
    await p.start();
    await expect(p.start()).rejects.toThrow();
    await sched.advance(3000);
    p.stop();
    const n = events.length;
    await sched.advance(60000);
    expect(events.length).toBe(n);
    expect(sched.pending).toBe(0);
  });

  it('speed scales time', async () => {
    const { sched, p, events } = run({ speed: 10 });
    await p.start();
    await sched.advance(4000);
    expect(finals(events)).toHaveLength(5);
  });

  it('rejects invalid scripts', () => {
    const sched = new FakeScheduler();
    const bad = (utterances: unknown[]) => () => new ScriptedProvider({ provenance: 'x', consultation_id: 'c', batches: [{ label: 'b', utterances }] }, sched);
    const u = (o: object) => ({ id: 'u1', speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: 'hi', start_ms: 0, end_ms: 100, ...o });
    expect(bad([u({ speaker: 'UNATTRIBUTED' })])).toThrow();
    expect(bad([u({ speaker_basis: 'MANUAL_SELECTION' })])).toThrow();
    expect(bad([u({}), u({})])).toThrow(); // duplicate id
    expect(bad([u({}), u({ id: 'u2', start_ms: 50, end_ms: 200 })])).toThrow(); // overlap
    expect(bad([u({})])).not.toThrow();
  });
});
