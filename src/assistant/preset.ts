/** Durable safe identity, also applied by ordinary DSH cold-session restoration. */
import type { Context } from '@deepseek-ai/cordis';
import { ensure } from '../errors.ts';
export const inject = ['sfManage', 'tools', 'systemPrompt', 'agentPresets'];
export function apply(ctx: Context): void {
    const service = ctx.get('sfManage') as unknown as {
        composeAssistantPreset(scope: Context): void;
    } | undefined;
    ensure(service, 'UNAVAILABLE', 'Manage尚未就绪，禁止恢复辅助会话');
    service.composeAssistantPreset(ctx);
}
