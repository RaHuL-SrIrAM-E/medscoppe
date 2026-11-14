/**
 * Runs the scripted consultation against a REAL backend over HTTP. Skipped unless MEDSCOPE_BACKEND_URL is set:
 *   (cd ../backend && .venv/bin/uvicorn app.main:app --port 8000) &
 *   MEDSCOPE_BACKEND_URL=http://127.0.0.1:8000 npx vitest run src/consult/session/session.integration.test.ts
 * With no Gemini credentials the backend answers from its labelled hand-authored replay, and this test asserts that.
 */
import { describe, expect, it } from 'vitest';
import { visibleObservations } from '../context/context-store.js';
import { HttpExtractionClient } from '../extraction/extraction-client.js';
import { realScheduler } from '../core/scheduler.js';
import { syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';
import { ConsultationSession } from './consultation-session.js';

const url = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.MEDSCOPE_BACKEND_URL;

describe.skipIf(!url)('scripted consultation against the real backend', () => {
  it('produces the expected observations and labels the extraction honestly', async () => {
    const session = new ConsultationSession({
      consultationId: syntheticTranscript.consultation_id,
      provider: new ScriptedProvider(syntheticTranscript, realScheduler, { speed: 60, tailMs: 600 }),
      extraction: new HttpExtractionClient({ baseUrl: url! }),
      scheduler: realScheduler,
      now: () => new Date().toISOString(),
    });
    await session.start();
    await new Promise<void>((resolve) => {
      const off = session.subscribe((s) => s.session.inputExhausted && (off(), resolve()));
    });
    await session.whenIdle();
    const s = session.getSnapshot();
    const found = (visibleObservations(s.context) as any[]).map((o) => `${o.symptom}:${o.status}`).sort();
    expect(found).toEqual(['CHEST_PAIN:ABSENT', 'COUGH:PRESENT', 'DYSPNOEA:PRESENT', 'FEVER:PRESENT']);
    expect(s.failedBatches).toHaveLength(0);
    // no credentials in this environment: results must be labelled as replay, never as a live model
    if (s.provenance.extraction.mode === 'REPLAY_FIXTURE') expect(s.banner.join(' ')).toMatch(/RECORDED REPLAY/);
    expect(s.banner.join(' ')).not.toMatch(s.provenance.extraction.mode === 'LIVE_MODEL' ? /RECORDED REPLAY/ : /LIVE MODEL/);
    session.dispose();
  }, 30000);
});
