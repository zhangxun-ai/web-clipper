const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { namespaceObsidianAssets } = require('../shared/obsidian-export.js');

function loadMaterializer(sendMessage) {
  const source = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
  const start = source.indexOf('async function materializeWebImageAssets(');
  const end = source.indexOf('async function downloadExportPayload(', start);
  const context = { chrome: { runtime: { sendMessage } }, throwIfExportCanceled() {}, setStatus() {} };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run = materializeWebImageAssets;', context);
  return context.run;
}

const payload = () => ({ sourceUrl: 'https://scys.com/articleDetail/xq_topic/123',
  content: '# 原文\n\n![原图](assets/web-image-001)\n\n![重复原图](assets/web-image-001)',
  imageRequests: [{ url: 'https://scys.com/img?format=webp', reference: 'assets/web-image-001' }] });

test('local export materializes image bytes using actual MIME and preserves repeated occurrences', async () => {
  const calls = [];
  const run = loadMaterializer(async request => { calls.push(request); return { ok: true, data: { mimeType: 'image/png', contentBase64: 'aW1hZ2U=' } }; });
  const result = await run(payload(), 17);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'exporter:capture-web-image');
  assert.equal(calls[0].sourceUrl, payload().sourceUrl);
  assert.equal(calls[0].tabId, 17);
  assert.equal(result.assets[0].path, 'assets/web-image-001.png');
  assert.equal(result.assets[0].contentBase64, 'aW1hZ2U=');
  assert.equal(result.content.match(/assets\/web-image-001.png/g).length, 2);
  assert.equal(result.imageRequests.length, 0);
});

test('local export stops on unreadable images or invalid payloads without remote fallback', async () => {
  for (const response of [{ ok: false, error: '网站暂不允许读取该图片' }, { ok: true, data: { mimeType: 'text/html', contentBase64: 'aW1hZ2U=' } }]) {
    await assert.rejects(loadMaterializer(async () => response)(payload(), 17), /第 1 张图片/);
  }
});

test('independent Obsidian saves cannot overwrite another note image and rewrite repeated references', () => {
  const assets = [{ path: 'assets/image-001.png', mimeType: 'image/png', contentBase64: 'aW1hZ2U=' }];
  const markdown = '![一](assets/image-001.png)\n\n![二](assets/image-001.png)';
  const first = namespaceObsidianAssets(markdown, assets, 'note-a');
  const second = namespaceObsidianAssets(markdown, assets, 'note-b');
  assert.notEqual(first.assets[0].path, second.assets[0].path);
  assert.equal(first.markdown.match(/assets\/note-a\/image-001.png/g).length, 2);
  assert.equal(assets[0].path, 'assets/image-001.png');
  assert.throws(() => namespaceObsidianAssets(markdown, [{ ...assets[0], path: '../outside.png' }], 'note-c'), /图片文件无效/);
});

test('Obsidian publishes the note only after all image writes succeed', async () => {
  const source = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
  const start = source.indexOf('async function saveCurrentMarkdownToObsidian(');
  const end = source.indexOf('async function availableObsidianNotePath(', start);
  const calls = [];
  const context = { refreshObsidianBinding: async () => ({ permission: 'granted', handle: {} }),
    obsidianExportApi: { namespaceObsidianAssets }, crypto: { randomUUID: () => 'note-a' },
    buildObsidianNoteFile: require('../shared/obsidian-export.js').buildObsidianNoteFile,
    extractBodyMarkdown: text => text, setObsidianStatus() {}, availableObsidianNotePath: async (_root, path) => path,
    obsidianVaultStorage: { writeTextFiles: async () => calls.push('note') },
    writeObsidianAssetFiles: async () => { calls.push('images'); throw new Error('disk full'); } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run = saveCurrentMarkdownToObsidian;', context);
  await assert.rejects(context.run({ title: '文章', markdown: '![图片](assets/image-001.png)', assets: [{ path: 'assets/image-001.png', contentBase64: 'aW1hZ2U=' }] }), /disk full/);
  assert.deepEqual(calls, ['images']);
});


test('Obsidian gives existing same-title notes a new filename without overwriting', async () => {
  const source = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
  const start = source.indexOf('async function availableObsidianNotePath(');
  const end = source.indexOf('async function writeObsidianAssetFiles(', start);
  const directory = { getDirectoryHandle: async () => directory, getFileHandle: async name => {
    if (name === '文章.md') return {};
    throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
  } };
  const context = { crypto: { randomUUID: () => 'abcd1234-1111-2222-3333-444444444444' } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run = availableObsidianNotePath;', context);
  assert.equal(await context.run(directory, 'notes/文章.md'), 'notes/文章-abcd1234.md');
});
