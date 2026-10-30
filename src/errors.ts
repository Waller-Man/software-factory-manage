import type { ManageError } from './types.ts';
import { ZodError } from 'zod';
export class ManageFailure extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) { super(message); }
}
export function ensure(value: unknown, code: string, message: string, field?: string): asserts value {
  if (!value) throw new ManageFailure(code, message, field);
}
export function failure(error: unknown): ManageError {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const field = issue ? [...issue.path.map(String), ...(issue.code === 'unrecognized_keys' ? issue.keys : [])].join('.') : '';
    return { code: 'INVALID_INPUT', message: `请求参数不符合接口${field ? '：' + field : ''}；请核对当前action的必填字段、类型及允许的参数`, ...(field ? { field } : {}) };
  }
  if (error instanceof ManageFailure) return { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) };
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return { code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', message: '请求中断；若已提交，请读取原回执，不要重复写入' };
  return { code: 'INTERNAL', message: '操作未完成，请保留草稿并检查服务状态' };
}
