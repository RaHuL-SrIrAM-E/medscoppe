/**
 * Controlled test scenarios for exercising states the normal scripted consultation never reaches (a conflicting
 * statement, an extraction failure). They are selected only by an explicit `?consultFixture=` parameter, and the controls
 * then say "TEST FIXTURE: <name>", so a fixture can never be mistaken for the normal replay.
 */
import patientBelief from '../../../../contracts/fixtures/scenarios/patient-belief.response.json';
import conflictStatus from '../../../../contracts/fixtures/scenarios/conflict-status.response.json';
import { ExtractResponse } from '../contracts/schema.js';
import { ExtractionError } from '../extraction/extraction-client.js';
import type { ScriptedTranscript } from '../transcription/scripted-provider.js';
import type { FixtureExtractionClient } from './fixture-extraction-client.js';
import { syntheticResponses, syntheticTranscript } from './synthetic-fixtures.js';

export type ScenarioName = 'failure' | 'conflict' | 'belief';

export function isScenario(name: string | null): name is ScenarioName {
  return name === 'failure' || name === 'conflict' || name === 'belief';
}

/** The normal script plus one more patient line that contradicts the first answer. */
export function conflictTranscript(): ScriptedTranscript {
  return {
    ...syntheticTranscript,
    batches: [
      ...syntheticTranscript.batches,
      {
        label: 'Patient contradicts the cough statement (test fixture)',
        utterances: [{ id: 'u6', speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: "Actually, I don't have a cough.", start_ms: 31000, end_ms: 33500 }],
      },
    ],
  };
}

export function conflictResponses() {
  const map = syntheticResponses();
  // the fixture contradicts "obs_known1"; point it at the cough that the normal replay creates
  const text = JSON.stringify(conflictStatus).split('obs_known1').join('obs_syn_001').split('"is_replay":false').join('"is_replay":true');
  const raw = JSON.parse(text.split('"provider":"fixture"').join('"provider":"replay"').split('"model":"static"').join('"model":"replay-fixture"'));
  map.set('u6', ExtractResponse.parse({ ...raw, extraction_id: 'ext_fixture_conflict_1' }));
  return map;
}

/** The normal script plus one patient line naming a disease: shows the condition card and its tests and medicines view. */
export function beliefTranscript(): ScriptedTranscript {
  return {
    ...syntheticTranscript,
    batches: [
      ...syntheticTranscript.batches,
      {
        label: 'Patient names a condition (test fixture)',
        utterances: [{ id: 'u6', speaker: 'PATIENT', speaker_basis: 'SCRIPTED', text: 'I think I have pneumonia.', start_ms: 31000, end_ms: 33500 }],
      },
    ],
  };
}

export function beliefResponses() {
  const map = syntheticResponses();
  const text = JSON.stringify(patientBelief).split('"u12"').join('"u6"').split('"is_replay":false').join('"is_replay":true');
  const raw = JSON.parse(text.split('"provider":"fixture"').join('"provider":"replay"').split('"model":"static"').join('"model":"replay-fixture"'));
  map.set('u6', ExtractResponse.parse({ ...raw, extraction_id: 'ext_fixture_belief_1' }));
  return map;
}

/** The first batch fails permanently; the Retry control then succeeds. */
export function applyFailure(client: FixtureExtractionClient): void {
  client.failNext(new ExtractionError('invalid_response', 'Test fixture: simulated invalid response.', false));
}
