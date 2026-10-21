const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const obsidianExportApi = require("../shared/obsidian-export.js");

function fixture(onDownload) {
  const source = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
  const start = source.indexOf("async function downloadExportPayload");
  const end = source.indexOf("function forceStripWechatNoiseTail");
  const calls = [], anchors = [], blobs = new Map(), revoked = [];
  let canceled = false, namespace = 0;
  const context = {
    Blob, Uint8Array, atob, obsidianExportApi,
    crypto: { randomUUID: () => `save-${++namespace}` },
    setStatus() {},
    throwIfExportCanceled() { if (canceled) throw new Error("已停止导出"); },
    setTimeout(callback) { callback(); },
    URL: {
      createObjectURL(blob) { const url = `blob:test-${blobs.size + 1}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    document: {
      body: { appendChild() {} },
      createElement() {
        return { style: {}, click() { anchors.push({ href: this.href, filename: this.download }); }, remove() {} };
      }
    },
    async downloadFile(request) {
      const call = { ...request, bytes: Buffer.from(await blobs.get(request.url).arrayBuffer()) };
      calls.push(call);
      return onDownload ? onDownload(call, calls.length, () => { canceled = true; })
        : { filename: path.basename(request.filename), path: `/Downloads/${request.filename}` };
    },
    downloadWithFallback() { throw new Error("Attachment references must never use a fallback filename"); }
  };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.download = downloadExportPayload;`, context);
  return { download: context.download, calls, anchors, blobs, revoked };
}

const payload = () => ({ mimeType: "text/markdown;charset=utf-8", content: "# 标题\n\n![配图](assets/image-001.png)\n\n![再次出现](assets/image-001.png)\n",
  assets: [{ path: "assets/image-001.png", mimeType: "image/png", contentBase64: "aW1n" }] });

test("downloads unchanged image bytes before a readable Markdown with short relative links", async () => {
  const f = fixture(), result = await f.download(payload(), "我的文章.md", "markdown");
  assert.equal(result.filename, "我的文章.md"); assert.equal(result.started, true);
  assert.deepEqual(f.calls.map(c => c.filename), ["assets/save-1/image-001.png", "我的文章.md"]);
  assert.deepEqual(f.calls[0].bytes, Buffer.from("img"));
  const markdown = f.calls[1].bytes.toString();
  assert.equal((markdown.match(/\(assets\/save-1\/image-001.png\)/g) || []).length, 2);
  assert.doesNotMatch(markdown, /data:image|base64/);
  assert(f.calls.every(c => c.saveAs === false && c.conflictAction === "uniquify"));
  assert.equal(f.anchors.length, 0); assert.equal(f.revoked.length, 2);
});

test("repeated article titles receive independent attachment namespaces", async () => {
  const f = fixture();
  await f.download(payload(), "同名.md", "markdown");
  await f.download(payload(), "同名.md", "markdown");
  assert.equal(f.calls[0].filename, "assets/save-1/image-001.png");
  assert.equal(f.calls[2].filename, "assets/save-2/image-001.png");
  assert.match(f.calls[3].bytes.toString(), /assets\/save-2/);
});

test("an interrupted image or cancellation cannot publish a Markdown success", async () => {
  const failed = fixture(() => { throw new Error("下载已中断"); });
  await assert.rejects(failed.download(payload(), "文章.md", "markdown"), /中断/);
  assert.equal(failed.calls.length, 1); assert.equal(failed.revoked.length, 1);
  const canceled = fixture((call, _index, cancel) => { cancel(); return { path: `/Downloads/${call.filename}` }; });
  await assert.rejects(canceled.download(payload(), "文章.md", "markdown"), /已停止/);
  assert.equal(canceled.calls.length, 1);
});

test("renamed or redirected image paths are rejected instead of creating broken references", async () => {
  for (const returned of ["/Downloads/image-001.png", "", "/Downloads/assets/save-1/image-001 (1).png"]) {
    const f = fixture(() => ({ path: returned }));
    await assert.rejects(f.download(payload(), "文章.md", "markdown"), /图片保存位置/);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture((call, index) => ({ path: `${index === 1 ? "/Downloads/" : "/Other/"}${call.filename}` }));
  await assert.rejects(f.download(payload(), "文章.md", "markdown"), /文章与图片保存位置不一致/);
});

test("unsafe attachment paths and invalid bytes fail without a Markdown download", async () => {
  for (const asset of [{ path: "../outside.png", contentBase64: "aW1n" }, null,
    { path: "assets/image.png", contentBase64: "%%%%" }]) {
    const f = fixture();
    await assert.rejects(f.download({ ...payload(), assets: [asset] }, "文章.md", "markdown"));
    assert.equal(f.calls.length, 0);
  }
});

test("text-only exports retain the normal single Markdown download", async () => {
  const f = fixture(), result = await f.download({ mimeType: "text/markdown;charset=utf-8", content: "# 正文\n" }, "纯文本.md", "markdown");
  assert.equal(result.started, true); assert.equal(result.filename, "纯文本.md");
  assert.equal(f.calls.length, 0); assert.equal(f.anchors.length, 1);
  assert.equal(await f.blobs.get(f.anchors[0].href).text(), "# 正文\n");
});
