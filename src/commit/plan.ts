import { randomUUID } from 'node:crypto';
import type { ChangePlan, ManageDraft, PlanNode, PlanStep, NodeRef } from '../types.ts';
import type { GraphState } from '../gateway.ts';
import { graphFingerprint, nodeKey, toNode } from '../gateway.ts';
import { canonical, digest } from '../canonical.ts';
import { ensure } from '../errors.ts';
import { relations, versionId, required } from '../fields/definitions.ts';
import { validateProperties, validateUpdate } from '../fields/validation.ts';
export function referencedIds(draft: ManageDraft): string[] {
  return [...new Set(draft.changes.flatMap(change => {
    const refs = change.kind === 'create' ? [change.parent] : change.kind === 'move-version' ? [change.target, change.parent, { vertexId: change.fromParentId }] : [change.target];
    return refs.flatMap(ref => 'vertexId' in ref ? [ref.vertexId] : []);
  }))];
}
export function simulate(draft: ManageDraft, original: GraphState, complete: boolean): { graph: GraphState; steps: PlanStep[] } {
  const graph = structuredClone(original), nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const steps: PlanStep[] = [];
  const push = (step: Omit<PlanStep, 'index'>) => steps.push({ index: steps.length, ...step });
  const find = (ref: NodeRef): PlanNode => { const node = nodes.get(nodeKey(ref)); ensure(node, 'NOT_FOUND', '草稿目标或父节点不存在'); return node; };
  for (const change of draft.changes) {
    if (change.kind === 'create') {
      const parent = find(change.parent), edgeLabel = (relations[parent.label] as Record<string, string>)[change.label];
      ensure(edgeLabel, 'ILLEGAL_RELATION', '此父节点不允许新增该类子节点');
      validateProperties(change.label, change.properties, complete);
      if (change.label === 'Agent' && change.properties.agent_id?.trim()) ensure(![...nodes.values()].some(node => node.label === 'Agent' && node.properties.agent_id === change.properties.agent_id), 'ALREADY_EXISTS', '逻辑Agent ID已存在，请选择已有Agent');
      let nativeId = change.ref;
      if (change.label === 'Capability') nativeId = 'cap:' + change.id;
      if (change.label === 'AgentVersion' && parent.properties.agent_id && change.properties.version) {
        nativeId = versionId(parent.properties.agent_id, change.properties.version);
        ensure(!nodes.has(nativeId), 'ALREADY_EXISTS', '版本节点ID已被占用，不能覆盖已有节点');
      }
      ensure(!nodes.has(change.ref) && ![...nodes.values()].some(node => node.id === nativeId), 'ALREADY_EXISTS', '新节点身份冲突');
      const node: PlanNode = { id: nativeId, label: change.label, properties: { ...change.properties } };
      push({ operation: 'create_node', description: `新增${change.label}：${change.properties.name ?? change.properties.version ?? '未填写'}`, afterNode: node, ref: change.ref });
      const edge = { id: 'draft-edge:' + change.id, label: edgeLabel as 'HAS_CHILD' | 'HAS_AGENT' | 'HAS_VERSION', outV: parent.id, inV: change.ref };
      push({ operation: 'create_edge', description: '建立' + edge.label + '关系', edge });
      nodes.set(change.ref, { ...node, id: change.ref }); graph.edges.push(edge);
      continue;
    }
    const before = structuredClone(find(change.target));
    ensure(before.id !== graph.rootId, 'ROOT_PROTECTED', '根节点不能修改或删除');
    if ('vertexId' in change.target && draft.bases[before.id]) ensure(canonical(toNode(draft.bases[before.id])) === canonical(original.nodes.find(node => node.id === before.id)), 'DATA_CHANGED', '编辑对象已变化，请保留草稿并重新读取该对象');
    if (change.kind === 'move-version') {
      const parent = find(change.parent);
      ensure(before.label === 'AgentVersion' && parent.label === 'Agent', 'ILLEGAL_RELATION', '版本只能挂到逻辑Agent');
      const old = graph.edges.filter(edge => edge.label === 'HAS_VERSION' && edge.inV === before.id);
      ensure(old.length === 1 && old[0].outV === change.fromParentId, 'DATA_CHANGED', '版本原归属已变化，请重新核对');
      if (parent.id !== change.fromParentId) {
        const edge = { id: 'draft-move:' + change.id, label: 'HAS_VERSION' as const, outV: parent.id, inV: before.id };
        // Reuse the approved edge writer. Preserve the version even if a later step fails.
        push({ operation: 'create_edge', description: '为原版本建立新归属', edge });
        push({ operation: 'delete_edge', description: '解除原版本的旧归属', edge: old[0] });
        graph.edges = graph.edges.filter(item => item.id !== old[0].id); graph.edges.push(edge);
      }
    } else if (change.kind === 'update') {
      validateUpdate(before.label, change.set, change.unset);
      const after = structuredClone(before); Object.assign(after.properties, change.set);
      if (complete) {
        for (const [key, value] of Object.entries(change.set)) validateProperties(before.label, { [key]: value }, true, false);
        for (const key of required[before.label]) ensure(typeof after.properties[key] === 'string' && !!after.properties[key].trim(), 'VALIDATION_FAILED', '缺少实际数据库必填内容', key);
      }
      if (Object.keys(change.set).some(key => before.properties[key] !== change.set[key])) push({ operation: 'update_node', description: '修改' + before.label, beforeNode: before, afterNode: structuredClone(after), set: { ...change.set } });
      const actualUnset = change.unset.filter(key => Object.hasOwn(after.properties, key));
      if (actualUnset.length) {
        const prior = structuredClone(after); for (const key of actualUnset) delete after.properties[key];
        push({ operation: 'unset_properties', description: '清空可选属性：' + actualUnset.join('、'), beforeNode: prior, afterNode: structuredClone(after), unset: actualUnset });
      }
      nodes.set(before.id, after);
    } else {
      ensure(!graph.edges.some(edge => edge.outV === before.id), 'NOT_LEAF', '节点仍有孩子，不能删除');
      const parents = graph.edges.filter(edge => edge.inV === before.id), parentIds = parents.map(edge => edge.outV).sort();
      if (parents.length > 1) ensure(canonical(parentIds) === canonical([...change.confirmedParentIds].sort()), 'SHARED_DELETE_CONFIRMATION_REQUIRED', '节点有多个父级，请展示全部挂载并由用户明确确认');
      for (const edge of parents) push({ operation: 'delete_edge', description: '删除挂载关系' + edge.label, edge });
      push({ operation: 'delete_node', description: '删除叶节点' + (before.properties.name ?? before.properties.version), beforeNode: before });
      graph.edges = graph.edges.filter(edge => edge.inV !== before.id); nodes.delete(before.id);
    }
  }
  // Check the resulting graph, including both property edits and moves. The
  // stable vertexId is a locator; it is not recomputed from the displayed version.
  const versions = new Map<string, string>();
  for (const edge of graph.edges.filter(edge => edge.label === 'HAS_VERSION')) {
    const node = nodes.get(edge.inV), version = node?.properties.version;
    if (!version?.trim()) continue; // Incomplete drafts remain allowed; preview checks required text.
    const key = JSON.stringify([edge.outV, version]), prior = versions.get(key);
    ensure(!prior || prior === edge.inV, 'ALREADY_EXISTS', '同一逻辑Agent下版本号不能重复', 'version');
    versions.set(key, edge.inV);
  }
  graph.nodes = [...nodes.values()]; return { graph, steps };
}
export function plan(draft: ManageDraft, graph: GraphState): ChangePlan {
  const { steps } = simulate(draft, graph, true);
  ensure(steps.length > 0 && steps.length <= 100, 'VALIDATION_FAILED', '需要1至100个实际写入步骤');
  const now = Date.now(), result: ChangePlan = { id: randomUUID(), draftId: draft.id, revision: draft.revision, digest: '', beforeFingerprint: graphFingerprint(graph), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), steps };
  result.digest = digest({ ...result, digest: '' }); return result;
}
export const validDigest = (value: ChangePlan): boolean => value.digest === digest({ ...value, digest: '' });
