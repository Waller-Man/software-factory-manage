import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';
import type { ManageDraft, PreviewResult } from '../src/types.ts';
const signal = (): AbortSignal => new AbortController().signal;
async function save(f: ReturnType<typeof fixture>, draft: ManageDraft, preview?: PreviewResult) {
  const view = preview ?? await f.commits.preview(draft.id, draft.revision, 'test-ui', signal());
  return f.commits.commit({ draftId: draft.id, expectedRevision: draft.revision, planId: view.plan.id, digest: view.plan.digest, approvalNonce: view.approvalNonce }, 'test-ui', signal());
}
test('incomplete drafts, ref edits, revision conflict, undo and draft deletion never write graph', async () => {
  const f = fixture(); let draft = await f.drafts.create({ mode: 'overview' }, signal());
  draft = await f.drafts.stageCreate({ draftId: draft.id, expectedRevision: draft.revision, label: 'Capability', parent: { vertexId: 'root' }, properties: {} }, signal());
  const change = draft.changes[0]; assert.equal(change.kind, 'create'); if (change.kind !== 'create') return;
  await assert.rejects(f.drafts.update({ draftId: draft.id, expectedRevision: 0, title: 'outdated' }), { code: 'REVISION_CONFLICT' });
  draft = await f.drafts.stageUpdate({ draftId: draft.id, expectedRevision: draft.revision, target: { ref: change.ref }, set: { name: '草稿能力' } }, signal());
  const preview = await f.commits.preview(draft.id, draft.revision, 'test-ui', signal());
  const beforeRevision = draft.revision;
  draft = await f.drafts.update({ draftId: draft.id, expectedRevision: draft.revision, context: { step: 4, origin: 'manage' } }); assert.equal(draft.revision, beforeRevision);
  draft = await f.drafts.update({ draftId: draft.id, expectedRevision: draft.revision, title: '新的草稿标题' });
  await assert.rejects(save(f, { ...draft, revision: beforeRevision }, preview), { code: 'PLAN_STALE' });
  await assert.rejects(f.drafts.stageUpdate({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: 'root' }, set: { name: 'cannot rename root' } }, signal()), { code: 'ROOT_PROTECTED' });
  draft = await f.drafts.undo({ draftId: draft.id, expectedRevision: draft.revision, changeId: change.id }, signal()); assert.equal(draft.changes.length, 0);
  f.db.vertices.set('existing-leaf', { id: 'existing-leaf', label: 'Capability', properties: { name: '已有合成能力' } }); f.db.edge('HAS_CHILD', 'root', 'existing-leaf');
  draft = await f.drafts.stageUpdate({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: 'existing-leaf' }, set: { name: '修改草稿名称' } }, signal());
  f.db.vertices.get('existing-leaf').properties.name = '外部新名称';
  draft = await f.drafts.undo({ draftId: draft.id, expectedRevision: draft.revision, changeId: draft.changes[0].id }, signal()); assert.ok(!draft.bases['existing-leaf']);
  draft = await f.drafts.stageUpdate({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: 'existing-leaf' }, set: { name: '重新编辑' } }, signal()); assert.equal(draft.bases['existing-leaf'].properties.name, '外部新名称');
  await f.drafts.remove(draft.id, draft.revision); assert.equal(f.drafts.list().length, 0); assert.equal(f.db.writes, 0);
});
test('human preview/commit creates full chain, uses native Agent ID, updates and clears optional properties', async () => {
  const f = fixture(); let draft = await f.drafts.create({ mode: 'new-agent', title: '合成登记' }, signal());
  draft = await f.drafts.stageCreate({ draftId: draft.id, expectedRevision: draft.revision, label: 'Agent', parent: { vertexId: 'root' }, properties: { agent_id: 'agent:test', name: '测试Agent', description: '合成测试数据' } }, signal());
  const agent = draft.changes[0]; assert.equal(agent.kind, 'create'); if (agent.kind !== 'create') return;
  draft = await f.drafts.stageCreate({ draftId: draft.id, expectedRevision: draft.revision, label: 'AgentVersion', parent: { ref: agent.ref }, properties: { version: '1.0', status: 'draft', developer: '测试甲、测试乙', input_schema: '{"description":"测试文本"}', output_schema: '{"description":"测试结果"}', intermediate_artifacts_json: '[{"description":"测试快照","x-file-extension":".json"}]', cost_json: '{"source":"synthetic"}' } }, signal());
  const preview = await f.commits.preview(draft.id, draft.revision, 'test-ui', signal()); assert.equal(f.db.writes, 0);
  await assert.rejects(f.commits.commit({ draftId: draft.id, expectedRevision: draft.revision, planId: preview.plan.id, digest: preview.plan.digest, approvalNonce: 'forged' }, 'test-ui', signal()), { code: 'UNAUTHORIZED' });
  const receipt = await save(f, draft, preview); assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt)); assert.equal(f.db.writes, 4);
  assert.equal(receipt.bindings[agent.ref], '2:native-agent:test');
  const repeated = await save(f, draft, preview); assert.equal(repeated.requestId, receipt.requestId); assert.equal(f.db.writes, 4);
  const versionId = 'av:agent%3Atest:1.0'; let edit = await f.drafts.create({ mode: 'edit-version', targetVertexId: versionId }, signal());
  assert.equal(edit.bases[versionId].properties.developer, '测试甲、测试乙');
  edit = await f.drafts.stageUpdate({ draftId: edit.id, expectedRevision: edit.revision, target: { vertexId: versionId }, set: { developer: '测试丙' }, unset: ['cost_json'] }, signal());
  const changed = await save(f, edit); assert.equal(changed.state, 'succeeded', JSON.stringify(changed));
  assert.equal(f.db.vertices.get(versionId).properties.developer, '测试丙'); assert.ok(!Object.hasOwn(f.db.vertices.get(versionId).properties, 'cost_json'));
});
test('leaf rules, shared parents, stale revision/plan and database changes are enforced', async () => {
  const f = fixture();
  for (const [id, name] of [['parent2', '另一父级'], ['leaf', '共享叶节点']]) f.db.vertices.set(id, { id, label: 'Capability', properties: { name } });
  f.db.edge('HAS_CHILD', 'root', 'parent2'); f.db.edge('HAS_CHILD', 'root', 'leaf'); f.db.edge('HAS_CHILD', 'parent2', 'leaf');
  let draft = await f.drafts.create({ mode: 'overview' }, signal());
  await assert.rejects(f.drafts.stageDelete({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: 'parent2' } }, signal()), { code: 'NOT_LEAF' });
  await assert.rejects(f.drafts.stageDelete({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: 'leaf' } }, signal()), { code: 'SHARED_DELETE_CONFIRMATION_REQUIRED' });
  draft = await f.drafts.stageDelete({ draftId: draft.id, expectedRevision: draft.revision, target: { vertexId: 'leaf' }, confirmedParentIds: ['root', 'parent2'] }, signal());
  const preview = await f.commits.preview(draft.id, draft.revision, 'test-ui', signal());
  f.db.vertices.get('parent2').properties.name = '外部变化';
  await assert.rejects(save(f, draft, preview), { code: 'DATA_CHANGED' }); assert.equal(f.db.writes, 0);
  const fresh = await f.commits.preview(draft.id, draft.revision, 'test-ui', signal());
  const receipt = await save(f, draft, fresh); assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt)); assert.ok(!f.db.vertices.has('leaf')); assert.equal(f.db.writes, 3);
});
test('lost write response stays unknown, repeat commit never resends, reconcile is read-only', async () => {
  const f = fixture(); let draft = await f.drafts.create({ mode: 'overview' }, signal());
  draft = await f.drafts.stageCreate({ draftId: draft.id, expectedRevision: draft.revision, label: 'Capability', parent: { vertexId: 'root' }, properties: { name: '响应丢失的合成节点' } }, signal());
  const preview = await f.commits.preview(draft.id, draft.revision, 'test-ui', signal()); f.db.dropNextWriteResponse = true;
  const receipt = await save(f, draft, preview); assert.equal(receipt.state, 'unknown'); assert.equal(f.db.writes, 1);
  await save(f, draft, preview); assert.equal(f.db.writes, 1);
  const checked = await f.commits.reconcile({ draftId: draft.id, requestId: receipt.requestId }, signal()); assert.equal(checked.state, 'partial'); assert.equal(checked.results[0].state, 'verified'); assert.equal(f.db.writes, 1);
  await assert.rejects(f.drafts.remove(draft.id, draft.revision), { code: 'DRAFT_LOCKED' });
});
