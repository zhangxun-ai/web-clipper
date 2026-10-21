const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
const restore = source.slice(source.indexOf('function applyWechatHistoryView('), source.indexOf('\nfunction renderWechatHistoryStatus('));
function run(view, selection) {
  const ctx = vm.createContext({ wechatHistorySelection: selection, wechatHistoryView: null,
    isWechatHistoryRunning: false, isWechatSelectionDownloading: false, wechatProgressTimer: 0,
    renderWechatArticles() {}, setHistoryControlsDisabled() {}, renderWechatHistoryStatus() {} });
  vm.runInContext(restore, ctx);
  ctx.applyWechatHistoryView(view);
  return JSON.parse(JSON.stringify(ctx.wechatHistoryView));
}
test('legacy history without listId restores when no separate selection exists', () => {
  for (const listId of [undefined, null, '']) {
    const view = { state: 'error', articles: [], selectedUrls: ['legacy-url'], ...(listId === undefined ? {} : { listId }) };
    assert.deepEqual(run(view, null).selectedUrls, ['legacy-url']);
  }
});
test('selection belongs only to a nonempty matching list ID', () => {
  assert.deepEqual(run({ listId: 'current', selectedUrls: [] }, { listId: 'current', urls: ['chosen'] }).selectedUrls, ['chosen']);
  assert.deepEqual(run({ listId: 'current', selectedUrls: [] }, { listId: 'other', urls: ['other'] }).selectedUrls, []);
  assert.deepEqual(run({ articles: [] }, {}).selectedUrls, []);
});
