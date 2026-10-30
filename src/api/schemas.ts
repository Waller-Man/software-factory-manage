import { z } from 'zod';
import { fields } from '../fields/definitions.ts';
const id = z.string().min(1).max(4096).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const text = z.string().max(131072).refine(v => !v.includes('\0'));
export const reference = z.union([z.object({ vertexId: id }).strict(), z.object({ ref: id }).strict()]);
const properties = z.record(z.string().min(1).max(80).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v)), text);
const draftId = { draftId: id };
const revision = { ...draftId, expectedRevision: z.number().int().min(0) };
const context = z.object({ step: z.number().int().min(0).max(8), origin: z.enum(['overview', 'manage']), selected: reference.optional(), editingVersion: reference.optional() }).strict();
export const requests = {
  empty: z.object({}).strict(),
  createDraft: z.object({ title: z.string().min(1).max(200).optional(), mode: z.enum(['overview', 'new-agent', 'new-version', 'edit-version']), targetVertexId: id.optional() }).strict(),
  listDrafts: z.object({ includeSaved: z.boolean().optional() }).strict(),
  getDraft: z.object(draftId).strict(),
  assistant: z.object({ ...draftId, sourceSessionId: id.optional() }).strict(),
  revision: z.object(revision).strict(),
  updateDraft: z.object({ ...revision, title: z.string().min(1).max(200).optional(), context: context.optional() }).strict(),
  stageCreate: z.object({ ...revision, label: z.enum(['Capability', 'Agent', 'AgentVersion']), parent: reference, properties }).strict(),
  stageUpdate: z.object({ ...revision, target: reference, set: properties.optional(), unset: z.array(z.string().max(80)).max(Math.max(...Object.values(fields).map(items => items.length))).optional() }).strict(),
  stageDelete: z.object({ ...revision, target: reference, confirmedParentIds: z.array(id).max(100).optional() }).strict(),
  stageMoveVersion: z.object({ ...revision, target: reference, parent: reference }).strict(),
  undoChange: z.object({ ...revision, changeId: id }).strict(),
  commit: z.object({ ...revision, planId: id, digest: z.string().regex(/^[a-f0-9]{64}$/), approvalNonce: z.string().min(20).max(200) }).strict(),
  receipt: z.object({ ...draftId, requestId: id }).strict(),
};
