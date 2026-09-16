// Real MV3 capture + real image decoding. All page/image responses and Native
// Messaging replies are fixtures; this never connects to or writes to Feishu.
const assert = require("node:assert/strict");
const path = require("node:path");
const { deflateSync } = require("node:zlib");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const sourceUrl = "https://scys.com/articleDetail/xq_topic/fidelity-regression";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Generate decodable PNGs locally with deliberately different display/pixel
// sizes. A real createImageBitmap call must supply the staging dimensions.
function png(width, height) {
  const chunk = (name, data) => {
    const type = Buffer.from(name), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([header, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x96);
  for (let row = 0; row < height; row++) rows[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const dimensions = [[1280, 661, 640], [240, 150, 120], [600, 2400, 600]];
const assets = new Map(Array.from({ length: 18 }, (_, index) => {
  const [width, height, displayWidth] = dimensions[index % dimensions.length];
  return [`https://scys.com/fixture-images/${index + 1}.png`, { width, height, displayWidth, bytes: png(width, height) }];
}));
const opening = Array.from({ length: 18 }, (_, index) => index === 2 || index === 3
  ? "这句话在原文重复出现，应当保留。" : `帖子开头第 ${index + 1} 段：这部分也属于文章原文。`);
const listItems = Array.from({ length: 6 }, (_, index) => `前言列表第 ${index + 1} 项。`);
const calloutText = Array.from({ length: 6 }, (_, index) => [`提示 ${index + 1} 的第一段。`, `提示 ${index + 1} 的第二段。`]);
const callout = (paragraphs, index) => `<div class="callout border_color_2 background_color_2">
  <div class="block-icon" data-highlight-ignore><div class="callout-emoji-container emoji-for-text">
    <div class="callout-block-emoji"><span class="emoji-mart-emoji emoji-mart-emoji-native"><span class="emoji-text">💡</span></span></div>
  </div></div><div>${paragraphs.map((text, paragraph) => `<div class="vc-doc-item" id="callout-${index}-${paragraph}"><div><div class="block-text"><span class="text">${text}</span></div></div></div>`).join("")}</div>
</div>`;
const body = `<!doctype html><title>完整文章和懒加载图片回归</title><style>
  main { width: 760px; } .content-container { width: 720px; }
  .callout { background: rgb(255, 246, 229); border: 1px solid orange; padding: 12px; }
  .block-icon { float: left; } img { display: block; height: auto; }
</style><nav>站点导航不属于正文</nav><main><header>作者和操作菜单</header><h1>完整文章和懒加载图片回归</h1>
  <div class="content-container">
    <div class="post-content">${opening.map(text => `<p>${text}</p>`).join("")}<ul>${listItems.map(text => `<li>${text}</li>`).join("")}</ul></div>
    <div class="feishu-doc-stream"><div class="feishu-doc-wrapper"><div class="feishu-doc-content">
      <h2>嵌入飞书正文</h2>${calloutText.map(callout).join("")}
      ${Array.from(assets, ([url, asset], index) => `<img data-src="${url}" loading="lazy" style="width:${asset.displayWidth}px" alt="第 ${index + 1} 张原图"><p>图片 ${index + 1} 之后的说明。</p>`).join("")}
    </div></div></div>
  </div><section class="comments">读者评论不属于正文</section><aside>推荐其他文章</aside>
</main>`;

function textOf(block) {
  return Object.values(block).find(value => value?.elements)?.elements
    .map(element => element.text_run?.content || "").join("") || "";
}

function textInOrder(snapshot) {
  const byId = new Map(snapshot.blocks.map(block => [block.block_id, block]));
  const texts = [];
  const visit = id => {
    const block = byId.get(id);
    assert(block, `missing block ${id}`);
    const text = textOf(block);
    if (text) texts.push(text);
    for (const child of block.children || []) visit(child);
  };
  visit("WebRoot");
  return texts;
}

async function installNativeFixture(worker) {
  await worker.evaluate(() => {
    const plans = {}, staged = [], actions = [];
    const parent = { space_id: "123", node_token: "Parent", title: "回归测试", node_type: "origin" };
    globalThis.fidelityFixture = { plans, staged, actions };
    chrome.runtime.sendNativeMessage = (_host, message, callback) => {
      actions.push(message.action);
      const p = message.params;
      let data;
      try {
        switch (message.action) {
          case "status": data = { available: true }; break;
          case "list_spaces": data = { items: [{ space_id: "123", name: "测试知识库" }], has_more: false }; break;
          case "get_space": data = { space: { space_id: "123", name: "测试知识库" } }; break;
          case "get_node": data = { node: p.token === "Parent" ? parent
            : { ...parent, node_token: "SavedFidelity", obj_type: "docx", obj_token: "CreatedFidelity", parent_node_token: "Parent" } }; break;
          case "get_operation": data = { found: false }; break;
          case "prepare_web_content": {
            if (p.snapshot && !plans[p.operation_id]) plans[p.operation_id] = structuredClone(p.snapshot);
            const plan = plans[p.operation_id];
            if (!plan) throw Object.assign(new Error("请读取网页"), { code: "IMPORT_NOT_PREPARED" });
            data = { title: plan.title, block_count: plan.blocks.length, image_count: plan.images.length, images: plan.images };
            break;
          }
          case "stage_image": {
            staged.push(structuredClone(p));
            const entry = plans[p.operation_id]?.images.find(image => image.block_id === p.block_id);
            if (!entry) throw new Error("Image does not belong to the snapshot");
            const next = p.offset + atob(p.data_base64).length;
            entry.staged = next === p.total_size;
            data = { next_offset: next, complete: entry.staged };
            break;
          }
          case "import_step": {
            if (plans[p.operation_id].images.some(image => !image.staged)) throw new Error("Image bytes are incomplete");
            data = { complete: true, document: { token: "CreatedFidelity" } };
            break;
          }
          case "move_doc": data = { wiki_token: "SavedFidelity" }; break;
          default: throw new Error(`Unexpected native action ${message.action}`);
        }
        queueMicrotask(() => callback({ ok: true, data }));
      } catch (error) {
        queueMicrotask(() => callback({ ok: false, error: error.message, code: error.code }));
      }
    };
  });
  await worker.evaluate(async () => chrome.storage.local.set({ feishuWikiClipTarget: {
    url: "https://my.feishu.cn/wiki/Parent", origin: "https://my.feishu.cn", spaceId: "123",
    parentToken: "Parent", title: "回归测试", spaceName: "测试知识库" } }));
}

(async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const requests = [], pageErrors = [];
    await context.route("**/*", route => {
      const request = route.request(), url = request.url();
      if (url.startsWith("chrome-extension://")) return route.continue();
      if (url === sourceUrl) return route.fulfill({ contentType: "text/html; charset=utf-8", body });
      const asset = assets.get(url);
      if (asset) {
        requests.push({ url, resourceType: request.resourceType() });
        return route.fulfill({ contentType: "image/png", body: asset.bytes });
      }
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await installNativeFixture(worker);
    const source = await context.newPage();
    source.on("pageerror", error => pageErrors.push(error.message));
    await source.goto(sourceUrl);
    assert.equal(requests.length, 0, "lazy originals must not load while merely opening the fixture");
    assert.deepEqual(await source.locator("img").evaluateAll(images => images.map(image => image.naturalWidth)), Array(18).fill(0));
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, sourceUrl);
    const save = await context.newPage();
    save.on("pageerror", error => pageErrors.push(error.message));
    await save.goto(`chrome-extension://${extensionId}/feishu-save.html?${new URLSearchParams({ source: sourceUrl, sourceTabId: String(sourceTabId) })}`);
    await save.locator('#connectionPanel[data-state="connected"]').waitFor().catch(async error => {
      error.message += `\nSave page: ${await save.locator("body").innerText()}\nPage errors: ${pageErrors.join("; ")}`;
      throw error;
    });
    await save.waitForFunction(() => !document.getElementById("save").disabled);
    await save.locator("#save").click();
    await save.waitForFunction(() => {
      const status = document.getElementById("jobStatus");
      return status.textContent.includes("保存成功") || status.classList.contains("status-error");
    }, undefined, { timeout: 35000 });
    assert.match(await save.locator("#jobStatus").innerText(), /保存成功/);
    const fixture = await worker.evaluate(() => fidelityFixture);
    const [snapshot] = Object.values(fixture.plans);
    assert(snapshot, "the full-page capture reaches Native preparation");
    assert.deepEqual(textInOrder(snapshot), [...opening, ...listItems, "嵌入飞书正文", ...calloutText.flat(),
      ...Array.from({ length: 18 }, (_, index) => `图片 ${index + 1} 之后的说明。`)],
    "all original paragraphs and lists precede the embedded article, including deliberately repeated prose");
    assert.doesNotMatch(textInOrder(snapshot).join(""), /站点导航|作者和操作|读者评论|推荐其他/);
    console.log("PASS: actual MV3 capture covers SCYS post + embedded document in source order and excludes surrounding site UI");

    const callouts = snapshot.blocks.filter(block => block.block_type === 19);
    const byId = new Map(snapshot.blocks.map(block => [block.block_id, block]));
    assert.equal(callouts.length, 6, "all six highlighted source groups remain native callout containers");
    callouts.forEach((block, index) => {
      assert.equal(block.callout.background_color, 2);
      assert.equal(block.callout.border_color, 2);
      assert.equal(block.callout.emoji_id, "bulb", "the source bulb is represented as the matching native callout icon");
      const childText = [];
      const visit = id => {
        const child = byId.get(id);
        if (textOf(child)) childText.push(textOf(child));
        (child.children || []).forEach(visit);
      };
      block.children.forEach(visit);
      assert.deepEqual(childText, calloutText[index], "each callout retains both paragraphs in its own boundary");
    });
    assert(!snapshot.blocks.some(block => textOf(block) === "💡"), "callout icons must not become detached text paragraphs");
    console.log("PASS: six native callouts preserve color, grouping and bulb icons without duplicate emoji paragraphs");

    assert.equal(snapshot.images.length, 18);
    assert.equal(requests.length, 18, "each original image is downloaded once, without page scrolling or display loads");
    assert(requests.every(request => ["fetch", "xhr"].includes(request.resourceType)), "capture reads the original bytes directly");
    for (const entry of snapshot.images) {
      const asset = assets.get(entry.url);
      assert(asset, `unexpected image ${entry.url}`);
      assert.equal(entry.display_width, asset.displayWidth, "rendered reading width is separate from intrinsic pixels");
      assert(!Object.hasOwn(byId.get(entry.block_id).image, "display_width"),
        "the capture-only display hint must not leak into the Feishu image block payload");
      const chunks = fixture.staged.filter(chunk => chunk.block_id === entry.block_id);
      assert(chunks.length > 0);
      assert(chunks.every(chunk => chunk.pixel_width === asset.width && chunk.pixel_height === asset.height),
        "every staged chunk carries actual decoded pixel dimensions even when the source image never loaded");
      assert(chunks.every(chunk => chunk.total_size === asset.bytes.length));
      assert(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data_base64, "base64"))).equals(asset.bytes),
        "display sizing must not resize or recompress the original image bytes");
    }
    assert.equal(await source.evaluate(() => scrollY), 0);
    assert.deepEqual(await source.locator("img").evaluateAll(images => images.map(image => image.naturalWidth)), Array(18).fill(0),
      "saving does not need to load source-page img elements");
    assert.deepEqual(pageErrors, []);
    console.log("PASS: 18 unloaded images preserve original bytes; real decoded dimensions and independent display widths reach stage_image (Native/Feishu responses simulated)");

    // A locally correct conversion is not enough if the selected article root
    // omits a visible sibling. Hidden responsive copies must not block saving.
    // Exercise the already-injected capture API without starting another save.
    const captureCurrentSource = () => worker.evaluate(async tabId => {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
        try { return { snapshot: await FeishuWebCapture.snapshot() }; }
        catch (error) { return { error: { code: error.code, message: error.message } }; }
      } });
      return frame.result;
    }, sourceTabId);
    const visibilityResults = [];
    for (const regionClass of ["post-content", "feishu-doc-content"]) {
      for (const visibility of ["visible", "directly-hidden", "ancestor-hidden"]) {
        await source.evaluate(({ regionClass, visibility }) => {
          document.getElementById("outside-capture-fixture")?.remove();
          const holder = document.createElement("div");
          holder.id = "outside-capture-fixture";
          const region = document.createElement("div");
          region.className = regionClass;
          region.innerHTML = "<p>容器外仍可见的正文必须被发现。</p>";
          if (visibility === "directly-hidden") region.style.display = "none";
          if (visibility === "ancestor-hidden") holder.style.display = "none";
          holder.append(region);
          document.querySelector("main").append(holder);
        }, { regionClass, visibility });
        const captured = await captureCurrentSource();
        visibilityResults.push({ regionClass, visibility, ...captured });
      }
    }
    const failures = visibilityResults.filter(result => result.visibility === "visible"
      ? result.error?.code !== "PAGE_CAPTURE_FAILED" || !/正文区域.*完整/.test(result.error?.message || "")
      : Boolean(result.error) || !result.snapshot);
    assert.deepEqual(failures.map(({ regionClass, visibility, error }) => ({ regionClass, visibility, error })), [],
      "visible omitted regions must fail explicitly; regions hidden directly or by an ancestor must not cause false positives");
    for (const result of visibilityResults.filter(result => result.visibility !== "visible")) {
      assert.deepEqual(textInOrder(result.snapshot), textInOrder(snapshot),
        `${result.regionClass} hidden via ${result.visibility} must not alter the visible article`);
      assert.equal(result.snapshot.images.length, 18);
    }
    assert.equal(await worker.evaluate(() => fidelityFixture.actions.length), fixture.actions.length,
      "coverage checks must not trigger Native writes or another save");
    assert.deepEqual(pageErrors, []);
    console.log("PASS: visible SCYS content outside the selected root is rejected; directly and ancestor-hidden copies do not block capture");

    const repeatedSentence = "重复句在不同位置都属于原文。";
    const paragraphs = texts => texts.map(text => `<p>${text}</p>`).join("");
    const postOnly = ["独立帖子开篇。", repeatedSentence, "独立帖子末段。", repeatedSentence];
    const docOnly = ["独立飞书正文开篇。", repeatedSentence, "独立飞书正文末段。", repeatedSentence];
    const introduction = ["多文档之前的导语。", repeatedSentence];
    const firstDoc = ["第一份嵌入文档的内容。", repeatedSentence];
    const secondDoc = ["第二份嵌入文档的内容。", repeatedSentence];
    const displayContentsPost = ["无独立布局框的导语。", repeatedSentence];
    const displayContentsDoc = ["无独立布局框的嵌入正文。", repeatedSentence];
    const rootCases = [
      { name: "post-only without content-container", expected: postOnly,
        html: `<div class="post-content">${paragraphs(postOnly)}</div>` },
      { name: "doc-only without content-container", expected: docOnly,
        html: `<div class="feishu-doc-content">${paragraphs(docOnly)}</div>` },
      { name: "one visible document and hidden copies without content-container", expected: docOnly,
        html: `<div class="post-content" style="display:none"><p>隐藏帖子副本不属于正文。</p></div>
          <div style="display:none"><div class="feishu-doc-content">正在加载隐藏文档副本，请稍候…</div></div>
          <div class="feishu-doc-content">${paragraphs(docOnly)}</div>` },
      { name: "optional empty introduction before a ready embedded document", expected: docOnly,
        html: `<div class="content-container"><div class="post-content"><p><br></p></div>
          <div class="feishu-doc-content">${paragraphs(docOnly)}</div></div>` },
      { name: "introduction and multiple embedded documents", expected: [...introduction, ...firstDoc, ...secondDoc],
        html: `<div class="content-container"><div class="post-content">${paragraphs(introduction)}</div>
          <div class="feishu-doc-stream"><div class="feishu-doc-wrapper">
            <div class="feishu-doc-content">${paragraphs(firstDoc)}</div>
            <div class="feishu-doc-content">${paragraphs(secondDoc)}</div>
          </div></div></div>` },
      { name: "display:contents article and body regions", expected: [...displayContentsPost, ...displayContentsDoc],
        html: `<div class="content-container" style="display:contents">
          <div class="post-content" style="display:contents">${paragraphs(displayContentsPost)}</div>
          <div class="feishu-doc-content" style="display:contents">${paragraphs(displayContentsDoc)}</div>
        </div>` }
    ];
    for (const testCase of rootCases) {
      await source.evaluate(html => {
        document.body.innerHTML = `<nav>不属于文章的导航</nav><main>${html}<section class="comments">不属于文章的评论</section></main>`;
      }, testCase.html);
      const captured = await captureCurrentSource();
      assert.equal(captured.error, undefined, `${testCase.name}: ${captured.error?.message || "capture failed"}`);
      assert.deepEqual(textInOrder(captured.snapshot), testCase.expected,
        `${testCase.name} must retain every region in order, including repeated original sentences`);
      assert.equal(captured.snapshot.images.length, 0);
    }
    assert.equal(await worker.evaluate(() => fidelityFixture.actions.length), fixture.actions.length,
      "article-structure checks must remain capture-only and never initiate another Native operation");
    assert.equal(requests.length, 18, "text-only structure fixtures must not initiate extra image downloads");
    assert.deepEqual(pageErrors, []);
    console.log("PASS: standalone posts/docs, introduction with multiple docs and display:contents regions retain source order and legitimate repeated sentences");

    const delayedIntroduction = ["导语已经加载完成。"];
    const readyEmbedded = ["第一份嵌入正文已经加载完成。"];
    const delayedEmbedded = ["第二份嵌入正文现已完整加载。", repeatedSentence];
    for (const pendingContent of ["正在加载文档，请稍候…", ""]) {
      await source.evaluate(({ intro, ready, delayed, pendingContent }) => {
        document.body.innerHTML = `<main><div class="content-container">
          <div class="post-content">${intro}</div>
          <div class="feishu-doc-content">${ready}</div>
          <div class="feishu-doc-content" id="delayed-embedded">${pendingContent}</div>
        </div></main>`;
        // The source emits no aria-busy marker. The existing introduction and
        // first document must not conceal a loading or still-empty document.
        setTimeout(() => { document.getElementById("delayed-embedded").innerHTML = delayed; }, 1100);
      }, { intro: paragraphs(delayedIntroduction), ready: paragraphs(readyEmbedded),
        delayed: paragraphs(delayedEmbedded), pendingContent });
      const loaded = await captureCurrentSource();
      assert.equal(loaded.error, undefined, loaded.error?.message);
      assert.deepEqual(textInOrder(loaded.snapshot), [...delayedIntroduction, ...readyEmbedded, ...delayedEmbedded],
        `capture must wait for a ${pendingContent ? "loading" : "still-empty"} embedded document after already-loaded content`);
      assert.doesNotMatch(textInOrder(loaded.snapshot).join(""), /正在加载|请稍候/);
    }

    await source.evaluate(() => {
      const hiddenBackup = document.createElement("div");
      hiddenBackup.style.display = "none";
      hiddenBackup.innerHTML = '<div class="feishu-doc-content">正在加载文档，请稍候…</div>';
      document.querySelector(".content-container").append(hiddenBackup);
    });
    const hiddenLoading = await captureCurrentSource();
    assert.equal(hiddenLoading.error, undefined, "an invisible loading backup must not prevent capturing completed visible content");
    assert.deepEqual(textInOrder(hiddenLoading.snapshot), [...delayedIntroduction, ...readyEmbedded, ...delayedEmbedded]);
    assert.equal(await worker.evaluate(() => fidelityFixture.actions.length), fixture.actions.length,
      "readiness checks must remain capture-only without starting a save");
    assert.equal(requests.length, 18);
    assert.deepEqual(pageErrors, []);
    console.log("PASS: capture waits for loading/empty embedded documents without aria-busy; hidden loading backups do not block completed content");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
