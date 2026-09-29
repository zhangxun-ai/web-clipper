// Actual popup -> MV3 service -> source capture -> downloadable Markdown.
// Only the article and image HTTP responses are fixtures; no external writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  const context = await chromium.launchPersistentContext("", {
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
    const source = await context.newPage();
    await source.goto(sourceUrl);
    const nextPage = context.waitForEvent("page");
    await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false }));
    const popup = await nextPage;
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator('[data-preset="ai-ready"]').click();
    let downloads = 0;
    popup.on("download", () => downloads++);
    const downloadEvent = popup.waitForEvent("download");
    await popup.locator("#primaryAction").click();
    const download = await Promise.race([downloadEvent, popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-error"))
      .then(async () => { throw new Error(await popup.locator("#status").textContent()); })]);
    const markdown = fs.readFileSync(await download.path(), "utf8");
    const embedded = [...markdown.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
    assert.equal(embedded.length, 2);
    assert(embedded.every(match => Buffer.from(match[1], "base64").equals(bytes)), "image bytes survive the full export unchanged");
    assert.match(markdown, /正文开始/);
    assert.match(markdown, /正文结尾/);
    assert(!markdown.includes("assets/web-image-") && !markdown.includes(imageUrl));
    await popup.waitForFunction(() => document.getElementById("primaryAction").dataset.actionKey === "export-markdown");

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
    assert.equal(downloads, 1, "an unavailable image must not create a second incomplete archive");
    console.log("PASS: actual MV3 popup downloads unchanged original image bytes, retains repeated images, rejects content-script proxy calls and stops on missing images");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
