# Phase 2: voice consultation and clinical context engine

Status: **approved architecture** (decisions below). Synthetic data only. Not a diagnostic device.
Nothing in this phase may be pushed or deployed while the BodyParts3D licence is unconfirmed
(`docs/asset-licenses.md`).

## 1. Approved decisions

- Gemini through the official `google-genai` SDK, **pinned to 3.3.0** (verified: the config, timeout, retry and error
  surfaces the adapter needs all exist in that version). Gemini sits behind a provider adapter. The model ID is an
  environment variable and is discovered from the account, never hard-coded.
- Zod validates contracts on the frontend; Pydantic validates on the backend; both are checked against shared fixtures.
- Synthetic consultation text may be sent to Google Gemini. No real patient data, ever.
- A clearly labelled **recorded-replay** extraction fallback exists for when credentials are unavailable.
- Wake word for explicit voice commands: **"MEDSCOPE"**.
- One fading live-caption line (about 60 characters at most) is allowed. There is no transcript panel.
- Credentials never appear in frontend code, and environment files are never committed.

## 2. Principles

1. **The model proposes; the application validates and decides** what enters the consultation store.
2. **The anatomy model stays central.** No dashboard, sidebar, transcript window or chatbot panel.
3. **Provenance is mandatory.** Every observation traces to verbatim transcript text and a speaker.
4. **Append-only.** Nothing is silently overwritten; the doctor can review, correct and reject.
5. **Never claim what is not verified:** no speaker diarisation, no Quest microphone support until tested on hardware.

## 3. Demonstration strategy

| Path | Role | Notes |
|---|---|---|
| **Primary: scripted respiratory consultation** | Competition demo | Explicit patient/doctor utterances with realistic timing. Drives the real session state machine, the real extraction service and the real spatial review workflow. Not a static animation and not hard-coded results. Without Gemini credentials the extraction step uses the labelled replay fixture. |
| **Secondary: live microphone** | Desktop Chromium only | `WebSpeechProvider`. Quest Browser support for speech recognition is unverified (forum reports say unsupported). Permission denial, unsupported APIs and recognition failures are handled visibly. |

## 4. Architecture

```
app/src/consult/
  audio/          AudioInput interface; BrowserMicInput
  transcription/  TranscriptionProvider interface; ScriptedProvider, WebSpeechProvider
  session/        pure state machine: IDLE, STARTING, LISTENING, PAUSED, ENDED, FAILED
  context/        pure append-only store: revisions, conflicts, held-for-review, doctor actions
  contracts/      Zod schemas mirroring the Pydantic models
  extraction/     ExtractionClient (HTTP to the backend)
  commands/       pure CommandRouter: execute | ambiguous | unknown | none
  speech-out/     SpeechOutputProvider; interrupt and echo guard
  controller.ts   wires providers -> session -> extraction -> store -> presenters
app/src/spatial-ui/  consult console, observation beads, observation card, consultation pulse
backend/app/consult/ schema.py, validation.py, reconcile.py, service.py, gemini.py, replay.py, routes.py
contracts/           shared JSON Schema and golden fixtures used by pytest and vitest
```

Sessions have independent regions (listening, extraction in flight, speaking), so pausing, extracting and speaking can
overlap. The existing intent bus is kept; the consultation store subscribes to it as `anatomyStore` does.

## 5. Clinical context schema (schema version 1.0)

```
Speaker        DOCTOR | PATIENT | UNATTRIBUTED
SpeakerBasis   SCRIPTED | MANUAL_SELECTION | UNVERIFIED         (never "diarised")
ObservationKind  SYMPTOM | PATIENT_STATED_CONDITION             (there is no diagnosis kind)
Source         PATIENT_REPORTED | DOCTOR_CONFIRMED | DOCTOR_OBSERVED | SYSTEM_DERIVED
Status         PRESENT | ABSENT | UNKNOWN | UNRESOLVED
Confidence     LOW | MEDIUM | HIGH                              (a bucket, to avoid false precision)
Evidence       { utterance_id, role: STATEMENT | QUESTION_CONTEXT, quote, char_start, char_end }
Attributes     { onset?, duration?, severity?, character_over_time[], context[] }   (null = not stated)
Observation    { id, kind, symptom, label?, status, source, originated_as, confidence, attributes,
                 evidence[], revision, supersedes?, conflicts_with[], review, extractor, created_at }
```

### Rules and where each is enforced

| Rule | Enforcement |
|---|---|
| Patient-reported never becomes doctor-confirmed | The model cannot emit `DOCTOR_CONFIRMED`. It is created **only** by an explicit doctor action in the store. |
| `DOCTOR_OBSERVED` is not `DOCTOR_CONFIRMED` | `DOCTOR_OBSERVED` requires a doctor-attributed statement of an examination finding. A doctor sentence is not a confirmed finding. Questions and restatements never create observations. |
| A disease named by the patient is not a diagnosis | `PATIENT_STATED_CONDITION` is forced to `PATIENT_REPORTED` + `UNRESOLVED` and displayed as "patient believes X (unverified)". |
| Unattributed speech cannot become a patient claim | A `PATIENT_REPORTED` observation requires a `STATEMENT` evidence item from a `PATIENT` utterance. Observations from `UNATTRIBUTED` utterances are returned as `held_for_review` and re-extracted after the doctor assigns a speaker. |
| Missing stays unknown | Attributes not stated are `null`. Gaps are derived by code, not guessed by the model. |
| Conflicts stay unresolved | A contradiction marks both observations `UNRESOLVED` with `conflicts_with`. Only an explicit doctor resolution changes that. |
| Traceable | Evidence is required and checked as a verbatim substring of the cited utterance; the stored quote is re-cut from the source text. |
| No silent overwrite | The store is an event log; confirm, correct, reject and resolve each add a revision. The original is retained. |
| No medication or dosing | No such field exists. Model-authored free text and quotes containing dose, unit or prescription patterns are rejected. |
| No diagnosis | There is no field for one. |

## 6. Backend API

```
GET  /health                       adds extraction_provider, extraction_is_replay, schema_version (no secrets)
GET  /v1/consultation/schema       JSON Schema bundle
POST /v1/consultation/extract
  request:  { schema_version, consultation_id, data_classification: "SYNTHETIC",
              utterances[], context_utterances[], known_observations[] }
  200:      { extraction_id, schema_version, proposals[], held_for_review[], rejected[],
              extractor: { provider, model, is_replay, latency_ms }, warnings[] }
  errors:   422 invalid request | 413 too large | 403 non-synthetic data
            503 extraction_unavailable (retriable) | 502 model_output_invalid (not retriable)
Proposal = { action: ADD | REINFORCE | REFINE | CONTRADICT, target_id?, observation }
```

The server **reconciles** the model's output against `known_observations` and decides the action itself; the model's
suggested action is only a hint. The backend is stateless, persists nothing and never logs transcript text.

### Gemini adapter

`generate_content` with `response_mime_type=application/json`, a Pydantic-derived `response_json_schema`, temperature 0,
a request timeout and bounded retries. Gemini does not enforce `minLength`, `maxLength`, `uniqueItems` and similar
constraints, so Pydantic validation after the call is the real gate. Transcript text is passed as data, with an
explicit instruction that it is never to be followed as instructions.

Provider selection: `EXTRACTION_PROVIDER=gemini | replay | auto` (default `auto`: Gemini when a key and model are
configured, otherwise replay). **Every response says which one ran, and replay is flagged.**

The replay fixtures are **hand-authored** to resemble model output, because no credentials were available when they were
written. They are labelled as such and are replaced by real recordings with `backend/scripts/record_replay.py` once a key exists.

## 7. Transcription providers

| Provider | Audio goes to | Limits |
|---|---|---|
| ScriptedProvider | Nowhere | Not a real microphone; always labelled "scripted". |
| WebSpeechProvider | The browser vendor's cloud service (Chrome: Google), disclosed before use | Desktop Chromium. No diarisation, no word timestamps. A working-start check is required (the constructor can exist without working). Quest unverified. |
| BackendChunkProvider (later) | Our backend, then the chosen STT | Depends on microphone access inside an immersive session, unverified. |

Speakers are labelled by the script or by an explicit Doctor/Patient selector. Unattributed speech is never promoted to
a patient claim.

## 8. Spatial design

- **Consultation pulse:** the existing floor rings. Idle faint, listening mint (mic level), paused amber, extracting rotating dashes, speaking ripples.
- **Console:** compact near-field controls (mic orb, stop/end, speaker selector) about 0.5 m lower-left, at least 64 mm targets, poke with ray fallback. An always-visible mic-live indicator and an immediate stop.
- **Observation beads** anchored near relevant anatomy (display anchors only, not an anatomical claim). Source is encoded by **shape and colour**: hollow ring = patient-reported, solid with halo = doctor-confirmed, slashed = absent, flickering amber = unresolved. Beads carry no text, to respect the draw-call budget and progressive disclosure.
- **One observation card** (reusing the info-card pattern): compact first, then one supporting quote with timestamp and speaker basis, then Confirm, Correct, Reject.
- **Live caption:** one fading line of at most about 60 characters.
- Anatomy exploration keeps working throughout; the consult entities are separate interactables.

## 9. Voice commands and speech output

- Commands require the wake word: "MEDSCOPE, show the lungs". Speech without it never executes a command and is never sent to extraction.
- `CommandRouter` returns `execute | ambiguous | unknown | none`; ambiguous commands ask a clarifying question and do nothing.
- A bare "stop" is accepted only while MEDSCOPE is speaking. Tapping the orb also interrupts.
- The spoken summary is generated **deterministically from validated observations**, never freely by Gemini. A visible text fallback is always shown.
- Echo guard: while speaking, recognised speech is discarded unless it matches the interrupt grammar or does not overlap the spoken text.

## 10. Safety and privacy

Synthetic data only; the backend rejects any other `data_classification`. No raw audio is persisted. No credentials in the
frontend. The microphone indicator reflects the provider's real state. Every provider and data flow is disclosed before
use. Structure text and curated mappings are marked unreviewed.

## 11. Milestones (approved order)

1. Shared contracts, Pydantic and Zod schemas, consultation (context) state.
2. Backend extraction service and Gemini adapter.
3. Deterministic extraction tests and the synthetic respiratory fixture.
4. Scripted consultation provider and frontend session machine.
5. Spatial consultation controls and observation beads.
6. Observation review, correction and confirmation.
7. Browser microphone integration.
8. Speech output, interruption and echo guard.
9. Wake-word command routing.
10. Full regression and visual polish.

Each milestone is independently testable and runs the existing suites. The ghost-skeleton draw-call optimisation is
deferred until the consultation experience works.

## 12. Risks

Quest speech recognition and in-session microphone access are unverified; text-to-speech on Quest is unverified; Gemini
models and APIs change between generations; the free-tier data terms should be checked; strict evidence matching may
reject valid items (mitigated by whitespace and case tolerant matching); the draw-call budget; speaker attribution is manual;
the BodyParts3D licence remains unconfirmed; the competition deadline is close.

## 13. Open items

- **Model discovery:** no Gemini credentials were available when the integration was written, so the account's available
  models were **not** inspected. `backend/scripts/list_models.py` does it once `GEMINI_API_KEY` is set; choose `GEMINI_MODEL` from its output.
- Replace the hand-authored replay fixtures with real recordings.
- Verify microphone, speech recognition and speech synthesis on a Quest headset.

## 14. Implementation status

| Milestone | Status |
|---|---|
| 1. Shared contracts, Pydantic and Zod schemas, consultation state | **Done** (`contracts/`, `backend/app/consult/schema.py`, `app/src/consult/contracts`, `app/src/consult/context`) |
| 2. Backend extraction service and Gemini adapter | **Done**, verified with a fake client only; **never run against the live API** (no credentials) |
| 3. Deterministic extraction tests and synthetic fixture | **Done** (13 scenarios plus the primary consultation; hand-authored replay) |
| 4 to 10 | Not started |

Verified against the real service: `backend/scripts/demo_extract.py`. SDK check: `google-genai` 3.3.0 matches the plan.
**Discrepancy to note:** the SDK pulls `httpx2`, `google-auth`, `requests`, `tenacity` and `websockets` into the backend
environment. `httpx` 0.28.1 remains installed and unaffected.

## 15. Approved refinements (after Milestones 1 to 3 review)

1. **"The last two days" is a two-day duration**, not an approximation. Only explicit hedging words ("about", "around",
   "roughly", "approximately", "nearly", "almost", "a couple of", "or so") set `approximate`. The word "about" is never
   added to evidence or duration text.
2. **Dose content never becomes an observation, but a symptom in the same utterance survives.** A quote that contains dose
   text is trimmed to a clean clause that itself names the symptom ("I took 500 mg of paracetamol and I have a fever"
   yields a fever with the quote "I have a fever"). Evidence that is only dose text yields nothing. A dose in a duration
   phrase drops the attribute, not the observation. Dose content as an observation label is rejected.
3. **Patient-stated conditions are never diagnoses.** The doctor may dismiss them or annotate them (`annotateObservation`,
   a new revision that changes only the note). Confirmation and correction are refused, including through conflict resolution.
4. **Unattributed observations are held** until the doctor assigns a speaker, then the utterance is re-extracted with
   `speaker_basis = MANUAL_SELECTION`; the held candidates are then cleared.
5. **A definite statement after UNKNOWN revises the active observation** (new `REVISE` action: a new revision of the same
   observation, history kept, no duplicate). Observations from different sources are never merged.

`DOCTOR_CONFIRMED` still comes only from an explicit doctor action. A doctor's utterance never infers it.

## 16. Milestone 4: scripted provider and session machine (implemented)

Code: `app/src/consult/{core,session,transcription,extraction,testing,demo}`. No spatial UI, microphone, TTS or command routing.

**Three independent regions** (`session/session-machine.ts`, pure, never throws; an invalid event returns `INVALID_TRANSITION` and leaves state untouched):

| Region | States | Notes |
|---|---|---|
| lifecycle | IDLE, STARTING, LISTENING, PAUSED, ENDED, FAILED | input side |
| extraction | requests in flight (counter), succeeded, failed, lastError | may start while PAUSED and drains after ENDED/FAILED |
| speaking | IDLE, SPEAKING | independent of both others; wired in Milestone 8 |

**Lifecycle transitions**

| From | Event | To |
|---|---|---|
| IDLE | START | STARTING |
| STARTING | PROVIDER_STARTED | LISTENING |
| STARTING | PROVIDER_FAILED | FAILED |
| STARTING | END | ENDED |
| LISTENING | PAUSE | PAUSED |
| LISTENING | END | ENDED |
| LISTENING | PROVIDER_FAILED (non-fatal / fatal) | PAUSED / FAILED |
| PAUSED | RESUME | LISTENING |
| PAUSED | END | ENDED |
| PAUSED | PROVIDER_FAILED (non-fatal / fatal) | PAUSED / FAILED |
| FAILED | START (retry, clears failure) | STARTING |
| FAILED | END | ENDED |
| ENDED | any | terminal |

`INPUT_EXHAUSTED` (a finite script has delivered everything) is valid only in LISTENING or PAUSED and does not change the lifecycle. Other events are invalid in every other state.

**Pipeline**: provider events -> session -> finals (deduplicated by utterance id, validated) -> batches -> sequential extraction queue -> backend -> append-only store. A batch flushes after a PATIENT final, after a quiet window (restarted by speech activity), on `exhausted` and on `end`. Extraction is one request at a time, with fresh known observations and the preceding utterances as context; retriable failures back off and retry up to 3 times, others are recorded and can be retried with `retryFailed()`. Duplicate responses (same `extraction_id`) are applied once.

**Replay status**: the banner always carries the input label and the extraction mode (`REPLAY_FIXTURE`, `LIVE_MODEL`, `MIXED`, or not contacted). Replay is sticky: a single replayed response is never reported as live.

**Demo**: `cd app && npm run demo:consultation -- --speed=25 [--pause-demo] [--backend=http://127.0.0.1:8000]`. Without `--backend` it uses offline recorded fixtures. Backend integration test: `MEDSCOPE_BACKEND_URL=... npx vitest run src/consult/session/session.integration.test.ts`.

## 17. Milestone 5: scripted consultation in the spatial app (implemented)

No microphone, Web Speech, TTS or wake-word code. The scripted provider drives the real session, extraction client and append-only store.

**Integration points**
- `core/intents.ts`: new intents `RESUME_LISTENING`, `END_CONSULTATION`, `RETRY_EXTRACTION`, `SELECT_OBSERVATION`, `CLEAR_OBSERVATION_SELECTION`, `CONFIRM_OBSERVATION`, `REJECT_OBSERVATION`, `RESOLVE_CONFLICT` (alongside the existing `START_CONSULTATION`, `PAUSE_LISTENING`). The anatomy reducer ignores them.
- `consult/app/consult-app.ts` (`ConsultApp`, pure, tested on virtual time): handles those intents, owns one `ConsultationSession` per run (an ended session is terminal, so each run is a fresh session and store), owns the UI-only selection, and derives everything the spatial layer paints. It contains no consultation logic.
- `consult/app/consult-runtime.ts`: real timers, the synthetic transcript, backend when reachable (`/health` probe, 2 s) otherwise the labelled offline recorded replay. Optional URL parameters `?consultSpeed=N` and `?consultBackend=off`. No credentials.
- `consult/ui/consult-view-model.ts`: pure view models (controls, beads, card, review actions).
- `spatial-ui/consult-controls-system.ts`, `observation-beads-system.ts`, `observation-card-system.ts` plus `public/ui/consult-controls.uikitml`, `observation-card.uikitml` and two scene nodes. `src/index.ts` registers the systems.

**Rules enforced in `ConsultApp`**: `CONFIRM_OBSERVATION`, `REJECT_OBSERVATION` and `RESOLVE_CONFLICT` are accepted only from `hand` or `desktop` sources (a deliberate press), never `voice` or `script`. A press while a session is running or starting never creates a second session. Opening an observation card clears the anatomy selection and vice versa, so only one contextual card is open. When the script is exhausted and extraction has drained, the run ends itself as COMPLETE.

**Bead language**: shape says presence (filled sphere present, ring absent, small sphere plus ring unclear, pulsing orange ring conflict, diamond the patient's own statement), colour says origin (blue patient-reported, gold doctor-observed, mint doctor-confirmed with a halo). Chest-associated symptoms have a thin leader to one shared chest hub, an orientation aid only; systemic ones (fever) float above with no line.

**Known display limitation**: the UI font has no em dash (the console reports a missing glyph), so the two mandatory labels are painted with " - " instead of the specified em dash. The logical strings, tests and logs keep the em dash.

## 18. Competition-readiness pass (implemented)

**Review actions on the observation card** (all through the append-only store; the UI holds no review rules, `ConsultApp` and the store decide):
- **Correct** opens a short option row: Mark present / Mark absent and Severity Mild / Moderate / Severe. It emits `CORRECT_OBSERVATION`, which calls `correctObservation`. The result is a new revision with `review.state = CORRECTED` and `source = DOCTOR_CONFIRMED` (an explicit doctor action). Earlier revisions and the original evidence quote stay in the store; the card says "Revision n. Earlier revisions and the original quote are kept."
- **Note** opens three preset notes (Needs follow-up, Patient unsure, Clarified with patient). It emits `ANNOTATE_OBSERVATION`, which calls `annotateObservation`. A note changes neither status, source nor evidence and is never a confirmation. There is deliberately no free-text entry.
- A patient-stated condition offers no Correct, no Confirm and no Keep this; it can only be annotated or dismissed. It is never promoted to a diagnosis.
- Confirm, Dismiss, Keep this, Correct and Note are accepted only from `hand` or `desktop` sources (a deliberate press); `voice` and `script` are refused. While an option row is open the card shrinks to the title, the choices and Back.

**Caption**: one line, at most 60 characters including the speaker, showing the live partial and then the end of the finished utterance. It holds 1.5 s, dims, and clears at 3.2 s (`CAPTION_FADE_AFTER_MS`, `CAPTION_CLEAR_AFTER_MS`). It is not a transcript: only one line exists at a time.

**Backend probing is opt-in.** With no backend configured the app makes no network request and runs the offline recorded replay, labelled "Offline recorded replay. No backend configured." To use a backend: set `VITE_API_BASE_URL`, or pass `?consultBackend=on` (http://localhost:8000) or `?consultBackend=<url>`; `?consultBackend=off` forces offline. A configured backend that does not answer falls back to the offline replay, labelled "Backend unreachable: using the offline recorded replay." (the browser logs the failed request itself; that cannot be suppressed from script).

**URL parameters** (non-secret): `consultSpeed=N` (script speed), `consultFixture=failure|conflict` (controlled test scenarios; never contact a backend; the controls say "TEST FIXTURE: <name>"; the failure fixture fails the first extraction permanently so Retry can be exercised, the conflict fixture adds a patient line contradicting the cough), `consultDebug=1` (exposes a read-only state summary, used by `verify:consult-states`).

**Verification scripts**: `verify:consult` (hands, MODE=offline|backend, explicit), `verify:consult-states` (real mouse path in the production build: normal run, correction, annotation, confirmation, dismissal, new session, failure and retry, conflict and resolution; 38 checks), `verify:production` (pinned to `?consultBackend=off`).

**Not available yet**: assigning a speaker to unattributed speech has no UI. `ConsultationSession.assignSpeaker` and the re-extraction path exist and are unit-tested, but the scripted consultation never produces unattributed speech and a speaker picker was out of scope. Free-text correction (duration wording, onset) and free-text notes are also not offered.
