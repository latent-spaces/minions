// The engine lives in runtime/. Packaging records its hashes and adds the project tool catalog.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { VERSION, GUIDE_REVISION } from '../src/version.mjs';
import { bundledGuideFiles, referenceHash, skillMetadata } from '../src/skill-bundle.mjs';
import { createWorkerGuidance, WORKER_GUIDE_SECTIONS } from '../src/worker-guidance.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const packagePath = join(root, 'package.json');
const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
const guideFiles = bundledGuideFiles();
const digestLine = /^  references-sha256: "[a-f0-9]{64}"$/m;
if (!digestLine.test(guideFiles['SKILL.md'])) throw new Error('The router must declare references-sha256.');
const router = guideFiles['SKILL.md'].replace(digestLine, `  references-sha256: "${referenceHash(guideFiles)}"`);
const bundledSkill = skillMetadata(router);
if (metadata.version !== VERSION || bundledSkill.guide_revision !== GUIDE_REVISION) throw new Error('Package version and skill guide revision must match their declarations.');
if (router !== guideFiles['SKILL.md']) writeFileSync(join(root, 'skills/mlswarm/SKILL.md'), router);
const dest = join(root, 'runtime');
// One validation implementation across browser, API, Worker and the connector.
buildSync({ entryPoints: [join(root, '../contracts/src/hosting-runtime.ts')], outfile: join(dest, 'hosting-contract.mjs'),
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2023', legalComments: 'none' });
const workerGuides = createWorkerGuidance({ core: readFileSync(join(dest, 'AGENT_PROMPT_V2.md'), 'utf8'), guideRevision: GUIDE_REVISION,
  sections: Object.fromEntries(WORKER_GUIDE_SECTIONS.map(name => [name, guideFiles[`references/${name}.md`]])) });
writeFileSync(join(dest, 'worker-guides.json'), `${JSON.stringify(workerGuides, null, 2)}\n`);
const names = ['project-operations.mjs', 'work-controller.mjs', 'providers.mjs', 'claude-settings.json', 'AGENT_PROMPT_V2.md', 'worker-guides.json', 'hosting-contract.mjs'];
const files = {};
for (const name of names) {
  const data = readFileSync(join(dest, name));
  files[name] = createHash('sha256').update(data).digest('hex');
}
// Export the catalog through the same SDK/factory as production; no duplicated tool schemas.
// tsx loads as an import hook: its CLI opens an IPC pipe, which sandboxes can refuse.
const serverRequire = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
// Listing tools opens no saved database: a throwaway in-memory test session, never the engine's own file.
function catalogEnvironment() {
  const env = { ...process.env, NODE_ENV: 'test', MLSWARM_TEST_SESSION: `mlswarm-tests-${randomBytes(6).toString('hex')}` };
  for (const key of ['MLSWARM_ENGINE', 'MLSWARM_SQLITE_PATH', 'MLSWARM_TEST_SQLITE_PATH']) delete env[key];
  return env;
}
const catalog = execFileSync(process.execPath, ['--import', pathToFileURL(serverRequire.resolve('tsx')).href, join(root, '../../apps/server/scripts/export-project-tool-catalog.ts')], { encoding: 'utf8', env: catalogEnvironment(), timeout: 30000 });
JSON.parse(catalog);
writeFileSync(join(dest, 'project-tools.json'), catalog);
files['project-tools.json'] = createHash('sha256').update(catalog).digest('hex');
writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify({ files }, null, 2)}\n`);
console.log('Packaged the engine. No connection or model was started.');
