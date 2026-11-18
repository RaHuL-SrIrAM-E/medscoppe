/**
 * Wires the ConsultApp to the real application: real timers, the synthetic scripted consultation, the backend when it
 * is configured and reachable and the labelled offline recorded replay otherwise, and the shared intent bus.
 *
 * Non-secret configuration only. The backend is OPT-IN: set `VITE_API_BASE_URL`, or pass `?consultBackend=on`
 * (http://localhost:8000) or `?consultBackend=<url>`. Without that the app makes no network request at all and
 * runs the offline recorded replay, so a missing backend produces no failed requests and no console noise.
 * Other URL parameters: `?consultSpeed=N` (default 1), `?consultFixture=failure|conflict|belief` (controlled test scenarios,
 * always labelled on the controls) and `?consultDebug=1` (exposes a read-only state summary for browser tests).
 * No credential ever appears in the frontend.
 */
import { intentBus } from '../../core/intents.js';
import { realScheduler } from '../core/scheduler.js';
import { HttpExtractionClient } from '../extraction/extraction-client.js';
import { FixtureExtractionClient } from '../testing/fixture-extraction-client.js';
import { applyFailure, beliefResponses, beliefTranscript, conflictResponses, conflictTranscript, isScenario } from '../testing/scenario-fixtures.js';
import { syntheticResponses, syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';
import { ConsultApp, type ExtractionResolution } from './consult-app.js';

const PROBE_TIMEOUT_MS = 2000;
const DEFAULT_BACKEND = 'http://localhost:8000';

function params(): URLSearchParams {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    return new URLSearchParams();
  }
}

/** The backend URL to use, or null when none is configured. */
export function configuredBackend(search: URLSearchParams, envUrl: string | undefined): string | null {
  const p = search.get('consultBackend');
  if (p === 'off') return null;
  if (p === 'on') return envUrl || DEFAULT_BACKEND;
  if (p && /^https?:\/\//.test(p)) return p;
  return envUrl || null;
}

export function createConsultRuntime(): ConsultApp {
  const q = params();
  const speed = Math.min(60, Math.max(0.25, Number(q.get('consultSpeed')) || 1));
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const baseUrl = configuredBackend(q, env?.VITE_API_BASE_URL);
  const scenarioParam = q.get('consultFixture');
  const scenario = isScenario(scenarioParam) ? scenarioParam : null;

  const offlineClient = (): FixtureExtractionClient => {
    const client = new FixtureExtractionClient(scenario === 'conflict' ? conflictResponses() : scenario === 'belief' ? beliefResponses() : syntheticResponses(), realScheduler, { latencyMs: 500 / speed });
    if (scenario === 'failure') applyFailure(client);
    return client;
  };

  const resolveExtraction = async (): Promise<ExtractionResolution> => {
    // a controlled test scenario never talks to a backend
    if (baseUrl && !scenario) {
      try {
        const health = await new HttpExtractionClient({ baseUrl, timeoutMs: PROBE_TIMEOUT_MS }).health();
        return { client: new HttpExtractionClient({ baseUrl }), source: 'BACKEND', backend: health.extraction_is_replay ? 'BACKEND_REPLAY' : 'BACKEND_LIVE' };
      } catch {
        return { client: offlineClient(), source: 'OFFLINE_FIXTURE', backend: 'UNREACHABLE' };
      }
    }
    return { client: offlineClient(), source: 'OFFLINE_FIXTURE', backend: 'NOT_CONFIGURED' };
  };

  const transcript = scenario === 'conflict' ? conflictTranscript() : scenario === 'belief' ? beliefTranscript() : syntheticTranscript;
  const app = new ConsultApp({
    consultationId: transcript.consultation_id,
    scheduler: realScheduler,
    now: () => new Date().toISOString(),
    createProvider: () => new ScriptedProvider(transcript, realScheduler, { speed, tailMs: 800 }),
    resolveExtraction,
    emit: (intent, source) => intentBus.emit(intent, source),
    testFixture: scenario,
  });
  intentBus.subscribe(({ intent, source }) => app.handle(intent, source));
  void app.prepare();

  if (q.get('consultDebug') === '1') {
    (globalThis as Record<string, unknown>).__medscopeConsult = () => {
      const s = app.getSnapshot();
      return {
        life: s.controls.lifecycle,
        beads: s.beads.map((b) => ({ id: b.observationId, label: b.label, origin: b.origin, presence: b.presence })),
        selected: s.selectedObservationId,
        card: s.card ? { title: s.card.title, confirmLine: s.card.confirmLine, source: s.card.sourceLine, evidence: s.card.evidenceQuote, duration: s.card.durationLine, panel: s.card.panel, options: s.card.options.map((o) => o.label), note: s.card.noteLine, revision: s.card.revisionLine } : null,
        extractionLabel: s.controls.extractionLabel,
        extractionDetail: s.controls.extractionDetail,
        fixture: s.controls.fixtureLine,
        caption: s.controls.caption,
        captionFading: s.controls.captionFading,
        error: s.controls.errorLine,
        retry: s.controls.retry,
        source: s.extractionSource,
      };
    };
  }
  return app;
}
