import type { PlanNode, PlanStep } from '../types.ts';
import { fields, required } from '../fields/definitions.ts';
import { canonical } from '../canonical.ts';
import { ensure } from '../errors.ts';
import { WriteTransport } from './transport.ts';
export interface CudPort { verifySchema(signal: AbortSignal): Promise<void>; apply(step: PlanStep, bindings: Record<string, string>, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<string | undefined>; dispose(): void }
export const resolveId = (id: string, bindings: Record<string, string>): string => {
  if (!id.startsWith('draft:')) return id;
  ensure(bindings[id], 'PLAN_INVALID', '草稿引用尚未绑定实际数据库ID'); return bindings[id];
};
export class CudWriter implements CudPort {
  constructor(private readonly transport: WriteTransport) {}
  async verifySchema(signal: AbortSignal): Promise<void> {
    const raw = await this.transport.request('GET', '/schema', signal); ensure(raw && Array.isArray(raw.vertexlabels) && Array.isArray(raw.propertykeys) && Array.isArray(raw.edgelabels), 'SCHEMA', '数据库Schema不可读取');
    for (const [label, properties] of Object.entries(fields)) {
      const vertex = (raw.vertexlabels as Record<string, unknown>[]).find(v => v.name === label);
      ensure(vertex && Array.isArray(vertex.properties) && Array.isArray(vertex.nullable_keys), 'SCHEMA', '缺少业务Schema');
      ensure(properties.every(key => (vertex.properties as unknown[]).includes(key)), 'SCHEMA', '业务属性Schema不兼容');
      const mandatory = (vertex.properties as string[]).filter(key => !(vertex.nullable_keys as string[]).includes(key));
      ensure(canonical([...mandatory].sort()) === canonical([...required[label as keyof typeof required]].sort()), 'SCHEMA', '数据库必填属性已变化，请先复核，插件不会迁移Schema');
      if (label === 'Agent') ensure(vertex.id_strategy === 'PRIMARY_KEY' && canonical(vertex.primary_keys) === canonical(['agent_id']), 'SCHEMA', 'Agent稳定主键策略不兼容');
      else ensure(vertex.id_strategy === 'CUSTOMIZE_STRING', 'SCHEMA', '能力或版本ID策略不兼容');
      for (const key of properties) ensure((raw.propertykeys as Record<string, unknown>[]).some(p => p.name === key && p.data_type === 'TEXT' && p.cardinality === 'SINGLE'), 'SCHEMA', '业务属性需为TEXT/SINGLE');
    }
    for (const [name, source, target] of [['HAS_CHILD', 'Capability', 'Capability'], ['HAS_AGENT', 'Capability', 'Agent'], ['HAS_VERSION', 'Agent', 'AgentVersion']]) ensure((raw.edgelabels as Record<string, unknown>[]).some(e => e.name === name && e.source_label === source && e.target_label === target), 'SCHEMA', '业务关系Schema不兼容');
  }
  private path(resource: 'vertices' | 'edges', id: string): string { return '/graph/' + resource + '/' + encodeURIComponent(resource === 'vertices' ? JSON.stringify(id) : id); }
  private async checkNode(node: PlanNode, bindings: Record<string, string>, signal: AbortSignal): Promise<void> {
    const id = resolveId(node.id, bindings), raw = await this.transport.request('GET', this.path('vertices', id), signal);
    ensure(raw?.id === id && raw.label === node.label && raw.properties && typeof raw.properties === 'object', 'DATA_CHANGED', '写入目标与Gateway读取的目标不一致');
    const stored = raw.properties as Record<string, unknown>, projected = Object.fromEntries(Object.entries(stored).filter(([key]) => fields[node.label].includes(key)));
    ensure(canonical(projected) === canonical(node.properties), 'DATA_CHANGED', '写入前目标属性已变化，停止后续步骤');
  }
  async apply(step: PlanStep, bindings: Record<string, string>, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<string | undefined> {
    if (step.beforeNode) await this.checkNode(step.beforeNode, bindings, signal);
    let method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown;
    if (step.operation === 'create_node') {
      const node = step.afterNode!;
      if (node.label !== 'Agent') ensure(!await this.transport.request('GET', this.path('vertices', node.id), signal), 'ALREADY_EXISTS', '数据库节点ID已存在，禁止覆盖创建');
      method = 'POST'; path = '/graph/vertices'; body = { label: node.label, ...(node.label === 'Agent' ? {} : { id: node.id }), properties: node.properties };
    } else if (step.operation === 'create_edge') {
      const edge = step.edge!; method = 'POST'; path = '/graph/edges'; body = { label: edge.label, outV: resolveId(edge.outV, bindings), inV: resolveId(edge.inV, bindings), outVLabel: edge.label === 'HAS_VERSION' ? 'Agent' : 'Capability', inVLabel: edge.label === 'HAS_CHILD' ? 'Capability' : edge.label === 'HAS_AGENT' ? 'Agent' : 'AgentVersion', properties: {} };
    } else if (step.operation === 'delete_edge') {
      const edge = step.edge!, raw = await this.transport.request('GET', this.path('edges', edge.id), signal);
      ensure(raw?.label === edge.label && raw.outV === edge.outV && raw.inV === edge.inV, 'DATA_CHANGED', '删除的挂载关系已变化');
      method = 'DELETE'; path = this.path('edges', edge.id);
    } else if (step.operation === 'delete_node') { method = 'DELETE'; path = this.path('vertices', resolveId(step.beforeNode!.id, bindings)); }
    else {
      const node = step.beforeNode!; method = 'PUT'; path = this.path('vertices', resolveId(node.id, bindings)) + '?action=' + (step.operation === 'update_node' ? 'append' : 'eliminate');
      body = { label: node.label, properties: step.operation === 'update_node' ? step.set : Object.fromEntries(step.unset!.map(key => [key, node.properties[key]])) };
    }
    signal.throwIfAborted(); await beforeSend(); signal.throwIfAborted();
    const result = await this.transport.request(method, path, signal, body);
    return typeof result?.id === 'string' ? result.id : undefined;
  }
  dispose(): void { this.transport.dispose(); }
}
