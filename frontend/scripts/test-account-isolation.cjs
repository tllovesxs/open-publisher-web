const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const localStorage = storage();
const sessionStorage = storage();
function load(path, imports) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, {
    exports, require: name => {
      assert.ok(name in imports, `Unexpected dependency: ${name}`);
      return imports[name];
    }, localStorage, sessionStorage, structuredClone, URL,
    window: { location: { origin: 'http://localhost:5173' } },
  });
  return exports;
}
async function main() {
  const workspace = load('src/api/publicWorkspace.ts', {
    '../data/examples.v1.json': { default: { articles: [{ id: 'example-public', title: 'Public' }], media: [], templates: [] } },
    '../data/product-promotion.v1.json': { default: { template: {} } },
    '../data/example-article.v1.md?raw': { default: '# Public' },
  });
  localStorage.setItem('opw:local-workspace:guest:articles', JSON.stringify([{ articleId: 'private-legacy', title: 'Private' }]));
  localStorage.setItem('opw_user_id', 'alice');
  assert.deepEqual((await workspace.localRows('articles')).map(row => row.articleId), ['example-public']);
  await assert.rejects(workspace.localAdapter({ url: '/articles/private-legacy', method: 'get' }));
  await assert.rejects(workspace.localAdapter({ url: '/articles', method: 'post', data: '{}' }));
  assert.equal(workspace.localMediaSource('private-image'), null);
  const runs = load('src/lib/activeRunContext.tsx', {
    react: { createContext: () => ({}) }, 'react/jsx-runtime': {},
    './bridge': {}, '../auth/AuthContext': {},
  });
  const run = { runId: 'run-alice', articleId: 'private-alice', ownerUserId: 'alice' };
  sessionStorage.setItem('gaoliu.active-article-run', JSON.stringify(run));
  assert.equal(runs.readStoredRun(null), null);
  assert.equal(runs.readStoredRun('bob'), null);
  assert.equal(runs.readStoredRun('alice').articleId, 'private-alice');
  sessionStorage.setItem('gaoliu.active-article-run', JSON.stringify({ ...run, ownerUserId: null }));
  assert.equal(runs.readStoredRun('alice'), null);
  sessionStorage.setItem('gaoliu.active-article-run:alice', JSON.stringify(run));
  assert.equal(runs.readStoredRun('alice').articleId, 'private-alice');
  assert.equal(runs.readStoredRun('bob'), null);
  console.log('Account isolation passed: public examples, anonymous legacy data, private writes, task ownership.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
