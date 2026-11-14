/**
 * Client for the backend extraction API. The backend, not the browser, talks to Gemini: no credential and no model id
 * ever appears here. Requests are validated before they are sent and responses before they are used.
 */
import { ApiError, ExtractRequest, ExtractResponse } from '../contracts/schema.js';

export class ExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface BackendHealth {
  readonly status: string;
  readonly gemini_configured: boolean;
  readonly extraction_provider: 'gemini' | 'replay';
  readonly extraction_is_replay: boolean;
  readonly schema_version: string;
}

export interface ExtractionClient {
  health(): Promise<BackendHealth>;
  extract(request: ExtractRequest): Promise<ExtractResponse>;
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HttpExtractionClient implements ExtractionClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async health(): Promise<BackendHealth> {
    const body = await this.call('/health', { method: 'GET' }, 'health');
    const h = body as Partial<BackendHealth>;
    if (typeof h.extraction_is_replay !== 'boolean' || (h.extraction_provider !== 'gemini' && h.extraction_provider !== 'replay')) {
      throw new ExtractionError('invalid_response', 'The backend health response was not understood.', false);
    }
    return h as BackendHealth;
  }

  async extract(request: ExtractRequest): Promise<ExtractResponse> {
    // Refuse to send anything that does not match the contract. This also keeps non-synthetic data from leaving.
    const checked = ExtractRequest.safeParse(request);
    if (!checked.success) throw new ExtractionError('invalid_request', 'The request did not match the contract and was not sent.', false);
    const body = await this.call('/v1/consultation/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checked.data) }, 'extract');
    const parsed = ExtractResponse.safeParse(body);
    if (!parsed.success) throw new ExtractionError('invalid_response', 'The extraction response did not match the contract and was discarded.', false);
    return parsed.data;
  }

  private async call(path: string, init: RequestInit, what: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (e) {
      const aborted = (e as { name?: string } | null)?.name === 'AbortError';
      throw new ExtractionError(aborted ? 'client_timeout' : 'network_error', aborted ? `The ${what} request timed out.` : `The backend could not be reached for ${what}.`, true);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      /* not JSON */
    }
    if (response.ok) {
      if (json === null) throw new ExtractionError('invalid_response', 'The backend returned an empty response.', false, response.status);
      return json;
    }
    const err = ApiError.safeParse(json);
    if (err.success) throw new ExtractionError(err.data.code, err.data.message, err.data.retriable, response.status);
    throw new ExtractionError(`http_${response.status}`, `The backend returned HTTP ${response.status}.`, response.status >= 500, response.status);
  }
}

/** Base URL comes from non-secret configuration only. */
export function createExtractionClient(baseUrl?: string): ExtractionClient {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return new HttpExtractionClient({ baseUrl: baseUrl ?? env?.VITE_API_BASE_URL ?? 'http://localhost:8000' });
}
