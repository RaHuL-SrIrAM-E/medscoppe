// Bundles and runs the scripted-consultation demo in Node. Usage: npm run demo:consultation -- --speed=25 [--backend=http://127.0.0.1:8000] [--pause-demo]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

fs.mkdirSync('artifacts', { recursive: true });
await build({ entryPoints: ['src/consult/demo/run-demo.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'artifacts/consult-demo.mjs', logLevel: 'error' });
const r = spawnSync('node', ['artifacts/consult-demo.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
