import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';

test('dataset references are optional, preserve/clear through approval, and never require root/files/network', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.db.vertices.set('a', { id: 'a', label: 'Agent', properties: { agent_id: 'synthetic', name: '合成Agent', description: '合成能力' } }); f.db.edge('HAS_AGENT', 'root', 'a');
  f.db.vertices.set('v', { id: 'v', label: 'AgentVersion', properties: { version: '1', status: 'draft', input_schema: '{}', output_schema: '{}' } }); f.db.edge('HAS_VERSION', 'a', 'v');
  try {
    const config = await f.drafts.reader.factoryConfig(signal); assert.equal(config.state, 'missing');
    let d = await f.drafts.create({ mode: 'edit-version', targetVertexId: 'v' }, signal);
    const request = () => ({ draftId: d.id, expectedRevision: d.revision, target: { vertexId: 'v' } });
    d = await f.drafts.stageUpdate({ ...request(), set: { developer: '合成开发者' } }, signal);
    await f.commits.preview(d.id, d.revision, 'ui', signal);
    assert.ok(d.changes[0].kind === 'update' && !Object.hasOwn(d.changes[0].set, 'datasets_json'));
    const data = JSON.stringify([{ name: '合成本地声明', local_path: 'requirements/sample.zip' }, { name: '合成来源声明', source_url: 'https://example.com/dataset.zip' }]);
    d = await f.drafts.stageUpdate({ ...request(), set: { datasets_json: data } }, signal);
    const save = async () => { const view = await f.commits.preview(d.id, d.revision, 'ui', signal); return f.commits.commit({ ...request(), planId: view.plan.id, digest: view.plan.digest, approvalNonce: view.approvalNonce }, 'ui', signal); };
    assert.equal(f.db.writes, 0); assert.equal((await save()).state, 'succeeded');
    assert.equal(f.db.vertices.get('v').properties.datasets_json, data);
    d = await f.drafts.create({ mode: 'edit-version', targetVertexId: 'v' }, signal);
    d = await f.drafts.stageUpdate({ ...request(), set: { developer: '另一个合成开发者' } }, signal);
    assert.equal((await save()).state, 'succeeded'); assert.equal(f.db.vertices.get('v').properties.datasets_json, data);
    d = await f.drafts.create({ mode: 'edit-version', targetVertexId: 'v' }, signal);
    d = await f.drafts.stageUpdate({ ...request(), unset: ['datasets_json'] }, signal);
    assert.equal((await save()).state, 'succeeded'); assert.ok(!Object.hasOwn(f.db.vertices.get('v').properties, 'datasets_json'));
  } finally { f.core.dispose(); }
});

test('incomplete dataset drafts are allowed but invalid shapes, paths and credential URLs cannot be approved', async () => {
  const f = fixture(), signal = new AbortController().signal;
  try {
    let d = await f.drafts.create({ mode: 'new-agent' }, signal);
    d = await f.drafts.stageCreate({ draftId: d.id, expectedRevision: d.revision, label: 'Agent', parent: { vertexId: 'root' }, properties: { agent_id: 'synthetic', name: '合成', description: '合成能力' } }, signal);
    const agent = d.changes[0]; assert.equal(agent.kind, 'create'); if (agent.kind !== 'create') return;
    d = await f.drafts.stageCreate({ draftId: d.id, expectedRevision: d.revision, label: 'AgentVersion', parent: { ref: agent.ref }, properties: { version: '1', status: 'draft', input_schema: '{}', output_schema: '{}' } }, signal);
    const version = d.changes[1]; assert.equal(version.kind, 'create'); if (version.kind !== 'create') return;
    for (const value of ['', '{}', '[{}]', '[{"name":"合成"}]', '[{"name":"合成","local_path":"../escape"}]', '[{"name":"合成","local_path":"C:/private"}]', '[{"name":"合成","local_path":"%2e%2e/escape"}]', '[{"name":"合成","source_url":"file:///private"}]', '[{"name":"合成","source_url":"https://user:pass@example.com/data"}]']) {
      d = await f.drafts.stageUpdate({ draftId: d.id, expectedRevision: d.revision, target: { ref: version.ref }, set: { datasets_json: value } }, signal);
      await assert.rejects(f.commits.preview(d.id, d.revision, 'ui', signal), { code: 'VALIDATION_FAILED' });
    }
    d = await f.drafts.stageUpdate({ draftId: d.id, expectedRevision: d.revision, target: { ref: version.ref }, unset: ['datasets_json'] }, signal);
    await f.commits.preview(d.id, d.revision, 'ui', signal); assert.equal(f.db.writes, 0);
  } finally { f.core.dispose(); }
});
