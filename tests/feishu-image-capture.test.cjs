const assert = require("node:assert/strict"), test = require("node:test"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../shared/feishu-image-capture.js"), "utf8");
function fixture({ width = 3264, height = 2448, mime = "image/jpeg" } = {}) {
  const urls = [], blob = new Blob([new Uint8Array([255, 216, 255, 1])], { type: mime });
  const context = { URL, Uint8Array, AbortController, setTimeout, clearTimeout,
    location: new URL("https://my.feishu.cn/docx/Source"), btoa: s => Buffer.from(s, "binary").toString("base64"),
    fetch: async (url, options) => { urls.push(url); assert.equal(options.credentials, "include"); return { ok: true, blob: async () => blob }; },
    createImageBitmap: async () => ({ width, height, close() {} }) };
  vm.runInNewContext(source, context);
  const request = { sourceUrl: "https://my.feishu.cn/docx/Source", blockId: "SourceBlock", token: "ImageToken", width: 3264, height: 2448 };
  return { context, request, urls, capture: context.FeishuImageCapture.capture };
}

test("reads the normal full-resolution viewer asset and preserves its bytes", async () => {
  const f = fixture(), asset = await f.capture(f.request);
  assert.equal(f.urls[0], "https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/ImageToken/?preview_type=16");
  assert.equal(asset.pixelWidth, 3264);
  assert.equal(asset.pixelHeight, 2448);
  assert.deepEqual(Buffer.from(asset.contentBase64, "base64"), Buffer.from([255, 216, 255, 1]));
});

test("a valid thumbnail is rejected before it can silently replace the original", async () => {
  const f = fixture({ width: 1280, height: 960 });
  await assert.rejects(f.capture(f.request), /像素小于原图/);
});

test("navigation away from the source blocks image capture", async () => {
  const f = fixture();
  f.context.location = new URL("https://my.feishu.cn/docx/Other");
  await assert.rejects(f.capture(f.request), /源页面已改变/);
  assert.equal(f.urls.length, 0);
});

test("a login or error page cannot be staged as an image", async () => {
  const f = fixture({ mime: "text/html" });
  await assert.rejects(f.capture(f.request), /格式无效/);
});
