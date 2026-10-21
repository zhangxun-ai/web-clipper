// Real MV3 injection and browser decoding; HTTP assets are fixtures. No Feishu writes.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const sourceUrl = "https://my.feishu.cn/docx/ImageFormatSource";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438HwHwAGmAKHfbWTmQAAAABJRU5ErkJggg==", "base64");

(async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    await context.route(sourceUrl, route => route.fulfill({ contentType: "text/html", body: "<title>Image format regression</title>" }));
    let body = png, contentType = "image/jpeg";
    await context.route("https://internal-api-drive-stream.feishu.cn/**", route => route.fulfill({
      contentType, body, headers: { "Access-Control-Allow-Origin": "https://my.feishu.cn", "Access-Control-Allow-Credentials": "true" }
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage(); await page.goto(sourceUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, sourceUrl);
    async function inject() {
      await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId },
        files: ["shared/image-asset.js", "shared/feishu-image-capture.js", "shared/web-image-capture.js"] }), tabId);
    }
    async function capture(kind, width = 1) {
      return worker.evaluate(async ({ tabId, kind, width, sourceUrl }) => (await chrome.scripting.executeScript({
        target: { tabId }, func: async (kind, width, sourceUrl) => {
          try {
            const request = { sourceUrl, token: "ImageToken", blockId: "ImageBlock", width, height: 1 };
            const asset = kind === "feishu" ? await FeishuImageCapture.capture(request)
              : await WebImageCapture.capturePublic("https://internal-api-drive-stream.feishu.cn/image");
            return { ok: true, asset };
          } catch (error) { return { ok: false, error: error.message }; }
        }, args: [kind, width, sourceUrl]
      }))[0].result, { tabId, kind, width, sourceUrl });
    }
    // Reinjecting the updated reader replaces the old version without page reload.
    await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId },
      func: () => { globalThis.FeishuImageCapture = { version: 2, capture() { throw new Error("stale reader"); } }; } }), tabId);
    await inject();
    for (contentType of ["image/jpeg", "application/octet-stream"]) {
      for (const kind of ["feishu", "web"]) {
        const result = await capture(kind);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.asset.mimeType, "image/png");
        assert.equal(result.asset.pixelWidth, 1);
        assert.equal(result.asset.pixelHeight, 1);
        assert.deepEqual(Buffer.from(result.asset.contentBase64, "base64"), png);
      }
    }
    const thumbnail = await capture("feishu", 100);
    assert.equal(thumbnail.ok, false); assert.match(thumbnail.error, /像素小于原图/);
    for (body of [Buffer.from("<html>login</html>"), png.subarray(0, 16)]) {
      for (const kind of ["feishu", "web"]) {
        const result = await capture(kind);
        assert.equal(result.ok, false);
        assert.match(result.error, /格式无效|无法完整解码/);
      }
    }
    console.log("PASS: MV3 readers preserve PNG bytes despite incorrect MIME, upgrade old injection, reject thumbnails, HTML and corrupt images");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
