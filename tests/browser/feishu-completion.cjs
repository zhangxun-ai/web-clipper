// Actual MV3 page, tabs, focus, storage events and reload. Job/native responses
// are fixtures; no connector, notifications or remote documents are touched.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const jobsKey = "feishuWikiClipJobs";
const acksKey = "completionFixtureAcks";
const target = { url: "https://my.feishu.cn/wiki/Parent", origin: "https://my.feishu.cn", spaceId: "123",
  parentToken: "Parent", title: "外部内容", spaceName: "课程研发库" };
const completedAt = new Date().toISOString();
const requests = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const makeJob = (index, seconds) => ({
  id: `completion-${index + 1}`, requestId: requests[index],
  source: { url: index < 2 ? "https://example.com/shared-article" : `https://example.com/article-${index + 1}`, type: "web" },
  target, title: ["图文长文章的第一次保存", "同一篇原文的第二次保存", "前台完成的文章", "旧任务缺少完成时间"][index],
  stage: "importing", autoRun: false, completionViewed: false,
  createdAt: new Date(Date.parse(completedAt) - seconds * 1000).toISOString(), updatedAt: completedAt,
  progress: { phase: "content_images", completed: 3, total: 8 }
});
const initialJobs = [makeJob(0, 156), makeJob(1, 78), makeJob(2, 8), makeJob(3, 20)];
Object.assign(initialJobs[3], { stage: "complete", resultUrl: "https://my.feishu.cn/wiki/LegacySaved" });

async function installPageFixture(page) {
  await page.addInitScript(({ jobsKey, acksKey, target }) => {
    window.completionFixture = { reads: [], faviconChanges: [], messages: [] };
    const fixture = window.completionFixture;
    const visible = element => Boolean(element && !element.hidden && getComputedStyle(element).display !== "none"
      && getComputedStyle(element).visibility !== "hidden" && element.getClientRects().length);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes" && record.target.id === "taskFavicon" && record.attributeName === "href") {
          fixture.faviconChanges.push({ before: record.oldValue, after: record.target.getAttribute("href"),
            focused: document.hasFocus(), visible: !document.hidden });
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"], attributeOldValue: true });
    chrome.runtime.sendMessage = (message, callback) => {
      fixture.messages.push(structuredClone(message));
      (async () => {
        const store = await chrome.storage.local.get([jobsKey, acksKey]);
        const jobs = store[jobsKey] || [];
        if (message.action === "state") {
          const job = jobs.find(candidate => candidate.requestId === message.requestId
            && (!message.jobId || candidate.id === message.jobId) && candidate.source.url === message.sourceUrl
            && (!message.targetUrl || candidate.target.url === message.targetUrl)) || null;
          fixture.reads.push({ at: performance.now(), stage: job?.stage });
          return { job, running: Boolean(job && job.stage !== "complete"), target,
            completionViewed: Boolean(job?.completionViewed) };
        }
        if (message.action === "acknowledge_completion") {
          const job = jobs.find(candidate => candidate.id === message.jobId);
          if (!job || job.stage !== "complete" || job.requestId !== message.requestId
            || job.source.url !== message.sourceUrl || job.target.url !== message.targetUrl) {
            throw new Error("Completion acknowledgement must match job, request, source and destination");
          }
          const summary = document.getElementById("completionSummary"), result = document.getElementById("resultLink");
          const record = { ...structuredClone(message), focused: document.hasFocus(), visible: !document.hidden,
            summaryRendered: visible(summary), resultRendered: visible(result), resultUrl: result?.href };
          job.completionViewed = true;
          await chrome.storage.local.set({ [jobsKey]: jobs, [acksKey]: [...(store[acksKey] || []), record] });
          return { completionViewed: true };
        }
        if (message.action === "native") {
          if (message.operation === "status") return { available: true };
          if (message.operation === "get_node") return { node: { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" } };
          if (message.operation === "get_space") return { space: { name: "课程研发库" } };
          throw new Error(`Unexpected fixture native operation ${message.operation}`);
        }
        if (["target", "remember_target"].includes(message.action)) return target;
        throw new Error(`Unexpected fixture message ${message.action}`);
      })().then(data => callback({ ok: true, data }), error => callback({ ok: false, code: "FIXTURE_ERROR", error: error.message }));
    };
  }, { jobsKey, acksKey, target });
}

(async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const errors = [];
    const focusSessions = new WeakMap();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      globalThis.completionNativeCalls = [];
      chrome.runtime.sendNativeMessage = (_host, message, callback) => {
        completionNativeCalls.push(message.action);
        callback({ ok: false, code: "FIXTURE_NATIVE_DISABLED", error: "No real connector is used in completion UI tests" });
      };
      chrome.notifications.create = (_id, _options, callback) => callback?.("fixture-notification");
    });
    await worker.evaluate(async ({ jobsKey, acksKey, initialJobs, target }) => {
      await chrome.storage.local.set({ [jobsKey]: initialJobs, [acksKey]: [], feishuWikiClipTarget: target });
    }, { jobsKey, acksKey, initialJobs, target });

    async function makePage(job) {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      // Playwright enables focus emulation on every page by default. Disable
      // that harness behavior so real tab activation controls hasFocus().
      const session = await context.newCDPSession(page);
      focusSessions.set(page, session);
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await installPageFixture(page);
      const query = new URLSearchParams({ source: job.source.url, target: target.url, requestId: job.requestId });
      await page.goto(`chrome-extension://${extensionId}/feishu-save.html?${query}`);
      // The first extension navigation swaps renderer processes; Playwright
      // initializes focus emulation again for that new renderer session.
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await page.locator('#connectionPanel[data-state="connected"]').waitFor();
      return page;
    }
    async function focus(page, inactive) {
      await page.bringToFront();
      await page.waitForFunction(() => document.hasFocus());
      if (inactive) await inactive.waitForFunction(() => !document.hasFocus(), undefined, { polling: 50 });
      const activeUrls = await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(tab => tab.url));
      assert(activeUrls.includes(page.url()), "the expected page must be an actual active Chromium tab");
    }
    async function storedJob(id) {
      return worker.evaluate(async ({ jobsKey, id }) => (await chrome.storage.local.get(jobsKey))[jobsKey].find(job => job.id === id), { jobsKey, id });
    }
    async function acknowledgements() {
      return worker.evaluate(async acksKey => (await chrome.storage.local.get(acksKey))[acksKey], acksKey);
    }
    async function completeJob(id) {
      await worker.evaluate(async ({ jobsKey, id, completedAt }) => {
        const jobs = (await chrome.storage.local.get(jobsKey))[jobsKey];
        Object.assign(jobs.find(job => job.id === id), { stage: "complete", completedAt, updatedAt: completedAt,
          resultUrl: `https://my.feishu.cn/wiki/Saved${id.replaceAll("-", "")}`, completionViewed: false });
        await chrome.storage.local.set({ [jobsKey]: jobs });
      }, { jobsKey, id, completedAt });
    }
    const iconPath = page => page.locator("#taskFavicon").evaluate(icon => new URL(icon.href, location.href).pathname);
    const normalizedTime = async page => (await page.locator("#completionTime").innerText()).replace(/\s+/g, "");
    async function waitUntilViewed(page, id) {
      await page.waitForFunction(async ({ jobsKey, id }) => {
        const jobs = (await chrome.storage.local.get(jobsKey))[jobsKey];
        return jobs.find(job => job.id === id)?.completionViewed === true;
      }, { jobsKey, id });
      await page.waitForFunction(() => document.title.startsWith("剪存 · "));
    }
    async function afterNextStateRead(page) {
      const previous = await page.evaluate(() => completionFixture.reads.length);
      // Background rAF can stop in headed Chromium; poll with a real timer.
      await page.waitForFunction(previous => completionFixture.reads.length > previous, previous, { polling: 50 });
    }

    const first = await makePage(initialJobs[0]);
    await focus(first);
    assert.equal(await first.title(), `保存中 · ${initialJobs[0].title}`);
    assert.equal(await iconPath(first), "/icon/32.png");
    assert.equal(await first.locator("#completionSummary").isVisible(), false);
    const second = await makePage(initialJobs[1]);
    await focus(second, first);
    assert.equal(await second.title(), `保存中 · ${initialJobs[1].title}`);

    // Complete just after the prior poll. A sub-1.2s update cannot be the next
    // two-second poll; it exercises the shipped storage-event refresh path.
    await afterNextStateRead(first);
    await completeJob(initialJobs[0].id);
    await first.waitForFunction(() => document.getElementById("taskFavicon")?.href.endsWith("/icon/save-complete.svg"),
      undefined, { timeout: 1200, polling: 30 });
    assert.equal(await first.title(), `已完成 · ${initialJobs[0].title}`);
    await first.waitForFunction(async () => (await chrome.tabs.query({})).some(tab =>
      tab.url === location.href && tab.favIconUrl?.endsWith("/icon/save-complete.svg")), undefined, { polling: 50 });
    assert.equal(await first.evaluate(() => document.hasFocus()), false);
    assert.equal(await first.locator("#completionSummary").isVisible(), true);
    assert.equal(await first.locator("#completionIcon").isVisible(), true);
    assert.equal(await normalizedTime(first), "2分36秒");
    assert.equal((await acknowledgements()).length, 0, "background completion must remain unread");
    assert.equal(await second.locator("#completionSummary").isVisible(), false);
    assert.equal(await iconPath(second), "/icon/32.png");
    console.log("PASS: real background completion updates title/favicon through storage events and does not acknowledge unread results");

    const foreground = await makePage(initialJobs[2]);
    await focus(foreground, second);
    await afterNextStateRead(second);
    await completeJob(initialJobs[1].id);
    await second.waitForFunction(() => document.getElementById("taskFavicon")?.href.endsWith("/icon/save-complete.svg"),
      undefined, { timeout: 1200, polling: 30 });
    assert.equal((await acknowledgements()).length, 0);
    await focus(first, foreground);
    await waitUntilViewed(first, initialJobs[0].id);
    assert.equal(await iconPath(first), "/icon/32.png");
    assert.equal(await normalizedTime(first), "2分36秒");
    assert.equal((await storedJob(initialJobs[1].id)).completionViewed, false,
      "viewing one request must not acknowledge another request for the same article");
    assert.equal(await iconPath(second), "/icon/save-complete.svg");
    const firstReceipt = (await acknowledgements()).find(receipt => receipt.jobId === initialJobs[0].id);
    assert(firstReceipt);
    assert.equal(firstReceipt.requestId, initialJobs[0].requestId);
    assert.equal(firstReceipt.sourceUrl, initialJobs[0].source.url);
    assert.equal(firstReceipt.targetUrl, target.url);
    assert(firstReceipt.focused && firstReceipt.visible && firstReceipt.summaryRendered && firstReceipt.resultRendered,
      "completion may be acknowledged only while focused and after the completed result is rendered");

    await focus(foreground, first);
    await first.reload();
    await focusSessions.get(first).send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await first.locator("#completionSummary").waitFor();
    assert.equal(await first.evaluate(() => document.hasFocus()), false);
    assert.equal(await iconPath(first), "/icon/32.png");
    assert.equal(await first.title(), `剪存 · ${initialJobs[0].title}`);
    assert.equal(await normalizedTime(first), "2分36秒", "completed duration remains fixed across elapsed time and reload");
    assert.equal((await acknowledgements()).filter(receipt => receipt.jobId === initialJobs[0].id).length, 1);
    assert.equal(await iconPath(second), "/icon/save-complete.svg");
    console.log("PASS: viewing acknowledges only the exact request; fixed duration and read favicon survive switching away and reload");

    await focus(foreground, first);
    await foreground.evaluate(() => { completionFixture.faviconChanges.length = 0; });
    await completeJob(initialJobs[2].id);
    await waitUntilViewed(foreground, initialJobs[2].id);
    assert.equal(await iconPath(foreground), "/icon/32.png");
    assert.equal(await normalizedTime(foreground), "8秒");
    const changes = await foreground.evaluate(() => completionFixture.faviconChanges);
    assert(!changes.some(change => /save-complete\.svg/.test(`${change.before || ""} ${change.after || ""}`)),
      "a task completed in the focused page must never flash the green unread favicon");
    assert.equal((await storedJob(initialJobs[1].id)).completionViewed, false);
    console.log("PASS: foreground completion renders before acknowledgement and never flashes the unread favicon");

    const legacy = await makePage(initialJobs[3]);
    await focus(legacy, foreground);
    await legacy.locator("#completionSummary").waitFor();
    await waitUntilViewed(legacy, initialJobs[3].id);
    assert.equal(await legacy.locator("#completionDuration").isVisible(), false,
      "a legacy task without a reliable completedAt must not show an invented elapsed duration");
    assert.equal(await legacy.locator("#resultLink").isVisible(), true);
    await focus(foreground, legacy);
    for (const width of [1100, 390, 320]) {
      await foreground.setViewportSize({ width, height: 920 });
      assert.equal(await foreground.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const selector of ["#completionIcon", "#completionSummary", "#completionDuration", "#resultLink"]) {
        const box = await foreground.locator(selector).boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width, `${selector} must fit ${width}px`);
      }
      if (process.env.UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
        await foreground.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, `save-completion-${width}.png`), fullPage: true });
      }
    }
    for (const receipt of await acknowledgements()) {
      assert(receipt.focused && receipt.visible && receipt.summaryRendered && receipt.resultRendered,
        `acknowledgement for ${receipt.jobId} must follow visible focused completion rendering`);
    }
    assert.deepEqual(await worker.evaluate(() => completionNativeCalls), []);
    assert.deepEqual(errors, []);
    console.log("PASS: missing completion timestamps remain honest; completed result fits 1100/390/320px (real tabs/storage, fixture jobs)");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
