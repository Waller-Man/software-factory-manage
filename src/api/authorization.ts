import { randomBytes } from 'node:crypto';
import type { RemoteInvocation, PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { digest } from '../canonical.ts';
import { ensure, failure } from '../errors.ts';
export const UI_SESSION_PATH = '/api/sf-manage/ui-session';
/** UI-only capability, never persisted or projected into a model/session log. */
export class UiAuthorization {
  private sessions = new Map<string, { peer: PeerScope; expires: number }>();
  private active = true;
  constructor(private readonly lifetimeMs = 20 * 60_000) {}
  async bootstrap(request: Request, connection: HostConnectionHandle): Promise<Response> {
    try {
      ensure(this.active, 'UNAVAILABLE', 'Manage已停用');
      const admission = connection.admit(request); ensure('peer' in admission, 'UNAUTHORIZED', '需要已登录的DSH网页');
      // DSH's node:http bridge uses http://dsh.internal for Request.url;
      // the authenticated original Host/Origin headers are the browser facts.
      let origin: URL | undefined; try { origin = new URL(request.headers.get('origin') ?? ''); } catch { /* denied below */ }
      ensure(request.method === 'POST' && origin && ['http:', 'https:'].includes(origin.protocol) && origin.origin === request.headers.get('origin') && origin.host === request.headers.get('host') && request.headers.get('sec-fetch-site') === 'same-origin', 'UNAUTHORIZED', '仅接受同源网页申请');
      ensure(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'INVALID_INPUT', '需要application/json');
      const body = await request.text(); ensure(body.length <= 512 && /^\s*\{\s*\}\s*$/.test(body), 'INVALID_INPUT', '请求体必须为空对象');
      const now = Date.now(); for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
      ensure(this.sessions.size < 128, 'BUSY', '界面连接过多，请稍后重试');
      const token = randomBytes(32).toString('base64url'), expires = now + this.lifetimeMs;
      this.sessions.set(digest(token), { peer: admission.peer, expires });
      return Response.json({ ok: true, data: { token, expiresAt: new Date(expires).toISOString() } }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) { return Response.json({ ok: false, error: failure(error) }, { status: 403, headers: { 'Cache-Control': 'no-store' } }); }
  }
  check(invocation: RemoteInvocation | undefined, token: string): string {
    ensure(this.active && typeof token === 'string' && token.length >= 20 && token.length <= 200, 'UNAUTHORIZED', '缺少有效界面授权');
    const hash = digest(token), session = this.sessions.get(hash);
    ensure(session && invocation && invocation.peer === session.peer && session.expires > Date.now(), 'UNAUTHORIZED', '界面授权过期或不属于当前调用，请重新连接并预览'); return hash;
  }
  dispose(): void { this.active = false; this.sessions.clear(); }
}
