/** One source for the model-facing schema and the strict execution parser. */
import { z } from 'zod';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { requests } from '../api/schemas.ts';

const target = requests.stageUpdate.shape.target.describe('已有数据库节点使用{vertexId:真实ID}；本草稿新增节点使用{ref:"draft:…"}，二选一。');
export const editSchema = z.discriminatedUnion('action', [
    requests.stageCreate.omit({ draftId: true }).extend({
        action: z.literal('create'),
        parent: target,
        properties: requests.stageCreate.shape.properties.describe('新增节点的字符串属性；未知可选值省略。'),
    }).strict(),
    requests.stageUpdate.omit({ draftId: true }).extend({
        action: z.literal('update'), target,
        label: requests.stageCreate.shape.label.optional().describe('可选，仅核对目标真实类型，不改变节点类型。'),
        set: requests.stageUpdate.shape.set.describe('填写新值，字符串键值对象；修改使用set，不使用properties。'),
        unset: requests.stageUpdate.shape.unset.describe('明确清空的可选属性名；不修改的字段省略。'),
    }).strict(),
    requests.stageMoveVersion.omit({ draftId: true }).extend({ action: z.literal('move-version'), target, parent: target.describe('新的父节点，必须是逻辑Agent。只更换当前版本归属，保留版本ID与资料。') }).strict(),
    // Confirmation of a shared-node deletion remains a user-only operation.
    requests.stageDelete.omit({ draftId: true, confirmedParentIds: true }).extend({ action: z.literal('delete'), target }).strict(),
]);
export const editParameters = { type: 'object', ...z.toJSONSchema(editSchema, { target: 'draft-7' }) } as ToolDefinition['parameters'];
