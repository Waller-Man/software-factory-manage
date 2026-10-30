import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';

function setup() {
    const f = fixture(), signal = new AbortController().signal;
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
        f.db.vertices.set(id, { id, label: 'Agent', properties: { agent_id: id, name: id, description: '合成Agent' } });
        f.db.edge('HAS_AGENT', 'root', id);
    }
    const id = 'av:agent-a:1.0';
    const properties = { version: '1.0', status: 'draft', developer: '合成原值', input_schema: '{"description":"合成输入"}', output_schema: '{"description":"合成输出"}', intermediate_artifacts_json: '[{"description":"合成材料"}]' };
    f.db.vertices.set(id, { id, label: 'AgentVersion', properties }); f.db.edge('HAS_VERSION', 'agent-a', id);
    return { ...f, signal, id };
}

test('moving a version preserves identity/data, supports edits and undo, and commits only the approved edges', async () => {
    const f = setup();
    try {
        let d = await f.drafts.create({ mode: 'edit-version', targetVertexId: f.id }, f.signal);
        const request = () => ({ draftId: d.id, expectedRevision: d.revision, target: { vertexId: f.id } });
        await assert.rejects(f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'root' } }, f.signal), { code: 'ILLEGAL_RELATION' });
        d = await f.drafts.stageUpdate({ ...request(), set: { developer: '合成新值' } }, f.signal);
        d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-b' } }, f.signal);
        d = await f.drafts.stageUpdate({ ...request(), set: { performance_evidence_json: '{"summary":"合成占位，未实测"}' } }, f.signal);
        assert.deepEqual(d.context.editingVersion, { vertexId: f.id });
        const move = d.changes.find(change => change.kind === 'move-version')!;
        d = await f.drafts.undo({ draftId: d.id, expectedRevision: d.revision, changeId: move.id }, f.signal);
        assert.ok(d.changes.every(change => change.kind === 'update'));
        d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-c' } }, f.signal);
        d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-b' } }, f.signal);
        assert.equal(d.changes.filter(change => change.kind === 'move-version').length, 1);
        assert.equal(f.db.writes, 0); assert.equal(f.db.vertices.get(f.id).properties.developer, '合成原值');
        const view = await f.commits.preview(d.id, d.revision, 'ui', f.signal);
        assert.deepEqual(view.plan.steps.map(step => step.operation), ['update_node', 'create_edge', 'delete_edge']);
        const receipt = await f.commits.commit({ ...request(), planId: view.plan.id, digest: view.plan.digest, approvalNonce: view.approvalNonce }, 'ui', f.signal);
        assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
        assert.equal(f.db.vertices.size, 5); assert.equal(f.db.vertices.get(f.id).properties.developer, '合成新值');
        assert.equal(f.db.vertices.get(f.id).properties.intermediate_artifacts_json, '[{"description":"合成材料"}]');
        assert.deepEqual([...f.db.edges.values()].filter(edge => edge.label === 'HAS_VERSION').map(edge => [edge.outV, edge.inV]), [['agent-b', f.id]]);
    } finally { f.core.dispose(); }
});

test('move refuses duplicate versions and stale approval; an uncertain edge write never deletes the version or auto compensates', async () => {
    const f = setup();
    try {
        let d = await f.drafts.create({ mode: 'edit-version', targetVertexId: f.id }, f.signal);
        const request = () => ({ draftId: d.id, expectedRevision: d.revision, target: { vertexId: f.id } });
        f.db.vertices.set('duplicate', { id: 'duplicate', label: 'AgentVersion', properties: { ...f.db.vertices.get(f.id).properties } }); f.db.edge('HAS_VERSION', 'agent-b', 'duplicate');
        await assert.rejects(f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-b' } }, f.signal), { code: 'ALREADY_EXISTS' });
        assert.equal(f.drafts.load(d.id).revision, 0);
        d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-c' } }, f.signal);
        const stale = await f.commits.preview(d.id, d.revision, 'ui', f.signal);
        d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-a' } }, f.signal);
        assert.equal(d.changes.length, 0);
        await assert.rejects(f.commits.commit({ draftId: d.id, expectedRevision: stale.plan.revision, planId: stale.plan.id, digest: stale.plan.digest, approvalNonce: stale.approvalNonce }, 'ui', f.signal), { code: 'PLAN_STALE' });
        d = await f.drafts.stageMoveVersion({ ...request(), parent: { vertexId: 'agent-c' } }, f.signal);
        const view = await f.commits.preview(d.id, d.revision, 'ui', f.signal);
        f.db.dropNextWriteResponse = true;
        const receipt = await f.commits.commit({ ...request(), planId: view.plan.id, digest: view.plan.digest, approvalNonce: view.approvalNonce }, 'ui', f.signal);
        assert.equal(receipt.state, 'unknown'); assert.equal(f.db.writes, 1);
        assert.ok(f.db.vertices.has(f.id));
        assert.ok([...f.db.edges.values()].some(edge => edge.outV === 'agent-a' && edge.inV === f.id));
        assert.ok([...f.db.edges.values()].some(edge => edge.outV === 'agent-c' && edge.inV === f.id));
    } finally { f.core.dispose(); }
});
