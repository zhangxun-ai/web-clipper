// Real MV3 popup UI and storage. Only source HTTP and Native status are fixtures.
// No paid history query, real connector write, or account authorization runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const screenshots = process.env.UI_SCREENSHOT_DIR || path.join(root, 'output/implementation-forest-ui-20261030/screenshots');
const sourceUrl = 'https://scys.com/deepsea/1/course/123?chapterId=2';
const seedUrl = 'https://mp.weixin.qq.com/s/forest-list-fixture';
const listView = { listId: 'forest-list', seedUrl, startDate: '2026-10-01', endDate: '2026-10-30', complete: true, state: 'ready',
  matchedAccount: { nickname: '森林回归公众号' }, selectedUrls: [],
  articles: Array.from({ length: 36 }, (_, index) => ({ title: `用于检验长列表的文章 ${index + 1}`, url: `https://mp.weixin.qq.com/s/forest-${index + 1}`, publishDate: '2026-10-25' })) };
(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: process.env.HEADED !== '1',
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    viewport: { width: 452, height: 600 }, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    await context.route('https://scys.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<meta charset="utf-8"><title>森林版本的原课程章节</title><main><section class="level3-section"><h1 id="chapter-title-2">森林版本的原课程章节</h1><div class="feishu-doc-content"><p>真实课程原文，保留文章来源。这一段补充完整的章节内容，用于检验当前章节导出的真实文件。</p></div></section></main>' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.forestNativeCalls = [];
      chrome.runtime.sendNativeMessage = (_host, message, callback) => {
        forestNativeCalls.push(message.action);
        callback({ ok: false, code: 'NATIVE_UNAVAILABLE', error: 'Fixture connector unavailable' });
      };
    });
    const source = await context.newPage(); await source.goto(sourceUrl);
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, sourceUrl);
    await worker.evaluate(async view => chrome.storage.local.set({ wechatHistoryInput: { seedUrl: view.seedUrl, startDate: view.startDate, endDate: view.endDate }, wechatHistoryView: view }), listView);
    const popupUrl = await worker.evaluate(({ sourceTabId, sourceUrl }) => chrome.runtime.getURL('popup.html') + '?' + new URLSearchParams({ sourceTabId: String(sourceTabId), source: sourceUrl }), { sourceTabId, sourceUrl });
    let popup = await context.newPage(); await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('status-ready'));
    await popup.locator('#navTools').click(); await popup.locator('#categoryTabFeishu').click();
    await popup.locator('#batchSource').selectOption('wechat');
    await popup.locator('#batchLinks').fill('https://mp.weixin.qq.com/s/draft-one\nhttps://mp.weixin.qq.com/s/draft-two');
    await popup.locator('#batchOutputTarget').selectOption('both');
    await popup.locator('#batchZipOutput').uncheck(); await popup.locator('#batchIncludeImages').uncheck();
    await popup.locator('#batchLinks').focus();
    await popup.locator('#openExportSettings').click();
    await popup.locator('#outputTargetObsidian').check();
    await popup.locator('#backFromSettings').click();
    assert.equal(await popup.locator('#batchSource').inputValue(), 'wechat');
    assert.equal(await popup.locator('#batchOutputTarget').inputValue(), 'both');
    assert.equal(await popup.locator('#batchZipOutput').isChecked(), false);
    assert.equal(await popup.locator('#batchIncludeImages').isChecked(), false);
    await popup.waitForFunction(async () => (await chrome.storage.local.get('popupToolDraft')).popupToolDraft?.batchLinks?.includes('draft-two'));
    await popup.close(); popup = await context.newPage(); await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('status-ready'));
    await popup.locator('#navTools').click(); await popup.locator('#categoryTabFeishu').click();
    assert.equal(await popup.locator('#batchSource').inputValue(), 'wechat');
    assert.equal(await popup.locator('#batchLinks').inputValue(), 'https://mp.weixin.qq.com/s/draft-one\nhttps://mp.weixin.qq.com/s/draft-two');
    assert.equal(await popup.locator('#batchOutputTarget').inputValue(), 'both');
    assert.equal(await popup.locator('#batchZipOutput').isChecked(), false);
    assert.equal(await popup.locator('#batchIncludeImages').isChecked(), false);
    console.log('PASS: task draft survives settings/default changes and closing/reopening, including source, links, output, ZIP and images');

    await popup.locator('#backToTools').click(); await popup.locator('#categoryTabWechat').click();
    assert(await popup.locator('#helperArticleResults').isVisible());
    assert.equal(await popup.locator('#wechatConditions').evaluate(el => el.open), false);
    await popup.locator('#helperOutputFormat').selectOption('markdown');
    await popup.locator('#includeImagesHelper').uncheck();
    await popup.locator('#helperArticleList').evaluate(el => { el.scrollTop = 700; window.forestFirstRow = el.firstElementChild; window.forestListScroll = el.scrollTop; });
    const firstArticle = popup.locator('.history-article').first();
    const checkRect = await firstArticle.locator('input').boundingBox(), copyRect = await firstArticle.locator('.history-article-copy').boundingBox();
    assert(copyRect.x > checkRect.x && Math.abs(copyRect.y - checkRect.y) < 8, 'article row places checkbox next to content');
    const titleRect = await firstArticle.locator('.history-article-link').boundingBox(), dateRect = await firstArticle.locator('time').boundingBox();
    assert(dateRect.y >= titleRect.y + titleRect.height, 'publication date has its own line below the title');
    assert.equal(await popup.locator('#helperArticleList').evaluate(el => getComputedStyle(el).listStyleType), 'none', 'article picker has no native bullet points');
    await popup.locator('#helperSelectAll').click();
    assert.equal(await popup.locator('#helperArticleList').evaluate(el => el.firstElementChild === window.forestFirstRow), true, 'selection updates preserve row nodes');
    assert.equal(await popup.locator('#helperArticleList').evaluate(el => el.scrollTop), await popup.evaluate(() => window.forestListScroll));
    assert.equal(await popup.locator('#helperOutputFormat').inputValue(), 'markdown');
    assert.equal(await popup.locator('#includeImagesHelper').isChecked(), false);
    assert.equal(await popup.locator('#helperSelectAll').evaluate(el => el === document.activeElement), true, 'storage selection refresh retains button focus');
    await popup.locator('#helperSelectNone').click();
    assert.equal(await popup.locator('#helperArticleList input:checked').count(), 0);
    assert.equal(await popup.locator('#helperOutputFormat').inputValue(), 'markdown');
    await popup.screenshot({ path: path.join(screenshots, 'forest-wechat-results.png'), fullPage: true, animations: 'disabled' });

    const managerPromise = context.waitForEvent('page');
    await popup.locator('#openWechatManager').click(); const manager = await managerPromise;
    await manager.waitForURL(/view=wechat-manage/);
    await manager.waitForFunction(() => document.getElementById('helperArticleList').children.length === 36);
    const managerUrl = new URL(manager.url());
    assert.equal(managerUrl.searchParams.get('sourceTabId'), String(sourceTabId));
    assert.equal(managerUrl.searchParams.get('source'), sourceUrl);
    assert.equal(await manager.locator('#docTitle').textContent(), '森林版本的原课程章节');
    assert.equal(await manager.locator('#helperOutputFormat').inputValue(), 'markdown');
    assert.equal(await manager.locator('#includeImagesHelper').isChecked(), false);
    await manager.locator('#helperArticleList input').first().check();
    await popup.waitForFunction(() => document.querySelector('#helperArticleList input').checked);
    assert(await manager.locator('#helperDownloadSelected').isEnabled());
    assert(await popup.locator('#helperDownloadSelected').isEnabled());
    assert.match(await popup.locator('#helperArticleSummary').textContent(), /2026-10-01.*2026-10-30/);
    for (const [width, height] of [[1120, 800], [800, 800], [360, 720], [320, 600]]) {
      await manager.setViewportSize({ width, height });
      assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded manager fits its viewport');
      if (width === 1120) {
        assert((await manager.locator('#helperArticleResults').boundingBox()).width >= 480, 'desktop expanded list uses the full available column instead of the fixed popup width');
        assert((await manager.locator('.history-article-link').first().boundingBox()).height < 60, 'desktop article titles cannot become narrow vertical text');
      }
      await manager.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      assert(await manager.locator('#helperDownloadSelected').isEnabled(), 'selected download stays enabled after responsive layout changes');
      const actionRect = await manager.locator('#helperDownloadSelected').boundingBox();
      assert(actionRect.y >= 0 && actionRect.y + actionRect.height <= height, 'long-list download action remains in view on desktop and narrow screens');
      await manager.screenshot({ path: path.join(screenshots, `forest-manager-scrolled-${width}.png`), animations: 'disabled' });
      await manager.evaluate(() => scrollTo(0, 0));
      await manager.screenshot({ path: path.join(screenshots, `forest-manager-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    await manager.close();
    assert.equal(await worker.evaluate(() => forestNativeCalls.some(action => action.startsWith('tikhub_article'))), false, 'selection and expanded manager never request paid history pages');
    console.log('PASS: local list selection preserves rows, scroll, focus and options; expanded manager keeps source identity and synchronizes selection without paid queries');

    await popup.locator('#backToTools').click(); await popup.locator('#categoryTabScys').click();
    await popup.locator('#courseOutputTarget').selectOption('download');
    await popup.locator('input[name=courseScope][value=all]').check();
    assert.equal(await popup.locator('#startCourseExport').textContent(), '导出完整专栏');
    await popup.evaluate(() => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        if (args[1]?.type === 'feishu-export:get-scys-course-outline') return args.at(-1)({ ok: true, data: { courseTitle: '回归专栏', courseUrl: location.href, chapters: [{ title: '第一章', url: 'https://scys.com/deepsea/1/course/123?chapterId=2' }] } });
        return original(...args);
      };
      window.forestRunnerRoutes = [];
      chrome.tabs.create = (options, callback) => { forestRunnerRoutes.push(options.url); const tab = { id: 999 }; if (callback) callback(tab); else return Promise.resolve(tab); };
    });
    const beforePreview = await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('batchJob:')).length);
    await popup.locator('#courseOutline > summary').click();
    await popup.waitForFunction(() => document.getElementById('courseOutlineList').textContent === '第一章');
    assert.equal(await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('batchJob:')).length), beforePreview, 'outline preview does not create an export task');
    assert.equal(await popup.evaluate(() => window.forestRunnerRoutes.length), 0);
    await popup.locator('#startCourseExport').click();
    await popup.waitForFunction(() => window.forestRunnerRoutes.length === 1);
    const jobId = new URL(await popup.evaluate(() => forestRunnerRoutes[0])).searchParams.get('jobId');
    const job = await worker.evaluate(async id => (await chrome.storage.local.get('batchJob:' + id))['batchJob:' + id], jobId);
    assert.equal(job.type, 'course-export'); assert.equal(job.outputTarget, 'download'); assert.equal(job.saveToObsidian, false);
    assert.equal(job.chapters.length, 1);
    assert.equal(await popup.locator('#courseOutlineList li').textContent(), '第一章');
    await popup.locator('input[name=courseScope][value=current]').check();
    assert.equal(await popup.locator('#startCourseExport').textContent(), '导出当前章节');
    const downloaded = popup.waitForEvent('download');
    await popup.locator('#startCourseExport').click();
    await popup.waitForFunction(() => !document.getElementById('startCourseExport').disabled);
    const chapterDownload = await Promise.race([downloaded, popup.waitForFunction(() => document.getElementById('status').classList.contains('status-error')).then(async () => { throw new Error('Current chapter export: ' + await popup.locator('#status').textContent()); })]);
    const chapterText = fs.readFileSync(await chapterDownload.path(), 'utf8');
    assert.match(chapterText, /真实课程原文/);
    assert.equal(await popup.evaluate(() => window.forestRunnerRoutes.length), 1, 'current chapter does not create another full-course runner');
    assert.deepEqual(errors, []);
    console.log('PASS: readonly outline preview creates no task; explicit full-course output creates the real stored job, while current chapter downloads its own actual Markdown');

    // The independent local list outlives the source tab. It must never capture
    // the unrelated active extension page as a replacement article.
    await source.close();
    const afterSourceClosedCalls = await worker.evaluate(() => forestNativeCalls.length);
    const retainedManager = await context.newPage();
    await retainedManager.addInitScript(() => {
      globalThis.forestSourceMessages = [];
      const send = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => { forestSourceMessages.push({ tabId: args[0], type: args[1]?.type }); return send(...args); };
    });
    await retainedManager.goto(managerUrl.href);
    await retainedManager.waitForFunction(() => document.getElementById('helperArticleList').children.length === 36
      && document.getElementById('status').textContent.includes('已有文章列表仍可管理'));
    assert.equal(new URL(retainedManager.url()).searchParams.get('sourceTabId'), String(sourceTabId));
    assert.equal(new URL(retainedManager.url()).searchParams.get('source'), sourceUrl);
    assert.equal(await retainedManager.locator('#helperOutputFormat').inputValue(), 'markdown');
    assert.equal(await retainedManager.locator('#includeImagesHelper').isChecked(), false);
    await retainedManager.locator('#helperArticleList input').nth(1).check();
    assert(await retainedManager.locator('#helperDownloadSelected').isEnabled());
    assert.equal(await retainedManager.locator('#openFeishuSave').isDisabled(), true, 'a missing source cannot expose an enabled save-current-page action');
    assert.equal(await retainedManager.locator('#primaryAction').isVisible(), false);
    assert.deepEqual(await retainedManager.evaluate(() => forestSourceMessages), [], 'local list recovery never reads the active extension page as article content');
    const retainedCalls = await worker.evaluate(before => forestNativeCalls.slice(before), afterSourceClosedCalls);
    assert.equal(retainedCalls.some(action => action.startsWith('tikhub_article')), false, 'recovery does not buy another history page');
    await retainedManager.setViewportSize({ width: 1120, height: 800 });
    await retainedManager.evaluate(() => scrollTo(0, 0));
    await retainedManager.screenshot({ path: path.join(screenshots, 'forest-manager-source-closed.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log('PASS: closing the original source retains the manageable local list, format and original route identity without reading another page or making a paid query');

  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
