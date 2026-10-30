import z from '@deepseek-ai/schemastery';
export interface ManageConfig { envFile?: string; requestTimeoutMs?: number }
export const Config: z<ManageConfig> = z.object({
  envFile: z.string().default('.env'),
  requestTimeoutMs: z.number().step(1).min(100).max(30000).default(10000),
});
