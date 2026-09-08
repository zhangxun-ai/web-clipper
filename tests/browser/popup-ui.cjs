// Real MV3 page, storage, injection and keyboard navigation. Only the source
// article is a network fixture; no user account or external write is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const screenshotDir = process.env.UI_SCREENSHOT_DIR;
const sourceUrl = 'https://scys.com/articleDetail/xq_topic/ui-review';
const articleTitle = '把读过的内容，变成自己的知识';

(async () => {
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: process.env.HEADED !== '1',
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    viewport: { width: 452, height: 600 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const errors = [];
  const shot = async (page, name) => {
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  };
  const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page must fit the viewport');
  try {
    await context.route('https://scys.com/**', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<meta charset="utf-8"><title>${articleTitle}</title><main><h1>${articleTitle}</h1><div class="feishu-doc-content"><p>好的知识管理，是让有价值的内容随时可用。这是一篇用于界面验收的示例文章。</p><h2>从阅读开始</h2><p>保留正文，选择合适的位置，完成一次清晰的整理。</p></div></main>`
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const source = await context.newPage();
    await source.goto(sourceUrl);
    const nextPage = context.waitForEvent('page');
    await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }));
    const popup = await nextPage;
    popup.on('pageerror', error => errors.push(error.message));
    await popup.waitForFunction(() => document.getElementById('status')?.classList.contains('status-ready'));
    assert.equal(await popup.locator('#docTitle').textContent(), articleTitle);
    assert(await popup.locator('#primaryAction').isEnabled());
    assert(await popup.locator('#openFeishuSave').isEnabled());
    const primary = await popup.locator('#primaryAction').boundingBox();
    assert(primary.y + primary.height < 600, 'primary export must be visible without scrolling in the popup');
    await noOverflow(popup);
    await shot(popup, 'popup-after');
    console.log(`PASS: 452px popup main action visible at ${Math.round(primary.y)}px, with real source title and enabled actions`);

    // Delay the real read response to make the cancel transition observable.
    // Cancellation finishes before any download or file write is attempted.
    await popup.evaluate(() => {
      const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        if (args[1]?.type === 'feishu-export:export-document') return setTimeout(() => sendMessage(...args), 700);
        return sendMessage(...args);
      };
    });
    await popup.locator('#primaryAction').click();
    assert.equal(await popup.locator('#primaryAction').getAttribute('data-action-key'), 'cancel-export');
    await popup.locator('#primaryAction').click();
    await popup.waitForFunction(() => document.getElementById('primaryAction').dataset.actionKey === 'export-markdown');
    assert.match(await popup.locator('#status').textContent(), /已停止导出/);
    assert.deepEqual(await worker.evaluate(() => chrome.downloads.search({})), []);
    console.log('PASS: only an active export shows cancel; stopping a pending read restores the action without a download');

    await popup.locator('#openExportSettings').click();
    assert(await popup.locator('#includeImages').isVisible());
    assert.equal(await popup.locator('#popupAdvancedSettings').evaluate(el => el.open), true);
    await popup.locator('[data-preset="ai-ready"]').click();
    assert(await popup.locator('#includeImages').isChecked());
    assert.equal(await popup.locator('[data-preset="ai-ready"]').getAttribute('aria-pressed'), 'true');
    await popup.locator('[data-preset="quick-export"]').click();
    assert.equal(await popup.locator('#includeImages').isChecked(), false);
    await popup.locator('#popupAdvancedSettings > summary').click();
    await popup.locator('[data-preset="obsidian"]').click();
    await popup.locator('#pickObsidianFolder').waitFor({ state: 'visible' });
    await popup.waitForFunction(() => document.querySelector('[data-preset="quick-export"]').getAttribute('aria-pressed') === 'true');
    assert(await popup.locator('#pickObsidianFolder').isVisible());
    assert.equal(await popup.evaluate(() => document.activeElement.id), 'pickObsidianFolder');
    assert.equal(await popup.locator('[data-preset="quick-export"]').getAttribute('aria-pressed'), 'true');
    assert(await popup.locator('#status.status-error').isVisible());
    await shot(popup, 'popup-obsidian-setup');
    console.log('PASS: settings link opens its controls; presets update inputs; missing Obsidian permission reveals and focuses the recovery action');

    // Reload from a real source to clear the expected setup error for tool checks.
    await worker.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.update(tab.id, { active: true });
    }, sourceUrl);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('status')?.classList.contains('status-ready'));
    await popup.locator('#toolsDrawer > summary').click();
    await popup.locator('#categoryTabWechat').click();
    assert(await popup.locator('#batchLinks').isVisible());
    assert(await popup.locator('#helperSeedUrl').isVisible());
    assert.equal(await popup.locator('#categoryTabWechat').getAttribute('tabindex'), '0');
    await popup.locator('#categoryTabWechat').press('ArrowRight');
    assert.equal(await popup.locator('#categoryTabFeishu').getAttribute('aria-selected'), 'true');
    assert.equal(await popup.locator('#categoryToolsPanel').getAttribute('aria-labelledby'), 'categoryTabFeishu');
    assert.equal(await popup.locator('#helperSeedUrl').isVisible(), false);
    await popup.locator('#categoryTabFeishu').press('End');
    assert.equal(await popup.locator('#categoryTabOther').getAttribute('aria-selected'), 'true');
    await popup.locator('#categoryTabOther').press('Home');
    assert.equal(await popup.locator('#categoryTabWechat').getAttribute('aria-selected'), 'true');
    assert.equal(await popup.locator('#docTitle').textContent(), articleTitle, 'tool categories must not replace the source');
    const columns = await popup.locator('.category-tabs').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 4, '452px popup must not collapse categories into four full-width rows');
    await popup.locator('#popupAdvancedSettings > summary').click();
    await noOverflow(popup);
    await shot(popup, 'popup-tools');
    console.log('PASS: all tool categories remain reachable; arrow/Home/End navigation and selected panel names are synchronized');

    // Long source title is read through the actual extension capture path.
    await source.evaluate(() => { document.title = '用于检验超长文章标题的内容'.repeat(12); });
    await worker.evaluate(async url => { const [tab] = await chrome.tabs.query({ url }); await chrome.tabs.update(tab.id, { active: true }); }, sourceUrl);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('status')?.classList.contains('status-ready'));
    for (const width of [452, 390, 320]) {
      await popup.setViewportSize({ width, height: 720 });
      await noOverflow(popup);
      await popup.locator('#toolsDrawer').evaluate(el => { el.open = true; });
      await popup.locator('#categoryTabWechat').click();
      await popup.locator('#popupAdvancedSettings').evaluate(el => { el.open = true; });
      await noOverflow(popup);
      await shot(popup, `popup-long-${width}`);
    }
    console.log('PASS: long titles, expanded date fields and export settings fit 452px, 390px and 320px');

    await context.route('https://mp.weixin.qq.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>公众号后台</title>' }));
    await source.goto('https://mp.weixin.qq.com/cgi-bin/home');
    await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://mp.weixin.qq.com/cgi-bin/home' }); await chrome.tabs.update(tab.id, { active: true }); });
    await popup.setViewportSize({ width: 452, height: 600 });
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('docType')?.textContent === '公众号后台');
    assert.equal(await popup.locator('#primaryAction').getAttribute('data-action-key'), 'focus-wechat-history');
    assert(await popup.locator('#primaryAction').isEnabled());
    await popup.locator('#primaryAction').click();
    assert(await popup.locator('#helperSeedUrl').isVisible());
    assert.equal(await popup.evaluate(() => document.activeElement.id), 'helperSeedUrl');
    console.log('PASS: WeChat backend primary action opens the history form instead of showing an idle cancel action');

    await source.goto('about:blank');
    await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'about:blank' }); await chrome.tabs.update(tab.id, { active: true }); });
    await popup.setViewportSize({ width: 452, height: 600 });
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('status')?.classList.contains('status-error'));
    assert.equal(await popup.locator('#primaryAction').isVisible(), false);
    assert.equal(await popup.locator('#openFeishuSave').isEnabled(), false);
    await shot(popup, 'popup-unsupported');
    assert.deepEqual(errors, []);
    console.log('PASS: unsupported browser page shows recovery guidance and no enabled export/save action; no page script errors');
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
