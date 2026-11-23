import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, connectionConfig, snapshotConfig } from '../src/config.ts';

test('component connection uses secret password and has no env or dataset-root setting', () => {
  const schema = Config.toJSON() as any, fields = schema.refs[schema.uid].dict;
  assert.equal(schema.refs[fields.password].meta.role, 'secret');
  for (const field of Object.values(fields) as string[]) assert.equal(schema.refs[field].meta.volatile, true);
  const live = Config({ username: 'synthetic', password: 'synthetic' });
  assert.equal(connectionConfig(snapshotConfig(live)).username, 'synthetic');
  assert.equal(snapshotConfig(live).requestTimeoutMs, 10000);
  assert.ok(!JSON.stringify(schema).includes('envFile') && !JSON.stringify(schema).includes('dataset_root'));
  assert.throws(() => connectionConfig({}), { code: 'CONFIG' });
  assert.throws(() => connectionConfig({ username: 'x:y', password: 'synthetic' }), { code: 'CONFIG' });
  assert.equal(connectionConfig({ username: 'synthetic', password: 'synthetic' }).graph, 'hugegraph');
});
