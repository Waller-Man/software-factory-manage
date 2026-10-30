import { ensure } from '../errors.ts';
import { fields, required } from './definitions.ts';
import type { NodeKind } from '../types.ts';
export function validateProperties(label: NodeKind, values: Record<string, string>, complete = false, checkRequired = complete): void {
  for (const [key, value] of Object.entries(values)) {
    ensure(fields[label].includes(key), 'VALIDATION_FAILED', '不支持的字段', key);
    ensure(typeof value === 'string' && value.length <= 131072 && !value.includes('\0'), 'VALIDATION_FAILED', '字段必须是有界文本', key);
    if (!complete || !value.trim()) continue;
    if (key.endsWith('_json') || key.endsWith('_schema')) {
      let parsed: unknown; try { parsed = JSON.parse(value); } catch { ensure(false, 'VALIDATION_FAILED', '字段不是有效JSON；可先保存草稿再修正', key); }
      const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
      if (key === 'model_dependencies_json') ensure(Array.isArray(parsed) && parsed.every(v => object(v) && typeof v.name === 'string' && !!v.name.trim() && (v.vendor === undefined || typeof v.vendor === 'string')), 'VALIDATION_FAILED', '模型依赖需为含name、可选vendor的对象数组', key);
      else if (key === 'object_categories_json') ensure(Array.isArray(parsed) && parsed.every(v => typeof v === 'string' && !!v.trim()), 'VALIDATION_FAILED', '处理对象类别需为字符串数组', key);
      else if (key === 'intermediate_artifacts_json') ensure(Array.isArray(parsed) && parsed.every(object), 'VALIDATION_FAILED', '中间产物需为声明对象数组', key);
      else ensure(object(parsed), 'VALIDATION_FAILED', '此字段需为JSON对象；输入输出可使用简明声明或既有JSON Schema', key);
    }
    if (key === 'status') ensure(['draft', 'enabled', 'disabled', 'able'].includes(value), 'VALIDATION_FAILED', '请选择已支持的启用状态', key);
  }
  if (checkRequired) for (const key of required[label]) ensure(typeof values[key] === 'string' && !!values[key].trim(), 'VALIDATION_FAILED', '缺少实际数据库必填内容，不自动填占位值', key);
}
export function validateUpdate(label: NodeKind, set: Record<string, string>, unset: string[]): void {
  validateProperties(label, set);
  for (const key of [...Object.keys(set), ...unset]) {
    ensure(fields[label].includes(key), 'VALIDATION_FAILED', '不支持的修改字段', key);
    ensure(key !== 'agent_id', 'STABLE_ID', '已有逻辑Agent的稳定ID不可修改', key);
    if (label === 'Capability') ensure(key === 'name', 'VALIDATION_FAILED', '已有能力分类只支持改名', key);
    if (label === 'Agent') ensure(key === 'name' || key === 'description', 'VALIDATION_FAILED', '已有逻辑Agent只支持修改名称和能力描述', key);
  }
  for (const key of unset) ensure(!required[label].includes(key) && !Object.hasOwn(set, key), 'VALIDATION_FAILED', '不可清空必填字段，或同时set与unset', key);
}
