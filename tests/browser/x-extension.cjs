// Shipped MV3, real activeTab grant, isolated-world capture and image decoding.
// Source/image/Feishu replies are fixtures; no real account or external writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const sourceUrl = 'https://x.com/example/status/2015691086459768855';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438HwHwAGmAKHfbWTmQAAAABJRU5ErkJggg==', 'base64');
const badge = '<svg data-testid="icon-verified" aria-label="Verified account" role="img"><path/></svg>';
const photo = n => `<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/${n}.png"></div>`;
const fixture = `<meta charset="utf-8"><title>来源站点</title><main>
<article data-testid="tweet"><div data-testid="User-Name">回复作者${badge}</div><a href="/reply/status/555"><time>错误日期</time></a><div data-testid="tweetText">${'更长的评论不属于目标文章。'.repeat(60)}</div></article>
<article data-testid="tweet"><div data-testid="Tweet-User-Avatar"><img src="https://pbs.twimg.com/avatar.png"></div><div data-testid="User-Name">原作者${badge}</div>
<div data-testid="tweetText" style="white-space:pre-wrap">目标推文标题\n\n原始正文第二段。<svg id="authored-svg" aria-label="实际不支持的正文图"><path/></svg></div>
<nav><div data-testid="ScrollSnap-List">${photo('one')}${photo('two')}</div></nav>
<div role="link"><div data-testid="User-Name">引用作者${badge}</div><div data-testid="tweetText">引用的可见预览</div><button data-testid="tweet-text-show-more-link">Show more</button><a href="/quoted/status/77/photo/1">${photo('quote')}</a></div>
<a href="/example/status/2015691086459768855"><time datetime="2026-01-26T07:39:00Z">目标日期</time></a>
<div role="group"><button data-testid="reply">123</button><button data-testid="like">456</button></div></article></main>`;
(async () => {
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--enable-unsafe-extension-debugging'] });
  try {
    await context.route('https://x.com/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await context.route('https://pbs.twimg.com/**', r => r.fulfill({ contentType: 'image/png', body: png, headers: { 'Access-Control-Allow-Origin': '*' } }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => {
      const parent = { space_id: '123', node_token: 'Parent', title: '测试目录', node_type: 'origin' };
      const f = globalThis.xFixture = { calls: [], plans: {}, created: 0, staged: [] };
      chrome.runtime.sendNativeMessage = (_host, message, cb) => {
        f.calls.push(message.action); const p = message.params; let data;
        try {
          switch (message.action) {
            case 'status': data = { available: true }; break;
            case 'list_spaces': data = { items: [{ space_id: '123', name: '测试知识库' }], has_more: false }; break;
            case 'get_space': data = { space: { space_id: '123', name: '测试知识库' } }; break;
            case 'get_node': data = { node: p.token === 'Parent' ? parent : { ...parent, node_token: 'SavedX', obj_type: 'docx', obj_token: 'CreatedX', parent_node_token: 'Parent' } }; break;
            case 'get_operation': data = { found: false }; break;
            case 'prepare_web_content': {
              if (p.snapshot) f.plans[p.operation_id] = structuredClone(p.snapshot);
              const plan = f.plans[p.operation_id];
              if (!plan) throw Object.assign(new Error('尚未读取正文'), { code: 'IMPORT_NOT_PREPARED' });
              data = { title: plan.title, block_count: plan.blocks.length, image_count: plan.images.length, images: plan.images }; break;
            }
            case 'stage_image': {
              f.staged.push(structuredClone(p)); const image = f.plans[p.operation_id].images.find(i => i.block_id === p.block_id);
              const next = p.offset + atob(p.data_base64).length; image.staged = next === p.total_size;
              data = { next_offset: next, complete: image.staged }; break;
            }
            case 'import_step': {
              const plan = f.plans[p.operation_id];
              if (plan.images.some(i => !i.staged)) throw new Error('图片未全部暂存');
              if (!plan.created) { plan.created = true; f.created++; }
              data = { complete: true, document: { token: 'CreatedX' } }; break;
            }
            case 'move_doc': data = { wiki_token: 'SavedX' }; break;
            default: throw new Error(`Unexpected action ${message.action}`);
          }
          queueMicrotask(() => cb({ ok: true, data }));
        } catch (e) { queueMicrotask(() => cb({ ok: false, error: e.message, code: e.code })); }
      };
      return chrome.storage.local.set({ feishuWikiClipTarget: { url: 'https://my.feishu.cn/wiki/Parent', origin: 'https://my.feishu.cn', spaceId: '123', parentToken: 'Parent', title: '测试目录', spaceName: '测试知识库' } });
    });
    const source = await context.newPage(); await source.goto(sourceUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, sourceUrl);
    const denied = await worker.evaluate(async tabId => { try { await chrome.scripting.executeScript({ target: { tabId }, func: () => true }); return false; } catch (_) { return true; } }, tabId);
    assert(denied, 'X must not have permanent host permission in the shipped manifest');
    // CDP triggers the same extension action as the toolbar. This grants the
    // real activeTab permission without modifying the manifest or mocking APIs.
    const cdp = await context.browser().newBrowserCDPSession();
    const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const target = targets.targetInfos.find(t => t.url === sourceUrl); assert(target);
    await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
    await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => true }), tabId);
    const save = await context.newPage();
    await save.goto(`chrome-extension://${id}/feishu-save.html?${new URLSearchParams({ source: sourceUrl, sourceTabId: String(tabId) })}`);
    await save.locator('#connectionPanel[data-state="connected"]').waitFor();
    await save.waitForFunction(() => !document.getElementById('save').disabled);
    await save.locator('#save').click();
    await save.waitForFunction(() => document.getElementById('jobStatus').classList.contains('status-error'));
    assert.match(await save.locator('#jobStatus').innerText(), /svg/);
    assert.equal(await worker.evaluate(() => xFixture.created), 0);
    const failedJobId = new URL(save.url()).searchParams.get('jobId'); assert(failedJobId);
    // Remove the genuinely unsupported resource, then simulate a source tab
    // still running v9. The normal save service must upgrade it on retry.
    await source.locator('#authored-svg').evaluate(node => node.remove());
    await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
      globalThis.FeishuWebCapture = { version: 9, snapshot() { throw new Error('Old v9 capture was not upgraded'); }, handleMessage() {} };
    } }), tabId);
    await save.locator('#save').click();
    await save.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('保存成功'), undefined, { timeout: 25000 });
    assert.equal(new URL(save.url()).searchParams.get('jobId'), failedJobId, 'retry preserves the original request');
    const f = await worker.evaluate(() => xFixture);
    assert.equal(f.created, 1); assert.equal(Object.keys(f.plans).length, 1);
    const [plan] = Object.values(f.plans); assert.equal(plan.title, '目标推文标题');
    assert.deepEqual(plan.images.map(i => i.url), ['one', 'two', 'quote'].map(n => `https://pbs.twimg.com/${n}.png`));
    const text = plan.blocks.flatMap(b => Object.values(b).flatMap(v => v?.elements ? [v.elements.map(e => e.text_run?.content || '').join('')] : [])).join('\n');
    assert.match(text, /目标推文标题\n\n原始正文第二段。/); assert.match(text, /引用的可见预览/);
    assert.doesNotMatch(text, /更长的评论|错误日期|Show more|123|456/);
    assert.equal(f.staged.length, 3);
    for (const asset of f.staged) {
      assert.deepEqual(Buffer.from(asset.data_base64, 'base64'), png);
      assert.equal(asset.pixel_width, 1); assert.equal(asset.pixel_height, 1);
    }
    await save.reload(); await save.waitForFunction(() => document.getElementById('jobStatus').textContent.includes('保存成功'));
    assert.equal(await worker.evaluate(() => xFixture.created), 1);
    console.log('PASS shipped MV3 uses real X activeTab permission, rejects authored SVG before creation, upgrades old v9 on same-request retry, preserves all three decoded images and creates one document across reload');
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
