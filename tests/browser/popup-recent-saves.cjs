// Real MV3 popup, storage events and source capture. Native status is stubbed;
// no login, authorization or document writes are performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const screenshotDir = process.env.UI_SCREENSHOT_DIR;
const sourceUrl = 'https://scys.com/articleDetail/xq_topic/popup-return-article';
const target = { url: 'https://my.feishu.cn/wiki/Parent', origin: 'https://my.feishu.cn', parentToken: 'Parent',
  spaceId: '123', title: '产品研究', spaceName: '资料库' };
const requests = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const first = { id: 'recent-first', requestId: requests[0], source: { url: sourceUrl, type: 'web' }, target,
  title: '同文第一次保存', stage: 'complete', wikiToken: 'Saved', resultUrl: 'https://my.feishu.cn/wiki/Saved',
  autoRun: false, createdAt: '2026-09-29T01:00:00Z' };
const second = { ...first, id: 'recent-second', requestId: requests[1], title: '同文第二次需要处理',
  stage: 'moving', error: '连接暂时中断', wikiToken: '', resultUrl: '', createdAt: '2026-09-29T02:00:00Z' };

(async () => {
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: process.env.HEADED !== '1',
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    viewport: { width: 452, height: 600 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const errors = [], failedAssets = [];
  context.on('response', response => {
    if (response.url().startsWith('chrome-extension:') && response.status() >= 400) failedAssets.push(response.url());
  });
  context.on('requestfailed', request => {
    if (request.url().startsWith('chrome-extension:')) failedAssets.push(request.url());
  });
  try {
    await context.route('https://scys.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<title>从保存页返回的原文章</title><main><h1>从保存页返回的原文章</h1><div class="feishu-doc-content"><p>这一段来自指定的原文章，导出时必须保留。</p></div></main>' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.fixtureNativeCalls = [];
      chrome.runtime.sendNativeMessage = (_host, message, callback) => {
        globalThis.fixtureNativeCalls.push(message.action);
        if (message.action !== 'status') throw new Error('Unexpected native operation: ' + message.action);
        callback({ ok: false, code: 'NATIVE_UNAVAILABLE', error: 'Fixture connector unavailable' });
      };
    });
    const source = await context.newPage();
    await source.goto(sourceUrl);
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, sourceUrl);
    await worker.evaluate(async ({ first, second, target, sourceTabId }) => {
      const current = { ...second, sourceTabId };
      await chrome.storage.local.set({ feishuWikiClipJobs: [first, current],
        feishuWikiClipHistory: [{ ...first, title: '历史陈旧标题不可覆盖' }],
        feishuWikiClipJob: current, feishuWikiClipTarget: target });
    }, { first, second, target, sourceTabId });
    // An unrelated active browser page cannot replace the explicit sourceTabId.
    const unrelated = await context.newPage();
    await unrelated.goto('https://scys.com/unrelated');
    const popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    const popupUrl = await worker.evaluate(({ sourceUrl, sourceTabId }) => {
      const url = new URL(chrome.runtime.getURL('popup.html'));
      url.searchParams.set('source', sourceUrl);
      url.searchParams.set('sourceTabId', String(sourceTabId));
      return url.href;
    }, { sourceUrl, sourceTabId });
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('status-ready')
      && document.getElementById('destinationConnection').dataset.state === 'setup').catch(async error => {
        console.error(await popup.evaluate(() => ({ status: document.getElementById('status')?.textContent, connection: document.getElementById('destinationConnection')?.outerHTML, title: document.getElementById('docTitle')?.textContent })));
        console.error(await worker.evaluate(() => globalThis.fixtureNativeCalls));
        throw error;
      });
    assert.equal(await popup.locator('#docTitle').textContent(), '从保存页返回的原文章');
    assert.equal(await popup.locator('#destinationValue').textContent(), '资料库 / 产品研究');
    const primary = await popup.locator('#openFeishuSave').boundingBox();
    assert(primary.y + primary.height < 600, 'Feishu primary must be visible at 452x600');
    await popup.locator('#recentSaves > summary').click();
    assert.equal(await popup.locator('#recentSaveList li').count(), 2, 'same article saves remain separate requests');
    assert.equal(await popup.locator('[data-job-id="recent-first"] .recent-title').textContent(), first.title,
      'legacy history cannot replace a newer queue record after overview returns');
    assert.equal(await popup.locator('[data-job-id="recent-first"]').getAttribute('href'), first.resultUrl);
    const recovery = new URL(await popup.locator('[data-job-id="recent-second"]').getAttribute('href'));
    assert.equal(recovery.pathname, '/feishu-save.html');
    assert.equal(recovery.searchParams.get('jobId'), second.id);
    assert.equal(recovery.searchParams.get('requestId'), second.requestId);
    assert.equal(recovery.searchParams.get('source'), sourceUrl);
    assert.equal(recovery.searchParams.get('target'), target.url);
    assert.equal(recovery.searchParams.get('sourceTabId'), String(sourceTabId));
    assert.equal(recovery.searchParams.has('autoStart'), false);
    assert.deepEqual(await worker.evaluate(() => globalThis.fixtureNativeCalls), ['status']);
    if (screenshotDir) await popup.screenshot({ path: path.join(screenshotDir, 'popup-recent-saves.png'), fullPage: true, animations: 'disabled' });

    const malicious = { ...first, id: 'bad-result', requestId: undefined, title: '<img src=x onerror=alert(1)>',
      resultUrl: 'javascript:alert(1)', createdAt: '2026-09-29T03:00:00Z' };
    await worker.evaluate(async ({ first, second, malicious, sourceTabId }) => {
      const running = { ...second, sourceTabId, title: '自动恢复中的任务', autoRun: true, retryable: true };
      await chrome.storage.local.set({ feishuWikiClipJobs: [first, running, malicious], feishuWikiClipJob: running });
    }, { first, second, malicious, sourceTabId });
    await popup.waitForFunction(() => document.querySelectorAll('#recentSaveList li').length === 3
      && document.querySelector('[data-job-id="recent-second"] .recent-state').textContent === '处理中');
    assert.equal(await popup.locator('#recentSaveList img').count(), 0, 'job titles must be text, never markup');
    const safeRecovery = new URL(await popup.locator('[data-job-id="bad-result"]').getAttribute('href'));
    assert.equal(safeRecovery.protocol, 'chrome-extension:');
    assert.equal(safeRecovery.searchParams.get('jobId'), 'bad-result');
    assert.equal(safeRecovery.searchParams.has('requestId'), false, 'legacy task retains its own job identity');
    assert.deepEqual(await worker.evaluate(() => globalThis.fixtureNativeCalls), ['status'], 'storage changes never poll native status');
    console.log('PASS: recent saves retain two requests, verified result and exact recovery routes; status failure keeps history; storage updates do not poll native');

    await popup.locator('button[data-destination="local"]').click();
    await popup.waitForFunction(async () => (await chrome.storage.local.get('clipperDestination')).clipperDestination === 'local');
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('status-ready'));
    assert.equal(await popup.locator('button[data-destination="local"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await popup.locator('#docTitle').textContent(), '从保存页返回的原文章');
    const downloads = popup.waitForEvent('download');
    await popup.locator('#primaryAction').click();
    const download = await Promise.race([downloads, popup.waitForFunction(() => document.getElementById('status').classList.contains('status-error')).then(async () => { throw new Error(await popup.locator('#status').textContent()); })]);
    const markdown = fs.readFileSync(await download.path(), 'utf8');
    assert.match(markdown, /这一段来自指定的原文章/);
    assert.match(markdown, /https:\/\/scys\.com\/articleDetail\/xq_topic\/popup-return-article/);
    await popup.waitForFunction(() => document.getElementById('primaryAction').dataset.actionKey === 'export-markdown');
    await popup.evaluate(() => {
      window.fixtureSaveRoutes = [];
      chrome.tabs.create = async options => { window.fixtureSaveRoutes.push(options.url); return { id: 999 }; };
    });
    await popup.locator('button[data-destination="feishu"]').click();
    await popup.locator('#openFeishuSave').click();
    await popup.waitForFunction(() => window.fixtureSaveRoutes.length === 1);
    const boundSave = new URL(await popup.evaluate(() => window.fixtureSaveRoutes[0]));
    assert.equal(boundSave.searchParams.get('source'), sourceUrl);
    assert.equal(boundSave.searchParams.get('sourceTabId'), String(sourceTabId));
    assert.equal(boundSave.searchParams.get('target'), target.url, 'one-click save binds the displayed target');
    assert.equal(boundSave.searchParams.get('autoStart'), '1');
    await worker.evaluate(() => chrome.storage.local.remove('feishuWikiClipTarget'));
    await popup.waitForFunction(() => document.getElementById('destinationValue').textContent === '选择知识库位置');
    await popup.locator('#openFeishuSave').click();
    await popup.waitForFunction(() => window.fixtureSaveRoutes.length === 2);
    const unconfiguredSave = new URL(await popup.evaluate(() => window.fixtureSaveRoutes[1]));
    assert.equal(unconfiguredSave.searchParams.has('autoStart'), false, 'missing destination opens configuration, never auto-starts');
    assert.equal(unconfiguredSave.searchParams.has('target'), false);
    assert.notEqual(boundSave.searchParams.get('requestId'), unconfiguredSave.searchParams.get('requestId'));
    assert.deepEqual(errors, []);
    assert.deepEqual(failedAssets, []);
    assert.deepEqual(await popup.locator('img').evaluateAll(images => images.filter(img => !img.complete || !img.naturalWidth).map(img => img.src)), []);
    assert.deepEqual(await worker.evaluate(() => globalThis.fixtureNativeCalls), ['status', 'status']);
    console.log('PASS: destination persists; returned popup uses its explicit sourceTabId through a real Markdown download; icons decode and no page errors');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
