const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture(fetch) {
  const sandbox = { module: { exports: {} }, location: new URL('https://my.feishu.cn/docx/Source'),
    document: { querySelectorAll: () => [] }, chrome: { runtime: { onMessage: { addListener() {} } } },
    fetch, Uint8Array, AbortController, setTimeout, clearTimeout, btoa: s => Buffer.from(s, 'binary').toString('base64') };
  vm.runInNewContext(fs.readFileSync(require.resolve('../content-scripts/feishu-exporter.js'), 'utf8'), sandbox);
  return sandbox.module.exports.__test.convertClientVarsToMarkdown;
}
function source() {
  return { data: { block_map: {
    Source: { data: { type: 'page', children: ['intro', 'catalogue', 'heading', 'view', 'tail'] } },
    intro: { data: { type: 'text', text: { initialAttributedTexts: { text: { 0: '正文开始' } } } } },
    catalogue: { data: { type: 'isv', block_type_id: 'blk_637dcc698597401c1a8fd711', data: { showCataLogLevel: 3 } } },
    heading: { data: { type: 'heading1', text: { initialAttributedTexts: { text: { 0: '第一章' } } } } },
    view: { data: { type: 'view', children: ['file'] } },
    file: { data: { type: 'file', file: { token: 'Video', name: '教学视频.mp4', size: 16, mimeType: 'video/mp4' } } },
    tail: { data: { type: 'text', text: { initialAttributedTexts: { text: { 0: '正文结束' } } } } }
  } } };
}
const meta = { exportToken: 'Source', title: '附件回归' };
test('catalogue entries and an independently archived MP4 survive at their source positions', async () => {
  const bytes = Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
  const convert = fixture(async (url, options) => {
    assert.match(url, /download\/preview\/Video\/\?preview_type=16$/);
    assert.equal(options.credentials, 'include');
    return { ok: true, arrayBuffer: async () => bytes };
  });
  const assets = [];
  const markdown = await convert(meta, source(), { includeImages: false, localFileAssets: true, assets });
  assert.match(markdown, /\[第一章\]\(https:\/\/my.feishu.cn\/docx\/Source#heading\)/);
  assert.match(markdown, /\[教学视频.mp4\]\(assets\/attachment-001.mp4\)/);
  assert(markdown.indexOf('正文开始') < markdown.indexOf('[第一章]'));
  assert(markdown.indexOf('教学视频.mp4') < markdown.indexOf('正文结束'));
  assert.equal(assets.length, 1);
  assert.deepEqual(Buffer.from(assets[0].contentBase64, 'base64'), bytes);
});
for (const [name, response] of [
  ['denied', { ok: false, status: 403 }],
  ['truncated', { ok: true, arrayBuffer: async () => Buffer.from([0,0,0,16,102,116,121,112]) }],
  ['login page', { ok: true, arrayBuffer: async () => Buffer.from('login-page-login') }]
]) test(`attachment ${name} prevents an incomplete archive`, async () => {
  const convert = fixture(async () => response), assets = [];
  await assert.rejects(convert(meta, source(), { includeImages: false, localFileAssets: true, assets }), /附件.*未保存/);
  assert.equal(assets.length, 0);
});
test('unknown components remain a blocking error instead of silently disappearing', async () => {
  const input = source(); input.data.block_map.catalogue.data.block_type_id = 'Unknown';
  await assert.rejects(fixture()(meta, input, { includeImages: false, assets: [] }), /暂不支持导出的组件/);
});
test('linked export preserves the file reference without downloading it', async () => {
  const markdown = await fixture(() => { throw new Error('No fetch expected'); })(meta, source(), { includeImages: false });
  assert.match(markdown, /教学视频.mp4（原文附件）/);
});
