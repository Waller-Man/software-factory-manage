import { Context, Service } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ZodError, type ZodType } from 'zod';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { ManageResult, ManageStatus, ManageDraft, DraftSummary, CreateDraftRequest, ListDraftsRequest, DraftIdRequest, RevisionRequest, UpdateDraftRequest, StageCreateRequest, StageUpdateRequest, StageDeleteRequest, StageMoveVersionRequest, UndoChangeRequest, PreviewResult, CommitRequest, CommitReceipt, ReceiptRequest, HugeGraphReadService } from '../types.ts';
import { Config, type ManageConfig } from '../config.ts';
import { failure, ensure } from '../errors.ts';
import { GatewayReader } from '../gateway.ts';
import { readConnectionEnv, connectionEnvPath } from '../env.ts';
import { WriteTransport } from '../database/transport.ts';
import { CudWriter } from '../database/cud.ts';
import { DraftService } from '../drafts/service.ts';
import { domainSpec } from '../drafts/store.ts';
import { CommitService } from '../commit/service.ts';
import { UiAuthorization, UI_SESSION_PATH } from './authorization.ts';
import { requests } from './schemas.ts';
import { AssistantRuntime } from '../assistant/runtime.ts';
import type { AssistantRequest, AssistantSession } from '../types.ts';
declare module '@deepseek-ai/cordis' { interface Context { sfManage: ManageApi; hugegraphRead: HugeGraphReadService } }

interface Backend {
  auth: UiAuthorization; drafts?: DraftService; commits?: CommitService; writer?: CudWriter;
  writerError: { code: string; message: string }; reader: GatewayReader;
  lifetime: AbortController; calls: Set<Promise<unknown>>;
  assistant?: AssistantRuntime;
}
// Keep the actual writer/approval components off the publicly injectable facade.
// An opaque owner object also works through Cordis's context-bound Service view.
const backends = new WeakMap<object, Backend>();
function state(owner: object): Backend { const value = backends.get(owner); ensure(value, 'UNAVAILABLE', 'Manage状态已释放'); return value; }

/** Remote facade only; no raw writer or approval method is a model Tool. */
export class ManageApi extends TypertRemoteService {
  static inject = ['typert', 'storageDomain', 'connection'];
  static Config = Config;
  private ownerKey = {};
  constructor(ctx: Context, private config: ManageConfig) {
    super(ctx, 'sfManage');
    backends.set(this.ownerKey, { auth: new UiAuthorization(), writerError: { code: 'CONFIG', message: '尚未加载数据库连接' }, reader: new GatewayReader(() => ctx.get('hugegraphRead')), lifetime: new AbortController(), calls: new Set() });
  }
  protected async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    const backend = state(this.ownerKey);
    const domain = await this.ctx.storageDomain.open(domainSpec);
    backend.drafts = new DraftService(domain.table('drafts'), backend.reader); await backend.drafts.recover();
    try { backend.writer = new CudWriter(new WriteTransport(await readConnectionEnv(this.config.envFile), this.config.requestTimeoutMs)); }
    catch (error) { backend.writerError = failure(error); }
    backend.commits = new CommitService(backend.drafts, () => { ensure(backend.writer, backend.writerError.code, backend.writerError.message); return backend.writer; });
    const stopAssistant = this.ctx.inject(['agents', 'tools', 'systemPrompt', 'agentPresets', 'workingDirectory'], scope => {
      const runtime = new AssistantRuntime(scope, backend.drafts!, [connectionEnvPath(this.config.envFile)]); backend.assistant = runtime;
      scope.effect(() => async () => { backend.assistant = undefined; await runtime.dispose(); });
    });
    const connection = this.ctx.connection;
    const remove = connection.fetch.register({ path: UI_SESSION_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => backend.auth.bootstrap(request, connection) });
    yield async () => {
      backend.auth.dispose(); backend.lifetime.abort(); await remove();
      await stopAssistant.dispose();
      await backend.commits?.dispose(); await Promise.allSettled([...backend.calls]); await backend.drafts?.dispose(); backend.writer?.dispose(); await domain.close();
      backend.drafts = undefined; backend.commits = undefined; backend.writer = undefined;
    };
  }
  private async run<I, O>(token: string, request: I, schema: ZodType<I>, fn: (input: I, uiHash: string, signal: AbortSignal) => O | Promise<O>, signal?: AbortSignal): Promise<ManageResult<O>> {
    try {
      const backend = state(this.ownerKey), hash = backend.auth.check(this.ctx.invocation, token); ensure(backend.drafts && backend.commits, 'UNAVAILABLE', 'Manage尚未就绪');
      const original = this.ctx.invocation?.request.args.request ?? request;
      ensure(Buffer.byteLength(JSON.stringify(original) ?? '') <= 256 * 1024, 'LIMIT', '请求过大');
      const input = schema.parse(original), combined = AbortSignal.any([backend.lifetime.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
      const call = Promise.resolve().then(() => fn(input, hash, combined)); backend.calls.add(call);
      try { return { ok: true, data: await call }; } finally { backend.calls.delete(call); }
    } catch (error) {
      if (error instanceof ZodError) return { ok: false, error: { code: 'INVALID_INPUT', message: '请求字段、类型或取值不符合接口', field: error.issues[0]?.path.join('.') } };
      return { ok: false, error: failure(error) };
    }
  }
  @Remote
  async status(token: string, request: Record<string, never>, signal?: AbortSignal): Promise<ManageResult<ManageStatus>> {
    return this.run(token, request, requests.empty, async (_input, _hash, signal) => {
      const backend = state(this.ownerKey);
      let gatewayReady = false, writerReady = false, diagnostic = backend.writer ? undefined : backend.writerError;
      try { gatewayReady = await backend.reader.ready(signal); } catch (error) { diagnostic ??= failure(error); }
      if (backend.writer) try { await backend.writer.verifySchema(signal); writerReady = true; } catch (error) { diagnostic ??= failure(error); }
      if (!gatewayReady) diagnostic ??= { code: 'DEPENDENCY_UNAVAILABLE', message: 'Gateway未就绪，请检查hugegraphRead.health' };
      return { apiVersion: '1.0', readyToCommit: gatewayReady && writerReady, gatewayReady, writerReady, ...(diagnostic ? { diagnostic } : {}), aiSessionIncluded: !!backend.assistant };
    }, signal);
  }
  /** Only composes a restricted preset; it grants no draft, approval or database authority. */
  protected composeAssistantPreset(scope: Context): void { const runtime = state(this.ownerKey).assistant; ensure(runtime, 'DEPENDENCY_UNAVAILABLE', 'Manage AI依赖未就绪'); runtime.install(scope); }
  @Remote
  async ensureAssistant(token: string, request: AssistantRequest, signal?: AbortSignal): Promise<ManageResult<AssistantSession>> { return this.run(token, request, requests.assistant, (input, _hash, signal) => { const runtime = state(this.ownerKey).assistant; ensure(runtime, 'DEPENDENCY_UNAVAILABLE', '需要Agents、Tools、SystemPrompt、AgentPresets和WorkingDirectory服务'); return runtime.ensure(input.draftId, input.sourceSessionId, signal); }, signal); }
  @Remote
  async createDraft(token: string, request: CreateDraftRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.createDraft, (input, _hash, signal) => state(this.ownerKey).drafts!.create(input, signal), signal); }
  @Remote
  async listDrafts(token: string, request: ListDraftsRequest, signal?: AbortSignal): Promise<ManageResult<DraftSummary[]>> { return this.run(token, request, requests.listDrafts, input => state(this.ownerKey).drafts!.list(input.includeSaved), signal); }
  @Remote
  async getDraft(token: string, request: DraftIdRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.getDraft, input => state(this.ownerKey).drafts!.load(input.draftId), signal); }
  @Remote
  async updateDraft(token: string, request: UpdateDraftRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.updateDraft, input => state(this.ownerKey).drafts!.update(input), signal); }
  @Remote
  async deleteDraft(token: string, request: RevisionRequest, signal?: AbortSignal): Promise<ManageResult<{ deleted: true }>> { return this.run(token, request, requests.revision, input => state(this.ownerKey).drafts!.remove(input.draftId, input.expectedRevision), signal); }
  @Remote
  async stageCreate(token: string, request: StageCreateRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.stageCreate, (input, _hash, signal) => state(this.ownerKey).drafts!.stageCreate(input, signal), signal); }
  @Remote
  async stageUpdate(token: string, request: StageUpdateRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.stageUpdate, (input, _hash, signal) => state(this.ownerKey).drafts!.stageUpdate(input, signal), signal); }
  @Remote
  async stageMoveVersion(token: string, request: StageMoveVersionRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.stageMoveVersion, (input, _hash, signal) => state(this.ownerKey).drafts!.stageMoveVersion(input, signal), signal); }
  @Remote
  async stageDelete(token: string, request: StageDeleteRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.stageDelete, (input, _hash, signal) => state(this.ownerKey).drafts!.stageDelete(input, signal), signal); }
  @Remote
  async undoChange(token: string, request: UndoChangeRequest, signal?: AbortSignal): Promise<ManageResult<ManageDraft>> { return this.run(token, request, requests.undoChange, (input, _hash, signal) => state(this.ownerKey).drafts!.undo(input, signal), signal); }
  @Remote
  async previewChanges(token: string, request: RevisionRequest, signal?: AbortSignal): Promise<ManageResult<PreviewResult>> { return this.run(token, request, requests.revision, (input, hash, signal) => state(this.ownerKey).commits!.preview(input.draftId, input.expectedRevision, hash, signal), signal); }
  @Remote
  async commitChanges(token: string, request: CommitRequest, signal?: AbortSignal): Promise<ManageResult<CommitReceipt>> { return this.run(token, request, requests.commit, (input, hash, signal) => state(this.ownerKey).commits!.commit(input, hash, signal), signal); }
  @Remote
  async getReceipt(token: string, request: ReceiptRequest, signal?: AbortSignal): Promise<ManageResult<CommitReceipt>> { return this.run(token, request, requests.receipt, input => state(this.ownerKey).commits!.receipt(input), signal); }
  @Remote
  async reconcile(token: string, request: ReceiptRequest, signal?: AbortSignal): Promise<ManageResult<CommitReceipt>> { return this.run(token, request, requests.receipt, (input, _hash, signal) => state(this.ownerKey).commits!.reconcile(input, signal), signal); }
}
export default ManageApi;

