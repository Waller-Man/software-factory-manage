/** Reuse official DSH read definitions without publishing its write/edit tools. */
import type { Context } from '@deepseek-ai/cordis';
import Tools, { type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import { ensure } from '../errors.ts';

export const READER_NAMES = ['read', 'read_image', 'hugegraph_read'] as const;
export class NativeReaders {
    private ready?: Promise<ToolDefinition[]>;
    private stop?: () => Promise<void>;
    constructor(private ctx: Context, private protectedFiles: readonly string[] = []) {}
    async definitions(): Promise<ToolDefinition[]> {
        if (!this.ctx.get('fs')) return [];
        return this.ready ??= this.create();
    }
    private async create(): Promise<ToolDefinition[]> {
        let definitions: ToolDefinition[] = [];
        const fiber = this.ctx.plugin({ name: 'sf-manage-native-readers', apply: async scope => {
            const privateScope = scope.isolate('tools').isolate('systemPrompt');
            await privateScope.plugin(SystemPrompt);
            await privateScope.plugin(Tools, { mode: 'native' });
            const tools = privateScope.get('tools');
            ensure(tools, 'DEPENDENCY_UNAVAILABLE', 'DSH原生工具未就绪');
            // read_image is mounted by the official package's optional child injection.
            let stop = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
            const imageReady = scope.get('attachments') ? new Promise<void>((resolve, reject) => {
                stop = privateScope.on('tools/change', () => { queueMicrotask(() => { if (tools.get('read_image')) resolve(); }); });
                timer = setTimeout(() => { if (tools.get('read_image')) resolve(); else reject(new Error('DSH图片读取工具未就绪')); }, 5000);
            }) : undefined;
            try {
                await privateScope.plugin({ ...FileTools, apply: (ctx: Context, config: FileTools.Config) => FileTools.apply(ctx.extend({
                    // This host revision's optional image child omits its inherited service injects.
                    inject: (deps: string[], setup: (scope: Context) => void) => ctx.inject([...FileTools.inject, ...deps], setup),
                }), config) }, {});
                await imageReady;
            }
            finally { stop(); clearTimeout(timer); }
            definitions = ['read', 'read_image'].flatMap(name => { const tool = tools.get(name); return tool ? [tool] : []; });
        } });
        this.stop = async () => { await fiber.dispose(); };
        await fiber;
        return definitions;
    }
    async checkPath(scope: Context, exec: ToolExecution): Promise<void> {
        if (!['read', 'read_image'].includes(exec.name)) return;
        const path = (exec.arguments as { file_path?: unknown }).file_path;
        ensure(typeof path === 'string' && exec.agent, 'INVALID_INPUT', '请提供要读取的资料文件');
        const fs = scope.get('fs');
        ensure(fs, 'DEPENDENCY_UNAVAILABLE', 'DSH文件读取服务未启用');
        const directories = scope.get('workingDirectory');
        ensure(directories, 'DEPENDENCY_UNAVAILABLE', 'DSH工作区未就绪');
        const target = await fs.resolve(path, { cwd: await directories.ensure(exec.agent, exec.signal), signal: exec.signal });
        const sensitive = /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.?credentials(?:\.[^\\/]*)?|\.ssh|\.aws)([\\/]|$)/i;
        ensure(![path, target.displayPath, fs.processPath(target)].some(path => sensitive.test(path)), 'UNAUTHORIZED', '管理助手不能读取凭据配置文件');
        for (const file of this.protectedFiles) {
            const protectedTarget = await fs.resolve(file, { signal: exec.signal }).catch(() => undefined);
            ensure(!protectedTarget || protectedTarget.targetKey !== target.targetKey, 'UNAUTHORIZED', '管理助手不能读取数据库连接配置');
        }
    }
    async dispose() { await this.ready?.catch(() => {}); await this.stop?.(); }
}
