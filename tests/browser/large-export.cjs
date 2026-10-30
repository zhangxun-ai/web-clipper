// Real Chromium MV3 Feishu exporter -> bounded messages -> popup -> outputs.
// HTTP inputs and the Obsidian directory handle are fixtures. Local downloads
// go only into a disposable directory created by this test; no user files or
// real Feishu/Obsidian data are touched.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const sourceUrl = "https://my.feishu.cn/docx/LargeExportFixture";
const imageCount = 52;

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
// A valid ancillary PNG chunk keeps each full-resolution image above 1MiB
// without allocating large decoded bitmaps. Chromium still really decodes it.
const image = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
  pngChunk("teSt", Buffer.alloc(1024 * 1024, 0x79)),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 80, 120, 160]))), pngChunk("IEND", Buffer.alloc(0))]);
// A tiny real H.264 MP4 fixture, embedded so this test needs no media tools.
const video = Buffer.from("AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC7W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHvdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABi21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAATZtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAD2c3RibAAAAKpzdHNkAAAAAAAAAAEAAACaYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADRhdmNDAWQACv/hABdnZAAKrNlewEQAAAMABAAAAwAIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAABwbW9vZgAAABBtZmhkAAAAAAAAAAEAAABYdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADEQAAQAAAAALFAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAGHRydW4AAAAFAAAAAQAAAHgCAAAAAAACzW1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABBliIQAFf/+98nvwKbr29+BAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAMRAQEBAAAAEG1mcm8AAAAAAAAAQw==", "base64");
const videos = [video, Buffer.concat([video, Buffer.from([0, 0, 0, 9, 102, 114, 101, 101, 1])])];
const videoDigests = videos.map(bytes => createHash("sha256").update(bytes).digest("hex"));
const digest = createHash("sha256").update(image).digest("hex");
const text = value => ({ data: { type: "text", text: { initialAttributedTexts: { text: { 0: value } } } } });
const children = ["Start", "Catalogue", "Heading", ...Array.from({ length: imageCount }, (_, i) => `Image${i}`), "VideoView", "End"];
const blockMap = { LargeExportFixture: { data: { children } }, Start: text("正文开始：大文档中文完整性。"), End: text("正文结束：所有原图必须完整。"),
  Catalogue: { data: { type: "isv", block_type_id: "blk_637dcc698597401c1a8fd711", data: { showCataLogLevel: 3 } } },
  Heading: { data: { ...text("视频教学章节").data, type: "heading1" } },
  VideoView: { data: { type: "view", children: ["Video0", "Video1"] } }
};
for (let i = 0; i < videos.length; i++) blockMap[`Video${i}`] = { data: { type: "file", file: {
  token: `VideoToken${i}`, name: `教学视频${i}.mp4`, size: videos[i].length, mimeType: "video/mp4"
} } };
for (let i = 0; i < imageCount; i++) blockMap[`Image${i}`] = { data: { type: "image",
  image: { token: `Original${i}`, name: `原图${i}.png`, width: 1, height: 1 } } };

(async () => {
  const downloadDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clipper-large-export-disposable-")));
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-large-profile-disposable-"));
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
    await context.route(sourceUrl, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<title>大文档分片回归</title>" }));
    await context.route("https://my.feishu.cn/space/api/docx/pages/client_vars**", route => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ code: 0, data: { block_map: blockMap } })
    }));
    await context.route("https://internal-api-drive-stream.feishu.cn/**", route => {
      const index = /\/VideoToken([01])\//.exec(route.request().url())?.[1];
      return route.fulfill({
      contentType: index === undefined ? "image/png" : "video/mp4", body: index === undefined ? image : videos[Number(index)],
      headers: { "Access-Control-Allow-Origin": "https://my.feishu.cn", "Access-Control-Allow-Credentials": "true" }
    }); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      chrome.runtime.sendNativeMessage = (_host, message, callback) => {
        if (message.action !== "status") throw new Error("Unexpected native operation: " + message.action);
        callback({ ok: false, code: "NATIVE_UNAVAILABLE", error: "Fixture connector unavailable" });
      };
    });
    const source = await context.newPage();
    const cdp = await context.newCDPSession(source);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    await source.goto(sourceUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, sourceUrl);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?${new URLSearchParams({ sourceTabId: String(tabId), source: sourceUrl, destination: "local" })}`);
    await popup.waitForFunction(() => document.getElementById("status")?.classList.contains("status-ready"));
    await popup.locator("#includeImages").check();
    // Observe the production handler; only the deliberate failure below edits
    // a returned chunk. Staging, serialization and slicing remain real.
    await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const real = FeishuWebCapture.handleMessage;
      globalThis.transferFixture = { runs: [], corrupt: false };
      FeishuWebCapture.handleMessage = async message => {
        const result = await real(message);
        if (message.type === "feishu-export:export-document-v3") transferFixture.runs.push({
          id: result.transfer.id, length: result.transfer.length, chunks: 0, maxChunk: 0, released: false
        });
        const run = transferFixture.runs.find(entry => entry.id === message.id);
        if (message.type === "feishu-export:read-export-chunk" && run) {
          run.chunks++; run.maxChunk = Math.max(run.maxChunk, result.chunk.length);
          if (transferFixture.corrupt && message.offset === 256 * 1024) result.chunk = result.chunk.slice(1);
        }
        if (message.type === "feishu-export:release-export" && run) {
          run.released = true;
          try { await real({ type: "feishu-export:read-export-chunk", id: message.id, offset: 0 }); }
          catch (_) { run.unreadableAfterRelease = true; }
        }
        return result;
      };
    } }), tabId);
    async function transfers() {
      return worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId },
        func: () => transferFixture.runs }))[0].result, tabId);
    }
    async function downloads() {
      return worker.evaluate(async directory => (await chrome.downloads.search({})).filter(item => item.filename.startsWith(directory + "/"))
        .map(item => ({ filename: item.filename, state: item.state })), downloadDirectory);
    }
    async function runExport(expectError = false) {
      const previousRuns = (await transfers()).length;
      await popup.locator("#primaryAction").click();
      await popup.waitForFunction(() => !document.getElementById("primaryAction").disabled
        && !document.getElementById("status").classList.contains("status-loading"), undefined, { timeout: 120000 });
      const status = await popup.locator("#status").textContent();
      assert.equal(await popup.locator("#status").evaluate(el => el.classList.contains("status-error")), expectError, status);
      if (expectError) assert.match(status, /传输不完整/);
      const allRuns = await transfers();
      assert.equal(allRuns.length, previousRuns + 1);
      const run = allRuns.at(-1);
      assert(run.length > 64 * 1024 * 1024, "the real serialized export must exceed Chromium's 64MiB message limit");
      assert(run.maxChunk <= 256 * 1024);
      if (!expectError) assert.equal(run.chunks, Math.ceil(run.length / (256 * 1024)));
      assert.equal(run.released, true, "success and failure both release staged exports");
      assert.equal(run.unreadableAfterRelease, true, "released bytes are actually removed");
      return run;
    }
    const localRun = await runExport();
    const localFiles = await downloads();
    assert.equal(localFiles.length, imageCount + videos.length + 1);
    assert(localFiles.every(item => item.state === "complete"));
    const note = localFiles.find(item => item.filename.endsWith(".md"));
    const markdown = fs.readFileSync(note.filename, "utf8");
    assert.match(markdown, /正文开始[\s\S]*正文结束/);
    const refs = [...markdown.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map(match => match[1]);
    assert.equal(refs.length, imageCount);
    for (const ref of refs) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(downloadDirectory, ref))).digest("hex"), digest);
    assert.match(markdown, /\[视频教学章节\]\(https:\/\/my.feishu.cn\/docx\/LargeExportFixture#Heading\)/);
    const videoRefs = [...markdown.matchAll(/\[教学视频([01])\.mp4\]\((assets\/[^)]+)\)/g)];
    assert.equal(videoRefs.length, videos.length);
    for (const [, index, ref] of videoRefs) {
      const bytes = fs.readFileSync(path.join(downloadDirectory, ref));
      assert.equal(bytes.length, videos[Number(index)].length);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), videoDigests[Number(index)]);
    }
    assert(!markdown.includes("data:image") && !markdown.includes("internal-api-drive"));

    // In-memory FileSystemDirectoryHandle exercises the real note creation,
    // asset namespacing, binary decoding and write order without user storage.
    await popup.evaluate(() => {
      globalThis.memoryVault = { files: new Map(), writes: [] };
      const directory = prefix => ({ name: "Fixture Vault", queryPermission: async () => "granted",
        getDirectoryHandle: async name => directory(prefix + name + "/"),
        getFileHandle: async (name, options = {}) => {
          const key = prefix + name;
          if (!options.create && !memoryVault.files.has(key)) throw new DOMException("Not found", "NotFoundError");
          return { createWritable: async () => ({
            write: async value => {
              const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
              const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
              memoryVault.files.set(key, { path: key, size: bytes.byteLength, hash, ...(typeof value === "string" ? { content: value } : {}) });
              memoryVault.writes.push(key);
            }, close: async () => {}
          }) };
        }
      });
      ObsidianVaultStorage.isSupported = () => true;
      ObsidianVaultStorage.getVaultBinding = async () => ({ handle: directory(""), meta: { folderName: "Fixture Vault" } });
      ObsidianVaultStorage.queryVaultPermission = async () => "granted";
      ObsidianVaultStorage.pickDirectory = async () => directory("");
      ObsidianVaultStorage.ensureVaultPermission = async () => "granted";
      ObsidianVaultStorage.saveVaultBinding = async () => {};
    });
    await popup.locator('button[data-destination="obsidian"]').click();
    await popup.locator("#primaryAction").click();
    await popup.waitForFunction(() => document.getElementById("primaryAction").textContent.includes("保存到 Obsidian"));
    assert(await popup.locator("#popupAdvancedSettings").isVisible(), "directory configuration opens its separate settings view");
    await popup.locator("#backFromSettings").click();
    await runExport();
    const vault = await popup.evaluate(() => ({ files: [...memoryVault.files.values()], writes: memoryVault.writes }));
    assert.equal(vault.files.length, imageCount + videos.length + 1);
    const vaultNote = vault.files.find(file => file.path.endsWith(".md"));
    assert.match(vaultNote.content, /正文开始[\s\S]*正文结束/);
    const vaultRefs = [...vaultNote.content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
    assert.equal(vaultRefs.length, imageCount);
    for (const ref of vaultRefs) {
      const file = vault.files.find(file => file.path === path.posix.join(path.posix.dirname(vaultNote.path), ref));
      assert(file, `missing Obsidian reference ${ref}`); assert.equal(file.hash, digest); assert.equal(file.size, image.length);
    }
    assert.match(vaultNote.content, /\[视频教学章节\]\(https:\/\/my.feishu.cn\/docx\/LargeExportFixture#Heading\)/);
    const vaultVideoRefs = [...vaultNote.content.matchAll(/\[教学视频([01])\.mp4\]\(([^)]+)\)/g)];
    assert.equal(vaultVideoRefs.length, videos.length);
    for (const [, index, ref] of vaultVideoRefs) {
      const file = vault.files.find(entry => entry.path === path.posix.join(path.posix.dirname(vaultNote.path), ref));
      assert(file, `missing Obsidian video reference ${ref}`);
      assert.equal(file.hash, videoDigests[Number(index)]); assert.equal(file.size, videos[Number(index)].length);
    }
    assert.equal(vault.writes.at(-1), vaultNote.path, "publish the note only after every image is written");
    assert.equal((await downloads()).length, imageCount + videos.length + 1, "Obsidian export does not also download files");

    await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => { transferFixture.corrupt = true; } }), tabId);
    await runExport(true);
    assert.equal(await popup.evaluate(() => memoryVault.writes.length), imageCount + videos.length + 1, "truncated transfer must not write any Obsidian files");
    await popup.locator('button[data-destination="local"]').click();
    await runExport(true);
    assert.equal((await downloads()).length, imageCount + videos.length + 1, "truncated transfer must not download any files");
    console.log(`PASS: real MV3 ${Math.ceil(localRun.length / 1024 / 1024)}MiB export (${localRun.chunks} bounded chunks), ${imageCount} original PNGs, ${videos.length} MP4s and source catalogue intact locally and in Obsidian; incomplete transfers block both outputs and release all staged bytes`);
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
