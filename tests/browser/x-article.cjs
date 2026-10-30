// Browser DOM regression. Synthetic X markup; no real accounts or Feishu writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const sourceUrl = 'https://x.com/example/status/2108363527971041650';
const badge = '<svg role="img" data-testid="icon-verified" aria-label="Verified account"><path d="M0 0"/></svg>';
const actions = '<div role="group"><button data-testid="reply">回复</button><button data-testid="like">赞</button><a href="/example/analytics">99999</a></div>';
const fixture = `<!doctype html><meta charset="utf-8"><title>作者 on X / X</title><main><article data-testid="tweet">
<div>外层作者${badge}</div><a href="/example/status/2108363527971041650"><time datetime="2026-10-09T01:06:00Z">日期</time></a><article data-testid="twitterArticleReadView">
<div><img src="https://pbs.twimg.com/cover.png"></div><div data-testid="twitter-article-title">原始长文标题</div>${actions}
<div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent">
<p>开头正文<strong>保留重点</strong>。</p><h2>正文第二节</h2><ul><li>第一个要点</li><li>第二个要点</li></ul>
<img src="https://pbs.twimg.com/body.png"><blockquote>原文引用段落</blockquote>
<div data-testid="simpleTweet"><article data-testid="tweet"><div data-testid="Tweet-User-Avatar"><img src="https://pbs.twimg.com/avatar.png"></div>
<div data-testid="User-Name">引用作者${badge}</div><a href="/example/status/123"><time>原文链接</time></a><div data-testid="tweetText">引用推文的可见预览</div>
<button data-testid="tweet-text-show-more-link">Show more</button><nav><div data-testid="ScrollSnap-List">
<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/quote-1.png"></div>
<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/quote-2.png"></div></div></nav>${actions}</article></div>
<p>文章最后一句。</p></div></div></article></article><article>推荐文章不属于正文${'额外文字'.repeat(200)}</article></main>`;
function content(snapshot) {
  return snapshot.blocks.flatMap(b => Object.values(b).flatMap(v => v?.elements ? [v.elements.map(e => e.text_run?.content || '').join('')] : [])).join('\n');
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
    async function load(url = sourceUrl) {
      await page.goto(url);
      await page.evaluate(() => { globalThis.chrome = { runtime: { onMessage: { addListener() {} } } }; globalThis.module = { exports: {} }; });
      for (const file of ['shared/web-feishu-blocks.js', 'shared/web-markdown-utils.js', 'content-scripts/feishu-exporter.js']) {
        await page.addScriptTag({ path: path.join(root, file) });
      }
    }
    await load();
    const snapshot = await page.evaluate(() => FeishuWebCapture.snapshot());
    assert.equal(snapshot.title, '原始长文标题');
    assert.deepEqual(snapshot.images.map(i => i.url), ['cover', 'body', 'quote-1', 'quote-2'].map(n => `https://pbs.twimg.com/${n}.png`));
    const text = content(snapshot);
    assert.match(text, /开头正文保留重点。/);
    assert.match(text, /引用作者（Verified account）/);
    assert.match(text, /引用推文（页面预览，完整内容见原文链接）/);
    assert.match(text, /文章最后一句。/);
    assert.doesNotMatch(text, /外层作者|推荐文章|99999|Show more/);
    assert(snapshot.blocks.some(b => b.block_type === 4));
    assert.equal(snapshot.blocks.filter(b => b.block_type === 12).length, 2);
    assert(snapshot.blocks.some(b => b.text?.elements.some(e => e.text_run?.text_element_style?.link?.url === 'https://x.com/example/status/123')));
    const markdown = await page.evaluate(() => module.exports.__test.exportGenericWebDocument('markdown', { includeImages: true, localImageAssets: true }));
    assert.equal(markdown.imageRequests.length, 4);
    assert.doesNotMatch(markdown.content, /外层作者|推荐文章|99999|Show more/);
    assert.match(markdown.content, /引用推文的可见预览/);
    console.log('PASS X Article selects the long-form body and retains title, prose, headings, lists, quoted preview, permalink and every carousel image');

    await page.evaluate(() => document.querySelector('[data-testid="longformRichTextComponent"]').insertAdjacentHTML('beforeend', '<svg role="img" aria-label="正文流程图"><path/></svg>'));
    const error = await page.evaluate(async () => { try { await FeishuWebCapture.snapshot(); } catch (e) { return { code: e.code, message: e.message }; } });
    assert.equal(error.code, 'UNSUPPORTED_CONTENT'); assert.match(error.message, /svg/);
    await load();
    await page.evaluate(() => { document.querySelector('[data-testid="longformRichTextComponent"]').textContent = ""; });
    assert.equal(await page.evaluate(() => module.exports.__test.waitForWebCaptureRoot(location.href, 0).then(() => 'unexpected', e => e.code)), 'PAGE_NOT_READY');
    await page.evaluate(() => document.querySelector('[data-testid="longformRichTextComponent"]').remove());
    assert.equal(await page.evaluate(() => module.exports.__test.waitForWebCaptureRoot(location.href, 0).then(() => 'unexpected', e => e.code)), 'PAGE_NOT_READY');
    await load();
    await page.evaluate(() => { const a = document.querySelector('[data-testid="twitterArticleReadView"]'); a.parentElement.append(a.cloneNode(true)); });
    assert.equal(await page.evaluate(() => FeishuWebCapture.snapshot().then(() => 'unexpected', e => e.code)), 'PAGE_CAPTURE_FAILED');
    await load('https://example.com/article');
    await page.evaluate(() => { document.body.innerHTML = '<article><p>' + '普通网站正文'.repeat(30) + '</p><svg data-testid="icon-verified" aria-label="Verified account"></svg></article>'; });
    assert.equal(await page.evaluate(() => FeishuWebCapture.snapshot().then(() => 'unexpected', e => e.code)), 'UNSUPPORTED_CONTENT');
    console.log('PASS real SVGs remain blocked, loading and ambiguous articles cannot fall back to surrounding tweets, and other sites retain strict capture');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
