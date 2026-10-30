import type { NodeKind } from '../types.ts';
export const fields: Record<NodeKind, readonly string[]> = {
  Capability: ['name'],
  Agent: ['agent_id', 'name', 'description'],
  AgentVersion: ['version', 'status', 'description', 'developer', 'invoke_kind', 'dsh_ref', 'performance_evidence_json', 'constraints_json', 'model_dependencies_json', 'selection_policy_json', 'object_categories_json', 'input_schema', 'output_schema', 'intermediate_artifacts_json', 'cost_json', 'effect_json'],
};
export const required: Record<NodeKind, readonly string[]> = { Capability: ['name'], Agent: ['agent_id', 'name', 'description'], AgentVersion: ['version', 'status', 'input_schema', 'output_schema'] };
export const relations = { Capability: { Capability: 'HAS_CHILD', Agent: 'HAS_AGENT' }, Agent: { AgentVersion: 'HAS_VERSION' }, AgentVersion: {} } as const;
export const versionId = (agentId: string, version: string): string => `av:${encodeURIComponent(agentId)}:${encodeURIComponent(version)}`;
