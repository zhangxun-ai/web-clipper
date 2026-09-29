// Browser DOM regression only. Uses synthetic article content; no external writes.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const prose = Array.from({ length: 6 }, (_, i) => `原文长段落第${i}句话${'正文'.repeat(30)}。`).join('');
const fixture = `<!doctype html><meta charset="utf-8"><title>站点标题</title><main>
<div class="post-detail-content"><div class="article-title">完整原文标题</div></div>
<div class="content-container"><div class="post-content"><p>正文简介</p></div><div class="feishu-doc-content">
<h1>第一节原文标题</h1><div class="text block-header block3-header">类名章节标题</div>
<div class="vc-doc-item doc-heading-block doc-heading-2"><div><div class="text block-header block4-header">嵌套章节标题</div></div></div><p>${prose}</p>
<div class="vc-doc-item"><div class="bullet_container"><div class="row"><div class="list">父项原文</div></div><div class="list-children">
<div class="vc-doc-item"><div class="bullet_container"><div class="row"><div class="list">子项原文</div></div><div class="list-children">
<div class="vc-doc-item"><div class="bullet_container"><div class="row"><div class="list">孙项原文</div></div></div></div>
</div></div></div><p>子项后的说明</p><img data-src="https://scys.com/image-a" alt="原图[一]">
</div></div></div>
<div class="block-order"><div class="order-marker">2.</div><div class="list">有序父项</div><div class="list-children"><p>有序子正文</p><img data-src="https://scys.com/image-b" alt="原图二"></div></div>
</div></div><aside>不属于正文的推荐</aside></main>`;
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: fixture }) : route.abort());
    await page.goto('https://scys.com/articleDetail/xq_topic/local-regression');
    await page.evaluate(() => { globalThis.chrome = { runtime: { onMessage: { addListener() {} } } }; globalThis.module = { exports: {} }; });
    for (const file of ['shared/web-markdown-utils.js', 'content-scripts/feishu-exporter.js']) await page.addScriptTag({ path: path.join(root, file) });
    const result = await page.evaluate(() => module.exports.__test.exportGenericWebDocument('markdown', { includeImages: true, localImageAssets: true }));
    assert.equal(result.imageRequests.length, 2);
    assert.match(result.content, /^# 第一节原文标题$/m);
    assert.match(result.content, /^# 类名章节标题$/m);
    assert.match(result.content, /^## 嵌套章节标题$/m);
    assert.equal(result.content.split('嵌套章节标题').length - 1, 1);
    assert.ok(result.content.includes(prose), 'authored long paragraph stays together');
    assert.match(result.content, /^- 父项原文\n\n  - 子项原文\n\n    - 孙项原文/m);
    assert.match(result.content, /有序父项[\s\S]*有序子正文[\s\S]*assets\/web-image-002/);
    assert.doesNotMatch(result.content, /不属于正文的推荐/);
    assert.equal((result.content.match(/!\[/g) || []).length, 2);
    assert.match(result.content, /原图\\\[一\\\]/);
    console.log('PASS generic local export preserves headings, original paragraphs, three nested list levels and all image references');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
