import { randomUUID } from 'node:crypto';
import type { CreateDraftRequest, DraftSummary, ManageDraft, StageCreateRequest, StageDeleteRequest, StageUpdateRequest, StageMoveVersionRequest, UndoChangeRequest, UpdateDraftRequest, NodeRef } from '../types.ts';
import { ensure } from '../errors.ts';
import { Serial } from '../canonical.ts';
import { GatewayReader, nodeKey } from '../gateway.ts';
import { referencedIds, simulate } from '../commit/plan.ts';
import { validateProperties, validateUpdate } from '../fields/validation.ts';
import type { DraftRecord, DraftStore } from './store.ts';
export class DraftService {
  readonly queue = new Serial();
  private active = true;
  constructor(readonly store: DraftStore, readonly reader: GatewayReader) {}
  record(id: string): DraftRecord { ensure(this.active, 'UNAVAILABLE', 'Manage已停用'); const row = this.store.get(id); ensure(row?.owner === 'operator', 'NOT_FOUND', '草稿不存在或已删除'); return structuredClone(row); }
  load(id: string): ManageDraft { const row = this.record(id); const last = row.receipts.at(-1); return { ...row.draft, ...(last ? { lastCommitRequestId: last.requestId } : {}) }; }
  list(includeSaved = false): DraftSummary[] {
    return [...this.store.entries()].map(([, row]) => row.draft).filter(draft => includeSaved || draft.state !== 'saved').map(draft => ({ id: draft.id, title: draft.title, mode: draft.mode, revision: draft.revision, state: draft.state, updatedAt: draft.updatedAt, changeCount: draft.changes.length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async save(row: DraftRecord): Promise<void> { ensure(this.active, 'UNAVAILABLE', 'Manage已停用'); ensure(Buffer.byteLength(JSON.stringify(row)) <= 2 * 1024 * 1024, 'LIMIT', '草稿达到大小限制'); await this.store.put(row.draft.id, structuredClone(row)); }
  async create(input: CreateDraftRequest, signal: AbortSignal): Promise<ManageDraft> {
    return this.queue.run(async () => {
      ensure([...this.store.entries()].length < 500, 'LIMIT', '草稿数量达到上限');
      const at = new Date().toISOString(), draft: ManageDraft = { id: randomUUID(), formatVersion: 1, title: input.title ?? '未命名草稿', mode: input.mode, revision: 0, state: 'editing', createdAt: at, updatedAt: at, context: { step: 0, origin: input.mode === 'overview' ? 'overview' : 'manage' }, changes: [], bases: {} };
      if (input.targetVertexId) {
        const data = await this.reader.node(input.targetVertexId, signal);
        ensure(data.node.label !== 'FieldGroup', 'ILLEGAL_NODE', '不能编辑FieldGroup');
        if (input.mode === 'edit-version') ensure(data.node.label === 'AgentVersion', 'ILLEGAL_NODE', '版本修改模式需选择AgentVersion');
        draft.bases[input.targetVertexId] = data.node; draft.context.selected = { vertexId: input.targetVertexId };
        if (data.node.label === 'AgentVersion') draft.context.editingVersion = { vertexId: input.targetVertexId };
      }
      await this.save({ draft, owner: 'operator', receipts: [] }); return structuredClone(draft);
    });
  }
  async mutate(id: string, revision: number, fn: (row: DraftRecord) => Promise<void> | void): Promise<ManageDraft> {
    return this.queue.run(async () => {
      const row = this.record(id); ensure(row.draft.state === 'editing', 'DRAFT_LOCKED', '草稿已提交或结果待核对');
      ensure(row.draft.revision === revision, 'REVISION_CONFLICT', '草稿已变化，请载入最新修订');
      await fn(row); ensure(row.draft.changes.length <= 50, 'LIMIT', '每份草稿最多50项变更'); row.draft.revision++; row.draft.updatedAt = new Date().toISOString(); delete row.plan; delete row.approval;
      await this.save(row); return structuredClone(row.draft);
    });
  }
  update(input: UpdateDraftRequest): Promise<ManageDraft> {
    if (input.title === undefined && input.context) return this.queue.run(async () => {
      const row = this.record(input.draftId); ensure(row.draft.state === 'editing', 'DRAFT_LOCKED', '草稿已锁定'); ensure(row.draft.revision === input.expectedRevision, 'REVISION_CONFLICT', '草稿已变化');
      row.draft.context = input.context!; row.draft.updatedAt = new Date().toISOString(); await this.save(row); return structuredClone(row.draft);
    });
    return this.mutate(input.draftId, input.expectedRevision, row => { if (input.title !== undefined) row.draft.title = input.title; if (input.context) row.draft.context = input.context; });
  }
  async remove(id: string, revision: number): Promise<{ deleted: true }> {
    return this.queue.run(async () => { const row = this.record(id); ensure(row.draft.revision === revision, 'REVISION_CONFLICT', '草稿已变化'); ensure(row.draft.state !== 'committing' && row.draft.state !== 'attention', 'DRAFT_LOCKED', '执行中或待核对草稿不能删除'); await this.store.delete(id); return { deleted: true }; });
  }
  private async baseline(row: DraftRecord, target: NodeRef, signal: AbortSignal): Promise<void> {
    if ('vertexId' in target && !row.draft.bases[target.vertexId]) row.draft.bases[target.vertexId] = (await this.reader.node(target.vertexId, signal)).node;
  }
  stageCreate(input: StageCreateRequest, signal: AbortSignal): Promise<ManageDraft> {
    return this.mutate(input.draftId, input.expectedRevision, async row => {
      validateProperties(input.label, input.properties); ensure(row.draft.changes.length < 50, 'LIMIT', '每份草稿最多50项变更');
      const id = randomUUID(); row.draft.changes.push({ id, kind: 'create', ref: 'draft:' + id, label: input.label, parent: input.parent, properties: { ...input.properties } });
      const graph = await this.reader.load(referencedIds(row.draft), signal); simulate(row.draft, graph, false);
    });
  }
  stageUpdate(input: StageUpdateRequest, signal: AbortSignal): Promise<ManageDraft> {
    return this.mutate(input.draftId, input.expectedRevision, async row => {
      const set = input.set ?? {}, unset = [...new Set(input.unset ?? [])];
      ensure(Object.keys(set).length + unset.length > 0, 'VALIDATION_FAILED', '请提供set或unset');
      ensure(unset.every(key => !Object.hasOwn(set, key)), 'VALIDATION_FAILED', '同一字段不能同时set和unset');
      if ('ref' in input.target) {
        const ref = input.target.ref, change = row.draft.changes.find(change => change.kind === 'create' && change.ref === ref);
        ensure(change?.kind === 'create', 'NOT_FOUND', '新增草稿节点不存在'); validateProperties(change.label, set);
        for (const key of unset) { validateProperties(change.label, { [key]: '' }); delete change.properties[key]; }
        Object.assign(change.properties, set);
      } else {
        await this.baseline(row, input.target, signal); const base = row.draft.bases[input.target.vertexId]; ensure(base.label !== 'FieldGroup', 'ILLEGAL_NODE', '不可修改FieldGroup'); validateUpdate(base.label, set, unset);
        if (base.label === 'Agent') ensure(!row.draft.context.editingVersion, 'EDIT_SCOPE', '版本修改流程不能改逻辑Agent共享字段，请从概览打开该逻辑Agent的修改入口');
        const existing = row.draft.changes.find(change => change.kind === 'update' && nodeKey(change.target) === nodeKey(input.target));
        if (existing?.kind === 'update') {
          for (const key of unset) delete existing.set[key]; Object.assign(existing.set, set);
          existing.unset = [...new Set([...existing.unset.filter(key => !Object.hasOwn(set, key)), ...unset])];
        } else row.draft.changes.push({ id: randomUUID(), kind: 'update', target: input.target, set: { ...set }, unset });
      }
      const graph = await this.reader.load(referencedIds(row.draft), signal); simulate(row.draft, graph, false);
    });
  }
  stageMoveVersion(input: StageMoveVersionRequest, signal: AbortSignal): Promise<ManageDraft> {
    return this.mutate(input.draftId, input.expectedRevision, async row => {
      const refs = [input.target, input.parent];
      const graph = await this.reader.load([...referencedIds(row.draft), ...refs.flatMap(ref => 'vertexId' in ref ? [ref.vertexId] : [])], signal);
      const current = simulate(row.draft, graph, false).graph, targetId = nodeKey(input.target), parentId = nodeKey(input.parent);
      const target = current.nodes.find(node => node.id === targetId), parent = current.nodes.find(node => node.id === parentId);
      ensure(target?.label === 'AgentVersion', 'ILLEGAL_NODE', '只能更换AgentVersion的归属');
      ensure(parent?.label === 'Agent', 'ILLEGAL_RELATION', '版本只能挂到逻辑Agent，不能选择能力分类或版本');
      ensure(!row.draft.changes.some(change => change.kind === 'delete' && nodeKey(change.target) === targetId), 'NOT_FOUND', '该版本已在草稿删除');
      if ('ref' in input.target) {
        const change = row.draft.changes.find(change => change.kind === 'create' && change.ref === targetId);
        ensure(change?.kind === 'create', 'NOT_FOUND', '新增版本草稿不存在');
        change.parent = input.parent;
      } else {
        await this.baseline(row, input.target, signal);
        const originalParents = graph.edges.filter(edge => edge.label === 'HAS_VERSION' && edge.inV === targetId);
        ensure(originalParents.length === 1, 'AMBIGUOUS_PARENT', '版本必须有且只有一个原逻辑Agent，不能自动处理多个归属');
        const fromParentId = originalParents[0].outV;
        const prior = row.draft.changes.find(change => change.kind === 'move-version' && nodeKey(change.target) === targetId);
        row.draft.changes = row.draft.changes.filter(change => !(change.kind === 'move-version' && nodeKey(change.target) === targetId));
        if (fromParentId !== parentId) row.draft.changes.push({ id: prior?.id ?? randomUUID(), kind: 'move-version', target: input.target, fromParentId, parent: input.parent });
      }
      simulate(row.draft, graph, false);
      row.draft.context = { ...row.draft.context, selected: input.target, editingVersion: input.target };
    });
  }
  stageDelete(input: StageDeleteRequest, signal: AbortSignal): Promise<ManageDraft> {
    return this.mutate(input.draftId, input.expectedRevision, async row => {
      const graph = await this.reader.load([...referencedIds(row.draft), ...('vertexId' in input.target ? [input.target.vertexId] : [])], signal);
      const current = simulate(row.draft, graph, false).graph, key = nodeKey(input.target);
      ensure(current.nodes.some(node => node.id === key), 'NOT_FOUND', '目标节点不存在'); ensure(key !== current.rootId, 'ROOT_PROTECTED', '根节点不能删除');
      ensure(!current.edges.some(edge => edge.outV === key), 'NOT_LEAF', '节点仍有孩子，不能删除');
      if ('ref' in input.target) row.draft.changes = row.draft.changes.filter(change => !(change.kind === 'create' && change.ref === key));
      else {
        await this.baseline(row, input.target, signal);
        row.draft.changes = row.draft.changes.filter(change => !('target' in change && nodeKey(change.target) === key));
        row.draft.changes.push({ id: randomUUID(), kind: 'delete', target: input.target, confirmedParentIds: input.confirmedParentIds ?? [] });
        simulate(row.draft, graph, false);
      }
    });
  }
  undo(input: UndoChangeRequest, signal: AbortSignal): Promise<ManageDraft> {
    return this.mutate(input.draftId, input.expectedRevision, async row => {
      const removed = row.draft.changes.find(change => change.id === input.changeId); ensure(removed, 'NOT_FOUND', '变更不存在');
      row.draft.changes = row.draft.changes.filter(change => change.id !== input.changeId);
      // Explicitly undoing an existing-node edit also releases its old baseline,
      // so the next edit can load current data instead of remaining stale forever.
      if ('target' in removed && 'vertexId' in removed.target) {
        const id = removed.target.vertexId;
        if (!row.draft.changes.some(change => 'target' in change && 'vertexId' in change.target && change.target.vertexId === id)) delete row.draft.bases[id];
      }
      const graph = await this.reader.load(referencedIds(row.draft), signal); simulate(row.draft, graph, false);
    });
  }
  async recover(): Promise<void> {
    for (const [, current] of this.store.entries()) {
      const row = structuredClone(current); delete row.plan; delete row.approval;
      for (const receipt of row.receipts) if (receipt.state === 'executing') { receipt.state = 'unknown'; receipt.error = { code: 'HOST_RESTARTED', message: '宿主重启，请只读核对原回执，不自动重放写入' }; row.draft.state = 'attention'; }
      await this.save(row);
    }
  }
  async dispose(): Promise<void> { await this.queue.settled(); this.active = false; }
}
