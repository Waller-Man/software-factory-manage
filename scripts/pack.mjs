/** Pack verified runtime entries only; never enumerate or copy a real .env. */
import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { manage, root } from './dev.mjs';
import { readTgz, createZip } from './archive.mjs';
const artifacts = join(manage, 'artifacts'); await mkdir(artifacts, { recursive: true });
await mkdir(join(manage, 'docs'), { recursive: true });
await copyFile(join(root, 'docs/interfaces/manage.md'), join(manage, 'docs/api.md'));
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd pack --ignore-scripts --json --pack-destination artifacts'] : ['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts'];
const result = spawnSync(command, args, { cwd: manage, encoding: 'utf8', windowsHide: true, env: { ...process.env, npm_config_cache: join(artifacts, 'npm-cache') } });
if (result.status !== 0) { process.stderr.write(result.stderr ?? 'npm pack failed'); process.exit(result.status ?? 1); }
const metadata = JSON.parse(result.stdout)[0], entries = readTgz(await readFile(join(artifacts, metadata.filename))), files = entries.map(entry => entry.name);
if (JSON.stringify([...files].sort()) !== JSON.stringify(metadata.files.map(entry => entry.path).sort())) throw new Error('Tar entries differ from npm file list');
for (const path of files) {
  if (/(^|\/)(node_modules|src|tests?|artifacts)(\/|$)|\.tsbuildinfo$|\.private\.|(^|\/)credentials\.json$/.test(path)) throw new Error('Forbidden package content');
  if (/(^|\/)\.env(?:\..*)?$/.test(path) && path !== '.env.example') throw new Error('Private environment file included');
}
const required = ['package.json', 'README.md', 'docs/api.md', 'lib/index.js', 'lib/client.js', 'lib/types.d.ts', 'lib/contracts/manage.d.ts', 'lib/contracts/gateway.d.ts', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'cordis.patch.yml', '.env.example', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'scripts/check-connection.mjs'];
for (const path of [...required, 'lib/preset.js', 'THIRD_PARTY_NOTICES.md']) if (!files.includes(path)) throw new Error('Package file missing: ' + path);
const example = entries.find(entry => entry.name === '.env.example').data.toString('utf8');
for (const key of ['HUGEGRAPH_USERNAME', 'HUGEGRAPH_PASSWORD']) if (!new RegExp('^' + key + '=$', 'm').test(example)) throw new Error('Credential example must be blank');
const manifestEntry = entries.find(entry => entry.name === 'package.json'), manifest = JSON.parse(manifestEntry.data.toString('utf8'));
if (manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) throw new Error('Unexpected install script');
delete manifest.scripts; delete manifest.devDependencies; delete manifest.workspaces;
manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const prefix = 'software-factory-manage', releaseDir = join(artifacts, 'release', prefix);
// Remove only obsolete bundled helpers; preserve the user's local .env and all other files.
for (const name of ['check-env-acl.ps1', 'protect-env.ps1']) await rm(join(releaseDir, 'scripts', name), { force: true });
for (const entry of entries) { const path = join(releaseDir, entry.name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, entry.data); }
const zipName = prefix + '-' + manifest.version + '.zip', zip = createZip(entries.map(entry => ({ ...entry, name: prefix + '/' + entry.name })));
await writeFile(join(artifacts, zipName), zip);
await writeFile(join(artifacts, 'package-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), version: manifest.version, zip: zipName, zipBytes: zip.length, zipSha256: createHash('sha256').update(zip).digest('hex'), tgz: metadata.filename, tgzIntegrity: metadata.integrity, files, privateEnvExcluded: true, sourceExcluded: true, installScripts: false }, null, 2) + '\n');
console.log(JSON.stringify({ zip: zipName, bytes: zip.length, files: files.length, packageCheck: 'passed' }));
