import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';

function setup() {
  const f = fixture(), signal = new AbortController().signal;
  for (const id of ['a', 'b']) {
    f.db.vertices.set(id, { id, label: 'Agent', properties: { agent_id: 'agent:' + id, name: id, description: '逻辑能力原值' } });
    f.db.edge('HAS_AGENT', 'root', id);
  }
  for (const [id, parent, version] of [['v', 'a', '1.0'], ['a2', 'a', '2.0'], ['b3', 'b', '3.0']]) {
    f.db.vertices.set(id, { id, label: 'AgentVersion', properties: { version, description: '独立版本原值', status: 'draft', input_schema: '{}', output_schema: '{}' } });
    f.db.edge('HAS_VERSION', parent, id);
  }
  return { ...f, signal };
}

test('logical Agent name/description edit in its own flow; stable ID and version-flow scope remain protected', async () => {
  const f = setup();
  try {
    let d = await f.drafts.create({ mode: 'edit-version', targetVertexId: 'v' }, f.signal);
    const request = () => ({ draftId: d.id, expectedRevision: d.revision, target: { vertexId: 'a' } });
    await assert.rejects(f.drafts.stageUpdate({ ...request(), set: { agent_id: 'other' } }, f.signal), { code: 'STABLE_ID' });
    await assert.rejects(f.drafts.stageUpdate({ ...request(), set: { description: '错误入口' } }, f.signal), { code: 'EDIT_SCOPE' });
    d = await f.drafts.update({ draftId: d.id, expectedRevision: d.revision, context: { origin: 'overview', step: 0, selected: { vertexId: 'a' } } });
    d = await f.drafts.stageUpdate({ ...request(), set: { name: '合成新名称', description: '合成逻辑新能力' } }, f.signal);
    await assert.rejects(f.drafts.stageUpdate({ ...request(), unset: ['description'] }, f.signal), { code: 'VALIDATION_FAILED' });
    assert.equal(f.db.writes, 0);
    const view = await f.commits.preview(d.id, d.revision, 'ui', f.signal);
    const receipt = await f.commits.commit({ ...request(), planId: view.plan.id, digest: view.plan.digest, approvalNonce: view.approvalNonce }, 'ui', f.signal);
    assert.equal(receipt.state, 'succeeded');
    assert.deepEqual(f.db.vertices.get('a').properties, { agent_id: 'agent:a', name: '合成新名称', description: '合成逻辑新能力' });
    assert.equal(f.db.vertices.get('v').properties.description, '独立版本原值');
  } finally { f.core.dispose(); }
});

test('version rename and move validate the final parent, preserve identity/data, and reject duplicates or missing version', async () => {
  const f = setup();
  try {
    let d = await f.drafts.create({ mode: 'edit-version', targetVertexId: 'v' }, f.signal);
    const request = () => ({ draftId: d.id, expectedRevision: d.revision, target: { vertexId: 'v' } });
    await assert.rejects(f.drafts.stageUpdate({ ...request(), set: { version: '2.0' } }, f.signal), { code: 'ALREADY_EXISTS' });
    await assert.rejects(f.drafts.stageUpdate({ ...request(), unset: ['version'] }, f.signal), { code: 'VALIDATION_FAILED' });
    d = await f.drafts.stageUpdate({ ...request(), set: { version: '' } }, f.signal);
    await assert.rejects(f.commits.preview(d.id, d.revision, 'ui', f.signal), { code: 'VALIDATION_FAILED' });
    d = await f.drafts.stageUpdate({ ...request(), set: { version: '1.0' } }, f.signal);
    d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'b' } }, f.signal);
    // Merged update precedes move in the plan: uniqueness must use the final parent.
    d = await f.drafts.stageUpdate({ ...request(), set: { version: '2.0', description: '合成版本新能力' } }, f.signal);
    await assert.rejects(f.drafts.stageUpdate({ ...request(), set: { version: '3.0' } }, f.signal), { code: 'ALREADY_EXISTS' });
    assert.equal(f.drafts.load(d.id).revision, d.revision); assert.equal(f.db.writes, 0);
    const view = await f.commits.preview(d.id, d.revision, 'ui', f.signal);
    const receipt = await f.commits.commit({ ...request(), planId: view.plan.id, digest: view.plan.digest, approvalNonce: view.approvalNonce }, 'ui', f.signal);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
    assert.equal(f.db.vertices.size, 6); assert.equal(f.db.vertices.get('v').properties.version, '2.0');
    assert.equal(f.db.vertices.get('v').properties.input_schema, '{}');
    assert.equal(f.db.vertices.get('a').properties.description, '逻辑能力原值');
    assert.equal([...f.db.edges.values()].find(e => e.inV === 'v')!.outV, 'b');
  } finally { f.core.dispose(); }
});
