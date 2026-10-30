/** Synthetic database only. No file or connection from the user's .env is read. */
import { Reader } from '../../gateway/src/reader.ts';
import { ReadClient } from '../../gateway/src/transport.ts';
import { GatewayReader } from '../src/gateway.ts';
import { CudWriter } from '../src/database/cud.ts';
import { WriteTransport } from '../src/database/transport.ts';
import { fields, required } from '../src/fields/definitions.ts';
import { DraftService } from '../src/drafts/service.ts';
import { CommitService } from '../src/commit/service.ts';
import type { DraftRecord, DraftStore } from '../src/drafts/store.ts';
export class MemoryStore implements DraftStore {
  rows = new Map<string, DraftRecord>();
  get(id: string) { const value = this.rows.get(id); return value && structuredClone(value); }
  entries() { return structuredClone(this.rows).entries(); }
  async put(id: string, value: DraftRecord) { this.rows.set(id, structuredClone(value)); }
  async delete(id: string) { return this.rows.delete(id); }
}
export const connection = { baseUrl: 'http://127.0.0.1:18080', graphSpace: 'DEFAULT', graph: 'hugegraph', username: 'synthetic-user', password: 'synthetic-test-only' };
export class FakeDatabase {
  vertices = new Map<string, any>([['root', { id: 'root', label: 'Capability', properties: { name: '软件工厂' } }]]);
  edges = new Map<string, any>();
  writes = 0; dropNextWriteResponse = false; sequence = 0;
  readonly schema = {
    vertexlabels: [...Object.entries(fields).map(([name, properties]) => ({ name, properties, nullable_keys: properties.filter(key => !required[name as keyof typeof required].includes(key)), id_strategy: name === 'Agent' ? 'PRIMARY_KEY' : 'CUSTOMIZE_STRING', primary_keys: name === 'Agent' ? ['agent_id'] : [] })), { name: 'FieldGroup', properties: ['group_id', 'name', 'display_order', 'fields_json'] }],
    propertykeys: [...new Set([...Object.values(fields).flat(), 'group_id', 'display_order', 'fields_json'])].map(name => ({ name, data_type: name === 'display_order' ? 'INT' : 'TEXT', cardinality: 'SINGLE' })),
    edgelabels: [['HAS_CHILD', 'Capability', 'Capability'], ['HAS_AGENT', 'Capability', 'Agent'], ['HAS_VERSION', 'Agent', 'AgentVersion']].map(([name, source_label, target_label]) => ({ name, source_label, target_label })),
  };
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', suffix = url.pathname.split('/graph/')[1];
    if (url.pathname.endsWith('/schema')) return Response.json(this.schema);
    if (!suffix) return new Response('{}', { status: 404 });
    const slash = suffix.indexOf('/'), resource = slash < 0 ? suffix : suffix.slice(0, slash), encoded = slash < 0 ? undefined : suffix.slice(slash + 1), rows = resource === 'vertices' ? this.vertices : this.edges;
    const id = encoded === undefined ? undefined : resource === 'vertices' ? JSON.parse(decodeURIComponent(encoded)) : decodeURIComponent(encoded);
    if (method === 'GET') {
      if (id !== undefined) return rows.has(id) ? Response.json(rows.get(id)) : new Response('{}', { status: 404 });
      const label = url.searchParams.get('label'), source = url.searchParams.get('vertex_id');
      return Response.json({ [resource]: [...rows.values()].filter(row => (!label || row.label === label) && (!source || row.outV === JSON.parse(source))), page: null });
    }
    this.writes++;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)); let result: any = {};
    if (method === 'POST') {
      if (resource === 'vertices') { result = { ...body, id: body.id ?? '2:native-' + body.properties.agent_id }; }
      else result = { ...body, id: 'edge:' + (++this.sequence) };
      rows.set(result.id, structuredClone(result));
    } else if (method === 'PUT') {
      result = rows.get(id); if (!result) return new Response('{}', { status: 404 });
      if (url.searchParams.get('action') === 'eliminate') for (const key of Object.keys(body.properties)) delete result.properties[key];
      else Object.assign(result.properties, body.properties);
    } else if (method === 'DELETE') {
      rows.delete(id); if (resource === 'vertices') for (const [key, edge] of this.edges) if (edge.outV === id || edge.inV === id) this.edges.delete(key);
    }
    if (this.dropNextWriteResponse) { this.dropNextWriteResponse = false; throw new Error('synthetic response loss after mutation'); }
    return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(result);
  };
  edge(label: string, outV: string, inV: string) {
    const id = 'edge:' + (++this.sequence), from = this.vertices.get(outV), to = this.vertices.get(inV);
    this.edges.set(id, { id, label, outV, inV, outVLabel: from.label, inVLabel: to.label, properties: {} });
  }
}
export function fixture() {
  const db = new FakeDatabase(), core = new Reader(new ReadClient(connection, undefined, db.fetch));
  const gateway = { apiVersion: '1.0' as const, health: core.health.bind(core), read: core.read.bind(core), snapshot: core.snapshot.bind(core) };
  const reader = new GatewayReader(() => gateway), store = new MemoryStore(), drafts = new DraftService(store, reader), writer = new CudWriter(new WriteTransport(connection, 1000, db.fetch)), commits = new CommitService(drafts, () => writer);
  return { db, core, gateway, reader, store, drafts, writer, commits };
}
