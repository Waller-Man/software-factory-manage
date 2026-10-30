import { createHash } from 'node:crypto';
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task); this.tail = next.catch(() => {}); return next;
  }
  async settled(): Promise<void> { await this.tail; }
}
