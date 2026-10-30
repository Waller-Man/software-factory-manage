/** Synthetic configuration only; never reads a real .env or connects to a database. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { readConnectionEnv } from '../src/env.ts';

const manage = resolve(import.meta.dirname, '..');
const sample = 'HUGEGRAPH_BASE_URL=http://127.0.0.1:18080\nHUGEGRAPH_GRAPHSPACE=DEFAULT\nHUGEGRAPH_GRAPH=hugegraph\nHUGEGRAPH_USERNAME=synthetic\nHUGEGRAPH_PASSWORD="synthetic-only#=value"\n';
async function temporaryEnv(t: TestContext) {
  const artifacts = join(manage, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const scratch = await mkdtemp(join(artifacts, 'env-test-'));
  t.after(async () => {
    assert.equal(dirname(scratch), artifacts);
    await rm(scratch, { recursive: true, force: true });
  });
  return join(scratch, '.env');
}

test('Manage accepts an ordinary readable .env without private ACL/mode preparation', async t => {
  const path = await temporaryEnv(t);
  // Inherit the workspace directory ACL on Windows; ordinary 644 on POSIX.
  await writeFile(path, sample, { mode: 0o644 });
  const absolute = await readConnectionEnv(path);
  assert.equal(absolute.username, 'synthetic');
  assert.equal(absolute.password, 'synthetic-only#=value');
  assert.deepEqual(await readConnectionEnv(relative(manage, path)), absolute);
});

test('Manage still rejects missing, incomplete, oversized and invalid UTF-8 configuration without exposing contents', async t => {
  const path = await temporaryEnv(t);
  await assert.rejects(readConnectionEnv(path), { code: 'CONFIG', message: /Missing \.env/ });
  for (const content of [sample.replace('HUGEGRAPH_USERNAME=synthetic\n', ''), sample + '#'.repeat(16384), Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, content);
    await assert.rejects(readConnectionEnv(path), (error: any) => {
      assert.equal(error.code, 'CONFIG');
      assert.ok(!error.message.includes('synthetic-only#=value'));
      return true;
    });
  }
});
