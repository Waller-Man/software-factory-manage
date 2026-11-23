/** Authenticated Remote bridge and the component-owned native settings page. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { createElement as h, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import remote from '@software-factory/manage/remote';

const fields = [
  ['baseUrl', '数据库地址及端口', 'http://127.0.0.1:18080'],
  ['graphSpace', '图空间', 'DEFAULT'],
  ['graph', '图名称', 'hugegraph'],
  ['username', '数据库用户名', ''],
  ['password', '数据库密码', ''],
  ['requestTimeoutMs', '请求超时（毫秒）', '10000'],
] as const;
export function ManageConnectionForm({ view, form }: PropsRuntime<'plugins.row.config'>) {
  const [edits, setEdits] = useState<Record<string, string>>({}), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  const revision = useRef<number>();
  const dirty = Object.keys(edits).length > 0;
  if (view === 'summary') return h('span', null, '配置Manage数据库连接；数据集根位置从数据库公共节点读取。');
  if (!form || form.state.status !== 'ready') return h('p', { role: 'status' }, '组件配置尚未就绪，请检查DSH原生配置服务并启用本组件。');
  const disabled = saving || !form.state.writable;
  const save = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    const ops = Object.entries(edits).filter(([key, value]) => key !== 'password' || value !== '').map(([key, value]) => ({ op: 'set' as const, path: [key], value: key === 'requestTimeoutMs' ? Number(value) : value }));
    if (!ops.length) { setEdits({}); return; }
    if (ops.some(op => typeof op.value === 'number' && (!Number.isInteger(op.value) || op.value < 100 || op.value > 30000))) { setMessage('超时须为100至30000之间的整数。'); return; }
    setSaving(true);
    try {
      if (await form.mutate(ops, revision.current)) { setEdits({}); setMessage('配置已保存。正在执行的保存仍使用原连接；后续操作使用新配置，请返回业务页面重新连接并预览。'); }
      else setMessage('配置未保存或已被其他界面修改，请核对后重新载入。');
    } catch { setMessage('配置保存失败，请检查DSH配置服务；未输出连接凭据。'); }
    finally { setSaving(false); }
  };
  return h('form', { onSubmit: (event: FormEvent) => { void save(event); }, 'aria-label': 'Manage组件连接配置', style: { maxWidth: '640px', display: 'grid', gap: '14px' } },
    h('p', null, '与Read网关连接同一张图。不读取.env，不在此配置数据集根目录。'),
    ...fields.map(([key, title, fallback]) => h('label', { key, style: { display: 'grid', gap: '6px' } }, title,
      h('input', { name: key, 'aria-label': title, type: key === 'password' ? 'password' : key === 'requestTimeoutMs' ? 'number' : 'text',
        value: edits[key] ?? (key === 'password' ? '' : String(form.state.value?.[key] ?? fallback)),
        placeholder: key === 'password' ? '不填写则保留已保存密码' : undefined,
        required: key !== 'password', min: key === 'requestTimeoutMs' ? 100 : undefined, max: key === 'requestTimeoutMs' ? 30000 : undefined,
        disabled, autoComplete: key === 'password' ? 'new-password' : 'off',
        style: { padding: '10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-primary, #d9e1ea)', color: 'inherit', background: 'var(--dsw-alias-background-primary, transparent)' },
        onChange: (event: ChangeEvent<HTMLInputElement>) => { if (!dirty) revision.current = form.state.revision; setEdits(old => ({ ...old, [key]: event.target.value })); },
      }))),
    h('div', { style: { display: 'flex', gap: '10px' } }, h('button', { type: 'submit', disabled: disabled || !dirty }, saving ? '保存中…' : '保存配置'),
      h('button', { type: 'button', disabled: saving || !dirty, onClick: () => { setEdits({}); setMessage(''); } }, '放弃修改')),
    h('p', { role: 'status' }, message),
  );
}
export const inject = ['remote', 'slots'];
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await (ctx.get('remote') as TypertClientRemote).$mount(remote);
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: '@software-factory/manage#sf-manage' }, ManageConnectionForm));
  return unmount;
}
