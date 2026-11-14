/** The synthetic respiratory consultation and its recorded replay responses, loaded from the shared contracts. */
import transcript from '../../../../contracts/fixtures/synthetic-respiratory/transcript.json';
import r1 from '../../../../contracts/fixtures/synthetic-respiratory/response-1.json';
import r2 from '../../../../contracts/fixtures/synthetic-respiratory/response-2.json';
import r3 from '../../../../contracts/fixtures/synthetic-respiratory/response-3.json';
import { ExtractResponse } from '../contracts/schema.js';
import type { ScriptedTranscript } from '../transcription/scripted-provider.js';

export const syntheticTranscript = transcript as unknown as ScriptedTranscript;

export const syntheticResponses = (): Map<string, ExtractResponse> =>
  new Map([
    ['u1', ExtractResponse.parse(r1)],
    ['u2,u3', ExtractResponse.parse(r2)],
    ['u4,u5', ExtractResponse.parse(r3)],
  ]);
