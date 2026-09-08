// Real MV3 page and clipboard on Chromium; only the missing connector response
// and navigator platform are fixtures. This does not validate Windows binaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");

(async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    permissions: ["clipboard-read", "clipboard-write"],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const errors = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => {
      globalThis.onboardingNativeCalls = [];
      chrome.runtime.sendNativeMessage = (_host, message, callback) => {
        onboardingNativeCalls.push(message.action);
        callback({ ok: false, code: "NATIVE_UNAVAILABLE", error: "fixture: no connector" });
      };
    });
    for (const [os, platform, userAgent, browser] of [
      ["mac", "MacIntel", "Mozilla/5.0 (Macintosh) Chrome/140.0", "chrome"],
      ["windows", "Win32", "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0", "chrome"],
      ["windows", "Win32", "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Edg/140.0", "edge"]
    ]) {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(({ platform, userAgent }) => {
        Object.defineProperty(navigator, "platform", { value: platform });
        Object.defineProperty(navigator, "userAgent", { value: userAgent });
        Object.defineProperty(navigator, "userAgentData", { value: undefined });
      }, { platform, userAgent });
      await page.goto(`chrome-extension://${id}/feishu-save.html?source=https://example.com/article`);
      await page.locator('#connectionPanel[data-state="setup"]').waitFor();
      assert.equal(await page.locator("#connectorBrowser").inputValue(), browser);
      assert.equal(await page.locator("#connect").isVisible(), false);
      assert.equal(await page.locator("#connectorDownload").count(), 0);
      assert.equal(await page.locator("#installCode").count(), 0);
      if (os === "mac") {
        assert.match(await page.locator("#agentInstallPrompt").textContent(), new RegExp(`当前插件 ID：${id}`));
        assert.match(await page.locator("#agentInstallPrompt").textContent(), /当前浏览器：chrome/);
        await page.locator("#copyAgentPrompt").click();
        await page.waitForFunction(() => document.getElementById("copyAgentPrompt").textContent === "已复制安装提示词");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator("#agentInstallPrompt").textContent());
        await page.locator("#connectorBrowser").selectOption("dia");
        await page.locator("#copyAgentPrompt").click();
        await page.waitForFunction(() => document.getElementById("copyAgentPrompt").textContent === "已复制安装提示词");
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /当前浏览器：dia/);
        await page.locator("#sourceInstall > summary").click();
        assert.match(await page.locator("#installCommand").textContent(), /--browser dia$/);
        await page.locator("#agentPromptPreview > summary").click();
      } else {
        assert.equal(await page.locator("#sourceInstall").isVisible(), false);
        assert.equal(await page.locator("#copyAgentPrompt").isVisible(), false);
        assert.equal(await page.locator("#copyAgentPrompt").isDisabled(), true);
        assert.equal(await page.locator("#agentInstallPrompt").textContent(), "");
        assert.match(await page.locator("#connectorPlatform").textContent(), /本地导出可用；保存到飞书暂仅支持 Mac/);
        assert.equal(await page.locator("#installCommand").textContent(), "");
      }
      for (const width of [744, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${os}/${browser} setup must fit ${width}px`);
        for (const selector of (os === "mac" ? ["#agentInstallPrompt", "#connectorBrowser", "#copyAgentPrompt"] : ["#connectorPlatform"])) {
          const box = await page.locator(selector).boundingBox();
          assert(box.x >= 0 && box.x + box.width <= width, `${selector} must fit ${width}px`);
        }
      }
      if (process.env.UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, `connector-agent-${os}-${browser}-320.png`), fullPage: true });
      }
      await page.close();
      console.log(`PASS: ${os}/${browser} Agent setup/support boundary and 744/390/320px layout`);
    }
    assert.deepEqual(errors, []);
    assert((await worker.evaluate(() => onboardingNativeCalls)).every(action => action === "status"), "setup must never start OAuth or create an app");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
