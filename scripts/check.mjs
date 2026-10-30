import { spawnSync } from 'node:child_process';
import { root, hostRequire, prepare } from './dev.mjs';
await prepare();
for (const args of [['-b', 'packages/contracts', 'packages/manage', '--pretty', 'false'], ['--noEmit', '--target', 'ES2024', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--ignoreDeprecations', '6.0', 'packages/manage/src/client.ts']]) {
  const result = spawnSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
