/** Consume the existing read service. No duplicate HTTP reader or overview API. */
import type { HugeGraphReadService, NodeView, NodeRef, PlanNode, PlanEdge } from './types.ts';
import type { GatewayResult, NodeData, ReadData } from '@software-factory/contracts/gateway';
import { ensure, ManageFailure } from './errors.ts';
import { digest } from './canonical.ts';
export interface GraphState { rootId: string; nodes: PlanNode[]; edges: PlanEdge[] }
export const nodeKey = (ref: NodeRef): string => 'vertexId' in ref ? ref.vertexId : ref.ref;
export const toNode = (view: NodeView): PlanNode => {
  ensure(view.label !== 'FieldGroup', 'ILLEGAL_NODE', 'FieldGroup不是可编辑业务节点');
  ensure(Object.values(view.properties).every(v => typeof v === 'string'), 'SCHEMA', '业务属性存储必须为TEXT');
  return { id: view.vertexId, label: view.label, properties: view.properties as Record<string, string> };
};
export const graphFingerprint = (graph: GraphState): string => digest({ rootId: graph.rootId, nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)) });
function unwrap<T>(result: GatewayResult<T>): T {
  if (!result.ok) throw new ManageFailure(result.error.code, result.error.message, result.error.field);
  ensure(result.meta.complete && !result.meta.truncated, 'READ_INCOMPLETE', 'Gateway结果不完整，不能据此准备写入'); return result.data;
}
export class GatewayReader {
  constructor(private readonly provider: () => HugeGraphReadService | undefined) {}
  private service(): HugeGraphReadService { const service = this.provider(); ensure(service?.apiVersion === '1.0', 'DEPENDENCY_UNAVAILABLE', '需要启用Gateway read API 1.0'); return service; }
  async ready(signal: AbortSignal): Promise<boolean> { const result = await this.service().health(signal); return result.ok && result.data.ready; }
  async node(id: string, signal: AbortSignal): Promise<NodeData> {
    let offset = 0, expectedFingerprint: string | undefined, first: NodeData | undefined;
    do {
      const result = await this.service().read({ kind: 'node', vertexId: id, limit: 100, offset, ...(expectedFingerprint ? { expectedFingerprint } : {}) }, signal);
      const data = unwrap(result); ensure('kind' in data && data.kind === 'node', 'GATEWAY_CONTRACT', 'Gateway节点返回类型不匹配');
      if (!first) { first = structuredClone(data); expectedFingerprint = result.ok ? result.meta.fingerprint : undefined; }
      else { first.relations.push(...data.relations); first.neighbors.push(...data.neighbors); }
      if (!data.page.hasMore) break;
      ensure(data.page.nextOffset !== null && data.page.nextOffset > offset && data.page.nextOffset <= 2000, 'READ_INCOMPLETE', '节点关系超出可完整读取范围'); offset = data.page.nextOffset;
    } while (true);
    ensure(first, 'NOT_FOUND', '节点不存在');
    first.relations = [...new Map(first.relations.map(edge => [edge.id, edge])).values()];
    first.neighbors = [...new Map(first.neighbors.map(node => [node.vertexId, node])).values()]; return first;
  }
  async maybeNode(id: string, signal: AbortSignal): Promise<NodeData | undefined> {
    try { return await this.node(id, signal); } catch (error) { if (error instanceof ManageFailure && error.code === 'NOT_FOUND') return undefined; throw error; }
  }
  async agents(agentId: string, signal: AbortSignal): Promise<NodeView[]> {
    const result = await this.service().read({ kind: 'agents', agentId, detail: 'full', limit: 100 }, signal);
    const data: ReadData = unwrap(result); ensure('kind' in data && data.kind === 'agents', 'GATEWAY_CONTRACT', 'Gateway Agent返回类型不匹配');
    ensure(!data.page.hasMore, 'READ_INCOMPLETE', 'Agent唯一性查询不完整'); return data.items;
  }
  async load(extraIds: string[], signal: AbortSignal): Promise<GraphState> {
    const result = await this.service().snapshot({ includeVersions: true, detail: 'full', maxDepth: 16, maxNodes: 1000, maxEdges: 3000 }, signal);
    const data = unwrap(result), nodes = new Map(data.nodes.filter(v => v.label !== 'FieldGroup').map(v => [v.vertexId, toNode(v)]));
    const edges = new Map(data.edges.map(v => [v.id, { id: v.id, label: v.label, outV: v.outV, inV: v.inV }]));
    // A bounded root snapshot alone cannot prove all parents of a shared node.
    for (const id of [...new Set(extraIds)].sort()) {
      const detail = await this.node(id, signal); nodes.set(id, toNode(detail.node));
      for (const neighbor of detail.neighbors) if (neighbor.label !== 'FieldGroup' && !nodes.has(neighbor.vertexId)) nodes.set(neighbor.vertexId, toNode(neighbor));
      for (const edge of detail.relations) edges.set(edge.id, { id: edge.id, label: edge.label, outV: edge.outV, inV: edge.inV });
    }
    return { rootId: data.rootCapabilityId, nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}
