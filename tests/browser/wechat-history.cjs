// Real MV3 popup -> seed metadata -> restricted native bridge -> paginated
// history -> actual batch runner and ZIP download. Only Native Messaging and
// article/image HTTP responses are fixtures. No .env, paid API or Feishu writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deflateSync } = require("node:zlib");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const username = "gh_6990113d8818";
const biz = "MzE5ODg1MTY4Mw==";
const nickname = "语言即世界浏览器回归";
const cursor = "eyJvZmZzZXQiOiIyMCIsInNpZ24iOiIrLz0ifQ==";
const imageUrl = "https://mmbiz.qpic.cn/wechat-history-fixture.png";
const epoch = value => Math.floor(new Date(`${value}+08:00`).getTime() / 1000);
const articleUrl = (mid, articleBiz = biz) => {
  const url = new URL("https://mp.weixin.qq.com/s");
  for (const [key, value] of Object.entries({ __biz: articleBiz, mid: String(mid), idx: "1", sn: String(mid).padStart(32, "0") })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};
const records = [
  { mid: "101", title: "次日零点文章", published: "2026-09-08T00:01:00", created: "2026-09-07T22:00:00", body: "次日正文必须排除" },
  { mid: "102", title: "种子文章真实发表日期", published: "2026-09-07T12:00:00", created: "2026-09-06T18:00:00", body: "种子正文开头，保留原文内容。" },
  { mid: "103", title: "当日零点边界文章", published: "2026-09-07T00:00:00", created: "2026-09-06T17:00:00", body: "零点边界正文开头，仍属于开始日期。" },
  { mid: "104", title: "前日最后一分钟", published: "2026-09-06T23:59:00", created: "2026-09-06T16:00:00", body: "前日正文必须排除" }
].map(item => ({ ...item, url: articleUrl(item.mid) }));
const seedUrl = records[1].url;
const badUrl = articleUrl("105");
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const articleHtml = item => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escape(item.title)}</title><meta property="og:url" content="${escape(item.url)}">
<script>var biz = "${biz}"; var mid = "${item.mid}"; var idx = "${item.idx || "1"}";
var sn = "${item.mid.padStart(32, "0")}"; var user_name = "${username}";
var ct = "${epoch(item.published)}";</script></head><body>
<div id="js_article"><h1 id="activity-name">${escape(item.title)}</h1>
<a id="js_name">${nickname}</a><span id="publish_time">${item.published.slice(0, 10)}</span>
<div id="js_content"><p>${escape(item.body)}</p><h2>原文二级标题</h2>
<img data-src="${imageUrl}"><p>图片后的原文结尾，内容完整。</p></div></div></body></html>`;
const listItem = item => ({ title: item.title, url: item.url,
  createTimestamp: epoch(item.created), updateTimestamp: epoch(item.created),
  publishTimestamp: epoch(item.published), publicationSource: "article" });
const successfulPages = [
  { account: { username, fakeid: biz }, articles: records.slice(0, 2).map(listItem), isEnd: false, nextOffset: cursor, cached: false },
  { account: { username, fakeid: biz }, articles: records.slice(2).map(listItem), isEnd: true, nextOffset: "", cached: false }
];

function pngChunk(name, data) {
  const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, type, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
const imageBytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 80, 120, 160]))), pngChunk("IEND", Buffer.alloc(0))]);

// Read the ZIP local headers produced by the shipped runner (stored entries).
// This validates downloaded bytes rather than the UI's success message.
function unzipStoredEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, "runner ZIP entries must be stored without compression");
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString("utf8");
    const start = offset + 30 + nameSize + extraSize;
    assert(start + size <= bytes.length, "downloaded ZIP entry is not truncated");
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert(entries.size > 0, "download contains actual ZIP entries");
  return entries;
}

async function installNativeFixture(worker) {
  await worker.evaluate(({ username, biz, pages }) => {
    const fixture = globalThis.wechatHistoryFixture = { calls: [], jobs: [], pages, pageIndex: 0, errors: [], requests: [], attached: {}, delayMs: 0 };
    // An extension-created target can send its first request before Playwright
    // attaches response routing. Keep real tab creation/navigation APIs, but
    // postpone that first HTTP request until the test has attached to the tab.
    const createTab = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = (options, callback) => {
      if (String(options.url || "").includes("batch-runner.html?jobId=") && fixture.runnerDelayMs) {
        const promise = new Promise(resolve => setTimeout(resolve, fixture.runnerDelayMs)).then(() => createTab(options));
        if (typeof callback !== "function") return promise;
        promise.then(callback); return;
      }
      if (!String(options.url || "").startsWith("https://mp.weixin.qq.com/")) return createTab(options, callback);
      const marker = crypto.randomUUID();
      const promise = createTab({ ...options, url: "about:blank#wechat-history-fixture-" + marker }).then(async tab => {
        const until = Date.now() + 10000;
        while (!fixture.attached[marker]) {
          if (Date.now() > until) throw new Error("Playwright did not attach fixture routing to the new article tab");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return chrome.tabs.update(tab.id, { url: options.url });
      });
      if (typeof callback !== "function") return promise;
      promise.then(callback).catch(error => { fixture.errors.push(error.message); callback(undefined); });
    };
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === "wechat-history" && ["resolve", "download", "list", "download-selected"].includes(message.action)) {
        fixture.requests.push({ action: message.action, params: structuredClone(message.params) });
      }
      return false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith("batchJob:") && change.newValue) fixture.jobs.push(structuredClone(change.newValue));
      }
    });
    chrome.runtime.sendNativeMessage = (host, message, callback) => {
      fixture.calls.push(structuredClone(message));
      try {
        const expectedHost = message.action.startsWith("tikhub_") ? "com.wechat.clipper" : "com.feishu.clipper";
        if (host !== expectedHost) throw new Error("Unexpected native host");
        let data;
        if (message.action === "status") data = { available: true, version: "fixture" };
        else if (message.action === "tikhub_status") data = { available: true, configured: true, source: "tikhub" };
        else if (message.action === "tikhub_article_page") {
          const params = message.params;
          if (params.username !== username || params.biz !== biz) throw new Error("Wrong account passed to native bridge");
          if (Object.keys(params).some(key => !["username", "biz", "offset"].includes(key))) throw new Error("Native page request contains unexpected fields");
          const expectedOffset = fixture.pageIndex === 0 ? "" : fixture.pages[fixture.pageIndex - 1]?.nextOffset;
          if ((params.offset || "") !== expectedOffset) throw new Error("Opaque pagination cursor was changed or skipped");
          if (fixture.pageError && fixture.pageIndex === fixture.pageError.index) {
            const response = { ok: false, code: fixture.pageError.code, error: fixture.pageError.error, details: fixture.pageError.details };
            if (fixture.delayMs) setTimeout(() => callback(response), fixture.delayMs); else queueMicrotask(() => callback(response));
            return;
          }
          data = fixture.pages[fixture.pageIndex++];
          if (!data) throw new Error("History fetched beyond fixture pages");
        } else throw new Error("Unexpected native action: " + message.action);
        const response = { ok: true, data: structuredClone(data) };
        if (message.action === "tikhub_article_page" && fixture.delayMs) setTimeout(() => callback(response), fixture.delayMs);
        else queueMicrotask(() => callback(response));
      } catch (error) {
        fixture.errors.push(error.message);
        queueMicrotask(() => callback({ ok: false, code: "FIXTURE_ERROR", error: error.message }));
      }
    };
  }, { username, biz, pages: successfulPages });
}

(async () => {
  // Created by this test as disposable browser download staging. It never
  // contains pre-existing user files or configured project credentials.
  const downloadsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-history-download-test-"));
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1", acceptDownloads: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const browserErrors = [], unexpectedRequests = [];
  const originalArticleRequests = [];
  let badArticle = false;
  let mismatch = "";
  let worker;
  const routeArticle = route => {
    const url = new URL(route.request().url());
    originalArticleRequests.push(url.toString());
    if (url.searchParams.get("mid") === "105" && mismatch === "mid") {
      return route.fulfill({ status: 302, headers: { location: records[2].url }, body: "" });
    }
    if (url.searchParams.get("mid") === "106" && mismatch === "idx") {
      if (url.searchParams.get("idx") === "1") {
        url.searchParams.set("idx", "2");
        return route.fulfill({ status: 302, headers: { location: url.toString() }, body: "" });
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: articleHtml({ ...records[2], mid: "106", idx: "2", url: url.toString() }) });
    }
    const item = records.find(record => url.searchParams.get("mid") === record.mid);
    if (item) return route.fulfill({ contentType: "text/html; charset=utf-8", body: articleHtml(item) });
    if (url.searchParams.get("mid") === "105" && badArticle) {
      return route.fulfill({ contentType: "text/html; charset=utf-8",
        body: '<title>环境异常</title><div class="weui-msg__title">环境异常</div><p>完成验证后即可继续访问</p>' });
    }
    unexpectedRequests.push(url.toString());
    return route.fulfill({ status: 404, body: "Unexpected fixture request" });
  };
  context.on("page", page => {
    page.on("pageerror", error => browserErrors.push(error.message));
    page.waitForURL(/^about:blank#wechat-history-fixture-/, { timeout: 1000 }).then(async () => {
      const marker = page.url().split("#wechat-history-fixture-")[1];
      await page.route("https://mp.weixin.qq.com/**", routeArticle);
      if (worker && marker) await worker.evaluate(marker => { wechatHistoryFixture.attached[marker] = true; }, marker);
    }).catch(() => {});
  });
  try {
    await context.route("https://api.tikhub.io/**", route => {
      unexpectedRequests.push(route.request().url());
      return route.abort();
    });
    await context.route(imageUrl, route => route.fulfill({ contentType: "image/png", body: imageBytes }));
    await context.route("https://mp.weixin.qq.com/**", routeArticle);
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const completedDownloads = expected => worker.evaluate(async expected => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const downloads = await chrome.downloads.search({});
        if (downloads.some(item => item.state === "interrupted")) throw new Error("browser download was interrupted");
        const complete = downloads.filter(item => item.state === "complete");
        if (complete.length >= expected) return complete;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("browser downloads never completed");
    }, expected);
    await installNativeFixture(worker);
    await worker.evaluate(() => chrome.storage.local.set({ outputTarget: "obsidian", clipperDestination: "obsidian", includeImages: true }));
    const extensionId = new URL(worker.url()).host;
    const source = await context.newPage();
    await source.goto(seedUrl);
    const cdp = await context.newCDPSession(source);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadsDirectory, eventsEnabled: true });
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, seedUrl);
    const seed = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: "feishu-export:get-wechat-history-seed" }), sourceTabId);
    assert.equal(seed.ok, true, seed.error);
    assert.equal(seed.data.username, username, "the shipped content script extracts the account's gh username");
    assert.equal(seed.data.biz, biz);
    assert.equal(seed.data.publishTimestamp, epoch(records[1].published));
    const popupUrl = `chrome-extension://${extensionId}/popup.html?${new URLSearchParams({ sourceTabId: String(sourceTabId), source: seedUrl, destination: "obsidian" })}`;
    let popup = await context.newPage();
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator("#toolsDrawer > summary").click();
    await popup.locator("#categoryTabWechat").click();
    await popup.locator("#helperSeedUrl").fill(seedUrl);
    await popup.locator("#helperStartDate").fill("2026-09-07");
    await popup.locator("#helperEndDate").fill("2026-09-07");
    assert.equal(await popup.locator("#openWechatMpLogin").count(), 0, "TikHub workflow must not require opening the old backend login");
    await popup.locator("#helperCheck").click();
    await popup.waitForFunction(() => /status-(ready|error)/.test(document.getElementById("helperStatus")?.className || ""));
    assert.equal(await popup.locator("#helperStatus").evaluate(element => element.classList.contains("status-ready")), true,
      `${await popup.locator("#helperStatus").textContent()}\nFixture native calls: ${JSON.stringify(await worker.evaluate(() => wechatHistoryFixture.calls))}`);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.calls.some(call => call.action === "tikhub_status")), true);

    const beforeDenied = await worker.evaluate(() => wechatHistoryFixture.calls.length);
    for (const action of ["status", "resolve", "download", "list", "download-selected"]) {
      const denied = await worker.evaluate(async ({ tabId, action }) => {
        return (await chrome.scripting.executeScript({ target: { tabId }, func: action =>
          chrome.runtime.sendMessage({ type: "wechat-history", action, params: {} }), args: [action] }))[0].result;
      }, { tabId: sourceTabId, action });
      assert.equal(denied.ok, false, `content scripts cannot invoke the paid history ${action} route`);
    }
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.calls.length), beforeDenied, "rejected content-script calls must not reach Native Messaging");

    const beforeListOriginals = originalArticleRequests.length;
    await popup.locator("#helperDownload").click();
    await popup.waitForFunction(() => !document.getElementById("helperArticleResults").hidden, null, { timeout: 45000 });
    await popup.waitForFunction(() => !document.getElementById("helperDownload").disabled);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), 0, "listing never creates a download or Obsidian task");
    assert.equal(originalArticleRequests.length - beforeListOriginals, 1, "listing opens only the seed article, never each candidate original");
    assert.equal(await popup.locator(".history-article").count(), 2);
    assert.match(await popup.locator("#helperArticleSummary").textContent(), new RegExp(nickname));
    assert.match(await popup.locator("#helperArticleSummary").textContent(), /2026-09-07/);
    assert.deepEqual(await popup.locator(".history-article-date").allTextContents(), ["2026-09-07", "2026-09-07"]);
    assert.deepEqual(await popup.locator(".history-article-link").allTextContents(), [records[1].title, records[2].title]);
    assert.equal(await popup.locator(".history-article-link").first().getAttribute("href"), seedUrl);
    assert.equal(await popup.locator(".history-article-link").first().getAttribute("target"), "_blank");
    assert.equal(await popup.locator("#helperOutputFormat").inputValue(), "zip", "WeChat has its own ZIP default despite persisted Obsidian preference");
    assert.equal(await popup.locator("#helperDownloadSelected").isDisabled(), true);
    await popup.locator(".history-article-check input").first().check();
    await popup.close();
    popup = await context.newPage(); await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator("#toolsDrawer > summary").click(); await popup.locator("#categoryTabWechat").click();
    await popup.locator("#helperArticleResults").waitFor({ state: "visible" });
    assert.equal(await popup.locator(".history-article-check input").first().isChecked(), true, "selection survives closing/reopening the popup");
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.calls.filter(call => call.action === "tikhub_article_page").length), 2, "reopening a listed range does not buy more pages");
    await popup.locator("#helperSelectNone").click();
    assert.equal(await popup.locator("#helperDownloadSelected").isDisabled(), true);
    await popup.locator("#helperSelectAll").click();
    await popup.locator("#includeImagesHelper").check();
    const screenshots = path.join(root, "output/playwright/wechat-history-selection");
    fs.mkdirSync(screenshots, { recursive: true });
    for (const [width, name] of [[452, "desktop"], [320, "narrow"]]) {
      await popup.setViewportSize({ width, height: 720 });
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "article picker must fit the popup without horizontal overflow");
      await popup.screenshot({ path: path.join(screenshots, name + ".png"), fullPage: true });
    }
    await popup.setViewportSize({ width: 452, height: 720 });
    const listId = await popup.evaluate(() => chrome.storage.local.get("wechatHistoryView").then(value => value.wechatHistoryView.listId));
    const tampered = await popup.evaluate(params => chrome.runtime.sendMessage({ type: "wechat-history", action: "download-selected", params }), {
      listId, articleUrls: [records[0].url], options: { includeImages: true, zipOutput: true, outputTarget: "download" }
    });
    assert.equal(tampered.ok, false, "out-of-range selection cannot be exported");
    const badTarget = await popup.evaluate(params => chrome.runtime.sendMessage({ type: "wechat-history", action: "download-selected", params }), {
      listId, articleUrls: [records[1].url], options: { includeImages: true, zipOutput: true, outputTarget: "obsidian" }
    });
    assert.equal(badTarget.ok, false, "the WeChat download service cannot create an implicit Obsidian write");
    const runnerCreated = context.waitForEvent("page", { timeout: 45000, predicate: async page => {
      try { await page.waitForURL(/batch-runner\.html\?jobId=/, { timeout: 1000 }); return true; }
      catch (_) { return false; }
    } });
    await popup.locator("#helperDownloadSelected").click();
    const runner = await Promise.race([runnerCreated, popup.waitForFunction(() => document.getElementById("helperStatus")?.classList.contains("status-error"))
      .then(async () => { throw new Error(`${await popup.locator("#helperStatus").textContent()}\nFixture history requests: ${JSON.stringify(await worker.evaluate(() => wechatHistoryFixture.requests))}`); })]);
    await runner.waitForURL(/batch-runner\.html\?jobId=/);
    await runner.waitForFunction(() => document.getElementById("jobStatus")?.classList.contains("status-ready"), null, { timeout: 45000 });
    const state = await worker.evaluate(() => ({ jobs: wechatHistoryFixture.jobs, calls: wechatHistoryFixture.calls, errors: wechatHistoryFixture.errors }));
    assert.deepEqual(state.errors, []);
    assert.equal(state.jobs.length, 1, "one complete range creates one real stored batch job");
    const job = state.jobs[0];
    assert.deepEqual([...job.links].sort(), [records[1].url, records[2].url].sort(), "range is filtered by actual page ct, including midnight, rather than provider create_time");
    assert.equal(job.includeImages, true);
    assert.equal(job.zipOutput, true);
    assert.equal(job.outputTarget, "download");
    assert.equal(job.saveToObsidian, false);
    assert.deepEqual(job.dateRange, { startDate: "2026-09-07", endDate: "2026-09-07" });
    assert.equal(job.account.fakeid, biz);
    const downloadRequest = await worker.evaluate(() => wechatHistoryFixture.requests.find(request => request.action === "download-selected" && request.params?.articleUrls?.length === 2));
    assert.deepEqual(downloadRequest.params, { listId, articleUrls: [records[1].url, records[2].url],
      options: { includeImages: true, zipOutput: true, outputTarget: "download" } }, "popup sends a fixed download request; the service worker owns collection and task creation");
    const pageCalls = state.calls.filter(call => call.action === "tikhub_article_page");
    assert.equal(pageCalls.length, 2, "a short non-final page must continue to the next cursor");
    assert.equal(pageCalls[1].params.offset, cursor);
    assert.equal(await runner.locator("#jobSuccess").textContent(), "2");
    assert.equal(await runner.locator("#jobFailure").textContent(), "0");
    const downloads = await completedDownloads(1);
    assert.equal(downloads.length, 1, "the actual batch runner must complete one ZIP download");
    assert.equal(path.dirname(downloads[0].filename), downloadsDirectory);
    const entries = unzipStoredEntries(fs.readFileSync(downloads[0].filename));
    const markdownEntries = [...entries.entries()].filter(([name]) => name.endsWith(".md"));
    assert.equal(markdownEntries.length, 2);
    for (const [, bytes] of markdownEntries) {
      const text = bytes.toString("utf8");
      assert.match(text, /(?:种子正文开头|零点边界正文开头)/);
      assert.match(text, /原文二级标题/);
      assert.match(text, /图片后的原文结尾/);
      const embedded = [...text.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
      assert.equal(embedded.length, 1);
      assert(Buffer.from(embedded[0][1], "base64").equals(imageBytes), "original image bytes survive the actual ZIP download");
      assert.doesNotMatch(text, /次日正文必须排除|前日正文必须排除/);
    }
    const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
    assert.equal(manifest.successCount, 2);
    assert.equal(manifest.failureCount, 0);
    await runner.close();
    console.log("PASS: MV3 account/date/title list and selection survive popup reopening; persisted Obsidian defaults still produce local ZIP with intact original image bytes");

    async function resetScenario(pages, delayMs = 0) {
      await worker.evaluate(async ({ pages, delayMs }) => {
        // A fresh scenario must not reuse the prior range's completed cache.
        // This Chromium profile and these state entries belong to this test.
        const state = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(Object.keys(state).filter(key => key.startsWith("wechatHistory:") || key.startsWith("wechatDownload:") || key.startsWith("wechatQuery:") || key === "wechatHistoryView" || key === "wechatHistorySelection" || key.startsWith("wechatAccountIndex:") || key.startsWith("wechatSeed:") || key.startsWith("wechatArticleMeta:")));
        wechatHistoryFixture.pages = pages;
        wechatHistoryFixture.pageIndex = 0;
        wechatHistoryFixture.errors = [];
        wechatHistoryFixture.delayMs = delayMs;
        wechatHistoryFixture.pageError = null;
      }, { pages, delayMs });
    }

    // A page containing an old draft/publication does not establish that later
    // provider pages also have older actual publication dates.
    const outOfOrderPages = [
      { ...successfulPages[0], articles: [listItem(records[1]), listItem(records[3])] },
      { ...successfulPages[1], articles: [listItem(records[2])] }
    ];
    await resetScenario(outOfOrderPages);
    const beforeReadOnly = await worker.evaluate(() => ({ jobs: wechatHistoryFixture.jobs.length, calls: wechatHistoryFixture.calls.length }));
    const collected = await popup.evaluate(params => chrome.runtime.sendMessage({ type: "wechat-history", action: "resolve", params }), {
      seedMeta: seed.data, startDate: "2026-09-07", endDate: "2026-09-07"
    });
    assert.equal(collected.ok, true, collected.error);
    assert.equal(collected.data.complete, true);
    assert.deepEqual([...collected.data.links].sort(), [records[1].url, records[2].url].sort(), "the second page's in-range publication survives an older article on the first page");
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.pageIndex), 2, "only the provider's end establishes completeness");
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), beforeReadOnly.jobs, "read-only resolve must not create a download task");
    console.log("PASS: cross-page publication-date disorder cannot cause early completion or silently omit a later in-range article");

    // Older raw pages have the message dateTime but no article sendTime.
    // A message just before midnight must still check an article published
    // just after midnight against its original ct.
    await resetScenario([{ ...successfulPages[1], articles: [{ ...listItem(records[2]),
      publishTimestamp: epoch("2026-09-06T23:59:00"), publicationSource: "message" }] }]);
    const midnight = await popup.evaluate(params => chrome.runtime.sendMessage({ type: "wechat-history", action: "resolve", params }), {
      seedMeta: seed.data, startDate: "2026-09-07", endDate: "2026-09-07"
    });
    assert.equal(midnight.ok, true, midnight.error);
    assert.deepEqual(midnight.data.links, [records[2].url]);
    assert.equal(midnight.data.articles[0].publishTimestamp, epoch(records[2].published));
    console.log("PASS: message-date fallback checks adjacent dates and uses original ct at the midnight boundary");

    async function expectIncompleteFailure(name, pages) {
      await resetScenario(pages);
      const before = await worker.evaluate(() => wechatHistoryFixture.jobs.length);
      const downloadsBefore = (await worker.evaluate(() => chrome.downloads.search({ state: "complete" }))).length;
      await popup.locator("#helperDownload").click();
      await popup.waitForFunction(() => document.getElementById("helperStatus")?.classList.contains("status-error"), null, { timeout: 45000 });
      await popup.waitForFunction(() => !document.getElementById("helperDownload").disabled);
      assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), before, `${name} cannot create a successful batch job`);
      const status = await popup.locator("#helperStatus").textContent();
      assert.doesNotMatch(status, /(?:没有命中|下载完成|已打开任务页)/, `${name} must not be reported as empty or complete`);
      assert.equal((await worker.evaluate(() => chrome.downloads.search({ state: "complete" }))).length, downloadsBefore, `${name} cannot create an incomplete archive`);
    }
    const seedOnlyPage = { account: { username, fakeid: biz }, articles: [listItem(records[1])], isEnd: false, nextOffset: cursor, cached: false };
    await expectIncompleteFailure("repeated pagination cursor", [seedOnlyPage, { ...seedOnlyPage }]);
    await expectIncompleteFailure("non-final page missing cursor", [{ ...seedOnlyPage, nextOffset: "" }]);
    async function expectSelectedFailure(name, pages) {
      await resetScenario(pages);
      const before = await worker.evaluate(() => wechatHistoryFixture.jobs.length);
      const downloadsBefore = (await worker.evaluate(() => chrome.downloads.search({ state: "complete" }))).length;
      const listed = await popup.evaluate(params => chrome.runtime.sendMessage({ type: "wechat-history", action: "list", params }), {
        seedUrl, startDate: "2026-09-07", endDate: "2026-09-07"
      });
      assert.equal(listed.ok, true, `${name}: listing should not require original article reads`);
      const rejected = await popup.evaluate(params => chrome.runtime.sendMessage({ type: "wechat-history", action: "download-selected", params }), {
        listId: listed.data.listId, articleUrls: listed.data.links,
        options: { includeImages: false, zipOutput: true, outputTarget: "download" }
      });
      assert.equal(rejected.ok, false, `${name} must be rejected when validating selected originals`);
      assert.match(rejected.code, /^WECHAT_(?:ARTICLE|ACCOUNT|PUBLISH_TIME)/);
      assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), before, `${name} must not create a batch job`);
      assert.equal((await worker.evaluate(() => chrome.downloads.search({ state: "complete" }))).length, downloadsBefore, `${name} must not create an archive`);
    }
    badArticle = true;
    await expectSelectedFailure("verification page without actual publication metadata", [
      { ...seedOnlyPage, articles: [...seedOnlyPage.articles,
        { title: "无法核对发表时间", url: badUrl, createTimestamp: epoch("2026-09-07T11:00:00"), updateTimestamp: epoch("2026-09-07T11:00:00") }], isEnd: true, nextOffset: "" }
    ]);
    badArticle = false;
    mismatch = "mid";
    await expectSelectedFailure("same-account redirect to another article mid", [
      { ...seedOnlyPage, articles: [{ ...listItem(records[2]), url: badUrl }], isEnd: true, nextOffset: "" }
    ]);
    mismatch = "idx";
    await expectSelectedFailure("same-account redirect to another article idx", [
      { ...seedOnlyPage, articles: [{ ...listItem(records[2]), url: articleUrl("106") }], isEnd: true, nextOffset: "" }
    ]);
    mismatch = "";
    await expectSelectedFailure("provider publication time disagrees with the original article", [
      { ...seedOnlyPage, articles: [{ ...listItem(records[2]), publishTimestamp: epoch("2026-09-07T01:00:00") }], isEnd: true, nextOffset: "" }
    ]);
    console.log("PASS: content-script callers are denied; invalid cursors, unverified pages, article identity changes and disagreeing publication times cannot create a batch job or archive");

    await resetScenario(successfulPages, 700);
    await worker.evaluate(() => { wechatHistoryFixture.pageError = { index: 1, code: "TIKHUB_HTTP_400", error: "服务拒绝此页请求", details: { httpStatus: 400, elapsedMs: 700, category: "http_error", cached: false } }; });
    const beforePartial = await worker.evaluate(() => ({ calls: wechatHistoryFixture.calls.length, jobs: wechatHistoryFixture.jobs.length }));
    await popup.locator("#helperDownload").click();
    await popup.waitForFunction(() => document.querySelectorAll(".history-article").length === 1 && document.getElementById("helperDownload").disabled);
    assert.equal(await popup.locator(".history-article-check input").first().isDisabled(), false, "first page is selectable while the next page is still loading");
    await popup.locator(".history-article-check input").first().check();
    assert.equal(await popup.locator("#helperDownloadSelected").isDisabled(), false, "partial selection can start a download while query is pending");
    await popup.waitForFunction(() => document.getElementById("helperStatus")?.classList.contains("status-error"));
    await popup.waitForFunction(() => !document.getElementById("helperDownload").disabled);
    assert.equal(await popup.locator(".history-article").count(), 1, "HTTP 400 preserves the successful first page");
    assert.match(await popup.locator("#helperStatus").textContent(), /HTTP 400/);
    assert.equal(await popup.locator(".history-article-check input").first().isChecked(), true);
    const failedPartial = await worker.evaluate(() => chrome.storage.local.get("wechatHistoryView").then(value => value.wechatHistoryView));
    assert.equal(failedPartial.complete, false);assert.equal(failedPartial.pageCount, 1);
    assert.equal(failedPartial.errorDetails.httpStatus, 400);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), beforePartial.jobs);
    await worker.evaluate(() => { wechatHistoryFixture.pageError = null; wechatHistoryFixture.delayMs = 0; });
    await popup.locator("#helperDownload").click();
    await popup.waitForFunction(() => !document.getElementById("helperDownload").disabled && document.querySelectorAll(".history-article").length === 2);
    const continuedCalls = await worker.evaluate(before => wechatHistoryFixture.calls.slice(before).filter(call => call.action === "tikhub_article_page"), beforePartial.calls);
    assert.deepEqual(continuedCalls.map(call => call.params.offset || ""), ["", cursor, cursor], "continue retries only the failed opaque cursor");
    assert.equal(await popup.locator(".history-article-check input").first().isChecked(), true, "selection persists through continuation");
    const beforeCached = await worker.evaluate(() => wechatHistoryFixture.calls.filter(call => call.action === "tikhub_article_page").length);
    await popup.locator("#helperStartDate").fill("2026-09-06");
    await popup.locator("#helperDownload").click();
    await popup.waitForFunction(() => !document.getElementById("helperDownload").disabled && document.querySelectorAll(".history-article").length === 3);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.calls.filter(call => call.action === "tikhub_article_page").length), beforeCached, "a completed account index filters another range without a new paid request");
    assert.equal(await worker.evaluate(() => chrome.storage.local.get("wechatHistoryView").then(value => value.wechatHistoryView.cached)), true);
    await popup.locator("#helperStartDate").fill("2026-09-07");
    console.log("PASS: progressive list stays selectable during HTTP 400, error preserves selections, continuation only retries its cursor, and cross-range cache makes no new paid request");

    // A closed query persists its list without creating a download. Reopening
    // restores the result without buying the pages again.
    await resetScenario(successfulPages, 2000);
    const beforeClose = await worker.evaluate(() => ({ jobs: wechatHistoryFixture.jobs.length, requests: wechatHistoryFixture.requests.length }));
    await popup.locator("#helperDownload").click();
    await worker.evaluate(async () => {
      const until = Date.now() + 30000;
      while (!wechatHistoryFixture.pageIndex) {
        if (Date.now() > until) throw new Error("query never reached its list page");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await popup.close();
    await worker.evaluate(async () => {
      const until = Date.now() + 30000;
      while ((await chrome.storage.local.get("wechatHistoryView")).wechatHistoryView?.state !== "ready") {
        if (Date.now() > until) throw new Error("closed-popup query did not finish");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), beforeClose.jobs);
    popup = await context.newPage(); await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator("#toolsDrawer > summary").click(); await popup.locator("#categoryTabWechat").click();
    await popup.locator("#helperArticleResults").waitFor({ state: "visible" });
    assert.equal(await popup.locator(".history-article").count(), 2);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.pageIndex), 2);
    await popup.locator(".history-article-check input").first().check();
    await popup.locator("#includeImagesHelper").uncheck();
    await popup.locator("#helperOutputFormat").selectOption("markdown");
    await worker.evaluate(() => { wechatHistoryFixture.runnerDelayMs = 1500; });
    const backgroundRunnerCreated = context.waitForEvent("page", { timeout: 45000, predicate: async page => {
      try { await page.waitForURL(/batch-runner\.html\?jobId=/, { timeout: 1000 }); return true; }
      catch (_) { return false; }
    } });
    await popup.locator("#helperDownloadSelected").click();
    await popup.waitForFunction(() => document.getElementById("helperDownloadSelected").disabled);
    const closeRequest = await worker.evaluate(before => wechatHistoryFixture.requests.slice(before).find(request => request.action === "download-selected"), beforeClose.requests);
    assert(closeRequest, "the download request reaches the worker before closing the popup");
    assert.deepEqual(closeRequest.params.options, { includeImages: false, zipOutput: false, outputTarget: "download" });
    await popup.evaluate(() => {
      document.getElementById("includeImages").checked = true;
      document.getElementById("includeImages").dispatchEvent(new Event("change"));
      document.getElementById("helperOutputFormat").value = "zip";
    });
    await popup.locator('button[data-destination="obsidian"]').click();
    await popup.close();
    await worker.evaluate(() => chrome.storage.local.set({ includeImages: true, outputTarget: "obsidian", clipperDestination: "obsidian" }));
    const backgroundRunner = await backgroundRunnerCreated;
    await backgroundRunner.waitForFunction(() => document.getElementById("jobStatus")?.classList.contains("status-ready"), null, { timeout: 45000 });
    const afterClose = await worker.evaluate(() => wechatHistoryFixture.jobs);
    assert.equal(afterClose.length, beforeClose.jobs + 1, "the background creates one task while the initiating popup is closed");
    const closedJob = afterClose[afterClose.length - 1];
    assert.equal(closedJob.includeImages, false);
    assert.equal(closedJob.zipOutput, false);
    assert.equal(closedJob.outputTarget, "download");
    assert.equal(closedJob.saveToObsidian, false);
    assert.deepEqual(closedJob.links, [seedUrl]);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.pageIndex), 2, "selected downloads reuse the reviewed list and make no new paid requests");
    assert.equal(await backgroundRunner.locator("#jobSuccess").textContent(), "1");
    assert.equal(await backgroundRunner.locator("#jobFailure").textContent(), "0");
    const finalDownloads = await completedDownloads(2);
    assert.equal(finalDownloads.length, 2, "closed-popup background task still completes a second actual download");
    const plainDownload = finalDownloads.find(item => item.filename.endsWith(".md"));
    assert(plainDownload, "the click-time non-ZIP choice produces Markdown");
    const plainText = fs.readFileSync(plainDownload.filename, "utf8");
    assert.match(plainText, /种子正文开头/);
    assert.match(plainText, /图片后的原文结尾/);
    assert.doesNotMatch(plainText, /data:image|!\[/, "the click-time image choice remains off after preference changes");
    console.log("PASS: closed-popup query restores its list; selected Markdown download retains click-time choices and completes after closing the popup without new paid requests");
    await resetScenario([{ ...seedOnlyPage, isEnd: true, nextOffset: "" }]);
    popup = await context.newPage(); await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator("#toolsDrawer > summary").click(); await popup.locator("#categoryTabWechat").click();
    await popup.locator("#helperStartDate").fill("2026-09-09"); await popup.locator("#helperEndDate").fill("2026-09-09");
    assert.equal(await popup.locator("#helperArticleResults").isHidden(), true, "changing the date cannot leave the old account/range selection visible");
    await popup.locator("#helperDownload").click();
    await popup.waitForFunction(() => !document.getElementById("helperArticleResults").hidden, null, { timeout: 45000 });
    assert.equal(await popup.locator(".history-article").count(), 0);
    assert.equal(await popup.locator("#helperArticleEmpty").isVisible(), true);
    assert.equal(await popup.locator("#helperDownloadSelected").isDisabled(), true);
    assert.equal(await worker.evaluate(() => wechatHistoryFixture.jobs.length), beforeClose.jobs + 1, "empty complete lists never create an export");
    assert.deepEqual(unexpectedRequests, [], "history must not call old backend endpoints or the paid provider outside the native fixture");
    assert.deepEqual(browserErrors, [], "browser pages must not have uncaught script errors");
  } finally {
    await context.close();
    // Keep exact disposable download staging for inspection on failure; this
    // test never recursively removes user or workspace paths.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
