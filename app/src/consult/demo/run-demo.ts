/**
 * Runs the scripted consultation in the terminal through the real session machine, extraction client and context store.
 * Flags: --speed=N (default 25)   --backend=URL (default: offline recorded fixtures, clearly labelled)   --pause-demo
 */
import { visibleObservations } from '../context/context-store.js';
import { realScheduler } from '../core/scheduler.js';
import { ConsultationSession, type SessionSnapshot } from '../session/consultation-session.js';
import { HttpExtractionClient, type ExtractionClient } from '../extraction/extraction-client.js';
import { FixtureExtractionClient } from '../testing/fixture-extraction-client.js';
import { syntheticResponses, syntheticTranscript } from '../testing/synthetic-fixtures.js';
import { ScriptedProvider } from '../transcription/scripted-provider.js';

const proc = (globalThis as unknown as { process: { argv: string[]; exit(c: number): never; stdout: { write(s: string): void } } }).process;
const arg = (name: string): string | undefined => proc.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name: string): boolean => proc.argv.includes(`--${name}`);
const out = (s: string) => proc.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const speed = Number(arg('speed') ?? 25);
const backend = arg('backend');
const extraction: ExtractionClient = backend
  ? new HttpExtractionClient({ baseUrl: backend })
  : new FixtureExtractionClient(syntheticResponses(), realScheduler, { latencyMs: 300 / speed });

const session = new ConsultationSession({
  consultationId: syntheticTranscript.consultation_id,
  provider: new ScriptedProvider(syntheticTranscript, realScheduler, { speed, tailMs: 600 }),
  extraction,
  scheduler: realScheduler,
  now: () => new Date().toISOString(),
});

let lastLifecycle = '';
let lastObs = '';
let lastUtt = 0;
let bannerShown = false;
session.subscribe((s: SessionSnapshot) => {
  if (!bannerShown) { bannerShown = true; for (const l of s.banner) out(`## ${l}`); }
  if (s.session.lifecycle !== lastLifecycle) { lastLifecycle = s.session.lifecycle; out(`[state] ${lastLifecycle}`); }
  for (; lastUtt < s.utterances.length; lastUtt++) { const u = s.utterances[lastUtt]!; out(`[heard] ${u.speaker}: ${u.text}`); }
  const obs = (visibleObservations(s.context) as any[]).map((o) => `${o.symptom ?? o.label}:${o.status}`).join(', ');
  if (obs !== lastObs) { lastObs = obs; out(`[context] ${obs || '(empty)'}`); }
});

out(`MEDSCOPE scripted consultation demo (speed x${speed}, extraction: ${backend ? backend : 'offline recorded fixtures'})`);
await session.start();
if (flag('pause-demo')) {
  await sleep(14000 / speed + 100);
  out('[action] pause'); session.pause();
  await sleep(500);
  out('[action] resume'); session.resume();
}
await new Promise<void>((resolve) => { const off = session.subscribe((s) => s.session.inputExhausted && (off(), resolve())); });
await session.whenIdle();
session.end();
const s = session.getSnapshot();
out('');
for (const l of s.banner) out(`## ${l}`);
out(`transitions: ${s.transitions.map((t) => `${t.from}>${t.to}`).join(' ')}`);
out('final observations (none are doctor-confirmed):');
for (const o of visibleObservations(s.context) as any[]) out(`  - ${o.symptom ?? o.label}  ${o.status}  source=${o.source}  attrs=${JSON.stringify(o.attributes.duration ?? {})}`);
session.dispose();
proc.exit(s.failedBatches.length === 0 ? 0 : 1);
