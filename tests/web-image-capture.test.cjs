const assert = require("node:assert/strict"), test = require("node:test"), vm = require("node:vm"), fs = require("node:fs");
const script = fs.readFileSync(require.resolve("../shared/web-image-capture.js"), "utf8");
function fixture(mime = "image/webp") {
  const calls = [], bytes = Buffer.from([82, 73, 70, 70, 1, 2, 3]);
  const ctx = { URL, Uint8Array, AbortController, setTimeout, clearTimeout,
    location: new URL("https://scys.com/articleDetail/xq_topic/123"), btoa: s => Buffer.from(s, "binary").toString("base64"),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, blob: async () => new Blob([bytes], { type: mime }) }; },
    createImageBitmap: async () => ({ width: 1280, height: 900, close() {} }) };
  vm.runInNewContext(script, ctx);
  return { ctx, calls, bytes, capture: ctx.WebImageCapture.capture,
    request: { sourceUrl: ctx.location.href, url: "https://cdn.example.com/article.webp" } };
}

test("preserves exact image bytes, dimensions and MIME without sending page credentials to a CDN", async () => {
  const f = fixture(), image = await f.capture(f.request);
  assert.equal(f.calls[0].options.credentials, "same-origin");
  assert.deepEqual(Buffer.from(image.contentBase64, "base64"), f.bytes);
  assert.equal(image.pixelWidth, 1280); assert.equal(image.pixelHeight, 900);
  assert.equal(image.mimeType, "image/webp");
});
test("navigation, unsafe URLs and non-image responses are rejected before staging", async () => {
  for (const url of ["file:///secret", "javascript:alert(1)", "https://user:pass@example.com/i", "data:text/html;base64,YQ=="]) {
    const f = fixture(); await assert.rejects(f.capture({ ...f.request, url })); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.ctx.location = new URL("https://scys.com/other");
  await assert.rejects(f.capture(f.request), /跳转/); assert.equal(f.calls.length, 0);
  const login = fixture("text/html"); await assert.rejects(login.capture(login.request), /格式/);
});
test("CORS failure is explicit so the workflow cannot save a document with missing images", async () => {
  const f = fixture(); f.ctx.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(f.capture(f.request), /不允许读取/);
});
test("the granted-host background reader omits credentials and still verifies image bytes", async () => {
  const f = fixture();
  const image = await f.ctx.WebImageCapture.capturePublic(f.request.url);
  assert.equal(f.calls[0].options.credentials, "omit");
  assert.deepEqual(Buffer.from(image.contentBase64, "base64"), f.bytes);
});
