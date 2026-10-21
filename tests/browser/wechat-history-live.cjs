// Opt-in paid, live test: real Native Messaging + TikHub + WeChat + ZIP.
// No account login, Feishu writes, API key output, or provider mocks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const seedUrl = "https://mp.weixin.qq.com/s/KiN29IcdzkNY_Yo4GJus0w";
const username = "gh_6990113d8818", biz = "MzE5ODg1MTY4Mw==";
if (process.env.WECHAT_HISTORY_LIVE !== "1") throw new Error("Set WECHAT_HISTORY_LIVE=1 to run the paid live test (up to 20 list pages, $0.01 per uncached request)." );

function zipEntries(bytes) {
  const entries = new Map();
  for (let offset = 0; offset + 30 < bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), names = bytes.readUInt16LE(offset + 26), extras = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + names + extras;
    entries.set(bytes.subarray(offset + 30, offset + 30 + names).toString("utf8"), bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

(async () => {
  // Explicit disposable profile; registry points to the already installed host.
  // Chrome with --user-data-dir looks for its user-level host registry here.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-live-profile-staging-"));
  const registry = path.join(profile, "NativeMessagingHosts");
  fs.mkdirSync(registry);
  const manifestPath = path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wechat.clipper.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "com.wechat.clipper");
  fs.writeFileSync(path.join(registry, "com.wechat.clipper.json"), JSON.stringify(manifest));
  const output = path.join(root, "output/playwright/wechat-history-live");
  fs.mkdirSync(output, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true,
    acceptDownloads: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    assert(manifest.allowed_origins.includes(`chrome-extension://${extensionId}/`));
    const native = (action, params = {}) => worker.evaluate(({ action, params }) => new Promise(resolve => {
      chrome.runtime.sendNativeMessage("com.wechat.clipper", { action, params }, response =>
        resolve(chrome.runtime.lastError ? { ok: false, error: "Native Messaging unavailable" } : response));
    }), { action, params });
    const status = await native("tikhub_status");
    assert(status.ok && status.data.configured, status.error);
    console.log("PASS live: real browser Native Messaging handshake, project credential configured");
    await worker.evaluate(() => {
      globalThis.liveWechatNativeCalls = [];
      const send = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
      chrome.runtime.sendNativeMessage = (host, message, callback) => {
        const started = Date.now();
        return send(host, message, response => {
          if (host === "com.wechat.clipper" && message.action === "tikhub_article_page") {
            const record = { elapsedMs: Date.now() - started, ok: response?.ok === true,
              cached: response?.data?.cached === true, code: response?.code || null,
              helperElapsedMs: response?.data?.elapsedMs ?? response?.details?.elapsedMs ?? null,
              httpStatus: response?.details?.httpStatus ?? null };
            liveWechatNativeCalls.push(record);
            console.log("Live native page", JSON.stringify(record));
          }
          callback(response);
        });
      };
    });
    const pages = () => worker.evaluate(() => liveWechatNativeCalls);
    const source = await context.newPage();
    await source.goto(seedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await source.locator("#js_content").waitFor({ timeout: 45000 });
    const cdp = await context.newCDPSession(source);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: output, eventsEnabled: true });
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, seedUrl);
    const popup = await context.newPage();
    await worker.evaluate(() => {
      globalThis.liveWechatJobs = [];
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local") for (const [key, value] of Object.entries(changes)) {
          if (key.startsWith("batchJob:") && value.newValue) liveWechatJobs.push(value.newValue);
        }
      });
      return chrome.storage.local.set({ outputTarget: "obsidian", clipperDestination: "obsidian", includeImages: true });
    });
    await popup.setViewportSize({ width: 452, height: 720 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?${new URLSearchParams({ sourceTabId: String(sourceTabId), source: seedUrl, destination: "obsidian" })}`);
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"), null, { timeout: 45000 });
    await popup.locator("#toolsDrawer > summary").click();
    await popup.locator("#categoryTabWechat").click();
    await popup.locator("#helperSeedUrl").fill(seedUrl);
    await popup.locator("#helperStartDate").fill("2026-08-01");
    await popup.locator("#helperEndDate").fill("2026-10-05");
    const queryStarted = Date.now();
    await popup.locator("#helperDownload").click();
    let runner;
    await popup.waitForFunction(() => document.querySelectorAll(".history-article").length >= 2,
      null, { timeout: 120000 });
    const firstResultsMs = Date.now() - queryStarted;
    const firstView = await worker.evaluate(async () => (await chrome.storage.local.get("wechatHistoryView")).wechatHistoryView);
    console.log("PASS live: first visible candidates", JSON.stringify({ firstResultsMs,
      count: firstView.articles.length, complete: firstView.complete, state: firstView.state, pages: await pages() }));
    assert.equal(await popup.locator(".history-article").count(), 2);
    assert.equal(await popup.locator("#helperOutputFormat").inputValue(), "zip");
    assert.equal(await worker.evaluate(() => liveWechatJobs.length), 0, "list query cannot automatically export or write Obsidian");
    for (const checkbox of await popup.locator(".history-article-check input").all()) await checkbox.check();
    await popup.locator("#includeImagesHelper").check();
    await popup.screenshot({ path: path.join(output, "article-picker.png"), fullPage: true });
    await popup.locator("#helperDownloadSelected").click();
    const runnerUntil = Date.now() + 45000;
    while (Date.now() < runnerUntil) {
      runner = context.pages().find(page => page.url().includes("batch-runner.html?jobId="));
      if (runner) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(runner, "selected articles must create a real batch runner");
    const job = await worker.evaluate(() => liveWechatJobs[0]);
    assert.equal(job.outputTarget, "download"); assert.equal(job.saveToObsidian, false); assert.equal(job.zipOutput, true);
    await runner.waitForFunction(() => document.getElementById("jobStatus")?.classList.contains("status-ready"), null, { timeout: 180000 });
    assert.equal(await runner.locator("#jobFailure").textContent(), "0");
    const downloads = await worker.evaluate(() => chrome.downloads.search({ state: "complete" }));
    assert.equal(downloads.length, 1);
    const entries = zipEntries(fs.readFileSync(downloads[0].filename));
    const markdown = [...entries.entries()].filter(([name]) => name.endsWith(".md"));
    assert.equal(markdown.length, 2);
    const text = markdown.map(([, bytes]) => bytes.toString("utf8")).join("\n");
    assert.match(text, /和曾鸣聊产业史观/);
    assert.match(text, /阿里巴巴/);
    const embedded = [...text.matchAll(/data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/g)];
    assert(embedded.length > 0, "download must contain actual article image bytes");
    assert(embedded.every(match => Buffer.from(match[1], "base64").length > 100));
    for (const [name, bytes] of markdown) {
      const content = bytes.toString("utf8");
      assert(content.length > 1000, "each selected article needs full body: " + name);
      assert.match(content, /data:image\//, "each article needs image bytes: " + name);
    }
    console.log("PASS live: partial selection exported two real article bodies and image bytes", JSON.stringify({ markdownCount: markdown.length,
      downloadedImageCount: embedded.length, outputTarget: job.outputTarget, zip: downloads[0].filename }));
    const until = Date.now() + 600000;
    let finalView, lastProgress = "";
    while (Date.now() < until) {
      finalView = await worker.evaluate(async () => (await chrome.storage.local.get("wechatHistoryView")).wechatHistoryView);
      const progress = JSON.stringify({ state: finalView.state, complete: finalView.complete,
        pageCount: finalView.pageCount, articleCount: finalView.articles.length, nativeCalls: await pages() });
      if (progress !== lastProgress) { console.log("Live range progress", progress); lastProgress = progress; }
      if (finalView.state === "error" || finalView.complete) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    let crossDateCache = { verified: false, reason: "Provider end not confirmed" };
    if (finalView.complete) {
      const before = (await pages()).length;
      await popup.locator("#helperStartDate").fill("2026-09-05");
      const started = Date.now();
      await popup.locator("#helperDownload").click();
      await popup.waitForFunction(() => document.querySelectorAll(".history-article").length === 1,
        null, { timeout: 30000 });
      const cacheView = await worker.evaluate(async () => (await chrome.storage.local.get("wechatHistoryView")).wechatHistoryView);
      assert.equal(cacheView.complete, true);
      assert.equal(cacheView.articles[0].publishDate, "2026-09-07");
      assert.equal((await pages()).length, before);
      crossDateCache = { verified: true, elapsedMs: Date.now() - started, newApiCalls: 0, count: 1 };
    }
    const summary = { nativeHandshake: true, pages: await pages(), range: { start: "2026-08-01", end: "2026-10-05" },
      firstResultsMs, firstResultsWerePartial: !firstView.complete,
      providerEndConfirmed: finalView.complete, finalState: finalView.state, errorCode: finalView.errorCode || null,
      errorDetails: finalView.errorDetails || null, crossDateCache,
      persistedDefault: "obsidian", actualOutput: job.outputTarget, zipOutput: job.zipOutput,
      listQueryExports: 0, selectionCount: job.links.length, matchedArticles: finalView.articles.length,
      downloadedImageCount: embedded.length, markdownBytes: markdown.map(([, bytes]) => bytes.length), zip: downloads[0].filename };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(summary, null, 2));
    await popup.screenshot({ path: path.join(output, "popup.png"), fullPage: true });
    await runner.screenshot({ path: path.join(output, "runner.png"), fullPage: true });
    if (finalView.complete) {
      console.log("PASS live: actual range, original publication date, article body and image ZIP", JSON.stringify(summary));
    } else {
      console.error("PARTIAL live: article ZIP passed; full collection/cross-date cache unverified", JSON.stringify(summary));
      process.exitCode = 1;
    }
  } finally { await context.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
