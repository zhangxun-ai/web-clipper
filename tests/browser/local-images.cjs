// Actual popup -> MV3 service -> source capture -> downloadable Markdown.
// Only the article and image HTTP responses are fixtures; no external writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const { deflateSync } = require("node:zlib");
const root = path.resolve(__dirname, "../..");
const sourceUrl = "https://scys.com/articleDetail/xq_topic/local-image-regression";
const imageUrl = "https://scys.com/archive-image.png";
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
const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 80, 120, 160]))), pngChunk("IEND", Buffer.alloc(0))]);

(async () => {
  // Isolated, disposable download destination; never writes into user Downloads.
  const downloadDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clipper-local-images-disposable-")));
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-local-profile-disposable-"));
  fs.mkdirSync(path.join(profileDirectory, "Default"));
  fs.writeFileSync(path.join(profileDirectory, "Default", "Preferences"), JSON.stringify({ download: {
    default_directory: downloadDirectory, prompt_for_download: false, directory_upgrade: true
  } }));
  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    let failImage = false;
    await context.route(imageUrl, route => route.fulfill(failImage
      ? { status: 403, body: "unavailable" }
      : { contentType: "image/png", body: bytes }));
    await context.route(sourceUrl, route => route.fulfill({ contentType: "text/html; charset=utf-8",
      body: '<title>离线原图回归</title><main><div class="post-title">离线原图回归</div><div class="content-container"><div class="feishu-doc-content"><p>正文开始，包含两次同一张原图。</p><img data-src="/archive-image.png"><p>图片之间的说明。</p><img data-src="/archive-image.png"><p>正文结尾。</p></div></div></main>' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      chrome.runtime.sendNativeMessage = (_host, message, callback) => {
        if (message.action !== "status") throw new Error("Unexpected native operation: " + message.action);
        callback({ ok: false, code: "NATIVE_UNAVAILABLE", error: "Fixture connector unavailable" });
      };
    });
    const source = await context.newPage();
    const cdp = await context.newCDPSession(source);
    // Restore Chrome's real filename/directory handling. Playwright's forced
    // download behavior flattens extension-requested relative subdirectories.
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    await source.goto(sourceUrl);
    // An already-open v6 source responds to page info but has no v2 export
    // handler. Exercise the popup's real proactive upgrade, not manual setup.
    await worker.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        globalThis.FeishuWebCapture = { version: 6, snapshot() { throw new Error("Old capture"); } };
        chrome.runtime.onMessage.addListener((message, _sender, respond) => {
          if (message.type !== "feishu-export:get-page-info") return false;
          respond({ ok: true, data: { title: "离线原图回归", docType: "web", supports: ["markdown", "json"] } });
          return false;
        });
      } });
    }, sourceUrl);
    const nextPage = context.waitForEvent("page");
    await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false }));
    const popup = await nextPage;
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator('button[data-destination="local"]').click();
    await popup.locator('#includeImages').check();
    async function downloads() {
      return worker.evaluate(async directory => (await chrome.downloads.search({})).filter(item => item.filename.startsWith(directory + "/"))
        .map(item => ({ filename: item.filename, state: item.state })), downloadDirectory);
    }
    async function exportAndWait() {
      await popup.locator("#primaryAction").click();
      await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-error")
        || /已生成并交给浏览器下载/.test(document.getElementById("status")?.textContent || ""));
      assert.equal(await popup.locator("#status").evaluate(el => el.classList.contains("status-error")), false,
        `${await popup.locator("#status").textContent()} ${JSON.stringify(await downloads())}`);
    }
    await exportAndWait();
    let items = await downloads();
    assert.equal(items.length, 2, "one actual image file and one Markdown, no ZIP");
    assert(items.every(item => item.state === "complete"), "all native downloads must finish before success");
    const note = items.find(item => item.filename.endsWith(".md"));
    assert.equal(path.dirname(note.filename), downloadDirectory, "the article remains directly visible at the download root");
    const markdown = fs.readFileSync(note.filename, "utf8");
    const references = [...markdown.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map(match => match[1]);
    assert.equal(references.length, 2);
    assert.equal(references[0], references[1], "repeated images retain both occurrences and share one file");
    assert(fs.readFileSync(path.join(downloadDirectory, references[0])).equals(bytes), "image bytes survive the full export unchanged");
    assert.match(markdown, /正文开始/);
    assert.match(markdown, /正文结尾/);
    assert(!markdown.includes("data:image") && !markdown.includes(imageUrl));
    await popup.waitForFunction(() => document.getElementById("primaryAction").dataset.actionKey === "export-markdown");

    // A second same-title export must preserve the previous note and images.
    await exportAndWait();
    items = await downloads();
    assert.equal(items.length, 4);
    const secondNote = items.find(item => item.filename.endsWith(".md") && item.filename !== note.filename);
    const secondMarkdown = fs.readFileSync(secondNote.filename, "utf8");
    const secondReference = secondMarkdown.match(/\((assets\/[^)]+)\)/)[1];
    assert.notEqual(secondReference, references[0]);
    assert.equal(fs.readFileSync(note.filename, "utf8"), markdown);
    assert(fs.readFileSync(path.join(downloadDirectory, secondReference)).equals(bytes));

    // Resolve the exact downloaded references offline and use the real decoder.
    const offline = await context.newPage();
    await offline.route(/^https?:/, route => route.abort());
    const htmlPath = path.join(downloadDirectory, "offline-image-check.html");
    fs.writeFileSync(htmlPath, references.map(ref => `<img src="${ref}">`).join("\n"), { flag: "wx" });
    await offline.goto(require("node:url").pathToFileURL(htmlPath).href);
    assert.deepEqual(await offline.locator("img").evaluateAll(async images => Promise.all(images.map(async image => {
      await image.decode(); return [image.naturalWidth, image.naturalHeight];
    }))), [[1, 1], [1, 1]]);

    const denied = await worker.evaluate(async sourceUrl => {
      const [tab] = await chrome.tabs.query({ url: sourceUrl });
      return (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () =>
        chrome.runtime.sendMessage({ type: "exporter:capture-web-image", sourceUrl: location.href, tabId: 1, url: location.origin + "/archive-image.png" }) }))[0].result;
    }, sourceUrl);
    assert.equal(denied.ok, false, "source content scripts cannot use the popup-only image route");
    failImage = true;
    await popup.locator("#primaryAction").click();
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-error"));
    assert.match(await popup.locator("#status").textContent(), /第 1 张图片未保存/);
    assert.equal((await downloads()).length, 4, "an unavailable image must not create an incomplete article");
    console.log("PASS: MV3 popup downloads Markdown and real attachments, preserves bytes/repeated images, isolates same titles, decodes offline and stops on missing images");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
