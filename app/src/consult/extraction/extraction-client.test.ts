import { describe, expect, it } from 'vitest';
import type { ExtractRequest } from '../contracts/schema.js';
import { syntheticResponses } from '../testing/synthetic-fixtures.js';
import { ExtractionError, HttpExtractionClient } from './extraction-client.js';

const request: ExtractRequest = {
  schema_version: '1.0',
  consultation_id: 'c',
  data_classification: 'SYNTHETIC',
  utterances: [{ id: 'u1', speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: 'I have a cough.', start_ms: 0, end_ms: 1000 }],
  context_utterances: [],
  known_observations: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const client = (fetchImpl: typeof fetch, timeoutMs?: number) => new HttpExtractionClient({ baseUrl: 'http://x/', fetch: fetchImpl, timeoutMs });
const fails = async (p: Promise<unknown>): Promise<ExtractionError> => {
  try { await p; } catch (e) { return e as ExtractionError; }
  throw new Error('expected failure');
};

describe('HttpExtractionClient', () => {
  it('posts the validated request and returns the parsed response', async () => {
    let seen: { url: string; body: any } | null = null;
    const res = syntheticResponses().get('u1')!;
    const c = client(async (url, init) => { seen = { url: String(url), body: JSON.parse(String(init?.body)) }; return json(res); });
    const out = await c.extract(request);
    expect(out.extraction_id).toBe(res.extraction_id);
    expect(seen!.url).toBe('http://x/v1/consultation/extract');
    expect(seen!.body.data_classification).toBe('SYNTHETIC');
  });

  it('refuses to send a request that does not match the contract', async () => {
    let called = false;
    const c = client(async () => { called = true; return json({}); });
    const e = await fails(c.extract({ ...request, utterances: [] }));
    expect(e.code).toBe('invalid_request');
    expect(e.retriable).toBe(false);
    expect(called).toBe(false);
  });

  it('maps coded API errors with their retriable flag', async () => {
    for (const [status, code, retriable] of [[503, 'provider_unavailable', true], [502, 'provider_output_invalid', true], [403, 'real_data_refused', false], [422, 'invalid_request', false]] as const) {
      const e = await fails(client(async () => json({ code, message: 'm', retriable }, status)).extract(request));
      expect(e).toMatchObject({ code, retriable, status });
    }
  });

  it('maps uncoded HTTP failures and network errors', async () => {
    expect(await fails(client(async () => new Response('oops', { status: 500 })).extract(request))).toMatchObject({ code: 'http_500', retriable: true });
    expect(await fails(client(async () => new Response('no', { status: 404 })).extract(request))).toMatchObject({ code: 'http_404', retriable: false });
    expect(await fails(client(async () => { throw new TypeError('fetch failed'); }).extract(request))).toMatchObject({ code: 'network_error', retriable: true });
  });

  it('times out', async () => {
    const hang: typeof fetch = (_u, init) => new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' }))));
    expect(await fails(client(hang, 20).extract(request))).toMatchObject({ code: 'client_timeout', retriable: true });
  });

  it('discards a response that does not match the contract', async () => {
    const e = await fails(client(async () => json({ extraction_id: 'x' })).extract(request));
    expect(e).toMatchObject({ code: 'invalid_response', retriable: false });
  });

  it('reads health and rejects a malformed health body', async () => {
    const ok = { status: 'ok', gemini_configured: false, extraction_provider: 'replay', extraction_is_replay: true, schema_version: '1.0' };
    expect((await client(async () => json(ok)).health()).extraction_is_replay).toBe(true);
    expect(await fails(client(async () => json({ status: 'ok' })).health())).toMatchObject({ code: 'invalid_response' });
  });
});
