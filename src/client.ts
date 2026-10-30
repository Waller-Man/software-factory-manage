/** No page: mount only the generated authenticated Manage namespace. */
import type { Context } from '@deepseek-ai/cordis';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import remote from '@software-factory/manage/remote';
export const inject = ['remote'];
export async function apply(ctx: Context): Promise<() => Promise<void>> { return (ctx.get('remote') as TypertClientRemote).$mount(remote); }
