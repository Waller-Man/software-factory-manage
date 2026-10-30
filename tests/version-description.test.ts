/** Synthetic graph only; description updates still require the existing human commit flow. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';

test('version descriptions create, preserve, update and clear independently of the logical Agent', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.db.vertices.set('logical', { id: 'logical', label: 'Agent', properties: { agent_id: 'agent:descriptions', name: '合成Agent', description: '逻辑能力原值' } }); f.db.edge('HAS_AGENT', 'root', 'logical');
  const base = { version: '1.0', status: 'draft', input_schema: '{}', output_schema: '{}' };
  const commit = async (draft: any) => {
    const preview = await f.commits.preview(draft.id, draft.revision, 'test-ui', signal);
    const receipt = await f.commits.commit({ draftId: draft.id, expectedRevision: draft.revision, planId: preview.plan.id, digest: preview.plan.digest, approvalNonce: preview.approvalNonce }, 'test-ui', signal);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
  };
  try {
    let draft = await f.drafts.create({ mode: 'new-version' }, signal);
    draft = await f.drafts.stageCreate({ draftId: draft.id, expectedRevision: draft.revision, label: 'AgentVersion', parent: { vertexId: 'logical' }, properties: base }, signal);
    assert.equal(f.db.writes, 0); await commit(draft);
    const version = [...f.db.vertices.values()].find(v => v.label === 'AgentVersion')!;
    assert.ok(!Object.hasOwn(version.properties, 'description'));
    const initial = await f.drafts.create({ mode: 'new-version' }, signal);
    const filled = await f.drafts.stageCreate({ draftId: initial.id, expectedRevision: initial.revision, label: 'AgentVersion', parent: { vertexId: 'logical' }, properties: { ...base, version: '2.0', description: '新版本独立说明' } }, signal);
    await commit(filled); assert.equal([...f.db.vertices.values()].find(v => v.properties.version === '2.0')!.properties.description, '新版本独立说明');
    for (const change of [{ set: { description: '具体版本能力' }, unset: [] }, { set: { developer: '合成开发者' }, unset: [] }, { set: {}, unset: ['description'] }]) {
      draft = await f.drafts.create({ mode: 'edit-version' }, signal);
      const beforeWrites = f.db.writes;
      draft = await f.drafts.stageUpdate({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: version.id }, ...change }, signal);
      assert.equal(f.db.writes, beforeWrites); await commit(draft);
      const current = f.db.vertices.get(version.id).properties;
      if (change.unset.length) assert.ok(!Object.hasOwn(current, 'description'));
      else assert.equal(current.description, '具体版本能力');
      assert.equal(f.db.vertices.get('logical').properties.description, '逻辑能力原值');
    }
  } finally { f.core.dispose(); }
});
