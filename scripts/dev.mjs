/** Development links only; runtime never depends on a source checkout path. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare as prepareHost, root, host, hostRequire } from '../../gateway/scripts/dev.mjs';
export { root, host, hostRequire };
export const manage = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Node package self-references resolve Manage's own exports without a new link.
export async function prepare() { await prepareHost(); }
