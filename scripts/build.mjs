import { mkdir, cp, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { manage, root, host, hostRequire, prepare } from './dev.mjs';
await prepare();
const compile = spawnSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), '-b', 'packages/contracts', 'packages/manage', '--pretty', 'false'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const stage = join(manage, 'artifacts/analysis');
for (const name of ['contracts', 'manage']) {
  const to = join(stage, 'packages', name); await mkdir(to, { recursive: true });
  await cp(join(root, 'packages', name, 'src'), join(to, 'src'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) await copyFile(join(root, 'packages', name, file), join(to, file));
}
const protocol = join(stage, 'packages/protocol'); await mkdir(protocol, { recursive: true });
await cp(join(host, 'packages/typert/protocol/src'), join(protocol, 'src'), { recursive: true });
await copyFile(join(host, 'packages/typert/protocol/package.json'), join(protocol, 'package.json'));
await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
await writeFile(join(stage, 'tsconfig.host.json'), JSON.stringify({ files: [], references: ['contracts', 'manage', 'protocol'].map(name => ({ path: 'packages/' + name })), compilerOptions: { target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, baseUrl: '.', paths: { '@deepseek-ai/dsh-typert-protocol': ['packages/protocol/src/index.ts'], '@software-factory/contracts/manage': ['packages/contracts/src/manage.ts'], '@software-factory/contracts/gateway': ['packages/contracts/src/gateway.ts'] }, ignoreDeprecations: '6.0' } }));
await writeFile(join(stage, 'tsconfig.client.json'), JSON.stringify({ files: ['packages/manage/src/client.ts'] }));
const { WorkspaceTypertGenerator } = await import('@deepseek-ai/dsh-typert-generator');
const outputs = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false }).generate(['@software-factory/manage'], ['host']);
if (outputs.length !== 1 || !outputs[0].remote) throw new Error('Missing strict Manage Host/Remote artifacts');
for (const output of outputs) {
  await writeFile(join(stage, 'typert.host.js'), output.js); await writeFile(join(manage, 'lib/typert.host.d.ts'), output.dts);
  await writeFile(join(stage, 'typert.remote-client.js'), output.remote.js); await writeFile(join(manage, 'lib/typert.remote-client.d.ts'), output.remote.dts);
}
await mkdir(join(manage, 'lib/contracts'), { recursive: true });
for (const file of ['manage.js', 'manage.d.ts', 'gateway.js', 'gateway.d.ts']) await copyFile(join(root, 'packages/contracts/lib', file), join(manage, 'lib/contracts', file));
async function declarations(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== 'contracts') await declarations(path); continue; }
    if (!entry.name.endsWith('.d.ts')) continue;
    let source = await readFile(path, 'utf8');
    for (const name of ['manage', 'gateway']) { let target = relative(dirname(path), join(manage, 'lib/contracts', name + '.js')).replaceAll('\\', '/'); if (!target.startsWith('.')) target = './' + target; source = source.replaceAll('@software-factory/contracts/' + name, target); }
    await writeFile(path, source.replace(/(from ['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
  }
}
await declarations(join(manage, 'lib'));
const { build } = await import(pathToFileURL(hostRequire.resolve('tsdown'))), ts = hostRequire('typescript');
const decorators = { name: 'manage-standard-decorators', transform(code, id) { if (!id.endsWith('.ts') || !/^\s*@/m.test(code)) return; return { code: ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText, map: null }; } };
for (const entry of ['typert.host', 'typert.remote-client']) await build({ config: false, entry: { [entry]: join(stage, entry + '.js') }, outDir: join(manage, 'lib'), platform: 'neutral', format: 'esm', clean: false, dts: false, deps: { onlyBundle: ['zod'] }, outputOptions: { entryFileNames: entry + '.js' } });
await build({ config: false, entry: { index: join(manage, 'src/index.ts') }, outDir: join(manage, 'lib'), platform: 'node', format: 'esm', clean: false, dts: false, deps: { neverBundle: [/^@deepseek-ai\//] }, plugins: [decorators], outputOptions: { entryFileNames: 'index.js' } });
await build({ config: false, entry: { client: join(manage, 'src/client.ts') }, outDir: join(manage, 'lib'), platform: 'browser', format: 'cjs', clean: false, dts: false, outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({id:"@software-factory/manage",factory:(require)=>{', intro: 'var module={exports:{}};var exports=module.exports;', footer: 'return module.exports;}});' } });
console.log('Built Manage Host, strict Remote descriptors, Client bridge and standalone types.');
await build({ config: false, entry: { preset: join(manage, 'src/assistant/preset.ts') }, outDir: join(manage, 'lib'), platform: 'node', format: 'esm', clean: false, dts: false, deps: { neverBundle: [/^@deepseek-ai\//] }, outputOptions: { entryFileNames: 'preset.js' } });
