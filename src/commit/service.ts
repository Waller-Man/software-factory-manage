import { randomBytes } from 'node:crypto';
import type { CommitReceipt, CommitRequest, PreviewResult, ReceiptRequest, PlanStep } from '../types.ts';
import { digest, canonical } from '../canonical.ts';
import { ensure, failure } from '../errors.ts';
import { graphFingerprint, toNode } from '../gateway.ts';
import { plan, referencedIds, validDigest } from './plan.ts';
import type { DraftService } from '../drafts/service.ts';
import type { CudPort } from '../database/cud.ts';
import { resolveId } from '../database/cud.ts';
export class CommitService {
  private active = true;
  constructor(private readonly drafts: DraftService, private readonly writer: () => CudPort) {}
  preview(draftId: string, revision: number, uiHash: string, signal: AbortSignal): Promise<PreviewResult> {
    return this.drafts.queue.run(async () => {
      const row = this.drafts.record(draftId); ensure(row.draft.state === 'editing', 'DRAFT_LOCKED', '草稿不能重新提交'); ensure(row.draft.revision === revision, 'REVISION_CONFLICT', '草稿已变化');
      await this.writer().verifySchema(signal);
      const graph = await this.drafts.reader.load(referencedIds(row.draft), signal);
      for (const change of row.draft.changes) if (change.kind === 'create' && change.label === 'Agent' && change.properties.agent_id) ensure((await this.drafts.reader.agents(change.properties.agent_id, signal)).length === 0, 'ALREADY_EXISTS', '逻辑Agent ID已存在');
      row.plan = plan(row.draft, graph); const approvalNonce = randomBytes(32).toString('base64url'); row.approval = { nonceHash: digest(approvalNonce), uiHash };
      await this.drafts.save(row); return { plan: structuredClone(row.plan), approvalNonce };
    });
  }
  commit(input: CommitRequest, uiHash: string, signal: AbortSignal): Promise<CommitReceipt> {
    return this.drafts.queue.run(async () => {
      ensure(this.active, 'UNAVAILABLE', 'Manage已停用'); const row = this.drafts.record(input.draftId);
      const existing = row.receipts.find(receipt => receipt.requestId === input.planId);
      if (existing) { ensure(existing.digest === input.digest && existing.revision === input.expectedRevision, 'IDEMPOTENCY_CONFLICT', '同一请求不能提交不同计划'); return structuredClone(existing); }
      const frozen = row.plan, approval = row.approval;
      ensure(row.draft.state === 'editing' && frozen && approval, 'PLAN_STALE', '请先预览当前草稿');
      ensure(row.draft.revision === input.expectedRevision && frozen.revision === input.expectedRevision && frozen.id === input.planId && frozen.digest === input.digest && validDigest(frozen), 'PLAN_STALE', '草稿修订或计划摘要已变化');
      ensure(approval.uiHash === uiHash && approval.nonceHash === digest(input.approvalNonce) && Date.parse(frozen.expiresAt) > Date.now(), 'UNAUTHORIZED', '人工保存凭据失效，请在同一界面重新预览');
      const writer = this.writer(); await writer.verifySchema(signal);
      const graph = await this.drafts.reader.load(referencedIds(row.draft), signal);
      ensure(graphFingerprint(graph) === frozen.beforeFingerprint, 'DATA_CHANGED', '预览后数据库已变化，请重新预览');
      const receipt: CommitReceipt = { requestId: frozen.id, draftId: row.draft.id, revision: row.draft.revision, planId: frozen.id, digest: frozen.digest, state: 'executing', startedAt: new Date().toISOString(), results: [], bindings: {}, steps: structuredClone(frozen.steps) };
      row.receipts.push(receipt); row.draft.state = 'committing'; delete row.approval;
      await this.drafts.save(row); // Persist acceptance before the first physical write.
      try {
        for (const step of frozen.steps) {
          ensure(this.active, 'UNAVAILABLE', 'Manage停用，停止后续写入'); signal.throwIfAborted();
          if (step.operation === 'create_node' && step.afterNode?.label === 'Agent') ensure((await this.drafts.reader.agents(step.afterNode.properties.agent_id!, signal)).length === 0, 'ALREADY_EXISTS', '逻辑Agent ID已存在');
          let sent = false;
          try {
            const id = await writer.apply(step, receipt.bindings, signal, async () => {
              ensure(this.active && validDigest(frozen) && row.draft.state === 'committing', 'UNAUTHORIZED', '当前步骤不再属于已批准计划');
              receipt.results.push({ index: step.index, state: 'attempting' }); await this.drafts.save(row); sent = true;
            });
            if (id) receipt.results.at(-1)!.actualId = id;
            if (step.ref) {
              let actualId = id;
              if (!actualId && step.afterNode?.label === 'Agent') { const matches = await this.drafts.reader.agents(step.afterNode.properties.agent_id!, signal); if (matches.length === 1) actualId = matches[0]!.vertexId; }
              if (!actualId && step.afterNode?.label !== 'Agent') actualId = step.afterNode!.id;
              ensure(actualId, 'READBACK_MISMATCH', '新节点实际ID无法确认'); receipt.bindings[step.ref] = actualId;
            }
            await this.verify(step, receipt.bindings, signal);
            receipt.results.at(-1)!.state = 'verified'; await this.drafts.save(row);
          } catch (error) {
            if (sent) { receipt.results.at(-1)!.state = 'unknown'; receipt.results.at(-1)!.error = failure(error); }
            throw error;
          }
        }
        receipt.state = 'succeeded'; row.draft.state = 'saved';
      } catch (error) {
        receipt.error = failure(error);
        receipt.state = receipt.results.some(result => result.state === 'unknown') ? 'unknown' : receipt.results.some(result => result.state === 'verified') ? 'partial' : 'failed';
        row.draft.state = receipt.results.length ? 'attention' : 'editing';
      }
      receipt.finishedAt = new Date().toISOString(); row.draft.updatedAt = receipt.finishedAt; delete row.plan;
      await this.drafts.save(row); return structuredClone(receipt);
    });
  }
  private async verify(step: PlanStep, bindings: Record<string, string>, signal: AbortSignal): Promise<void> {
    if (step.operation === 'create_edge' || step.operation === 'delete_edge') {
      const edge = step.edge!, detail = await this.drafts.reader.node(resolveId(edge.outV, bindings), signal);
      const found = detail.relations.some(value => value.label === edge.label && value.outV === resolveId(edge.outV, bindings) && value.inV === resolveId(edge.inV, bindings));
      ensure(step.operation === 'create_edge' ? found : !detail.relations.some(value => value.id === edge.id), 'READBACK_MISMATCH', '关系回读与计划不一致'); return;
    }
    if (step.operation === 'delete_node') { ensure(!await this.drafts.reader.maybeNode(resolveId(step.beforeNode!.id, bindings), signal), 'READBACK_MISMATCH', '叶节点删除尚未回读确认'); return; }
    const expected = step.afterNode!, id = step.ref ? bindings[step.ref] : resolveId(expected.id, bindings), detail = await this.drafts.reader.node(id, signal);
    const actual = toNode(detail.node); ensure(actual.label === expected.label && canonical(actual.properties) === canonical(expected.properties), 'READBACK_MISMATCH', '节点属性回读与批准计划不一致');
  }
  receipt(input: ReceiptRequest): CommitReceipt {
    const receipt = this.drafts.record(input.draftId).receipts.find(receipt => receipt.requestId === input.requestId); ensure(receipt, 'NOT_FOUND', '回执不存在'); return structuredClone(receipt);
  }
  reconcile(input: ReceiptRequest, signal: AbortSignal): Promise<CommitReceipt> {
    return this.drafts.queue.run(async () => {
      const row = this.drafts.record(input.draftId), receipt = row.receipts.find(receipt => receipt.requestId === input.requestId); ensure(receipt, 'NOT_FOUND', '回执不存在');
      ensure(receipt.state !== 'executing', 'BUSY', '仍在执行，请先查询原回执');
      for (const result of receipt.results.filter(result => result.state !== 'verified')) {
        const step = receipt.steps[result.index];
        try {
          if (step.ref && !receipt.bindings[step.ref]) {
            if (step.afterNode?.label === 'Agent') {
              const found = await this.drafts.reader.agents(step.afterNode.properties.agent_id!, signal); ensure(found.length === 1, 'READBACK_MISMATCH', '不能唯一确认新Agent'); receipt.bindings[step.ref] = found[0]!.vertexId;
            } else receipt.bindings[step.ref] = step.afterNode!.id;
          }
          await this.verify(step, receipt.bindings, signal); result.state = 'verified'; delete result.error;
        } catch (error) { result.state = 'unknown'; result.error = failure(error); }
      }
      if (receipt.results.length === receipt.steps.length && receipt.results.every(result => result.state === 'verified')) { receipt.state = 'succeeded'; row.draft.state = 'saved'; delete receipt.error; }
      else if (receipt.results.some(result => result.state === 'unknown')) receipt.state = 'unknown';
      else if (receipt.results.some(result => result.state === 'verified')) receipt.state = 'partial';
      await this.drafts.save(row); return structuredClone(receipt);
    });
  }
  async dispose(): Promise<void> { this.active = false; await this.drafts.queue.settled(); }
}
