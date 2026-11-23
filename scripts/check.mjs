import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { root, host, manage, hostRequire, prepare } from './dev.mjs';
await prepare();
const ui = createRequire(join(host, 'packages/client/ui-primitives/package.json'));
const reactTypes = dirname(ui.resolve('@types/react/package.json'));
const clientConfig = join(manage, 'artifacts/tsconfig.native-client.json');
await mkdir(dirname(clientConfig), { recursive: true });
await writeFile(clientConfig, JSON.stringify({ compilerOptions: { noEmit: true, target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, ignoreDeprecations: '6.0', paths: { react: [join(reactTypes, 'index.d.ts')] } }, files: [join(manage, 'src/client.ts')] }));
for (const args of [['-b', 'packages/contracts', 'packages/manage', '--pretty', 'false'], ['-p', clientConfig, '--pretty', 'false']]) {
  const result = spawnSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
