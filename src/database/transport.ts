/** Private fixed REST transport. Never exported as a service or Remote. */
import { ensure, ManageFailure } from '../errors.ts';
export interface Connection { baseUrl: string; graph: string; graphSpace?: string; username: string; password: string }
export class WriteTransport {
  private base: string;
  private authorization: string;
  constructor(config: Connection, private readonly timeoutMs = 10000, private readonly fetcher: typeof fetch = fetch) {
    let url: URL; try { url = new URL(config.baseUrl); } catch { throw new ManageFailure('CONFIG', '数据库地址无效'); }
    ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'CONFIG', '数据库地址必须是无凭据的HTTP(S) origin');
    ensure(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'CONFIG', '远程数据库需要HTTPS');
    for (const name of [config.graph, ...(config.graphSpace ? [config.graphSpace] : [])]) ensure(/^[A-Za-z0-9_-]+$/.test(name) && !name.startsWith('__'), 'CONFIG', '图或图空间名称无效');
    this.base = url.origin + (config.graphSpace ? '/graphspaces/' + encodeURIComponent(config.graphSpace) : '') + '/graphs/' + encodeURIComponent(config.graph);
    this.authorization = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
  }
  // Only CudWriter calls this internal transport with paths it constructs.
  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown> | undefined> {
    ensure(this.authorization, 'UNAVAILABLE', '数据库客户端已停用'); signal.throwIfAborted();
    ensure(path === '/schema' && method === 'GET' || /^\/graph\/(vertices|edges)(?:\/[^?]+)?(?:\?action=(append|eliminate))?$/.test(path), 'INVALID_INPUT', '非白名单数据库路径');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let response: Response;
    try { response = await this.fetcher(this.base + path, { method, redirect: 'error', signal: combined, headers: { Authorization: this.authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new ManageFailure(method === 'GET' ? 'DATABASE' : 'WRITE_UNKNOWN', '数据库请求未完成，请保留回执核对'); }
    if (response.status === 404 && method === 'GET') { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new ManageFailure(method === 'GET' ? 'DATABASE' : 'WRITE_UNKNOWN', '数据库返回HTTP ' + response.status + '，未回显响应正文'); }
    if (response.status === 204) return {};
    const reader = response.body?.getReader(); ensure(reader, 'DATABASE', '数据库响应为空');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { combined.throwIfAborted(); const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; ensure(bytes <= 2 * 1024 * 1024, 'LIMIT', '数据库响应过大'); chunks.push(item.value); } }
    finally { await reader.cancel().catch(() => {}); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ManageFailure('DATABASE', '数据库响应不是JSON'); }
    ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'DATABASE', '数据库响应格式无效'); return raw as Record<string, unknown>;
  }
  dispose(): void { this.authorization = ''; }
}
