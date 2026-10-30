/** Plugin-local .env only. Never export values to process.env or echo source text. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection } from './database/transport.ts';
import { ManageFailure as GatewayError, ensure as requireThat } from './errors.ts';

const fields = ['HUGEGRAPH_BASE_URL', 'HUGEGRAPH_GRAPHSPACE', 'HUGEGRAPH_GRAPH', 'HUGEGRAPH_USERNAME', 'HUGEGRAPH_PASSWORD'] as const;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const connectionEnvPath = (configuredFile = '.env'): string => resolve(packageRoot, configuredFile);

/** Single-line dotenv syntax, comments and quoted values; no shell expansion. */
export function parseConnectionEnv(source: string): Connection {
  requireThat(Buffer.byteLength(source) <= 16384 && !source.includes('\0'), 'CONFIG', '.env must be UTF-8 text no larger than 16 KiB');
  const values: Record<string, string> = Object.create(null);
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    requireThat(match, 'CONFIG', 'Invalid .env assignment; check the file locally');
    const key = match[1]!;
    requireThat(fields.includes(key as typeof fields[number]) && !Object.hasOwn(values, key), 'CONFIG', '.env contains an unknown or duplicate key');
    const raw = match[2]!.trim(); let value = '';
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0]!; let closed = false;
      for (let i = 1; i < raw.length; i++) {
        const char = raw[i]!;
        if (quote === '"' && char === '\\' && (raw[i + 1] === '"' || raw[i + 1] === '\\')) { value += raw[++i]; continue; }
        if (char === quote) {
          requireThat(/^\s*(?:#.*)?$/.test(raw.slice(i + 1)), 'CONFIG', 'Unexpected text after a quoted .env value'); closed = true; break;
        }
        value += char;
      }
      requireThat(closed, 'CONFIG', 'Unclosed .env quote; inspect the file locally');
    } else value = raw.split('#', 1)[0]!.trimEnd();
    requireThat(value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value), 'CONFIG', '.env values must be bounded single-line strings');
    values[key] = value;
  }
  requireThat(fields.every(key => Object.hasOwn(values, key) && values[key]!.trim().length > 0), 'CONFIG', 'Fill all five .env fields, including database username and password');
  requireThat(!values.HUGEGRAPH_USERNAME!.includes(':'), 'CONFIG', 'Database username cannot contain a colon');
  return { baseUrl: values.HUGEGRAPH_BASE_URL!, graphSpace: values.HUGEGRAPH_GRAPHSPACE!, graph: values.HUGEGRAPH_GRAPH!, username: values.HUGEGRAPH_USERNAME!, password: values.HUGEGRAPH_PASSWORD! };
}

export async function readConnectionEnv(configuredFile = '.env'): Promise<Connection> {
  let buffer: Buffer | undefined;
  try {
    requireThat(typeof configuredFile === 'string' && configuredFile.length > 0 && configuredFile.length <= 4096 && !/[\u0000-\u001f]/.test(configuredFile), 'CONFIG', 'Invalid envFile configuration');
    const path = connectionEnvPath(configuredFile);
    const info = await lstat(path), parent = await lstat(dirname(path));
    requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && parent.isDirectory() && !parent.isSymbolicLink(), 'CONFIG', '.env must be a regular file in a non-symlink directory');
    // Normal filesystem access decides readability; no plugin-imposed ACL/mode policy.
    const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      const current = await file.stat();
      requireThat(current.dev === info.dev && current.ino === info.ino && current.nlink === 1 && current.size > 0 && current.size <= 16384, 'CONFIG', '.env changed or exceeds 16 KiB');
      buffer = Buffer.alloc(16385); let size = 0;
      while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
      requireThat(size <= 16384, 'CONFIG', '.env exceeds 16 KiB');
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw new GatewayError('CONFIG', '.env must use UTF-8 encoding'); }
      return parseConnectionEnv(source);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new GatewayError('CONFIG', 'Missing .env: copy .env.example to .env in the plugin directory, fill it locally, then re-enable');
    throw new GatewayError('CONFIG', 'Cannot read .env; check the file path and filesystem access locally');
  } finally { buffer?.fill(0); }
}

