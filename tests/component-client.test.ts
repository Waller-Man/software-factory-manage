/** Built Client and native owner-form contract; no real profile or credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve, join } from 'node:path';
const host = resolve(process.env.DSH_SOURCE ?? resolve(import.meta.dirname, '../../../../DSH-Softwarefactory')), hostRequire = createRequire(join(host, 'package.json')), uiRequire = createRequire(join(host, 'packages/client/ui-primitives/package.json'));

test('component config registers on the Manage row, saves fenced native edits, and never displays the stored password', async () => {
  const { JSDOM } = hostRequire('jsdom'), dom = new JSDOM('<!doctype html><div id="mount"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name], writable: true }); }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = uiRequire('react'), { createRoot } = uiRequire('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount'));
  let client: any, mounted = 0, stopped = 0; const rows: any[] = [], writes: any[] = [];
  try {
    dom.window.__ModuleLoader__ = { load: (definition: any) => { client = definition.factory(uiRequire); } };
    runInNewContext(await readFile(resolve(process.env.SF_MANAGE_CLIENT_FILE ?? resolve(import.meta.dirname, '../lib/client.js')), 'utf8'), { window: dom.window, console });
    const slots = { inject: (_name: string, setup: Function) => setup(), register: (options: any, component: any) => { rows.push({ options, component }); return () => {}; } };
    const remote = { $mount: async () => { mounted++; return async () => { stopped++; }; } };
    const stop = await client.apply({ slots, get: (name: string) => name === 'remote' ? remote : undefined });
    assert.equal(mounted, 1); assert.equal(rows.length, 1);
    assert.equal(rows[0].options.name, 'plugins.row.config'); assert.equal(rows[0].options.key, '@software-factory/manage#sf-manage');
    const form: any = { state: { status: 'ready', value: { baseUrl: 'http://127.0.0.1:18080', graphSpace: 'DEFAULT', graph: 'hugegraph', username: 'synthetic', password: 'stored-secret-must-not-render' }, revision: 7, writable: true }, mutate: async (ops: any, revision: any) => { writes.push({ ops, revision }); return true; } };
    await React.act(async () => root.render(React.createElement(rows[0].component, { view: 'page', form })));
    const doc = dom.window.document, password = doc.querySelector('input[name=password]') as HTMLInputElement;
    assert.equal(password.type, 'password'); assert.equal(password.value, ''); assert.ok(!doc.body.innerHTML.includes('stored-secret-must-not-render'));
    assert.equal(doc.querySelector('input[name=dataset_root]'), null); assert.equal(doc.querySelector('input[name=envFile]'), null);
    const edit = async (name: string, value: string) => React.act(async () => {
      const input = doc.querySelector(`input[name=${name}]`)!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await edit('username', 'updated-synthetic');
    await React.act(async () => { doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), { ops: [{ op: 'set', path: ['username'], value: 'updated-synthetic' }], revision: 7 });
    await edit('password', 'new-synthetic-secret');
    await React.act(async () => { doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(writes[1].ops[0].path[0], 'password'); assert.equal(writes[1].ops[0].value, 'new-synthetic-secret'); assert.equal(password.value, '');
    await stop(); assert.equal(stopped, 1);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
