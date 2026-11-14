import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_TRANSITIONS, canTransition, createSession, isExtracting, isListening, isSpeaking, transition,
  type Lifecycle, type SessionEvent, type SessionState,
} from './session-machine.js';

const LIFECYCLES: Lifecycle[] = ['IDLE', 'STARTING', 'LISTENING', 'PAUSED', 'ENDED', 'FAILED'];
const ev = (type: SessionEvent['type']): SessionEvent =>
  type === 'PROVIDER_FAILED' ? { type, reason: 'x', fatal: true } : type === 'EXTRACTION_FAILED' ? { type, error: 'e' } : ({ type } as SessionEvent);

/** Drive the machine to a lifecycle through valid events only. */
function at(l: Lifecycle): SessionState {
  let s = createSession();
  const run = (e: SessionEvent) => {
    const r = transition(s, e);
    expect(r.error).toBeNull();
    s = r.state;
  };
  if (l === 'IDLE') return s;
  run({ type: 'START' });
  if (l === 'STARTING') return s;
  if (l === 'FAILED') return run({ type: 'PROVIDER_FAILED', reason: 'boom', fatal: true }), s;
  if (l === 'ENDED') return run({ type: 'END' }), s;
  run({ type: 'PROVIDER_STARTED' });
  if (l === 'PAUSED') run({ type: 'PAUSE' });
  return s;
}

describe('lifecycle transitions', () => {
  it('follows the documented happy path', () => {
    let s = createSession();
    for (const [e, to] of [['START', 'STARTING'], ['PROVIDER_STARTED', 'LISTENING'], ['PAUSE', 'PAUSED'], ['RESUME', 'LISTENING'], ['END', 'ENDED']] as const) {
      s = transition(s, ev(e)).state;
      expect(s.lifecycle).toBe(to);
    }
  });

  it('matches the table exactly for every lifecycle x lifecycle event', () => {
    for (const from of LIFECYCLES) {
      for (const type of ['START', 'PROVIDER_STARTED', 'PAUSE', 'RESUME', 'END'] as const) {
        const r = transition(at(from), ev(type));
        const expected = LIFECYCLE_TRANSITIONS[from][type];
        if (expected) {
          expect(r.error, `${from} ${type}`).toBeNull();
          expect(r.state.lifecycle).toBe(expected);
        } else {
          expect(r.error?.code, `${from} ${type}`).toBe('INVALID_TRANSITION');
          expect(r.state.lifecycle).toBe(from);
        }
      }
    }
  });

  it('provider failure: fatal fails, non-fatal pauses, never from IDLE or ENDED', () => {
    expect(transition(at('LISTENING'), { type: 'PROVIDER_FAILED', reason: 'r', fatal: true }).state.lifecycle).toBe('FAILED');
    const soft = transition(at('LISTENING'), { type: 'PROVIDER_FAILED', reason: 'r', fatal: false }).state;
    expect(soft.lifecycle).toBe('PAUSED');
    expect(soft.failure).toEqual({ reason: 'r', fatal: false });
    expect(transition(at('STARTING'), { type: 'PROVIDER_FAILED', reason: 'r', fatal: false }).state.lifecycle).toBe('FAILED');
    for (const l of ['IDLE', 'ENDED', 'FAILED'] as const) {
      expect(transition(at(l), { type: 'PROVIDER_FAILED', reason: 'r', fatal: true }).error).not.toBeNull();
    }
  });

  it('FAILED can be retried with START, which clears the failure; ENDED is terminal', () => {
    const r = transition(at('FAILED'), { type: 'START' });
    expect(r.state.lifecycle).toBe('STARTING');
    expect(r.state.failure).toBeNull();
    for (const type of ['START', 'PAUSE', 'RESUME', 'PROVIDER_STARTED'] as const) {
      expect(transition(at('ENDED'), ev(type)).error).not.toBeNull();
    }
  });

  it('input exhaustion is valid only while listening or paused', () => {
    for (const l of LIFECYCLES) {
      const r = transition(at(l), { type: 'INPUT_EXHAUSTED' });
      expect(r.error === null).toBe(l === 'LISTENING' || l === 'PAUSED');
    }
    expect(transition(at('LISTENING'), { type: 'INPUT_EXHAUSTED' }).state.inputExhausted).toBe(true);
  });
});

describe('invalid transitions', () => {
  it('return an error, never throw, and leave the state untouched', () => {
    const s = at('IDLE');
    const r = transition(s, { type: 'PAUSE' });
    expect(r.error).toMatchObject({ code: 'INVALID_TRANSITION', from: 'IDLE', event: 'PAUSE' });
    expect(r.state).toBe(s);
    expect(r.changed).toBe(false);
    expect(canTransition(s, { type: 'PAUSE' })).toBe(false);
    expect(canTransition(s, { type: 'START' })).toBe(true);
  });

  it('double start, double pause and resume without pause are rejected', () => {
    expect(transition(at('STARTING'), { type: 'START' }).error).not.toBeNull();
    expect(transition(at('PAUSED'), { type: 'PAUSE' }).error).not.toBeNull();
    expect(transition(at('LISTENING'), { type: 'RESUME' }).error).not.toBeNull();
  });
});

describe('independent regions', () => {
  it('extraction counts in flight and never changes the lifecycle', () => {
    for (const l of ['LISTENING', 'PAUSED', 'ENDED', 'FAILED'] as const) {
      let s = at(l);
      s = transition(s, { type: 'EXTRACTION_STARTED' }).state;
      expect(s.lifecycle).toBe(l);
      expect(isExtracting(s)).toBe(true);
      s = transition(s, { type: 'EXTRACTION_SUCCEEDED' }).state;
      expect(isExtracting(s)).toBe(false);
      expect(s.lifecycle).toBe(l);
    }
    for (const l of ['IDLE', 'STARTING'] as const) expect(transition(at(l), { type: 'EXTRACTION_STARTED' }).error).not.toBeNull();
  });

  it('extraction completion needs a request in flight; failures are recorded', () => {
    expect(transition(at('LISTENING'), { type: 'EXTRACTION_SUCCEEDED' }).error).not.toBeNull();
    expect(transition(at('LISTENING'), { type: 'EXTRACTION_FAILED', error: 'e' }).error).not.toBeNull();
    let s = transition(at('LISTENING'), { type: 'EXTRACTION_STARTED' }).state;
    s = transition(s, { type: 'EXTRACTION_FAILED', error: 'backend_unavailable' }).state;
    expect(s.extraction).toMatchObject({ inFlight: 0, failed: 1, lastError: 'backend_unavailable' });
  });

  it('pausing does not stop extraction and an extraction does not stop pausing', () => {
    let s = transition(at('LISTENING'), { type: 'EXTRACTION_STARTED' }).state;
    s = transition(s, { type: 'PAUSE' }).state;
    expect(s.lifecycle).toBe('PAUSED');
    expect(isExtracting(s)).toBe(true);
    s = transition(s, { type: 'RESUME' }).state;
    s = transition(s, { type: 'END' }).state;
    expect(s.lifecycle).toBe('ENDED');
    expect(isExtracting(s)).toBe(true); // still draining after end
  });

  it('speaking is independent of listening and can be interrupted', () => {
    let s = at('LISTENING');
    s = transition(s, { type: 'SPEECH_STARTED' }).state;
    expect(isSpeaking(s) && isListening(s)).toBe(true);
    s = transition(s, { type: 'PAUSE' }).state;
    expect(isSpeaking(s)).toBe(true);
    s = transition(s, { type: 'SPEECH_INTERRUPTED' }).state;
    expect(isSpeaking(s)).toBe(false);
    expect(s.lifecycle).toBe('PAUSED');
  });

  it('speech events are validated', () => {
    expect(transition(at('IDLE'), { type: 'SPEECH_STARTED' }).error).not.toBeNull();
    expect(transition(at('LISTENING'), { type: 'SPEECH_ENDED' }).error).not.toBeNull();
    expect(transition(at('LISTENING'), { type: 'SPEECH_INTERRUPTED' }).error).not.toBeNull();
    const speaking = transition(at('LISTENING'), { type: 'SPEECH_STARTED' }).state;
    expect(transition(speaking, { type: 'SPEECH_STARTED' }).error).not.toBeNull();
  });
});

describe('purity', () => {
  it('never mutates the previous state', () => {
    const s = at('LISTENING');
    const frozen = JSON.stringify(s);
    Object.freeze(s);
    transition(s, { type: 'PAUSE' });
    transition(s, { type: 'EXTRACTION_STARTED' });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
