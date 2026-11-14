import { describe, expect, it } from 'vitest';
import bundle from '../../../../contracts/schema/consultation.schema.json';
import transcript from '../../../../contracts/fixtures/synthetic-respiratory/transcript.json';
import replay from '../../../../contracts/fixtures/synthetic-respiratory/replay.json';
import {
  ENUMS_BY_SCHEMA_NAME,
  ExtractRequest,
  ExtractResponse,
  ModelOutput,
  Observation,
  Proposal,
  Utterance,
} from './schema.js';

const files = import.meta.glob('../../../../contracts/fixtures/**/*.json', { eager: true, import: 'default' }) as Record<string, any>;
const byName = (suffix: string) => Object.entries(files).filter(([p]) => p.endsWith(suffix));
const scenarioInputs = Object.entries(files).filter(([p]) => p.includes('/scenarios/') && !p.endsWith('.response.json'));
const responses = [...byName('.response.json'), ...byName('/response-1.json'), ...byName('/response-2.json'), ...byName('/response-3.json')];
const stem = (p: string) => p.split('/').pop()!;

describe('shared contract fixtures validate against the Zod contracts', () => {
  it('found the fixtures', () => {
    expect(scenarioInputs.length).toBeGreaterThanOrEqual(20);
    expect(responses.length).toBeGreaterThanOrEqual(23);
  });

  it.each(scenarioInputs)('scenario input %s', (path, doc) => {
    expect(ExtractRequest.safeParse(doc.request).success).toBe(true);
    expect(ModelOutput.safeParse(doc.model_output).success).toBe(true);
  });

  it.each(responses)('response %s parses and round-trips without losing or inventing fields', (path, doc) => {
    const parsed = ExtractResponse.parse(doc);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(doc);
  });

  it('transcript utterances have explicit scripted speakers', () => {
    for (const b of transcript.batches) for (const u of b.utterances) {
      expect(Utterance.parse(u).speaker_basis).toBe('SCRIPTED');
    }
    expect(transcript.provenance.startsWith('SYNTHETIC')).toBe(true);
  });

  it('the replay fixture is labelled hand-authored and its outputs parse', () => {
    expect(replay.provenance).toContain('HAND-AUTHORED');
    for (const e of replay.entries) expect(ModelOutput.safeParse(e.model_output).success).toBe(true);
  });
});

describe('Zod and Pydantic agree', () => {
  const defs = (bundle as any).extract_response.$defs as Record<string, any>;
  const allDefs = { ...(bundle as any).observation.$defs, ...(bundle as any).model_output.$defs, ...(bundle as any).extract_request.$defs, ...defs };

  it.each(Object.entries(ENUMS_BY_SCHEMA_NAME))('enumeration %s has exactly the backend values', (name, zodEnum) => {
    const def = allDefs[name];
    expect(def, `${name} missing from the generated JSON Schema`).toBeDefined();
    expect([...zodEnum.options].sort()).toEqual([...def.enum].sort());
  });

  it('declares the same schema version', () => {
    expect((bundle as any).schema_version).toBe('1.0');
  });

  it('has no field that could carry a diagnosis, medication or dosage', () => {
    const text = JSON.stringify(bundle).toLowerCase();
    for (const word of ['"medication"', '"dosage"', '"prescription"', '"diagnosis"']) expect(text).not.toContain(word);
  });

  it('has no automatic-diarisation speaker basis', () => {
    expect(ENUMS_BY_SCHEMA_NAME.SpeakerBasis.options).toEqual(['SCRIPTED', 'MANUAL_SELECTION', 'UNVERIFIED']);
  });
});

describe('invalid input is rejected', () => {
  const utt = { id: 'u1', speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: 'I have a cough.' };

  it('unknown fields', () => {
    expect(Utterance.safeParse({ ...utt, diagnosis: 'asthma' }).success).toBe(false);
  });
  it.each([
    { speaker: 'UNATTRIBUTED', speaker_basis: 'SCRIPTED' },
    { speaker: 'PATIENT', speaker_basis: 'UNVERIFIED' },
    { id: 'has space' },
    { text: '' },
    { start_ms: 10, end_ms: 5 },
  ])('inconsistent utterance %j', (over) => {
    expect(Utterance.safeParse({ ...utt, ...over }).success).toBe(false);
  });
  it('a request needs unique utterance ids and at least one utterance', () => {
    const base = { schema_version: '1.0', consultation_id: 'c1', data_classification: 'SYNTHETIC' };
    expect(ExtractRequest.safeParse({ ...base, utterances: [utt, utt] }).success).toBe(false);
    expect(ExtractRequest.safeParse({ ...base, utterances: [] }).success).toBe(false);
  });
  it.each([
    { action: 'ADD' },
    { action: 'REINFORCE', target_id: 'o1' },
    { action: 'CONTRADICT', target_id: 'o1' },
    { action: 'REVISE', target_id: 'o1', new_status: 'UNKNOWN' },
    { action: 'REVISE', target_id: 'o1', new_status: 'PRESENT' },
    { action: 'REINFORCE', target_id: 'o1', new_status: 'PRESENT' },
  ])('a proposal whose shape does not match its action %j', (p) => {
    expect(Proposal.safeParse(p).success).toBe(false);
  });
  it('an observation label must be plain words', () => {
    const base = (responses.find(([p]) => stem(p) === 'patient-belief.response.json')![1] as any).proposals[0].observation;
    expect(Observation.safeParse(base).success).toBe(true);
    expect(Observation.safeParse({ ...base, label: 'ibuprofen 400mg' }).success).toBe(false);
  });
});
