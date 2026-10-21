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

    const wechatUrl = 'https://mp.weixin.qq.com/s/local-assets-regression';
    await page.route(wechatUrl, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <h1 id="activity-name">公众号本地图片回归</h1><div id="js_content"><p>正文开始</p>
      <img data-src="https://mmbiz.qpic.cn/one.png" data-caption="第一张"><p>中间说明</p>
      <img data-src="https://mmbiz.qpic.cn/one.png" data-caption="重复引用"><p>正文结束</p></div>` }));
    await page.goto(wechatUrl);
    await page.evaluate(() => {
      globalThis.legacyImageReads = 0;
      globalThis.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage(_message, callback) {
        globalThis.legacyImageReads++; callback({ ok: true, dataUrl: 'data:image/png;base64,aW1n' });
      } } };
      globalThis.module = { exports: {} };
    });
    for (const file of ['shared/web-markdown-utils.js', 'content-scripts/feishu-exporter.js']) await page.addScriptTag({ path: path.join(root, file) });
    const wechat = await page.evaluate(() => module.exports.__test.exportWechatDocument('markdown', { includeImages: true, localImageAssets: true }));
    assert.equal(wechat.sourceUrl, wechatUrl);
    assert.equal(wechat.title, '公众号本地图片回归');
    assert.equal(wechat.imageRequests.length, 1, 'one shared image download retains two references');
    assert.equal(wechat.imageRequests[0].url, 'https://mmbiz.qpic.cn/one.png');
    assert.equal((wechat.content.match(/assets\/web-image-001/g) || []).length, 2);
    assert.doesNotMatch(wechat.content, /data:image|https:\/\/mmbiz/);
    assert.equal(await page.evaluate(() => legacyImageReads), 0, 'local export delegates reading to the validated image service');
    const legacy = await page.evaluate(() => module.exports.__test.exportWechatDocument('markdown', { includeImages: true }));
    assert.equal(legacy.imageRequests.length, 0);
    assert.match(legacy.content, /data:image\/png;base64,aW1n/);
    assert.equal(await page.evaluate(() => legacyImageReads), 2, 'legacy batch export keeps its existing embedding behavior');
    const textOnly = await page.evaluate(() => module.exports.__test.exportWechatDocument('markdown', { includeImages: false, localImageAssets: true }));
    assert.equal(textOnly.imageRequests.length, 0); assert.doesNotMatch(textOnly.content, /!\[/);
    assert.match(textOnly.content, /正文开始[\s\S]*正文结束/);
    console.log('PASS WeChat local export delegates one image read, preserves repeated references and keeps legacy/text-only modes');

    const feishuUrl = 'https://my.feishu.cn/docx/LocalOriginal';
    const originalPng = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1940; canvas.height = 1076;
      canvas.getContext('2d').fillRect(0, 0, 1940, 1076);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    let fetchedOriginal = 0;
    await page.route(feishuUrl, route => route.fulfill({ contentType: 'text/html', body: '<title>原图导出回归</title><div class="docx-image-block" data-record-id="Image"><img src="https://my.feishu.cn/cover-thumbnail"></div>' }));
    await page.route('https://internal-api-drive-stream.feishu.cn/**', route => {
      assert.match(route.request().url(), /\/download\/preview\/OriginalToken\/\?preview_type=16$/);
      fetchedOriginal++;
      return route.fulfill({ contentType: 'image/jpeg', body: originalPng,
        headers: { 'Access-Control-Allow-Origin': 'https://my.feishu.cn', 'Access-Control-Allow-Credentials': 'true' } });
    });
    await page.goto(feishuUrl);
    await page.evaluate(() => { globalThis.chrome = { runtime: { onMessage: { addListener() {} } } }; globalThis.module = { exports: {} }; });
    for (const file of ['shared/image-asset.js', 'shared/web-markdown-utils.js', 'content-scripts/feishu-exporter.js']) await page.addScriptTag({ path: path.join(root, file) });
    const feishu = await page.evaluate(async () => {
      const assets = [];
      const content = await module.exports.__test.convertClientVarsToMarkdown({ exportToken: 'Doc', title: '原图' }, {
        data: { block_map: { Doc: { data: { children: ['Image'] } }, Image: { data: {
          type: 'image', image: { token: 'OriginalToken', name: 'mislabelled.jpg', width: 1940, height: 1076 }
        } } } }
      }, { includeImages: true, localImageAssets: true, assets });
      return { content, assets };
    });
    assert.equal(fetchedOriginal, 1);
    assert.match(feishu.content, /!\[mislabelled.jpg\]\(assets\/image-001.png\)/);
    assert.equal(feishu.assets[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(feishu.assets[0].contentBase64, 'base64'), originalPng);
    console.log('PASS Feishu local export preserves decoded 1940×1076 PNG bytes despite a JPEG label and a DOM thumbnail');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
