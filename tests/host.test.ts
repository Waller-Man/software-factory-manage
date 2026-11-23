/** Real Cordis + storageDomain + JSON persistence + strict Remote dispatcher.
 * Browser admission is a controlled test double, database is synthetic fetch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Settings from '@deepseek-ai/dsh-settings';
import Registry from '@deepseek-ai/dsh-typert-registry';
import ApiGateway from '@deepseek-ai/dsh-api-gateway';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domains from '@deepseek-ai/dsh-storage-domain';
import { bundlePatchPaths, loadOverlayPatches, composeEntries, evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';
import Manage from '../lib/index.js';
import { TYPERT } from '../lib/typert.host.js';
import remote from '../lib/typert.remote-client.js';
import { FakeDatabase, fixture } from './fixture.ts';
const packageRoot = resolve(import.meta.dirname, '..');
class TestConnection extends Service {
  operator: any;
  route?: { fetch: (request: Request) => Promise<Response> };
  constructor(ctx: Context) { super(ctx, 'connection'); this.operator = { id: 'synthetic-operator', ctx, dispose: async () => {} }; }
  get fetch() { return { register: (route: any) => { this.route = route; return async () => { this.route = undefined; }; } }; }
  admit(request: Request) { return request.headers.get('cookie') === 'dsh-test=synthetic' ? { peer: this.operator } : { rejection: 401 }; }
}
test('standard bundle, native settings, strict Remote, safe connection changes and persistence', { timeout: 30000 }, async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest), undefined);
  const rows = composeEntries([bundlePatchPaths(packageRoot, manifest.dsh.bundle).flatMap(path => loadOverlayPatches('manage-test', path))]);
  assert.equal(rows[0]!.id, 'sf-manage');
  for (const lang of ['zh', 'en']) assert.ok(JSON.parse(await readFile(join(packageRoot, 'locale', lang + '.json'), 'utf8')).meta.title);
  const resultRoot = resolve(packageRoot, '../../test-results'); await mkdir(resultRoot, { recursive: true });
  const scratch = await mkdtemp(join(resultRoot, 'manage-host-'));
  const componentConfig = { baseUrl: 'http://127.0.0.1:18080', graphSpace: 'DEFAULT', graph: 'hugegraph', username: 'synthetic', password: 'synthetic-only' };
  const ctx = new Context(), f = fixture(), previousFetch = globalThis.fetch;
  let holdWrite = false, releaseWrite!: () => void, writeStarted!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const started = new Promise<void>(resolve => { writeStarted = resolve; });
  const writeAuth: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      writeAuth.push(new Headers(init.headers).get('Authorization')!);
      if (holdWrite) { holdWrite = false; writeStarted(); await writeGate; }
    }
    return f.db.fetch(input, init);
  };
  try {
    await ctx.plugin(Registry); await ctx.plugin(ApiGateway, {}); await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root: join(scratch, 'storage') }); await ctx.plugin(Domains, { backend: 'json' }); await ctx.plugin(TestConnection);
    ctx.provide('hugegraphRead', f.gateway as never); const unregister = ctx.typert.register(TYPERT as never);
    assert.equal(remote.descriptors.length, 16);
    assert.ok(remote.descriptors.some(descriptor => descriptor.method === 'stageMoveVersion'));
    assert.ok(remote.descriptors.every(descriptor => descriptor.namespace === 'sfManage' && descriptor.cancellation?.parameter === 'signal'));
    await ctx.plugin(Loader);
    ctx.loader.builtins.syntheticManage = Manage;
    const entryId = await ctx.loader.create({ id: 'sf-manage', name: 'cordis:syntheticManage', config: componentConfig });
    const entry = ctx.loader.resolve(entryId);
    let fiber = entry.fiber!; await fiber.await();
    // Use production Settings.describe and a real active Loader entry. Only the editor inventory is synthetic.
    ctx.provide('profileContext', { home: scratch } as never);
    ctx.provide('configEditor', { configuration: () => [{ entry, inherited: componentConfig, override: componentConfig }] } as never);
    await ctx.plugin(Settings);
    const nativeForm = ctx.settings.describe({ redactSecrets: true }).find(form => form.ns === 'sf-manage');
    assert.ok(nativeForm, 'DSH must expose this component namespace to formFor(rowId)');
    assert.equal((nativeForm.value as any).baseUrl, componentConfig.baseUrl);
    assert.equal((nativeForm.value as any).password, undefined);
    assert.ok(!JSON.stringify(nativeForm).includes(componentConfig.password));
    for (const name of ['writer', 'commits', 'drafts', 'auth', 'config']) assert.equal((ctx.sfManage as any)[name], undefined, 'public facade must not expose ' + name);
    const call = (method: string, token: string, request: unknown) => ctx.typertGateway.invoke({ namespace: 'sfManage', method, args: { token, request } }) as Promise<any>;
    const denied = await call('createDraft', 'not-a-ui-capability', { mode: 'overview' }); assert.equal(denied.error.code, 'UNAUTHORIZED');
    assert.equal((await call('stageMoveVersion', 'not-a-ui-capability', { draftId: 'synthetic', expectedRevision: 0, target: { vertexId: 'version' }, parent: { vertexId: 'agent' } })).error.code, 'UNAUTHORIZED');
    const connection = ctx.connection as unknown as TestConnection;
    const bootstrap = async (origin = 'http://127.0.0.1:9999', cookie = 'dsh-test=synthetic') => connection.route!.fetch(new Request('http://dsh.internal/api/sf-manage/ui-session', { method: 'POST', headers: { host: '127.0.0.1:9999', origin, cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }));
    assert.equal((await bootstrap('http://cross-site.invalid')).status, 403); assert.equal((await bootstrap(undefined, 'wrong')).status, 403);
    let session = (await (await bootstrap()).json() as any).data;
    const foreign: any = await ctx.typertGateway.invoke({ namespace: 'sfManage', method: 'createDraft', args: { token: session.token, request: { mode: 'overview' } }, peer: { id: 'foreign-peer', ctx, dispose: async () => {} } as any }); assert.equal(foreign.error.code, 'UNAUTHORIZED');
    const direct = await ctx.sfManage.createDraft(session.token, { mode: 'overview' }); assert.ok(!direct.ok && direct.error.code === 'UNAUTHORIZED');
    const status = await call('status', session.token, {}); assert.ok(status.ok && status.data.readyToCommit, JSON.stringify(status));
    const bad = await call('createDraft', session.token, { mode: 'overview', approved: true }); assert.equal(bad.error.code, 'INVALID_INPUT');
    let response = await call('createDraft', session.token, { mode: 'overview', title: 'persistent synthetic draft' }); assert.ok(response.ok, JSON.stringify(response));
    let draft = response.data;
    response = await call('stageCreate', session.token, { draftId: draft.id, expectedRevision: draft.revision, label: 'Capability', parent: { vertexId: 'root' }, properties: { name: '原生Remote测试节点' } }); assert.ok(response.ok, JSON.stringify(response)); draft = response.data;
    const preview = await call('previewChanges', session.token, { draftId: draft.id, expectedRevision: draft.revision }); assert.ok(preview.ok, JSON.stringify(preview)); assert.equal(f.db.writes, 0);
    assert.ok(!JSON.stringify((await call('getDraft', session.token, { draftId: draft.id })).data).includes(preview.data.approvalNonce));
    const nextConfig = { ...componentConfig, username: 'synthetic-next' };
    await entry.update({ config: nextConfig }); await fiber.await();
    assert.equal(entry.fiber, fiber, 'native volatile edits must not remount the component');
    assert.equal((await call('getDraft', session.token, { draftId: draft.id })).error.code, 'UNAUTHORIZED');
    session = (await (await bootstrap()).json() as any).data;
    const stale = await call('commitChanges', session.token, { draftId: draft.id, expectedRevision: draft.revision, planId: preview.data.plan.id, digest: preview.data.plan.digest, approvalNonce: preview.data.approvalNonce });
    assert.equal(stale.error.code, 'PLAN_STALE'); assert.equal(f.db.writes, 0);
    const currentPreview = await call('previewChanges', session.token, { draftId: draft.id, expectedRevision: draft.revision }); assert.ok(currentPreview.ok, JSON.stringify(currentPreview));
    holdWrite = true;
    const saving = call('commitChanges', session.token, { draftId: draft.id, expectedRevision: draft.revision, planId: currentPreview.data.plan.id, digest: currentPreview.data.plan.digest, approvalNonce: currentPreview.data.approvalNonce });
    await started;
    await entry.update({ config: { ...nextConfig, username: 'synthetic-final', requestTimeoutMs: 11000 } });
    releaseWrite();
    const saved = await saving; assert.ok(saved.ok && saved.data.state === 'succeeded', JSON.stringify(saved)); assert.equal(f.db.writes, 2);
    assert.deepEqual(writeAuth, Array(2).fill('Basic ' + Buffer.from('synthetic-next:synthetic-only').toString('base64')), 'all steps of an accepted save keep the captured connection');
    const writes = f.db.writes;
    await fiber.dispose(); assert.equal(ctx.get('sfManage'), undefined); assert.equal(connection.route, undefined);
    fiber = await ctx.plugin(Manage, componentConfig);
    assert.equal((await call('getDraft', session.token, { draftId: draft.id })).error.code, 'UNAUTHORIZED');
    const renewed = (await (await bootstrap()).json() as any).data;
    const loaded = await call('getDraft', renewed.token, { draftId: draft.id }); assert.ok(loaded.ok && loaded.data.state === 'saved'); assert.equal(loaded.data.title, 'persistent synthetic draft');
    const receipt = await call('getReceipt', renewed.token, { draftId: draft.id, requestId: saved.data.requestId }); assert.ok(receipt.ok && receipt.data.state === 'succeeded'); assert.equal(f.db.writes, writes);
    await fiber.dispose(); unregister();
  } finally { releaseWrite(); globalThis.fetch = previousFetch; await ctx.fiber.dispose(); f.core.dispose(); }
});
