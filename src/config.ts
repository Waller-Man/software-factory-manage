import z from '@deepseek-ai/schemastery';
import type { Connection } from './database/transport.ts';
import { ensure } from './errors.ts';
export interface ManageConfig { baseUrl?: string; graphSpace?: string; graph?: string; username?: string; password?: string; requestTimeoutMs?: number }
// Native owner forms expose only volatile fields. Capture plain values per connection.
export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:18080').description('数据库地址及端口；远程连接使用 HTTPS，不含 REST 路径。').volatile(),
  graphSpace: z.string().default('DEFAULT').description('图空间。').volatile(),
  graph: z.string().default('hugegraph').description('与只读网关连接同一张业务图。').volatile(),
  username: z.string().default('').description('数据库用户名。').volatile(),
  password: z.string().role('secret').description('数据库密码；保存后不回显，不读取 .env。').volatile(),
  requestTimeoutMs: z.number().step(1).min(100).max(30000).default(10000).description('单次数据库请求超时（毫秒）。').volatile(),
});
export type LiveManageConfig = ReturnType<typeof Config>;
export function snapshotConfig(config: LiveManageConfig): ManageConfig {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.get()]));
}
export function connectionConfig(config: ManageConfig): Connection {
  const values = { baseUrl: config.baseUrl ?? 'http://127.0.0.1:18080', graphSpace: config.graphSpace ?? 'DEFAULT', graph: config.graph ?? 'hugegraph', username: config.username, password: config.password };
  for (const value of Object.values(values)) ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value), 'CONFIG', '请在Manage组件配置中填写数据库连接信息');
  ensure(!values.username!.includes(':'), 'CONFIG', '数据库用户名不能包含冒号');
  return values as Connection;
}
