// X DOM contract regressions. Synthetic data, no live accounts or external writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const targetId = '2015691086459768855';
const url = `https://x.com/example/status/${targetId}`;
const badge = '<svg data-testid="icon-verified" role="img" aria-label="Verified account"><path/></svg>';
const actions = '<div role="group"><button data-testid="reply">111</button><button data-testid="like">222</button><a href="/example/status/123/analytics">333</a></div>';
const image = name => `<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/${name}.png"></div>`;
const quote = (body = '引用预览', media = image('quoted')) => `<div role="link"><div data-testid="User-Name">引用作者${badge}</div><div data-testid="tweetText">${body}</div><button data-testid="tweet-text-show-more-link">Show more</button><a href="/quoted/status/77/photo/1">${media}</a></div>`;
const post = (id, body, extra = '') => `<article data-testid="tweet"><div data-testid="Tweet-User-Avatar"><img src="https://pbs.twimg.com/avatar.png"></div><div data-testid="User-Name">作者${badge}</div><div data-testid="tweetText" style="white-space:pre-wrap">${body}</div>${extra}<a href="/example/status/${id}"><time datetime="2026-01-26T07:39:00Z">Jan 26</time></a><a href="/example/status/${id}/analytics">999999 Views</a>${actions}</article>`;
const textOf = s => s.blocks.flatMap(b => Object.values(b).flatMap(v => v?.elements ? [v.elements.map(e => e.text_run?.content || '').join('')] : [])).join('\n');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    let fixture = '';
    const page = await browser.newPage();
    await page.route('**/*', r => r.request().resourceType() === 'document' ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<meta charset="utf-8"><title>不应使用站点摘要作为长标题</title><main>${fixture}</main>` }) : r.abort());
    async function load(body, source = url) {
      fixture = body;
      await page.goto(source);
      await page.evaluate(() => { globalThis.chrome = { runtime: { onMessage: { addListener() {} } } }; globalThis.module = { exports: {} }; });
      for (const file of ['shared/web-feishu-blocks.js', 'shared/web-markdown-utils.js', 'content-scripts/feishu-exporter.js']) await page.addScriptTag({ path: path.join(root, file) });
    }
    const capture = () => page.evaluate(() => FeishuWebCapture.snapshot());
    const failure = () => page.evaluate(() => FeishuWebCapture.snapshot().then(() => 'unexpected', e => e.code));
    const pending = () => page.evaluate(() => module.exports.__test.waitForWebCaptureRoot(location.href, 0).then(() => 'unexpected', e => e.code));
    const unrelated = post('999', '评论很长'.repeat(150), '<article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">评论中的Article标题</div></article>').replace('2026-01-26T07:39:00Z', '2020-01-01T00:00:00Z');
    const body = `短推文\n\n第二段<a href="https://example.com/guide">链接</a>`;
    const target = post(targetId, body, quote());
    await load(unrelated + target);
    const result = await capture();
    assert.equal(result.title, '短推文');
    assert.match(textOf(result), /短推文\n\n第二段链接/);
    assert.match(textOf(result), /引用作者（Verified account）/);
    assert.match(textOf(result), /引用推文（页面预览，完整内容见原文链接）/);
    assert.doesNotMatch(textOf(result), /评论很长|评论中的Article标题|999999|Show more|111|222|333/);
    assert.deepEqual(result.images.map(i => i.url), ['https://pbs.twimg.com/quoted.png']);
    assert(result.blocks.some(b => b.text?.elements.some(e => e.text_run?.text_element_style?.link?.url === 'https://x.com/quoted/status/77')));
    const exported = await page.evaluate(() => module.exports.__test.exportGenericWebDocument('markdown', { includeImages: true, localImageAssets: true }));
    assert.equal(exported.title, '短推文'); assert.equal(exported.imageRequests.length, 1);
    const jsonExport = await page.evaluate(() => module.exports.__test.exportGenericWebDocument('json', { includeImages: true }));
    assert.equal(JSON.parse(jsonExport.content).meta.publishTime, '2026-01-26T07:39:00Z');
    assert.doesNotMatch(exported.content, /评论很长|999999|Show more/);
    console.log('PASS exact URL identity selects short posts ahead of longer replies and quoted Articles, preserving source text, links and quoted images');

    const carousel = `<nav><div data-testid="ScrollSnap-List">${image('one')}${image('two')}</div></nav>`;
    await load(post(targetId, '轮播图正文', `<div role="group"><p>互动栏外的真实说明</p>${carousel}${actions}</div>${quote('纯文字引用', '')}`));
    const images = await capture();
    assert.deepEqual(images.images.map(i => i.url), ['https://pbs.twimg.com/one.png', 'https://pbs.twimg.com/two.png']);
    assert.match(textOf(images), /互动栏外的真实说明/);
    assert.match(textOf(images), /在来源网页查看引用/);
    assert.doesNotMatch(textOf(images), /111|222|333/);
    await load(post(targetId, '正文', '<nav><p>未知容器</p>' + image('unknown-nav') + '</nav>'));
    assert.equal(await failure(), 'CONTENT_MISMATCH', 'cleanup cannot silently erase a non-carousel source image');
    console.log('PASS original media survives primary carousels and quoted media; outer groups retain prose; cleanup omissions fail against the live DOM');

    for (const svg of ['<svg aria-label="真实流程图"><path/></svg>', '<svg data-testid="icon-verified" aria-label="仍是正文SVG"><path/></svg>']) {
      await load(post(targetId, '正文' + svg)); assert.equal(await failure(), 'UNSUPPORTED_CONTENT');
    }
    await load(post(targetId, '尚未展开', '<button data-testid="tweet-text-show-more-link">Show more</button>'));
    assert.equal(await failure(), 'PAGE_NOT_READY');
    await load(post(targetId, ''));
    assert.equal(await pending(), 'PAGE_NOT_READY');
    await load(post(targetId, '文章预览', '<div data-testid="article-cover-image"><img src="https://pbs.twimg.com/article.png"></div>'));
    assert.equal(await pending(), 'PAGE_NOT_READY');
    await load(post('999', `<a href="/example/status/${targetId}">正文提到了目标链接</a>`));
    assert.equal(await pending(), 'PAGE_NOT_READY');
    await load(post('999', '另一条推文', `<div role="link"><div data-testid="User-Name">目标作者</div><a href="/example/status/${targetId}"><time>引用时间</time></a><div data-testid="tweetText">引用内容</div></div>`));
    assert.equal(await pending(), 'PAGE_NOT_READY');
    console.log('PASS unexpanded, empty, preview-only and missing targets cannot save partial content or substitute a reply; real body SVGs stay protected');

    await load(target + target); assert.equal(await failure(), 'PAGE_CAPTURE_FAILED');
    await load(`<div style="display:none">${target}</div>${target}`); assert.equal((await capture()).title, '短推文');
    await load(target, `https://twitter.com/example/status/${targetId}?s=20`); assert.equal((await capture()).title, '短推文');
    await load(target, `https://x.com/i/web/status/${targetId}`); assert.equal((await capture()).title, '短推文');
    await load(target, 'https://x.com/example'); assert.equal(await failure(), 'PAGE_CAPTURE_FAILED');
    await load(post(targetId, '主推文标题', quote('<div data-testid="twitter-article-title">引用里的文章标题</div>')));
    assert.equal((await capture()).title, '主推文标题');
    await load(post(targetId, '', image('image-only'))); assert.equal((await capture()).images.length, 1);
    console.log('PASS hidden copies, duplicate targets, Twitter aliases, i/web URLs, quote titles and image-only posts follow the same content boundary');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
