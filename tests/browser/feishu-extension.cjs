// Real Chromium + the unchanged MV3 extension. Feishu responses are simulated;
// DOM injection, script errors, CORS, storage and the save UI use real Chrome APIs.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const parentUrl = "https://my.feishu.cn/wiki/Parent";
const pageUrl = id => `https://scys.com/articleDetail/xq_topic/${id}`;
const mentionId = "ou_01b2032de6b0af3a40a92357dac021e8";
const badAvatarUrl = pageUrl(mentionId);
const code = Array.from({ length: 505 }, (_, i) => `${i}:  保留代码与空白 ${"x".repeat(9)}\n`).join("");
const escape = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const article = body => `<title>浏览器剪存验收文章</title><main><h1>浏览器剪存验收</h1><div class="feishu-doc-content">${body}</div></main>`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438HwHwAGmAKHfbWTmQAAAABJRU5ErkJggg==", "base64");

async function installFeishuFixture(worker) {
  await worker.evaluate(() => {
    const plans = {}, saved = {}, calls = [];
    globalThis.browserFixture = { calls, plans, saved, created: 0, uploaded: 0 };
    const parent = { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" };
    chrome.runtime.sendNativeMessage = (_host, message, callback) => {
      calls.push(message.action);
      const p = message.params, f = globalThis.browserFixture;
      let data;
      try {
        switch (message.action) {
          case "status": data = { available: true }; break;
          case "list_spaces": data = { items: [{ space_id: "123", name: "测试知识库" }], has_more: false }; break;
          case "get_space": data = { space: { space_id: "123", name: "测试知识库" } }; break;
          case "get_node": data = { node: p.token === "Parent" ? parent : saved[p.token] }; break;
          case "get_operation": {
            const plan = plans[p.operation_id];
            const wikiToken = plan?.created && `Saved${plan.created}`;
            data = plan && saved[wikiToken] ? { found: true, source_token: "WebRoot", source_url: plan.source_url,
              document: { token: plan.created }, content_verified: true, wiki_token: wikiToken,
              target: { space_id: "123", parent_node_token: "Parent" }, phase: "moved" } : { found: false };
            break;
          }
          case "prepare_web_content": {
            if (p.snapshot && !plans[p.operation_id]) plans[p.operation_id] = structuredClone(p.snapshot);
            const plan = plans[p.operation_id];
            if (!plan) throw Object.assign(new Error("请读取网页"), { code: "IMPORT_NOT_PREPARED" });
            data = { title: plan.title, block_count: plan.blocks.length, image_count: plan.images.length, images: plan.images }; break;
          }
          case "stage_image": {
            const image = plans[p.operation_id].images.find(item => item.block_id === p.block_id);
            if (!image) throw new Error("Unbound image");
            const end = p.offset + atob(p.data_base64).length;
            image.staged = end === p.total_size;
            if (image.staged) f.uploaded++;
            data = { next_offset: end, complete: image.staged }; break;
          }
          case "import_step": {
            const plan = plans[p.operation_id];
            if (plan.images.some(image => !image.staged)) throw new Error("Missing image");
            if (!plan.created) plan.created = `Created${++f.created}`;
            data = { complete: true, document: { token: plan.created } }; break;
          }
          case "move_doc": {
            const token = `Saved${p.obj_token}`;
            saved[token] = { ...parent, node_token: token, obj_type: "docx", obj_token: p.obj_token, parent_node_token: "Parent" };
            data = { wiki_token: token }; break;
          }
          default: throw new Error(`Unexpected native action ${message.action}`);
        }
        queueMicrotask(() => callback({ ok: true, data }));
      } catch (error) { queueMicrotask(() => callback({ ok: false, error: error.message, code: error.code })); }
    };
  });
  await worker.evaluate(async () => chrome.storage.local.set({ feishuWikiClipTarget: {
    url: "https://my.feishu.cn/wiki/Parent", origin: "https://my.feishu.cn", spaceId: "123",
    parentToken: "Parent", title: "外部内容", spaceName: "测试知识库" } }));
}

(async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    let fixtureBody = article(`<h2>长代码与图文</h2><pre>${escape(code)}</pre><p><b>下一段</b></p><img src="https://mmbiz.qpic.cn/clipper-regression.png">`);
    let badAvatarCaptureRequests = 0;
    await context.route("https://scys.com/**", route => {
      if (route.request().url() === badAvatarUrl) {
        // The webpage's broken avatar naturally loads as resourceType=image.
        // The extension must never fetch it while collecting body images.
        if (["fetch", "xhr"].includes(route.request().resourceType())) badAvatarCaptureRequests++;
        return route.fulfill({ status: 400, contentType: "text/plain", body: "Not an image URL" });
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureBody });
    });
    await context.route("https://mmbiz.qpic.cn/clipper-regression.png", route => route.fulfill({ contentType: "image/png", body: png }));
    await context.route("https://mmbiz.qpic.cn/clipper-mention-*.png", route => route.fulfill({ contentType: "image/png", body: png }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    await installFeishuFixture(worker);
    const source = await context.newPage();
    await source.goto(pageUrl("long-code"));
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, source.url());
    const save = await context.newPage();
    save.on("dialog", dialog => dialog.accept());
    let selectedSourceUrl = "";
    async function openSave({ jobId } = {}) {
      selectedSourceUrl = source.url();
      await save.goto(`chrome-extension://${id}/feishu-save.html?${new URLSearchParams({ source: source.url(), sourceTabId: String(sourceTabId), ...(jobId ? { jobId } : {}) })}`);
      await save.locator('#connectionPanel[data-state="connected"]').waitFor();
      await save.waitForFunction(() => !document.getElementById("save").disabled);
      assert.equal(await save.locator("#targetUrl").inputValue(), parentUrl);
      assert.equal(await save.locator("#connect").isVisible(), false);
    }
    async function waitJob(predicate, timeout = 25000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const state = await save.evaluate(async sourceUrl => {
          const route = new URL(location.href).searchParams;
          const response = await chrome.runtime.sendMessage({ type: "feishu-clip", action: "state", sourceUrl,
            requestId: route.get("requestId"), ...(route.get("jobId") ? { jobId: route.get("jobId") } : {}) });
          if (!response.ok) throw new Error(response.error);
          return response.data.job;
        }, selectedSourceUrl);
        // A save click starts an asynchronous message. Do not mistake the
        // previous article's completed job for the newly requested save.
        if (state?.source.url === selectedSourceUrl && predicate(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Job timeout: ${await save.locator("#jobStatus").innerText()}`);
    }
    await openSave();
    if (process.env.FEISHU_UI_SCREENSHOT) {
      await save.screenshot({ path: process.env.FEISHU_UI_SCREENSHOT, fullPage: true });
      await save.setViewportSize({ width: 390, height: 844 });
      assert.equal(await save.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await save.screenshot({ path: process.env.FEISHU_UI_SCREENSHOT.replace(/\.png$/, "-narrow.png"), fullPage: true });
      await save.setViewportSize({ width: 1280, height: 720 });
    }
    await save.locator("#save").click();
    let job = await waitJob(j => j?.stage === "complete" || j?.error);
    assert.equal(job.stage, "complete", job.error);
    await save.waitForFunction(() => document.getElementById("jobStatus").textContent.includes("保存成功"));
    assert.equal(await save.locator("#resultLink").getAttribute("href"), job.resultUrl);
    assert.equal(await save.locator("#save").isVisible(), false);
    assert.equal(await save.locator("#saveForm").evaluate(element => element.open), false);
    if (process.env.FEISHU_UI_SCREENSHOT) await save.screenshot({ path: process.env.FEISHU_UI_SCREENSHOT.replace(/\.png$/, "-complete.png"), fullPage: true });
    await save.locator("#saveFormSummary").click();
    await save.evaluate(() => refreshState());
    assert.equal(await save.locator("#saveForm").evaluate(element => element.open), true);
    assert.equal(await save.locator("#sourceSettings").isVisible(), true);
    const plan = await worker.evaluate(op => browserFixture.plans[op], job.id);
    const nativeCode = plan.blocks.find(block => block.block_type === 14);
    assert.equal(nativeCode.code.elements.map(e => e.text_run.content).join(""), code);
    assert.equal(plan.images.length, 1);
    assert.equal(await worker.evaluate(() => browserFixture.uploaded), 1);
    console.log("PASS: real save UI, long code, image CORS fallback, remembered target");

    // A new article gets its own confirmation, not the prior article's result.
    const callsBeforeNextArticle = await worker.evaluate(() => browserFixture.calls.length);

    fixtureBody = `<main><div id="loading">正在加载文章，请稍候…</div></main><script>
      setTimeout(()=>{document.querySelector('main').innerHTML='<div class="feishu-doc-content" aria-busy="true"><p>先加载第一段。</p></div>'},500);
      setTimeout(()=>{document.querySelector('main').innerHTML=${JSON.stringify(article("<h2>延迟出现的标题</h2><p>这才是完整文章。</p>"))}},2200);
    </script>`;
    await source.goto(pageUrl("delayed"));
    await openSave();
    assert.equal(await save.locator("#jobPanel").isVisible(), false);
    assert.equal(await save.locator("#destinationSettings").getAttribute("open"), null);
    assert.equal(await save.locator("#save").innerText(), "保存到飞书");
    const nextArticleCalls = await worker.evaluate(offset => browserFixture.calls.slice(offset), callsBeforeNextArticle);
    assert(!nextArticleCalls.some(action => ["import_step", "move_doc"].includes(action)));
    assert.equal(await worker.evaluate(() => browserFixture.created), 1);
    console.log("PASS: a new article shows its own one-click confirmation without the previous result");
    await save.locator("#save").click();
    job = await waitJob(j => j?.stage === "complete" || j?.error);
    assert.equal(job.stage, "complete", job.error);
    const delayedPlan = await worker.evaluate(op => browserFixture.plans[op], job.id);
    assert.ok(JSON.stringify(delayedPlan).includes("这才是完整文章"));
    assert.ok(!JSON.stringify(delayedPlan).includes("正在加载"));
    assert.ok(!JSON.stringify(delayedPlan).includes("先加载第一段"));
    console.log("PASS: SPA article readiness, busy content root and a second consecutive save");

    fixtureBody = article("<p>包含不支持内容的正文</p><iframe src='about:blank'></iframe>");
    await source.goto(pageUrl("unsupported")); await openSave();
    await save.locator("#save").click();
    job = await waitJob(j => Boolean(j?.error));
    assert.match(job.error, /iframe/);
    assert.doesNotMatch(job.error, /未能读取网页正文/);
    const failedId = job.id;
    assert.equal(await worker.evaluate(() => browserFixture.created), 2);
    await save.waitForFunction(() => document.getElementById("jobStatus").classList.contains("status-error"));
    assert.equal(await save.locator("#jobDetails").getAttribute("open"), null);
    assert.equal(await save.locator("#resume").isVisible(), false);
    assert.match(await save.locator("#jobStatus").innerText(), /嵌入页面/);
    assert.doesNotMatch(await save.locator("#jobStatus").innerText(), /UNSUPPORTED_CONTENT|已有内容和进度已保留/);
    assert.equal(await save.locator("#save").innerText(), "重新读取并保存");

    fixtureBody = article("<p>上一篇文章失败后，下一篇仍可直接保存。</p>");
    await source.goto(pageUrl("after-failure")); await openSave();
    assert.equal(await save.locator("#jobPanel").isVisible(), false);
    await save.locator("#save").click();
    job = await waitJob(j => j?.stage === "complete" || j?.error);
    assert.equal(job.stage, "complete", job.error);
    assert.equal(await worker.evaluate(() => browserFixture.created), 3);
    const earlier = await save.evaluate(async jobId => (await chrome.runtime.sendMessage({ type: "feishu-clip", action: "state", jobId })).data.job, failedId);
    assert.equal(earlier.id, failedId);
    assert.match(earlier.error, /iframe/);
    console.log("PASS: a failed old article stays recoverable and never blocks or impersonates the next article");

    fixtureBody = article("<p>包含不支持内容的正文</p>");
    await source.goto(pageUrl("unsupported")); await openSave({ jobId: failedId });
    assert.equal(await save.locator("#save").innerText(), "重新读取并保存");
    await save.locator("#save").click();
    job = await waitJob(j => j?.stage === "complete");
    assert.equal(job.id, failedId);
    assert.equal(await worker.evaluate(() => browserFixture.created), 4);
    console.log("PASS: retrying a genuinely corrected article reuses its original task from the main save button");

    fixtureBody = "<main>正在加载文章，请稍候…</main>";
    await source.goto(pageUrl("navigation")); await openSave();
    // Mark the moment the real extraction starts so navigation occurs during
    // capture, rather than racing the queue before it has found the source tab.
    await worker.evaluate(async tabId => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["shared/scys-course-utils.js", "shared/web-markdown-utils.js", "shared/web-feishu-blocks.js", "content-scripts/feishu-exporter.js"] });
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const snapshot = globalThis.FeishuWebCapture.snapshot;
        globalThis.FeishuWebCapture.snapshot = (...args) => {
          document.documentElement.dataset.testCaptureStarted = "true";
          return snapshot(...args);
        };
      } });
    }, sourceTabId);
    await save.locator("#save").click();
    await source.locator('html[data-test-capture-started="true"]').waitFor();
    job = await waitJob(j => j?.source.url === pageUrl("navigation"));
    const navigatingId = job.id;
    await source.evaluate(() => history.pushState({}, "", "/articleDetail/xq_topic/another-article"));
    job = await waitJob(j => Boolean(j?.error));
    assert.match(job.error, /切换|跳转/);
    assert.equal(await worker.evaluate(() => browserFixture.created), 4);
    fixtureBody = article("<p>返回最初选择的文章后继续保存。</p>");
    await source.goto(pageUrl("navigation"));
    await save.reload();
    await save.waitForFunction(() => !document.getElementById("save").disabled);
    await save.locator("#save").click();
    job = await waitJob(j => j?.stage === "complete");
    assert.equal(job.stage, "complete", job.error); assert.equal(job.id, navigatingId);
    assert.equal(await worker.evaluate(() => browserFixture.created), 5);
    console.log("PASS: navigation during capture stops safely and resumes the original article");

    fixtureBody = `<main>正在加载文章，请稍候…</main><script>
      setTimeout(()=>{document.querySelector('main').innerHTML='<div class="feishu-doc-content" aria-busy="true"><p>一直未完成的部分正文。</p></div>'},1200);
    </script>`;
    await source.goto(pageUrl("missing")); await openSave();
    await save.locator("#save").click();
    job = await waitJob(j => Boolean(j?.error));
    assert.match(job.error, /尚未加载完成/);
    assert.equal(await worker.evaluate(() => browserFixture.created), 5);
    console.log("PASS: an unfinished article times out without saving loading or partial content");
    const bodyImageUrls = Array.from({ length: 42 }, (_, index) => `https://mmbiz.qpic.cn/clipper-mention-${index}.png`);
    fixtureBody = article(`<div class="block-text headFlex"><span class="text">去年从零起步，今年与</span><div class="headPc"><img src="${mentionId}" alt="" class="head_img"><a class="aHref">${mentionId}</a></div><span class="text">成立工作室，搭建内容工厂，跑通1-10。</span></div>${bodyImageUrls.map(url => `<img src="${url}">`).join("")}`);
    await source.goto(pageUrl("person-mention")); await openSave();
    await save.locator("#save").click();
    job = await waitJob(j => j?.stage === "complete" || j?.error);
    assert.equal(job.stage, "complete", job.error);
    const mentionPlan = await worker.evaluate(op => browserFixture.plans[op], job.id);
    assert.deepEqual(mentionPlan.images.map(image => image.url), bodyImageUrls);
    const mentionText = mentionPlan.blocks.flatMap(block => block.text?.elements || []).map(item => item.text_run.content).join("");
    assert(mentionText.includes(`去年从零起步，今年与${mentionId}成立工作室，搭建内容工厂，跑通1-10。`));
    assert.equal(badAvatarCaptureRequests, 0);
    assert.equal(await worker.evaluate(() => browserFixture.created), 6);
    assert.equal(await worker.evaluate(() => browserFixture.uploaded), 43);
    console.log("PASS: the real SCYS mention stays inline, all 42 body images save, and the broken avatar is never fetched by the clipper");

    // Every newly opened confirmation is an independent save intent, even for
    // the same URL. A second click inside one confirmation is still one intent.
    fixtureBody = article("<p>同一篇文章再次确认保存，应得到独立文档。</p>");
    await source.goto(pageUrl("same-article-again")); await openSave();
    const firstRequestId = new URL(save.url()).searchParams.get("requestId");
    assert(firstRequestId);
    await save.locator("#save").click();
    const initialSave = await waitJob(j => j?.stage === "complete" || j?.error);
    assert.equal(initialSave.stage, "complete", initialSave.error);
    assert.equal(initialSave.requestId, firstRequestId);
    const beforeRepeat = await worker.evaluate(() => ({ created: browserFixture.created, callCount: browserFixture.calls.length }));
    await openSave();
    const secondRequestId = new URL(save.url()).searchParams.get("requestId");
    assert(secondRequestId && secondRequestId !== firstRequestId);
    assert.equal(await save.locator("#jobPanel").isVisible(), false);
    assert.equal(await save.locator("#save").innerText(), "保存到飞书");
    assert.equal(await save.locator("#destinationSettings").getAttribute("open"), null);
    assert.equal(await save.locator("#targetUrl").inputValue(), parentUrl);
    const repeatSetupCalls = await worker.evaluate(offset => browserFixture.calls.slice(offset), beforeRepeat.callCount);
    assert(!repeatSetupCalls.some(action => ["import_step", "move_doc", "get_operation", "list_spaces"].includes(action)),
      "A new confirmation restored a past task or eagerly loaded the full directory");
    assert.equal(await worker.evaluate(() => browserFixture.created), beforeRepeat.created);
    const button = await save.locator("#save").boundingBox();
    assert(button);
    await save.mouse.dblclick(button.x + button.width / 2, button.y + button.height / 2);
    const repeatedSave = await waitJob(j => j?.stage === "complete" || j?.error);
    assert.equal(repeatedSave.stage, "complete", repeatedSave.error);
    assert.equal(repeatedSave.requestId, secondRequestId);
    assert.notEqual(repeatedSave.id, initialSave.id);
    assert.notEqual(repeatedSave.copy.token, initialSave.copy.token);
    assert.equal(await worker.evaluate(() => browserFixture.created), beforeRepeat.created + 1,
      "Two rapid clicks within one confirmation created multiple documents");
    await save.reload();
    await save.waitForFunction(() => document.getElementById("jobStatus").textContent.includes("保存成功"));
    assert.equal(new URL(save.url()).searchParams.get("requestId"), secondRequestId);
    assert.equal((await waitJob(j => j?.stage === "complete")).id, repeatedSave.id);
    assert.equal(await save.locator("#save").isVisible(), false);
    assert.equal(await save.locator("#resultLink").innerText(), "在飞书中打开");
    assert.equal(await save.locator("#resultLink").getAttribute("href"), repeatedSave.resultUrl);
    assert.equal(await worker.evaluate(() => browserFixture.created), beforeRepeat.created + 1);
    console.log("PASS: reopening the same article creates a fresh confirmation that only remembers its destination; double-click and reload preserve one save intent");

    // Actual SCYS component shapes: two video cards, one downloadable file
    // without href, and 120 body images. Only Feishu responses are simulated.
    const mediaImages = Array.from({ length: 120 }, (_, index) => `https://mmbiz.qpic.cn/clipper-mention-media-${index}.png`);
    const mediaUrl = "https://sphere-search-mobile.oss-cn-shanghai.aliyuncs.com/upload/doc/blocks/BrowserMedia";
    const selectedAudioUrl = "https://mmbiz.qpic.cn/clipper-selected.wav";
    const wav = Buffer.alloc(44 + 320);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(320, 40);
    await context.route(selectedAudioUrl, route => route.fulfill({ contentType: "audio/wav", body: wav }));
    const iconUrl = "https://scys.com/images/docx/link.png";
    let decorativeCaptures = 0;
    await context.route(iconUrl, route => {
      if (["fetch", "xhr"].includes(route.request().resourceType())) decorativeCaptures++;
      return route.fulfill({ contentType: "image/png", body: png });
    });
    const videoCard = (name, src = "") => `<div class="block-file video" data-highlight-ignore><div class="title"><img class="icon" src="${iconUrl}" alt="link"><span>${name}</span></div><div class="player"><video class="video-preview" preload="none" ${src ? `src="${src}"` : ""}></video><img class="btn" src="data:image/png;base64,${png.toString("base64")}"></div></div>`;
    const selectedAudio = `<audio id="selected-audio" title="多来源音频" controls preload="metadata"><source src="https://mmbiz.qpic.cn/ignored.wav" type="audio/unsupported-format"><source src="${selectedAudioUrl}" type="audio/wav"></audio>`;
    fixtureBody = article(`<p>视频前的正文</p>${videoCard("完整演示.mp4【在线播放】")}${videoCard("简洁演示.mp4【在线播放】", mediaUrl)}<a class="docx-file-card" data-highlight-ignore download="工具3.9.zip"><span class="docx-file-card__badge">ZIP</span><span class="docx-file-card__info"><span class="docx-file-card__name">工具3.9.zip</span><span class="docx-file-card__meta">压缩包 · 点击下载</span></span><svg class="docx-file-card__arrow" aria-hidden="true"></svg></a>${mediaImages.map(url => `<img src="${url}">`).join("")}<p>图片后的正文</p>${selectedAudio}`);
    await source.goto(pageUrl("media-and-attachments"));
    await source.waitForFunction(url => {
      const audio = document.getElementById("selected-audio");
      return audio.currentSrc === url && audio.readyState >= 1;
    }, selectedAudioUrl);
    await openSave();
    assert.equal(await save.locator("#jobPanel").isVisible(), false);
    const beforeMedia = await worker.evaluate(() => ({ created: browserFixture.created, uploaded: browserFixture.uploaded }));
    await save.locator("#save").click();
    job = await waitJob(j => j?.stage === "complete" || j?.error, 60000);
    assert.equal(job.stage, "complete", job.error);
    await save.waitForFunction(() => document.getElementById("jobStatus").textContent.includes("保存成功"));
    const mediaPlan = await worker.evaluate(op => browserFixture.plans[op], job.id);
    assert.deepEqual(mediaPlan.images.map(image => image.url), mediaImages);
    const runs = mediaPlan.blocks.flatMap(block => block.text?.elements || []).map(element => element.text_run);
    const mediaLinks = runs.filter(run => /演示|工具3\.9/.test(run.content));
    assert.equal(mediaLinks.length, 3);
    assert.match(mediaLinks[0].content, /视频：完整演示.*在原网页播放/);
    assert.equal(mediaLinks[0].text_element_style.link.url, source.url());
    assert.match(mediaLinks[1].content, /视频：简洁演示/);
    assert.equal(mediaLinks[1].text_element_style.link.url, mediaUrl);
    assert.match(mediaLinks[2].content, /附件：工具3\.9\.zip.*在原网页下载/);
    assert.equal(mediaLinks[2].text_element_style.link.url, source.url());
    assert.equal(runs.find(run => run.content === "音频：多来源音频").text_element_style.link.url, selectedAudioUrl,
      "The exporter clone must preserve the playable source selected by Chromium");
    assert(runs.some(run => run.content === "视频前的正文"));
    assert(runs.some(run => run.content === "图片后的正文"));
    assert.equal(decorativeCaptures, 0);
    assert.equal(await worker.evaluate(() => browserFixture.uploaded), beforeMedia.uploaded + 120);
    assert.equal(await worker.evaluate(() => browserFixture.created), beforeMedia.created + 1);
    console.log("PASS: one confirmation saves SCYS video/file cards plus all 120 body images; usable links survive and decorative icons are never captured");

    const calls = await worker.evaluate(() => browserFixture.calls);
    assert.ok(!calls.some(action => action.startsWith("authorize_")));
    console.log("PASS: all scenarios reuse existing login without authorization prompts");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
