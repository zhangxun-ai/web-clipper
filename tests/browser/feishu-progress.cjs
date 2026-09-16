// Actual extension page, DOM, timers and reload; task responses are fixtures.
// No connector or remote document writes are used in this UI regression.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");

(async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const target = { url: "https://my.feishu.cn/wiki/Parent", origin: "https://my.feishu.cn", spaceId: "123", parentToken: "Parent", title: "外部内容", spaceName: "课程研发库" };
      window.progressFixture = { running: true, target, job: {
        id: "progress-ui", requestId: new URL(location.href).searchParams.get("requestId"),
        source: { url: "https://example.com/article", type: "web" }, target,
        title: "小红书商业知识体系", stage: "collecting", autoRun: true,
        createdAt: new Date(Date.now() - 65000).toISOString(), updatedAt: new Date().toISOString(),
        progress: { phase: "collecting", completed: 7, total: 20 }
      } };
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.action === "state") {
          if (window.failState) return callback({ ok: false, code: "EXTENSION_RELOADED", error: "fixture: disconnected" });
          return callback({ ok: true, data: structuredClone(window.progressFixture) });
        }
        const data = message.operation === "status" ? { available: true }
          : message.operation === "get_node" ? { node: { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" } }
          : message.operation === "get_space" ? { space: { name: "课程研发库" } } : target;
        callback({ ok: true, data });
      };
    });
    await page.goto(`chrome-extension://${id}/feishu-save.html?source=https://example.com/article&requestId=11111111-1111-4111-8111-111111111111`);
    await page.locator('#connectionPanel[data-state="connected"]').waitFor();
    await page.locator("#progressBar").waitFor();
    assert.equal(await page.locator("#jobDetails").evaluate(el => el.open), false);
    assert(await page.locator("#steps").isVisible());
    assert.equal(await page.locator("#progressCount").textContent(), "7 / 20 张");
    assert.equal(await page.locator('#steps [aria-current="step"]').textContent(), "读取图文");
    const timing = await page.locator("#progressTiming").textContent();
    await page.waitForFunction(previous => document.getElementById("progressTiming").textContent !== previous, timing);
    await page.evaluate(() => {
      Object.assign(progressFixture.job, { stage: "importing", updatedAt: new Date().toISOString(), progress: { phase: "content_images", completed: 38, total: 68 } });
    });
    // Wait for the shipped two-second poll, rather than calling the renderer.
    await page.waitForFunction(() => document.getElementById("progressBar").value === 38);
    assert.equal(await page.locator('#steps [aria-current="step"]').textContent(), "写入并核对");
    assert.match(await page.locator("#progressCount").textContent(), /38 \/ 68 项/);
    for (const width of [1100, 390, 320]) {
      await page.setViewportSize({ width, height: 920 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const selector of ["#progressBar", "#progressCount", "#steps"]) {
        const box = await page.locator(selector).boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width, `${selector} must fit ${width}px`);
      }
      if (process.env.UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, `save-progress-${width}.png`), fullPage: true });
      }
    }
    for (const [stage, label] of [["moving", "保存到知识库"], ["verifying", "确认完成"]]) {
      await page.evaluate(stage => { progressFixture.job.stage = stage; }, stage);
      await page.waitForFunction(label => document.querySelector('#steps [aria-current="step"]')?.textContent === label, label);
      assert.equal(await page.locator("#progressBar").getAttribute("value"), null);
      assert.equal(await page.locator("#resultLink").isVisible(), false);
    }
    await page.evaluate(() => { window.failState = true; });
    await page.waitForFunction(() => document.getElementById("progressNotice").textContent.includes("连接已中断"));
    assert(await page.locator("#save").isDisabled());
    await page.evaluate(() => {
      window.failState = false;
      progressFixture.running = false;
      Object.assign(progressFixture.job, { stage: "complete", autoRun: false, resultUrl: "https://my.feishu.cn/wiki/Saved" });
    });
    await page.locator("#resultLink").waitFor();
    assert.equal(await page.locator("#jobProgress").isVisible(), false);
    assert.equal(await page.locator('#steps [data-done="true"]').count(), 4);
    await page.reload();
    await page.locator("#progressBar").waitFor();
    assert.match(await page.locator("#progressTiming").textContent(), /自开始已过 1 分/);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => { progressFixture.job.stage = "ready"; });
    await page.waitForFunction(() => document.getElementById("progressBar").getAttribute("value") === null);
    assert.equal(await page.locator("#progressBar").evaluate(el => getComputedStyle(el, "::-webkit-progress-bar").animationName), "none");
    assert.deepEqual(errors, []);
    console.log("PASS: visible stage transitions, real polling/timer, completion, disconnect, reload, reduced motion and 1100/390/320px layouts (fixture responses)");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
