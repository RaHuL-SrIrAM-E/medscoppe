/**
 * Wires the ConsultApp to the real application: real timers, the synthetic scripted consultation, the backend when it
 * is reachable and the labelled offline recorded replay when it is not, and the shared intent bus.
 *
 * Non-secret configuration only: the backend URL (`VITE_API_BASE_URL`, default http://localhost:8000). Optional URL
 * parameters for demos and tests: `?consultSpeed=N` (script speed, default 1) and `?consultBackend=off` to force the
 * offline replay. No credential ever appears in the frontend.
 */
import { intentBus } from '../../core/intents.js';
import { realScheduler } from '../core/scheduler.js';
import { HttpExtractionClient } from '../extraction/extraction-client.js';
import { FixtureExtractionClient } from '../testing/fixture-extraction-client.js';
import { syntheticResponses, syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';
import { ConsultApp, type ExtractionResolution } from './consult-app.js';

const PROBE_TIMEOUT_MS = 2000;

function params(): URLSearchParams {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    return new URLSearchParams();
  }
}

export function createConsultRuntime(): ConsultApp {
  const q = params();
  const speed = Math.min(60, Math.max(0.25, Number(q.get('consultSpeed')) || 1));
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const baseUrl = env?.VITE_API_BASE_URL ?? 'http://localhost:8000';
  const forceOffline = q.get('consultBackend') === 'off';

  const resolveExtraction = async (): Promise<ExtractionResolution> => {
    if (!forceOffline) {
      try {
        const health = await new HttpExtractionClient({ baseUrl, timeoutMs: PROBE_TIMEOUT_MS }).health();
        return { client: new HttpExtractionClient({ baseUrl }), source: 'BACKEND', backend: health.extraction_is_replay ? 'BACKEND_REPLAY' : 'BACKEND_LIVE' };
      } catch {
        /* fall through to the offline replay */
      }
    }
    return {
      client: new FixtureExtractionClient(syntheticResponses(), realScheduler, { latencyMs: 500 / speed }),
      source: 'OFFLINE_FIXTURE',
      backend: 'UNREACHABLE',
    };
  };

  const app = new ConsultApp({
    consultationId: syntheticTranscript.consultation_id,
    scheduler: realScheduler,
    now: () => new Date().toISOString(),
    createProvider: () => new ScriptedProvider(syntheticTranscript, realScheduler, { speed, tailMs: 800 }),
    resolveExtraction,
    emit: (intent, source) => intentBus.emit(intent, source),
  });
  intentBus.subscribe(({ intent, source }) => app.handle(intent, source));
  void app.prepare();
  return app;
}
