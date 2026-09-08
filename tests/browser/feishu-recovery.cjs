// Real Chromium, production save UI/state machine/alarms, simulated native host.
// Only a temporary extension's native transport is replaced. The fixture journal
// lives in this Node process, so terminating the MV3 worker does not erase it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const endpoint = "https://scys.com/__clipper_native_test__";
const parentUrl = "https://my.feishu.cn/wiki/Parent";
const parent = { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function createTestExtension() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-recovery-test-"));
  // This directory is created exclusively as disposable test staging. Copy only
  // runtime files, never user profiles, helper credentials, or repository data.
  const entries = ["background.js", "feishu-save.html", "feishu-save.js", "feishu-save.css", "popup.css",
    "popup.html", "popup.js", "wechat-markdown-cleanup.js", "shared", "icon", "_locales"];
  for (const entry of entries) fs.cpSync(path.join(root, entry), path.join(directory, entry), { recursive: true });
  fs.mkdirSync(path.join(directory, "content-scripts"));
  fs.copyFileSync(path.join(root, "content-scripts/feishu-exporter.js"), path.join(directory, "content-scripts/feishu-exporter.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  manifest.background.service_worker = "test-native-bootstrap.js";
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "test-native-bootstrap.js"), `
    const testWorkerGeneration = crypto.randomUUID();
    chrome.runtime.sendNativeMessage = (host, message, callback) => {
      if (host !== "com.feishu.clipper") throw new Error("Unexpected native host");
      fetch(${JSON.stringify(endpoint)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...message, testWorkerGeneration }) })
        .then(response => response.json()).then(callback, error => callback({ ok: false,
          error: error.message, code: "TEST_TRANSPORT_FAILED", retryable: false }));
    };
    const realNotificationCreate = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = async (notificationId, options) => {
      const created = await realNotificationCreate(notificationId, options);
      // Observe real Chrome notification calls in the Node fixture so the
      // count survives worker termination. Never replace the actual API.
      await fetch(${JSON.stringify(endpoint)}, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test_event: "notification_created", notificationId, title: options.title, testWorkerGeneration }) });
      return created;
    };
    importScripts("background.js");
  `);
  return { directory, dispose() {
    // Remove only the exact staging directory created above after checking its
    // identity and content scope. Chromium owns and cleans its separate profile.
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    assert.equal(fs.realpathSync(directory), path.join(fs.realpathSync(os.tmpdir()), path.basename(directory)));
    const allowed = new Set([...entries, "content-scripts", "manifest.json", "test-native-bootstrap.js"]);
    assert(fs.readdirSync(directory).every(entry => allowed.has(entry)));
    fs.rmSync(directory, { recursive: true });
  } };
}

function nativeFixture(scenario) {
  const state = { plans: new Map(), saved: new Map(), calls: [], notifications: [], created: 0, moves: 0, verified: 0 };
  const migrationTaskId = "7037044037068177428-075c9481e6a0007c1df689dfbe5b55a08b6b06f7";
  const failure = (code, uncertain = false) => ({ ok: false, code, retryable: true, uncertain,
    error: `${code}：测试故障，请由当前任务自动恢复。` });
  function handle(message) {
    if (message.test_event === "notification_created") {
      state.notifications.push({ id: message.notificationId, title: message.title, workerGeneration: message.testWorkerGeneration });
      return { ok: true };
    }
    const p = message.params || {};
    state.calls.push({ action: message.action, operationId: p.operation_id, token: p.token, requestId: p.request_id,
      copyToken: p.obj_token, parentToken: p.parent_node_token, spaceId: p.space_id,
      workerGeneration: message.testWorkerGeneration, at: Date.now() });
    let data;
    switch (message.action) {
      case "status": data = { available: true }; break;
      case "list_spaces": data = { items: [{ space_id: "123", name: "测试知识库" }], has_more: false }; break;
      case "get_space": data = { space: { space_id: "123", name: "测试知识库" } }; break;
      case "get_node": {
        if (p.token === "Parent") { data = { node: parent }; break; }
        const node = state.saved.get(p.token);
        assert(node, `Unknown wiki node ${p.token}`);
        const plan = [...state.plans.values()].find(value => value.created === node.obj_token);
        plan.verifyAttempts = (plan.verifyAttempts || 0) + 1;
        if (scenario === "transient-verification" && plan.verifyAttempts === 1) return failure("TEMPORARY_ERROR");
        state.verified++;
        data = { node }; break;
      }
      case "prepare_web_content": {
        if (p.snapshot && !state.plans.has(p.operation_id)) state.plans.set(p.operation_id, structuredClone(p.snapshot));
        const plan = state.plans.get(p.operation_id);
        if (!plan) return { ok: false, code: "IMPORT_NOT_PREPARED", error: "请读取网页" };
        data = { title: plan.title, block_count: plan.blocks.length, image_count: plan.images.length, images: plan.images }; break;
      }
      case "import_step": {
        const plan = state.plans.get(p.operation_id);
        assert(plan && !plan.images.length, "Recovery fixture expects a prepared text article");
        plan.importAttempts = (plan.importAttempts || 0) + 1;
        if (!plan.created) plan.created = `Created${++state.created}`;
        // The write is already committed in the fixture journal before its
        // response is lost. Replaying this operation returns the same document.
        if (["committed-response-lost", "worker-restart"].includes(scenario) && plan.importAttempts === 1) return failure("REQUEST_TIMEOUT", true);
        if (scenario === "create-uncertain" && !plan.explicitlyRestarted) return failure("CREATE_UNCERTAIN", true);
        if (scenario === "deferred-create-recovery" && plan.importAttempts === 1) {
          // The helper has started a read-only lookup after losing a creation
          // response. Waiting must persist and yield without a manual action.
          data = { complete: false, deferred_until: Date.now() + 400,
            progress: { phase: "content_recovering", completed: 1, total: 3 } }; break;
        }
        if (scenario === "content-mismatch") {
          if (plan.importAttempts > 1) return failure("CONTENT_MISMATCH");
          data = { complete: false, document: { token: plan.created },
            progress: { phase: "content_verifying", completed: 0, total: 1 } }; break;
        }
        data = { complete: true, document: { token: plan.created } }; break;
      }
      case "retry_content_creation": {
        const plan = state.plans.get(p.operation_id);
        assert.equal(scenario, "create-uncertain");
        assert(plan, "Re-save must reuse the already captured article");
        assert.match(p.request_id || "", /^[0-9a-f-]{36}$/);
        const alreadyApplied = plan.retryRequestId === p.request_id;
        if (!alreadyApplied) {
          assert.equal(plan.explicitlyRestarted, undefined, "One click must request only one replacement creation");
          plan.previousCreated = plan.created;
          delete plan.created;
          plan.retryRequestId = p.request_id;
          plan.explicitlyRestarted = true;
        }
        data = { stage: "content_prepared", title: plan.title, block_count: plan.blocks.length,
          image_count: plan.images.length, images: plan.images, retry_request_id: p.request_id, already_applied: alreadyApplied };
        break;
      }
      case "move_doc": {
        const plan = state.plans.get(p.operation_id);
        assert.equal(p.obj_token, plan.created);
        assert.equal(p.parent_node_token, "Parent");
        assert.equal(p.space_id, "123");
        plan.moveAttempts = (plan.moveAttempts || 0) + 1;
        const attempt = plan.moveAttempts;
        const deferred = (delay, taskId) => ({ ok: true, data: { recovering: true,
          deferred_until: Date.now() + delay, ...(taskId ? { task_id: taskId } : {}) } });
        const networkFailure = uncertain => ({ ok: false, code: "CLI_NETWORK", uncertain,
          retryable: false, error: "连接中断，迁入响应未返回。" });
        // These are helper-level recovery responses, not a simulation of the
        // helper's underlying HTTP POSTs. Python tests assert those boundaries.
        if (scenario === "move-no-task-network" && attempt === 1) return networkFailure(true);
        if (scenario === "move-three-articles" && plan.created === "Created1") {
          if (attempt === 1) return networkFailure(true);
          if (state.saved.size < 2) return deferred(700);
        }
        if (scenario === "move-task-poll") {
          if (attempt === 1 || attempt === 3) return deferred(500, migrationTaskId);
          if (attempt === 2) return networkFailure(false);
        }
        if (scenario === "move-worker-restart" && attempt === 1) return deferred(10000);
        const token = `Saved${p.obj_token}`;
        if (!state.saved.has(token)) state.moves++;
        if (!plan.moveCompletedAt) plan.moveCompletedAt = Date.now();
        state.saved.set(token, { ...parent, node_token: token, obj_type: "docx", obj_token: p.obj_token,
          parent_node_token: scenario === "move-target-mismatch" && plan.created === "Created1" ? "WrongParent" : "Parent" });
        data = { wiki_token: token }; break;
      }
      default: throw new Error(`Unexpected native action ${message.action}`);
    }
    return { ok: true, data };
  }
  return { state, handle, migrationTaskId };
}

async function until(read, accept, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await pause(75);
  }
  throw new Error(`${message}: ${JSON.stringify(latest)}`);
}

async function runScenario(directory, scenario) {
  const fixture = nativeFixture(scenario);
  const fixtureErrors = [];
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`]
  });
  try {
    await context.route("https://scys.com/**", async route => {
      try {
        if (route.request().url() === endpoint) {
          return await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture.handle(route.request().postDataJSON())) });
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<main><h1>自动恢复验收</h1>
          <div class="feishu-doc-content"><h2>完整正文</h2><p>场景 ${scenario}：这段正文应只保存为一份独立文档。</p></div></main>` });
      } catch (error) {
        fixtureErrors.push(error.message);
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: false, code: "TEST_FIXTURE_FAILED", error: error.message }) }).catch(() => {});
      }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const source = await context.newPage();
    await source.goto(`https://scys.com/articleDetail/xq_topic/${scenario}`);
    const sourceTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, source.url());
    let save = await context.newPage();
    const saveUrl = `chrome-extension://${id}/feishu-save.html?${new URLSearchParams({ source: source.url(), sourceTabId: String(sourceTabId) })}`;
    // Select the parent through the actual UI. No fixture writes a job or target
    // directly into storage, nor calls the start/resume service APIs itself.
    await save.goto(saveUrl);
    await save.locator('#connectionPanel[data-state="connected"]').waitFor();
    await save.locator("#targetUrl").fill(parentUrl);
    await save.locator("#resolveTarget").click();
    await save.waitForFunction(() => !document.getElementById("save").disabled);

    let cdp, versions = new Map();
    if (["worker-restart", "move-worker-restart"].includes(scenario)) {
      cdp = await context.newCDPSession(source);
      cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updated }) => {
        for (const version of updated) versions.set(version.versionId, version);
      });
      await cdp.send("ServiceWorker.enable");
    }
    const readFrom = (page, sourceUrl) => page.evaluate(async url => {
      const route = new URL(location.href).searchParams;
      const response = await chrome.runtime.sendMessage({ type: "feishu-clip", action: "state", sourceUrl: url,
        requestId: route.get("requestId"), ...(route.get("jobId") ? { jobId: route.get("jobId") } : {}) });
      if (!response.ok) throw new Error(response.error);
      return response.data.job;
    }, sourceUrl);
    const readJob = () => readFrom(save, source.url());
    await save.locator("#save").click();
    const first = await until(readJob, job => Boolean(job), "No job after one save click");
    const jobId = first.id;
    const resumeUrl = new URL(saveUrl);
    resumeUrl.searchParams.set("jobId", jobId);
    async function saveAnotherArticle(suffix) {
      const extraSource = await context.newPage();
      await extraSource.goto(`https://scys.com/articleDetail/xq_topic/${scenario}-${suffix}`);
      const extraTabId = await save.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, extraSource.url());
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/feishu-save.html?${new URLSearchParams({ source: extraSource.url(), sourceTabId: String(extraTabId) })}`);
      await page.waitForFunction(() => !document.getElementById("save").disabled);
      assert.equal(await page.locator("#jobPanel").isVisible(), false, "A new article inherited the older migration's status");
      assert.equal(await page.locator("#targetUrl").inputValue(), parentUrl);
      await page.locator("#save").click();
      const job = await until(() => readFrom(page, extraSource.url()), value => Boolean(value), "No task after one click on a new article");
      return { page, source: extraSource, jobId: job.id, read: () => readFrom(page, extraSource.url()) };
    }

    if (scenario === "move-three-articles") {
      const delayed = await until(readJob, job => job?.copy?.token && job.nextRunAt > Date.now() && job.autoRun,
        "First migration did not stay automatic and release the queue");
      assert.equal(delayed.taskId || "", "", "The lost migration response unexpectedly supplied a task id");
      await source.close();
      const next = await Promise.all([saveAnotherArticle("second"), saveAnotherArticle("third")]);
      const nextCompleted = await Promise.all(next.map(article => until(article.read,
        job => job?.stage === "complete", "A newer article was blocked by the earlier migration", 20000)));
      assert.equal(new Set(nextCompleted.map(job => job.id)).size, 2);
      const original = await until(readJob, job => job?.stage === "complete", "Earlier migration did not finish automatically", 20000);
      const jobs = [original, ...nextCompleted];
      assert.equal(fixture.state.created, 3);
      assert.equal(fixture.state.plans.size, 3);
      assert.equal(fixture.state.moves, 3);
      assert.equal(new Set(jobs.map(job => job.copy.token)).size, 3);
      for (const job of jobs) {
        const plan = fixture.state.plans.get(job.id);
        assert.equal(plan.importAttempts, 1, "Migration recovery rewrote or recreated the article");
        assert.equal(job.copy.token, plan.created);
        const requests = fixture.state.calls.filter(call => call.action === "move_doc" && call.operationId === job.id);
        assert(requests.length >= 1 && requests.length <= 8, "Recovery requests looped without bound");
        assert(requests.every(call => call.copyToken === job.copy.token && call.parentToken === "Parent" && call.spaceId === "123"));
        const notice = await until(() => save.evaluate(async notificationId => (await chrome.storage.local.get(notificationId))[notificationId],
          `feishuClipComplete:${job.id}`), value => Boolean(value?.deliveredAt), "Missing article-specific completion notification");
        assert.equal(notice.url, job.resultUrl);
        assert.equal(fixture.state.notifications.filter(notice => notice.id === `feishuClipComplete:${job.id}`).length, 1);
      }
      const firstPlan = fixture.state.plans.get(jobId);
      assert(nextCompleted.every(job => fixture.state.plans.get(job.id).moveCompletedAt <= firstPlan.moveCompletedAt),
        "The deferred first article did not let both newer articles finish");
      assert(!fixture.state.notifications.some(notice => notice.title === "这篇文章暂未保存完成"), "A recoverable migration produced a terminal failure alert");
      assert.deepEqual(fixtureErrors, []);
      console.log("PASS: three one-click saves finish with separate documents and notifications while the first migration recovers in the background");
      return;
    }

    if (scenario === "move-task-poll") {
      const pending = await until(readJob, job => job?.taskId === fixture.migrationTaskId && job.nextRunAt > Date.now(),
        "The async migration task id or deferred deadline was not preserved");
      assert.equal(pending.autoRun, true);
      assert.equal(pending.resultUrl || "", "");
      assert.equal(fixture.state.notifications.length, 0, "Migration still processing was reported as complete");
    }

    if (scenario === "move-worker-restart") {
      const pending = await until(readJob, job => job?.copy?.token && job.autoRun && job.nextRunAt > Date.now(),
        "No durable migration recovery before worker stop");
      assert.equal(pending.id, jobId);
      assert.equal(fixture.state.created, 1);
      assert(await save.evaluate(() => chrome.alarms.get("feishuClipAutoResume")));
      const version = await until(() => [...versions.values()], values => values.some(value => value.scriptURL === worker.url() && value.runningStatus === "running"), "No running extension worker");
      const current = version.find(value => value.scriptURL === worker.url() && value.runningStatus === "running");
      await save.close();
      await cdp.send("ServiceWorker.stopWorker", { versionId: current.versionId });
      await until(() => versions.get(current.versionId)?.runningStatus, value => value === "stopped", "Worker did not stop during migration recovery");
      // Poll only the out-of-process fixture; extension UI messages would wake
      // the worker and would no longer prove the durable alarm can do so.
      await until(() => fixture.state.verified, count => count === 1, "Alarm did not finish migration with the save page closed", 50000);
      const moves = fixture.state.calls.filter(call => call.action === "move_doc");
      assert.equal(moves.length, 2);
      assert.notEqual(moves[0].workerGeneration, moves[1].workerGeneration);
      await until(() => fixture.state.notifications.filter(notice => notice.id === `feishuClipComplete:${jobId}`).length,
        count => count === 1, "No real notification call while the save page was closed");
      save = await context.newPage();
      await save.goto(resumeUrl.href);
    }

    if (scenario === "worker-restart") {
      const retry = await until(readJob, job => job?.retryCount === 1 && job.autoRun && job.retryable, "No durable retry before worker stop");
      assert.equal(retry.id, jobId);
      assert.equal(fixture.state.created, 1);
      const alarm = await save.evaluate(() => chrome.alarms.get("feishuClipAutoResume"));
      assert(alarm, "Automatic recovery must install its own durable alarm");
      const version = await until(() => [...versions.values()], values => values.some(value => value.scriptURL === worker.url() && value.runningStatus === "running"), "No running extension worker version");
      const current = version.find(value => value.scriptURL === worker.url() && value.runningStatus === "running");
      // Closing the save UI prevents its polling messages from waking the
      // worker. The production alarm must wake it and replay the durable job.
      await save.close();
      await cdp.send("ServiceWorker.stopWorker", { versionId: current.versionId });
      await until(() => versions.get(current.versionId)?.runningStatus, status => status === "stopped", "Worker did not stop");
      await until(() => ({ verified: fixture.state.verified, calls: fixture.state.calls,
        workerStatus: versions.get(current.versionId)?.runningStatus }), state => state.verified === 1,
      "Alarm did not finish the same task after worker stop", 50000);
      const writes = fixture.state.calls.filter(call => call.action === "import_step");
      assert.equal(writes.length, 2);
      assert.notEqual(writes[0].workerGeneration, writes[1].workerGeneration,
        "The replay must run in a newly initialized worker, not the original worker");
      const recoveredWorker = context.serviceWorkers().find(value => value.url() === worker.url());
      const delivered = await until(() => recoveredWorker.evaluate(async id =>
        (await chrome.storage.local.get(id))[id], `feishuClipComplete:${jobId}`), value => Boolean(value?.deliveredAt),
      "No completion notification while the save page is closed");
      assert.equal(delivered.url, "https://my.feishu.cn/wiki/SavedCreated1");
      save = await context.newPage();
      await save.goto(resumeUrl.href);
    }

    const terminal = await until(readJob, job => job?.id === jobId && (job.stage === "complete" || job.error && !job.autoRun), "Automatic task did not reach a terminal state", 25000);
    assert.deepEqual(fixtureErrors, []);
    assert.equal(fixture.state.plans.size, 1);
    assert.equal(fixture.state.created, 1, "Recovery created a duplicate document");
    const plan = fixture.state.plans.get(jobId);
    assert(plan, "Recovery changed operation id");
    if (scenario === "move-target-mismatch") {
      assert.notEqual(terminal.stage, "complete");
      assert.equal(terminal.autoRun, false);
      assert.equal(terminal.resultUrl || "", "");
      assert.equal(plan.importAttempts, 1);
      assert.equal(plan.moveAttempts, 1);
      await until(() => fixture.state.notifications.some(notice => notice.title === "这篇文章暂未保存完成"), Boolean,
        "A genuine target mismatch did not notify the user");
      assert.equal(fixture.state.notifications.some(notice => notice.id === `feishuClipComplete:${jobId}`), false);
      const next = await saveAnotherArticle("after-conflict");
      const completed = await until(next.read, job => job?.stage === "complete", "A target mismatch blocked another article");
      assert.notEqual(completed.id, jobId);
      assert.equal(fixture.state.created, 2);
      assert.equal(plan.moveAttempts, 1, "A terminal target mismatch was blindly retried");
      console.log("PASS: a mismatched migration target never reports success or blocks the next article");
      return;
    }
    if (["content-mismatch", "create-uncertain"].includes(scenario)) {
      assert.equal(terminal.errorCode, scenario === "content-mismatch" ? "CONTENT_MISMATCH" : "CREATE_UNCERTAIN");
      assert.equal(terminal.autoRun, false);
      assert.equal(terminal.retryCount, 0);
      assert.equal(fixture.state.moves, 0);
      assert.equal(plan.importAttempts, scenario === "content-mismatch" ? 2 : 1);
      const callsAtStop = fixture.state.calls.length;
      await pause(1400); // Exceeds the first automatic retry delay.
      assert.equal(fixture.state.calls.length, callsAtStop, "Non-retryable failure repeated a native call");
      assert.equal(await save.evaluate(() => chrome.alarms.get("feishuClipAutoResume")), undefined);
      assert.equal(await save.evaluate(async id => (await chrome.storage.local.get(id))[id], `feishuClipComplete:${jobId}`), undefined);
      await save.waitForFunction(() => document.getElementById("jobStatus").classList.contains("status-error"));
      assert.equal(await save.locator("#jobDetails").getAttribute("open"), null);
      assert.equal(await save.locator("#resume").isVisible(), false);
      assert.equal(await save.locator("#endTask").isVisible(), false);
      assert.equal(await save.locator("#save").innerText(), scenario === "create-uncertain" ? "重新保存到飞书" : "重试保存");
      console.log(`PASS: ${scenario} stops without automatic repeated writes, even with retryable=true`);
      if (scenario === "create-uncertain") {
        const sourceReads = fixture.state.calls.filter(call => call.action === "prepare_web_content").length;
        await source.close(); // Re-save must use the saved plan even without the original tab.
        let dialogs = 0;
        save.on("dialog", async dialog => { dialogs++; await dialog.dismiss(); });
        assert.match(await save.locator("#saveHint").innerText(), /点击重新保存.*图文会复用/);
        await save.locator("#save").click();
        const resaved = await until(readJob, job => job?.stage === "complete", "One explicit re-save did not finish", 20000);
        assert.equal(resaved.id, jobId);
        assert.equal(dialogs, 0, "The re-save click must not require another confirmation");
        assert.equal(fixture.state.plans.size, 1);
        assert.equal(fixture.state.calls.filter(call => call.action === "prepare_web_content").length, sourceReads);
        const restarts = fixture.state.calls.filter(call => call.action === "retry_content_creation");
        assert.equal(restarts.length, 1);
        assert.equal(restarts[0].operationId, jobId);
        assert.equal(fixture.state.created, 2, "Explicit re-save must create one replacement, not loop");
        assert.equal(plan.previousCreated, "Created1");
        assert.equal(plan.created, "Created2");
        assert.equal(fixture.state.moves, 1);
        assert.equal([...fixture.state.saved.values()][0].obj_token, "Created2");
        const notification = await until(() => save.evaluate(async id => (await chrome.storage.local.get(id))[id],
          `feishuClipComplete:${jobId}`), value => Boolean(value?.deliveredAt), "No completion notification after re-save");
        assert.equal(notification.url, resaved.resultUrl);
        console.log("PASS: one explicit re-save reuses cached content with the original tab closed and finishes without another prompt");
      }
    } else {
      assert.equal(terminal.stage, "complete", terminal.error);
      assert.equal(terminal.autoRun, false);
      if (!scenario.startsWith("move-")) assert.equal(terminal.lastRetryCount || 0, scenario === "deferred-create-recovery" ? 0 : 1);
      assert.equal(fixture.state.moves, 1);
      assert.equal(plan.importAttempts, scenario === "transient-verification" || scenario.startsWith("move-") ? 1 : 2);
      if (scenario.startsWith("move-")) {
        assert.equal(plan.moveAttempts, scenario === "move-task-poll" ? 4 : 2);
        const moves = fixture.state.calls.filter(call => call.action === "move_doc");
        assert(moves.every(call => call.operationId === jobId && call.copyToken === terminal.copy.token
          && call.parentToken === "Parent" && call.spaceId === "123"));
        assert.equal(fixture.state.calls.some(call => call.action === "get_task"), false,
          "The browser must use the helper's durable migration operation, not a separate task polling path");
      }
      if (scenario === "transient-verification") assert.equal(plan.verifyAttempts, 2);
      if (scenario === "deferred-create-recovery") {
        const imports = fixture.state.calls.filter(call => call.action === "import_step");
        assert(imports[1].at - imports[0].at >= 350, "Deferred recovery busy-looped instead of waiting");
      }
      await save.waitForFunction(() => document.getElementById("jobStatus").textContent.includes("保存成功"));
      assert.equal(await save.locator("#resultLink").getAttribute("href"), terminal.resultUrl);
      const notification = await until(() => save.evaluate(async id => (await chrome.storage.local.get(id))[id],
        `feishuClipComplete:${jobId}`), value => Boolean(value?.deliveredAt), "No completion notification");
      assert.equal(notification.url, terminal.resultUrl);
      assert.equal(fixture.state.notifications.filter(notice => notice.id === `feishuClipComplete:${jobId}`).length, 1);
      assert.equal(fixture.state.notifications.filter(notice => notice.title === "这篇文章暂未保存完成").length, 0,
        "A recovered transient fault should not send a terminal failure notification");
      console.log(`PASS: ${scenario} completes after one save click with one created document`);
    }
    assert(!fixture.state.calls.some(call => call.action.startsWith("authorize_")));
  } finally { await context.close(); }
}

(async () => {
  const extension = createTestExtension();
  try {
    const scenarios = ["committed-response-lost", "deferred-create-recovery", "transient-verification", "content-mismatch", "create-uncertain", "worker-restart",
      "move-three-articles", "move-no-task-network", "move-task-poll", "move-worker-restart", "move-target-mismatch"];
    if (process.env.RECOVERY_SCENARIO) assert(scenarios.includes(process.env.RECOVERY_SCENARIO), "Unknown RECOVERY_SCENARIO");
    for (const scenario of process.env.RECOVERY_SCENARIO ? scenarios.filter(value => value === process.env.RECOVERY_SCENARIO) : scenarios) {
      await runScenario(extension.directory, scenario);
    }
  } finally { extension.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
