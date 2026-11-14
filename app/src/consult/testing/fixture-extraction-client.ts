/**
 * Test and offline double for the extraction API. It answers with recorded responses keyed by the batch's utterance ids,
 * after a scheduler delay. It is an ExtractionClient only so the session can be tested without a server. Everything it
 * returns is labelled as replay by the response itself (extractor.is_replay), which the session surfaces in its banner.
 */
import type { ExtractRequest, ExtractResponse } from '../contracts/schema.js';
import type { Scheduler } from '../core/scheduler.js';
import { ExtractionError, type BackendHealth, type ExtractionClient } from '../extraction/extraction-client.js';

export interface FixtureClientOptions {
  readonly latencyMs?: number;
  readonly health?: Partial<BackendHealth>;
  readonly healthFails?: boolean;
}

export const batchKey = (ids: readonly string[]): string => ids.join(',');

export class FixtureExtractionClient implements ExtractionClient {
  readonly calls: ExtractRequest[] = [];
  private readonly failures: ExtractionError[] = [];
  private readonly latency: number;

  constructor(
    private readonly responses: ReadonlyMap<string, ExtractResponse>,
    private readonly scheduler: Scheduler,
    private readonly options: FixtureClientOptions = {},
  ) {
    this.latency = options.latencyMs ?? 400;
  }

  /** The next extract() calls fail with these errors, in order, before answering normally. */
  failNext(...errors: ExtractionError[]): void {
    this.failures.push(...errors);
  }

  async health(): Promise<BackendHealth> {
    if (this.options.healthFails) throw new ExtractionError('network_error', 'unreachable', true);
    return {
      status: 'ok',
      gemini_configured: false,
      extraction_provider: 'replay',
      extraction_is_replay: true,
      schema_version: '1.0',
      ...this.options.health,
    };
  }

  extract(request: ExtractRequest): Promise<ExtractResponse> {
    this.calls.push(request);
    return new Promise((resolve, reject) => {
      this.scheduler.schedule(this.latency, () => {
        const failure = this.failures.shift();
        if (failure) return reject(failure);
        const response = this.responses.get(batchKey(request.utterances.map((u) => u.id)));
        if (!response) return reject(new ExtractionError('no_fixture', 'No recorded response for this batch.', false));
        resolve(response);
      });
    });
  }
}
