const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const api = require("../shared/feishu-wiki-clip.js");

test("an explicit save-again action prepares one creation attempt and reuses the staged job", async () => {
  const paused = activeJob({ autoRun: false, copy: null, error: "旧新建结果未知", errorCode: "CREATE_UNCERTAIN" });
  const runs = [];
  const svc = service({ runContentJob: async job => { runs.push(structuredClone(job)); await new Promise(() => {}); } },
    { feishuWikiClipJob: paused });
  const preparations = [];
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    assert.equal(message.action, "retry_content_creation");
    assert.equal(svc.store.feishuWikiClipJob.creationRetryRequestId, message.params.request_id);
    preparations.push(message.params);
    callback({ ok: true, data: { stage: "content_prepared", retry_request_id: message.params.request_id } });
  };
  const result = await svc.send({ action: "resume", jobId: paused.id, restartCreation: true });
  assert.equal(result.ok, true, result.error);
  await new Promise(setImmediate);
  assert.equal(preparations.length, 1);
  assert.equal(preparations[0].operation_id, paused.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, paused.id);
  assert.equal(runs[0].stage, "importing");
  assert.equal(runs[0].creationRetryRequestId, "");
  assert.equal((await svc.send({ action: "resume", jobId: paused.id, restartCreation: true })).ok, false);
  assert.equal(preparations.length, 1);
});

test("a lost save-again preparation response reuses its durable intent after worker restart", async () => {
  const paused = activeJob({ autoRun: false, copy: null, error: "未知", errorCode: "CREATE_UNCERTAIN" });
  const svc = service({}, { feishuWikiClipJob: paused });
  let firstRequest;
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    firstRequest = message.params.request_id;
    svc.chrome.runtime.lastError = { message: "Native host exited" };
    callback(); delete svc.chrome.runtime.lastError;
  };
  assert.equal((await svc.send({ action: "resume", jobId: paused.id, restartCreation: true })).ok, false);
  const next = service({ runContentJob: async () => new Promise(() => {}) }, svc.store);
  next.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    assert.equal(message.params.request_id, firstRequest);
    callback({ ok: true, data: { already_applied: true } });
  };
  assert.equal((await next.send({ action: "resume", jobId: paused.id, restartCreation: true })).ok, true);
});

test("save again cannot replace an existing document or an unrelated failure", async () => {
  for (const patch of [{ copy: { token: "Created" }, errorCode: "CREATE_UNCERTAIN" }, { copy: null, errorCode: "CONTENT_MISMATCH" }]) {
    const paused = activeJob({ autoRun: false, error: "暂停", ...patch });
    const svc = service({}, { feishuWikiClipJob: paused });
    const result = await svc.send({ action: "resume", jobId: paused.id, restartCreation: true });
    assert.equal(result.ok, false);
    assert.equal(svc.calls.some(c => c.message.action === "retry_content_creation"), false);
  }
});

function service(overrides = {}, persisted = {}, visibleNotifications = {}, surfaces = { tabs: [], windows: {} }, clock = Date) {
  let listener;
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const store = structuredClone(persisted), alarms = new Map();
  const notifications = new Map(Object.entries(visibleNotifications)), notificationCalls = [], openedTabs = [];
  let alarmListener, startupListener, notificationClick;
  const viewEvents = {};
  const viewEvent = name => ({ addListener: listener => { viewEvents[name] = listener; } });
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const base = `chrome-extension://${id}/`;
  const chrome = { runtime: { id, getURL: (p) => base + p, onMessage: { addListener: (f) => { listener = f; } },
    onStartup: { addListener: f => { startupListener = f; } },
    sendNativeMessage: (host, message, cb) => { calls.push({ host, message }); cb({ ok: true, data: { version: "1.0.88" } }); } },
    alarms: { get: async name => alarms.get(name), create: async (name, info) => alarms.set(name, info),
      clear: async name => alarms.delete(name), onAlarm: { addListener: f => { alarmListener = f; } } },
    notifications: { getAll: async () => Object.fromEntries(notifications),
      create: async (id, options) => { notificationCalls.push({ id, options }); notifications.set(id, true); return id; },
      clear: async id => notifications.delete(id), onClicked: { addListener: f => { notificationClick = f; } } },
    tabs: { create: async options => { openedTabs.push(structuredClone(options)); return { id: openedTabs.length }; },
      query: async query => structuredClone(surfaces.tabs.filter(tab => !query.active || tab.active)),
      onActivated: viewEvent("activated"), onRemoved: viewEvent("removed"), onUpdated: viewEvent("updated") },
    windows: { get: async id => structuredClone(surfaces.windows[id] || { focused: false }), onFocusChanged: viewEvent("focused") },
    storage: { local: { get: async () => structuredClone(store), set: async (value) => Object.assign(store, structuredClone(value)) } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../shared/feishu-clip-service.js"), "utf8"),
    { chrome, FeishuWikiClip: { ...api, ...overrides }, crypto: require("node:crypto").webcrypto, Set, URL, Date: clock,
      WebImageCapture: { capturePublic: async url => ({ publicUrl: url }) },
      setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: id => timers.delete(id) });
  const send = (message, sender = { id, url: base + "feishu-save.html" }) => new Promise((resolve) => listener({ type: "feishu-clip", ...message }, sender, resolve));
  return { send, calls, id, base, store, chrome, alarms, alarm: () => alarmListener({ name: "feishuClipAutoResume" }),
    startup: () => startupListener(), notifications, notificationCalls, openedTabs,
    clickNotification: id => notificationClick(id), timers, surfaces,
    viewEvent: (name, ...args) => viewEvents[name](...args),
    wake: () => { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1].callback(); } } };
}

test("rejects webpage content scripts, other extensions, and unrelated extension pages", async () => {
  const svc = service();
  for (const sender of [{ id: svc.id, url: "https://my.feishu.cn/docx/ABC" }, { id: "other", url: svc.base + "feishu-save.html" },
    { id: svc.id, url: svc.base + "popup.html" }, { id: svc.id, url: svc.base + "feishu-save.html.evil" }]) {
    const response = await svc.send({ action: "native", operation: "status" }, sender);
    assert.equal(response.ok, false);
  }
  assert.equal(svc.calls.length, 0);
});

test("web capture uses the selected source tab and a CORS fallback requires an existing host grant", async () => {
  let dependencies;
  const svc = service({ runContentJob: async (_job, deps) => { dependencies = deps; } });
  svc.chrome.runtime.sendNativeMessage = (_host, _msg, cb) => cb({ ok: true, data: {
    node: { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" } } });
  const pageUrl = "https://scys.com/articleDetail/xq_topic/123";
  const source = api.parseSourceUrl(pageUrl), seen = [], grants = [];
  svc.chrome.tabs = { get: async id => ({ id, url: pageUrl, status: "complete" }), query: async () => [] };
  let cors = false, allowed = false;
  svc.chrome.scripting = { executeScript: async request => {
    seen.push(request);
    if (request.files) return [];
    if (cors) return [{ frameId: 0, result: { ok: false, error: { code: "PAGE_CAPTURE_FAILED", message: "网站暂不允许读取该图片，请保持原网页打开并稍后重试。" } } }];
    return [{ frameId: 0, result: { ok: true, data: { source_url: pageUrl, title: "文章", blocks: [], images: [] } } }];
  } };
  svc.chrome.permissions = { contains: async request => { grants.push(request); return allowed; } };
  const start = await svc.send({ action: "start", sourceUrl: pageUrl, sourceTabId: 42,
    targetUrl: "https://my.feishu.cn/wiki/Parent", expectedSpaceId: "123" });
  assert.equal(start.ok, true);
  assert.equal(svc.store.feishuWikiClipJob.sourceTabId, 42);
  assert.equal((await dependencies.captureWeb(source, 42)).source_url, pageUrl);
  assert.ok(seen.every(request => request.target.tabId === 42));
  cors = true;
  const image = { url: "https://mmbiz.qpic.cn/article.jpg" };
  await assert.rejects(dependencies.captureImage(source, image, 42), /不允许读取/);
  allowed = true;
  assert.equal((await dependencies.captureImage(source, image, 42)).publicUrl, image.url);
  assert.equal(grants.at(-1).origins[0], "https://mmbiz.qpic.cn/*");
});

test("a missing script result is a recoverable transport error, not an empty article", async () => {
  let deps;
  const svc = service({ runContentJob: async (_job, value) => { deps = value; } });
  svc.chrome.runtime.sendNativeMessage = (_host, _msg, cb) => cb({ ok: true, data: {
    node: { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" } } });
  const source = api.parseSourceUrl("https://scys.com/articleDetail/xq_topic/123");
  svc.chrome.tabs = { get: async id => ({ id, url: source.url, status: "complete" }), query: async () => [] };
  svc.chrome.scripting = { executeScript: async () => [{ frameId: 0, result: null }] };
  await svc.send({ action: "start", sourceUrl: source.url, sourceTabId: 42, targetUrl: "https://my.feishu.cn/wiki/Parent", expectedSpaceId: "123" });
  await assert.rejects(deps.captureWeb(source, 42), error => error.code === "CAPTURE_INTERRUPTED" && /继续当前任务/.test(error.message));
});

test("a trusted page can check the bridge but cannot invoke native writes directly", async () => {
  const svc = service();
  const result = await svc.send({ action: "native", operation: "status" });
  assert.equal(result.ok, true);
  assert.equal(svc.calls[0].host, "com.feishu.clipper");
  for (const operation of ["copy_doc", "move_doc", "api", "delete", "get_token"]) {
    assert.equal((await svc.send({ action: "native", operation })).ok, false);
  }
  assert.equal(svc.calls.length, 1);
});

test("a stopped prior article remains recoverable while a different article starts immediately", async () => {
  let started;
  const svc = service({ runContentJob: async (job, deps) => {
    started = structuredClone(job); job.autoRun = false; await deps.save(job);
  } });
  svc.store.feishuWikiClipJob = { id: "prior", stage: "moving", error: "结果待核对", copy: { token: "CopiedDoc" } };
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => callback({ ok: true,
    data: { node: { space_id: "123", node_token: "Parent", title: "资料", node_type: "origin" } } });
  const result = await svc.send({ action: "start", sourceUrl: "https://my.feishu.cn/docx/Source",
    targetUrl: "https://my.feishu.cn/wiki/Parent", expectedSpaceId: "123" });
  assert.equal(result.ok, true, result.error);
  await new Promise(setImmediate);
  assert.equal(started.id, result.data.job.id);
  const prior = svc.store.feishuWikiClipJobs.find(job => job.id === "prior");
  assert.equal(prior.error, "结果待核对");
  assert.equal(prior.copy.token, "CopiedDoc");
  assert.equal(svc.store.feishuWikiClipHistory[0].id, "prior");
});

test("simultaneous starts are persisted once and run serially instead of rejecting the second article", async () => {
  const seen = [], finish = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id); await new Promise(resolve => finish.push(resolve));
    job.autoRun = false; job.stage = "complete"; await deps.save(job);
  } });
  let validate;
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => { validate = callback; };
  const message = source => ({ action: "start", sourceUrl: `https://my.feishu.cn/docx/${source}`,
    targetUrl: "https://my.feishu.cn/wiki/Parent", expectedSpaceId: "123" });
  const first = svc.send(message("Source"));
  await new Promise(setImmediate);
  const second = svc.send(message("Other"));
  const parent = { ok: true, data: { node: { space_id: "123", node_token: "Parent", title: "资料", node_type: "origin" } } };
  validate(parent);
  await new Promise(setImmediate);
  validate(parent);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true, a.error); assert.equal(b.ok, true, b.error);
  assert.equal(svc.store.feishuWikiClipJobs.length, 2);
  assert.deepEqual(seen, [a.data.job.id]);
  const state = (await svc.send({ action: "state", sourceUrl: message("Other").sourceUrl })).data;
  assert.equal(state.job.id, b.data.job.id);
  assert.equal(state.running, true); assert.equal(state.queued, true); assert.equal(state.queuePosition, 1);
  finish.shift()();
  await new Promise(setImmediate);
  assert.deepEqual(seen, [a.data.job.id, b.data.job.id]);
  finish.shift()();
  await new Promise(setImmediate);
  assert.equal((await svc.send({ action: "state", sourceUrl: message("Other").sourceUrl })).data.running, false);
});

test("requires reconfirmation if the parent moved into a different space", async () => {
  const svc = service();
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => callback({ ok: true,
    data: { node: { space_id: "222", node_token: "Parent", title: "资料", node_type: "origin" } } });
  const result = await svc.send({ action: "start", sourceUrl: "https://my.feishu.cn/docx/Source",
    targetUrl: "https://my.feishu.cn/wiki/Parent", expectedSpaceId: "111", spaceName: "以前的库" });
  assert.equal(result.ok, false);
  assert.match(result.error, /知识库已改变/);
  assert.equal(svc.store.feishuWikiClipJob, undefined);
});

test("duration starts at trusted message receipt before target checks and queued mutations, and duplicate starts keep it", async () => {
  const startTime = Date.parse("2026-09-16T00:00:00Z");
  let now = startTime, finishCheck, targetChecks = 0;
  class Clock extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  const svc = service({ runContentJob: async () => new Promise(() => {}) }, {}, {}, undefined, Clock);
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    assert.equal(message.action, "get_node");
    const result = { ok: true, data: { node: { space_id: "123", node_token: "Parent", title: "资料", node_type: "origin" } } };
    if (++targetChecks === 1) finishCheck = () => callback(result);
    else callback(result);
  };
  const message = { action: "start", sourceUrl: "https://my.feishu.cn/docx/Source", targetUrl: "https://my.feishu.cn/wiki/Parent",
    expectedSpaceId: "123", requestId: "00000000-0000-4000-8000-000000000001", createdAt: "2000-01-01T00:00:00Z" };
  const first = svc.send(message);
  await new Promise(setImmediate);
  now += 60000;
  const second = svc.send({ ...message, requestId: "00000000-0000-4000-8000-000000000002" });
  await new Promise(setImmediate);
  now += 120000;
  finishCheck();
  const a = await first, b = await second;
  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  assert.equal(Date.parse(a.data.job.createdAt), startTime);
  assert.equal(Date.parse(b.data.job.createdAt), startTime + 60000);
  now += 60000;
  const duplicate = await svc.send(message);
  assert.equal(duplicate.data.job.id, a.data.job.id);
  assert.equal(duplicate.data.job.createdAt, a.data.job.createdAt);
  assert.equal(targetChecks, 2);
});

test("ending a stopped task preserves its copy and recovery information", async () => {
  const svc = service();
  svc.store.feishuWikiClipJob = { id: "prior", stage: "move_failed", error: "迁入失败", taskId: "123-abc", copy: { token: "CopiedDoc" } };
  const result = await svc.send({ action: "end" });
  assert.equal(result.ok, true);
  assert.equal(svc.store.feishuWikiClipJob.stage, "abandoned");
  assert.equal(svc.store.feishuWikiClipJob.copy.token, "CopiedDoc");
  assert.equal(svc.store.feishuWikiClipJob.taskId, "123-abc");
  assert.equal(svc.calls.length, 0);
});

test("a missing native host stays distinct from Feishu authentication errors", async () => {
  const svc = service();
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => {
    svc.chrome.runtime.lastError = { message: "Specified native messaging host not found." };
    callback();
    delete svc.chrome.runtime.lastError;
  };
  const response = await svc.send({ action: "native", operation: "status" });
  assert.equal(response.code, "NATIVE_UNAVAILABLE");
  assert.match(response.error, /不需要重新授权/);
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => callback({ ok: false, error: "登录过期", code: "AUTH_REQUIRED" });
  assert.equal((await svc.send({ action: "native", operation: "list_spaces" })).code, "AUTH_REQUIRED");
});

const chosenTarget = token => api.targetFromNode({ space_id: "123", node_token: token,
  title: "资料", node_type: "origin" }, "https://my.feishu.cn", "知识库");

test("remembering a location is an immediate local preference independent from a clip job", async () => {
  const svc = service();
  svc.store.feishuWikiClipJob = { id: "stopped", stage: "ready", error: "读取失败" };
  const target = chosenTarget("Chosen");
  const result = await svc.send({ action: "remember_target", target: { ...target, unwanted: "discard" } });
  assert.equal(result.ok, true);
  assert.deepEqual(svc.store.feishuWikiClipTarget, target);
  assert.deepEqual((await svc.send({ action: "state" })).data.target, target);
  assert.equal(svc.store.feishuWikiClipJob.error, "读取失败");
  assert.equal(svc.calls.length, 0);
});

test("invalid target preferences and untrusted senders cannot replace the saved location", async () => {
  const svc = service();
  const prior = chosenTarget("Prior");
  svc.store.feishuWikiClipTarget = prior;
  for (const target of [null, { ...chosenTarget("Chosen"), url: "https://evil.example/wiki/Chosen" },
    { ...chosenTarget("Chosen"), parentToken: "Wrong" }, { ...chosenTarget("Chosen"), spaceId: "" }]) {
    assert.equal((await svc.send({ action: "remember_target", target })).ok, false);
    assert.deepEqual(svc.store.feishuWikiClipTarget, prior);
  }
  assert.equal((await svc.send({ action: "remember_target", target: chosenTarget("Chosen") },
    { id: svc.id, url: "https://my.feishu.cn/docx/Source" })).ok, false);
  assert.deepEqual(svc.store.feishuWikiClipTarget, prior);
});

test("a delayed start cannot replace a more recently selected default location", async () => {
  const svc = service({ runContentJob: async () => {} });
  let finish;
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => { finish = callback; };
  const pending = svc.send({ action: "start", sourceUrl: "https://my.feishu.cn/docx/Source",
    targetUrl: "https://my.feishu.cn/wiki/First", expectedSpaceId: "123" });
  await new Promise(setImmediate);
  const latest = chosenTarget("Latest");
  assert.equal((await svc.send({ action: "remember_target", target: latest })).ok, true);
  finish({ ok: true, data: { node: { space_id: "123", node_token: "First", title: "先前位置", node_type: "origin" } } });
  assert.equal((await pending).ok, true);
  assert.deepEqual(svc.store.feishuWikiClipTarget, latest);
  assert.equal(svc.store.feishuWikiClipJob.target.parentToken, "First");
});

test("native response preserves retryability even when a safely journaled result is uncertain", async () => {
  const svc = service();
  svc.chrome.runtime.sendNativeMessage = (_host, _message, callback) => callback({ ok: false, error: "请求暂时超时",
    code: "CLI_TIMEOUT", retryable: true, uncertain: true });
  const result = await svc.send({ action: "native", operation: "status" });
  assert.equal(result.retryable, true);
  assert.equal(result.uncertain, true);
  assert.equal(result.code, "CLI_TIMEOUT");
});

function activeJob(patch = {}) {
  return { ...api.createJob("https://my.feishu.cn/docx/Source", chosenTarget("Parent"), "durable-operation"),
    stage: "importing", autoRun: true, sourceToken: "Source", ...patch };
}

test("worker startup restores an auto-run job and alarms cannot concurrently start another runner", async () => {
  let calls = 0, finish, observed;
  const original = activeJob({ retryable: true, retryCount: 3, nextRetryAt: Date.now() + 4000,
    error: "网络中断", errorCode: "CLI_TIMEOUT", failedStep: "import_step", retryStepKey: "saved-step-key" });
  const svc = service({ runContentJob: async (job, deps) => {
    calls++; observed = structuredClone(job);
    await new Promise(resolve => { finish = resolve; });
    job.stage = "complete"; job.autoRun = false; job.error = "";
    await deps.save(job);
  } }, { feishuWikiClipJob: original });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(observed.id, original.id);
  assert.equal(observed.retryCount, 3);
  assert.equal(observed.nextRetryAt, original.nextRetryAt);
  assert.equal(svc.alarms.get("feishuClipAutoResume").periodInMinutes, 0.5);
  svc.alarm(); svc.alarm(); svc.startup();
  assert.equal((await svc.send({ action: "state" })).data.running, true);
  assert.equal(calls, 1);
  finish();
  await new Promise(setImmediate);
  assert.equal(svc.alarms.size, 0);
  assert.equal((await svc.send({ action: "state" })).data.running, false);
});

test("paused, exhausted and completed jobs do not resume on worker or browser startup", async () => {
  for (const job of [activeJob({ autoRun: false, error: "请确认权限" }), activeJob({ autoRun: false, stage: "ready" }),
    activeJob({ retryExhausted: true, retryCount: 5, retryable: true, error: "超时" }), activeJob({ stage: "complete" }),
    activeJob({ stage: "abandoned" }), activeJob({ error: "内容不一致", retryable: false, errorCode: "CONTENT_MISMATCH" })]) {
    let calls = 0;
    const svc = service({ runContentJob: async () => { calls++; } }, { feishuWikiClipJob: job });
    svc.alarms.set("feishuClipAutoResume", { periodInMinutes: 0.5 });
    await new Promise(setImmediate);
    svc.startup(); svc.alarm();
    await new Promise(setImmediate);
    assert.equal(calls, 0);
    assert.equal(svc.alarms.size, 0);
    assert.equal(svc.store.feishuWikiClipJob.autoRun, false);
  }
});

test("the watchdog continues an async migration using its original durable job instead of creating a new one", async () => {
  const seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id);
    job.stage = seen.length === 1 ? "pending" : "complete";
    job.autoRun = seen.length === 1;
    await deps.save(job);
  } }, { feishuWikiClipJob: activeJob({ stage: "pending", taskId: "existing-task", copy: { token: "Created" } }) });
  await new Promise(setImmediate);
  assert.equal((await svc.send({ action: "state" })).data.running, true);
  assert.equal((await svc.send({ action: "resume" })).ok, false);
  assert.equal((await svc.send({ action: "native", operation: "authorize_start" })).ok, false);
  assert.equal(svc.calls.some(call => call.message.action === "authorize_start"), false);
  svc.alarm();
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["durable-operation", "durable-operation"]);
  assert.equal(svc.store.feishuWikiClipJob.taskId, "existing-task");
  assert.equal(svc.store.feishuWikiClipJob.copy.token, "Created");
  assert.equal(svc.alarms.size, 0);
});

test("an explicit manual resume grants a fresh retry budget and terminal jobs cannot be revived", async () => {
  let observed;
  const svc = service({ runContentJob: async (job, deps) => { observed = structuredClone(job); job.autoRun = false; await deps.save(job); } });
  await new Promise(setImmediate);
  svc.store.feishuWikiClipJob = activeJob({ autoRun: false, retryExhausted: true, retryCount: 5,
    retryStepKey: "prior-step", error: "超时", nextRetryAt: 12345 });
  assert.equal((await svc.send({ action: "resume" })).ok, true);
  await new Promise(setImmediate);
  assert.equal(observed.retryCount, 0);
  assert.equal(observed.retryExhausted, false);
  assert.equal(observed.id, "durable-operation");
  svc.store.feishuWikiClipJob = activeJob({ autoRun: false, stage: "complete" });
  assert.equal((await svc.send({ action: "resume" })).ok, false);
});

const completedJob = (patch = {}) => activeJob({ stage: "complete", autoRun: false, title: "已核对的文章",
  wikiToken: "Saved", resultUrl: "https://my.feishu.cn/wiki/Saved", ...patch });

function completionRoute(job, patch = {}) {
  const url = new URL("chrome-extension://abcdefghijklmnopabcdefghijklmnop/feishu-save.html");
  const fields = { source: job.source.url, target: job.target.url, jobId: job.id, requestId: job.requestId || "", ...patch };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

function acknowledge(svc, job, patch = {}, route = completionRoute(job)) {
  return svc.send({ action: "acknowledge_completion", jobId: job.id, requestId: job.requestId || "",
    sourceUrl: job.source.url, targetUrl: job.target.url, ...patch }, { id: svc.id, url: route });
}

test("completion notices include only reliable elapsed time and are silent", async () => {
  const timestamps = { createdAt: "2026-09-16T00:00:00Z", completedAt: "2026-09-16T00:02:03Z" };
  for (const unknown of [false, true]) {
    const svc = service({}, { feishuWikiClipJob: completedJob({ ...timestamps, completionTimeUnknown: unknown }) });
    await new Promise(setImmediate);
    assert.equal(svc.notificationCalls[0].options.silent, true);
    assert.equal(svc.notificationCalls[0].options.message.includes("总耗时 2 分 3 秒"), !unknown);
    assert.equal((await svc.send({ action: "state" })).data.completionViewed, false);
  }
});

test("only the exact request in an active focused non-minimized save page suppresses a notice", async () => {
  const job = completedJob({ requestId: "view-request" });
  const cases = [
    { suppress: true },
    { route: completionRoute(job, { jobId: undefined }), suppress: true },
    { active: false }, { focused: false }, { state: "minimized" },
    { route: completionRoute(job, { requestId: "other-request" }) },
    { route: completionRoute(job, { jobId: "other-job" }) },
    { route: completionRoute(job, { source: "https://my.feishu.cn/docx/Other" }) },
    { route: completionRoute(job, { target: "https://my.feishu.cn/wiki/Other" }) },
    { pendingUrl: "https://example.com/" },
    { route: "https://example.com/feishu-save.html" },
    { missing: true }
  ];
  for (const item of cases) {
    const tab = { id: 8, windowId: 3, active: item.active !== false, url: item.route || completionRoute(job), pendingUrl: item.pendingUrl };
    const svc = service({}, { feishuWikiClipJob: job }, {}, { tabs: item.missing ? [] : [tab],
      windows: { 3: { focused: item.focused !== false, state: item.state || "normal" } } });
    await new Promise(setImmediate);
    assert.equal(svc.notificationCalls.length, item.suppress ? 0 : 1, JSON.stringify(item));
    const receipt = svc.store["feishuClipComplete:" + job.id];
    assert.equal(Boolean(receipt.suppressedAt), Boolean(item.suppress));
    assert.equal(Boolean(receipt.viewedAt), false);
    assert.equal((await svc.send({ action: "state" })).data.completionViewed, false);
  }
});

test("foreground suppression applies only to its own job and tab-read errors still notify", async () => {
  const job = completedJob({ requestId: "view-request" });
  const other = completedJob({ id: "other", requestId: "other-request", wikiToken: "Other", resultUrl: "https://my.feishu.cn/wiki/Other" });
  const svc = service({}, { feishuWikiClipJobs: [job, other] }, {}, { tabs: [{ id: 8, windowId: 3, active: true, url: completionRoute(job) }], windows: { 3: { focused: true } } });
  await new Promise(setImmediate);
  assert.deepEqual(svc.notificationCalls.map(item => item.id), ["feishuClipComplete:other"]);
  const failing = service({}, { feishuWikiClipJob: job });
  failing.chrome.tabs.query = async () => { throw new Error("Window closed"); };
  await new Promise(setImmediate);
  assert.equal(failing.notificationCalls.length, 1);
});

test("leaving a suppressed completion before acknowledgement retries exactly once without native work", async () => {
  for (const event of ["activated", "removed", "updated", "focused"]) {
    const job = completedJob({ requestId: "view-request" });
    const svc = service({}, { feishuWikiClipJob: job }, {}, { tabs: [{ id: 8, windowId: 3, active: true, url: completionRoute(job) }], windows: { 3: { focused: true } } });
    await new Promise(setImmediate);
    assert.equal(svc.notificationCalls.length, 0);
    svc.surfaces.tabs = [];
    svc.viewEvent(event, 8, { url: "https://example.com/" });
    await new Promise(setImmediate);
    svc.viewEvent(event, 8, { url: "https://example.com/" });
    await new Promise(setImmediate);
    assert.equal(svc.notificationCalls.length, 1, event);
    assert.equal(svc.calls.length, 0);
    assert.equal(svc.store.feishuWikiClipJob.autoRun, false);
  }
});

test("an exact rendered-result acknowledgement clears only its notice and survives stale saves and restart", async () => {
  let save;
  const job = completedJob({ requestId: "view-request" });
  const svc = service({ runContentJob: async (_job, deps) => { save = deps.save; await new Promise(() => {}); } },
    { feishuWikiClipJob: activeJob({ requestId: job.requestId }) }, { "feishuClipComplete:other": true });
  await new Promise(setImmediate);
  await save(job);
  const before = structuredClone(svc.store.feishuWikiClipJob);
  const result = await acknowledge(svc, job);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.completionViewed, true);
  assert.deepEqual(svc.store.feishuWikiClipJob, before);
  assert.equal(svc.notifications.has("feishuClipComplete:" + job.id), false);
  assert.equal(svc.notifications.has("feishuClipComplete:other"), true);
  const viewedAt = svc.store["feishuClipComplete:" + job.id].viewedAt;
  await save(job);
  assert.equal(svc.store["feishuClipComplete:" + job.id].viewedAt, viewedAt);
  assert.equal((await svc.send({ action: "state", jobId: job.id })).data.completionViewed, true);
  const restarted = service({}, svc.store);
  assert.equal((await restarted.send({ action: "state", jobId: job.id })).data.completionViewed, true);
  assert.equal(restarted.notificationCalls.length, 0);
  assert.equal((await acknowledge(restarted, job)).ok, true);
  assert.equal(restarted.store["feishuClipComplete:" + job.id].viewedAt, viewedAt);
});

test("acknowledgement rejects forged tuples, routes, unverified completion and untrusted senders", async () => {
  const job = completedJob({ requestId: "view-request" });
  const svc = service({}, { feishuWikiClipJob: job });
  await new Promise(setImmediate);
  for (const patch of [{ jobId: "other" }, { requestId: "other" }, { sourceUrl: "https://my.feishu.cn/docx/Other" },
    { targetUrl: "https://my.feishu.cn/wiki/Other" }, { requestId: undefined }]) {
    assert.equal((await acknowledge(svc, job, patch)).ok, false);
  }
  for (const patch of [{ jobId: "other" }, { requestId: "other" }, { source: "https://my.feishu.cn/docx/Other" }, { target: undefined }]) {
    assert.equal((await acknowledge(svc, job, {}, completionRoute(job, patch))).ok, false);
  }
  assert.equal((await acknowledge(svc, job, {}, svc.base + "popup.html")).ok, false);
  assert.equal((await svc.send({ action: "acknowledge_completion" }, { id: "foreign", url: completionRoute(job) })).ok, false);
  assert.equal(Boolean(svc.store["feishuClipComplete:" + job.id].viewedAt), false);
  for (const patch of [{ stage: "verifying" }, { error: "未核对" }, { resultUrl: "https://my.feishu.cn/wiki/Other" }]) {
    const unfinished = service({}, { feishuWikiClipJob: completedJob({ requestId: job.requestId, ...patch }) });
    assert.equal((await acknowledge(unfinished, job)).ok, false);
  }
});

test("legacy completed jobs acknowledge with their exact job route and an empty request id", async () => {
  const job = completedJob();
  const svc = service({}, { feishuWikiClipJob: job });
  assert.equal((await acknowledge(svc, job, {}, completionRoute(job, { jobId: undefined }))).ok, false);
  assert.equal((await acknowledge(svc, job, {}, completionRoute(job, { requestId: "new-page-request" }))).ok, true);
  assert.equal((await svc.send({ action: "state" })).data.completionViewed, true);
});

test("Chrome's original sender URL can acknowledge after replaceState only through the matching top-level tab route", async () => {
  const job = completedJob({ requestId: "view-request" });
  const svc = service({}, { feishuWikiClipJob: job });
  const sender = { id: svc.id, url: svc.base + "feishu-save.html?source=" + encodeURIComponent(job.source.url),
    frameId: 0, documentId: "page-document", documentLifecycle: "active", tab: { id: 8, url: completionRoute(job) } };
  const message = { action: "acknowledge_completion", jobId: job.id, requestId: job.requestId,
    sourceUrl: job.source.url, targetUrl: job.target.url };
  for (const patch of [{ frameId: 1 }, { frameId: undefined }, { documentLifecycle: "prerender" },
    { documentLifecycle: "cached" }, { url: svc.base + "popup.html" }, { id: "foreign" },
    { tab: { id: 8, url: completionRoute(job, { jobId: "another-job" }) } },
    { tab: { id: 8, url: completionRoute(job, { requestId: "another-request" }) } },
    { tab: { id: 8, url: completionRoute(job, { source: "https://my.feishu.cn/docx/Other" }) } },
    { tab: { id: 8, url: completionRoute(job, { target: "https://my.feishu.cn/wiki/Other" }) } },
    { tab: { id: 8, url: completionRoute(job), pendingUrl: "https://example.com" } }]) {
    assert.equal((await svc.send(message, { ...sender, ...patch })).ok, false, JSON.stringify(patch));
  }
  assert.equal((await svc.send({ ...message, targetUrl: "https://my.feishu.cn/wiki/Other" }, sender)).ok, false);
  const result = await svc.send(message, sender);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.completionViewed, true);
  assert(svc.store["feishuClipComplete:" + job.id].viewedAt);
});

test("a foreground acknowledgement prevents a suppressed notice after closing the page", async () => {
  const job = completedJob({ requestId: "view-request" });
  const svc = service({}, { feishuWikiClipJob: job }, {}, { tabs: [{ id: 8, windowId: 3, active: true, url: completionRoute(job) }], windows: { 3: { focused: true } } });
  assert.equal((await acknowledge(svc, job)).ok, true);
  svc.surfaces.tabs = [];
  svc.viewEvent("removed", 8);
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
  assert.equal(svc.store["feishuClipComplete:" + job.id].deliveredAt, "");
  assert.equal((await svc.send({ action: "state" })).data.completionViewed, true);
  const restarted = service({}, svc.store);
  assert.equal((await restarted.send({ action: "state" })).data.completionViewed, true);
  assert.equal(restarted.notificationCalls.length, 0);
});

test("an acknowledgement arriving during notification creation cannot lose its receipt", async () => {
  let save, releaseNotice, noticeStarted;
  const job = completedJob({ requestId: "view-request" });
  const svc = service({ runContentJob: async (_job, deps) => { save = deps.save; await new Promise(() => {}); } },
    { feishuWikiClipJob: activeJob({ requestId: job.requestId }) });
  await new Promise(setImmediate);
  const started = new Promise(resolve => { noticeStarted = resolve; });
  const create = svc.chrome.notifications.create;
  svc.chrome.notifications.create = async (...args) => {
    noticeStarted();
    await new Promise(resolve => { releaseNotice = resolve; });
    return create(...args);
  };
  const completion = save(job);
  await started;
  const acknowledgement = acknowledge(svc, job);
  await new Promise(setImmediate);
  releaseNotice();
  await completion;
  assert.equal((await acknowledgement).ok, true);
  const receipt = svc.store["feishuClipComplete:" + job.id];
  assert(receipt.viewedAt);
  assert(receipt.deliveredAt);
  assert.equal(svc.notificationCalls.length, 1);
  assert.equal(svc.notifications.has("feishuClipComplete:" + job.id), false);
});

test("a focus change during a pending foreground check is retried instead of losing the completion notice", async () => {
  const job = completedJob({ requestId: "view-request" });
  const svc = service({}, { feishuWikiClipJob: job }, {}, { tabs: [{ id: 8, windowId: 3, active: true, url: completionRoute(job) }], windows: { 3: { focused: true } } });
  await new Promise(setImmediate);
  let releaseWindow, checkStarted;
  const started = new Promise(resolve => { checkStarted = resolve; });
  svc.chrome.windows.get = async () => {
    checkStarted();
    await new Promise(resolve => { releaseWindow = resolve; });
    return { focused: true };
  };
  svc.viewEvent("focused", 3);
  await started;
  svc.surfaces.tabs = [];
  svc.viewEvent("removed", 8);
  releaseWindow();
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 1);
  assert.equal(svc.calls.length, 0);
});

test("only a successful final verification sends one notification, even if the completion is saved again", async () => {
  let finish;
  const svc = service({ runContentJob: async (job, deps) => {
    await new Promise(resolve => { finish = resolve; });
    await deps.save({ ...job, stage: "verifying", wikiToken: "Saved" });
    assert.equal(svc.notificationCalls.length, 0);
    const complete = completedJob();
    await deps.save(complete);
    await deps.save(complete);
  } }, { feishuWikiClipJob: activeJob() });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
  finish();
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 1);
  const notification = svc.notificationCalls[0];
  assert.equal(notification.id, "feishuClipComplete:durable-operation");
  assert.equal(notification.options.title, "已保存到飞书");
  assert.equal(notification.options.silent, true);
  assert.match(notification.options.message, /已核对的文章/);
  assert(svc.store[notification.id].deliveredAt);
  assert.equal(svc.store.feishuWikiClipJob.stage, "complete");
});

test("completed notifications are not sent again after dismissal, worker restart, or browser startup", async () => {
  const svc = service({}, { feishuWikiClipJob: completedJob() });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 1);
  const id = svc.notificationCalls[0].id;
  svc.notifications.delete(id);
  const restarted = service({}, svc.store);
  await new Promise(setImmediate);
  restarted.startup(); restarted.alarm();
  await new Promise(setImmediate);
  assert.equal(restarted.notificationCalls.length, 0);
  assert.equal(restarted.calls.length, 0);
});

test("a notification shown just before worker shutdown is recorded without displaying it again", async () => {
  const id = "feishuClipComplete:durable-operation";
  const svc = service({}, { feishuWikiClipJob: completedJob(), [id]: { url: completedJob().resultUrl, deliveredAt: "" } }, { [id]: true });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
  assert(svc.store[id].deliveredAt);
});

test("clicking an older success notification opens its verified document after the current job changes", async () => {
  const svc = service({}, { feishuWikiClipJob: completedJob() });
  await new Promise(setImmediate);
  const id = svc.notificationCalls[0].id;
  svc.store.feishuWikiClipJob = activeJob({ id: "new-job" });
  svc.clickNotification(id);
  await new Promise(setImmediate);
  assert.deepEqual(svc.openedTabs, [{ url: "https://my.feishu.cn/wiki/Saved", active: true }]);
  assert.equal(svc.notifications.has(id), false);
  assert(svc.store[id].viewedAt);
  svc.clickNotification("foreign-notification");
  svc.clickNotification("feishuClipComplete:unknown");
  svc.store["feishuClipComplete:invalid"] = { url: "https://evil.example/wiki/Other" };
  svc.clickNotification("feishuClipComplete:invalid");
  await new Promise(setImmediate);
  assert.equal(svc.openedTabs.length, 1);
});

test("a notification error cannot invalidate a saved document and is retried on the next worker startup", async () => {
  const svc = service({}, { feishuWikiClipJob: completedJob() });
  svc.chrome.notifications.create = async () => { throw new Error("Notifications unavailable"); };
  await new Promise(setImmediate);
  assert.equal(svc.store.feishuWikiClipJob.stage, "complete");
  assert.equal(svc.store.feishuWikiClipJob.error, "");
  assert.equal(svc.calls.length, 0);
  const restarted = service({}, svc.store);
  await new Promise(setImmediate);
  assert.equal(restarted.notificationCalls.length, 1);
});

test("failed, unverified and mismatched result URLs never send success notifications", async () => {
  for (const patch of [{ stage: "verifying" }, { error: "内容不一致", errorCode: "CONTENT_MISMATCH" },
    { resultUrl: "https://evil.example/wiki/Saved" }, { resultUrl: "https://another.feishu.cn/wiki/Saved" },
    { resultUrl: "https://my.feishu.cn/wiki/Other" }, { resultUrl: "https://my.feishu.cn/docx/Saved" }, { wikiToken: "" }]) {
    const svc = service({}, { feishuWikiClipJob: completedJob(patch) });
    await new Promise(setImmediate);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

function staleJob(patch = {}) {
  return activeJob({ source: api.parseSourceUrl("https://scys.com/articleDetail/xq_topic/old-article"),
    sourceToken: "WebRoot", copy: { token: "Created", url: "https://my.feishu.cn/docx/Created" },
    autoRun: false, stage: "importing", error: "新文档内容或格式尚未与原文核对一致", errorCode: "CONTENT_MISMATCH", ...patch });
}

function savedOperation(patch = {}) {
  return { found: true, source_token: "WebRoot", source_url: staleJob().source.url, document: { token: "Created" },
    content_verified: true, wiki_token: "Saved", target: { space_id: "123", parent_node_token: "Parent" }, phase: "moved", ...patch };
}

function operationFixture(svc, operation, nodePatch = {}) {
  const actions = [];
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    actions.push(message.action);
    let data;
    if (message.action === "get_operation") {
      assert.equal(message.params.operation_id, "durable-operation");
      data = operation;
    } else if (message.action === "get_node") data = { node: message.params.token === "Parent"
      ? { space_id: "123", node_token: "Parent", title: "资料", node_type: "origin" }
      : { space_id: "123", node_token: "Saved", node_type: "origin", obj_type: "docx", obj_token: "Created", parent_node_token: "Parent", ...nodePatch } };
    else throw new Error(`Unexpected native operation ${message.action}`);
    callback({ ok: true, data });
  };
  return actions;
}

test("opening the save page reconciles a stale error with an already verified result using reads only and unlocks a new source", async () => {
  let starts = 0;
  const svc = service({ runContentJob: async () => { starts++; } }, { feishuWikiClipJob: staleJob() });
  const actions = operationFixture(svc, savedOperation());
  const state = await svc.send({ action: "state", reconcile: true });
  assert.equal(state.data.job.stage, "complete");
  assert.equal(state.data.job.error, "");
  assert.equal(state.data.job.resultUrl, "https://my.feishu.cn/wiki/Saved");
  assert.equal(state.data.running, false);
  assert.equal(state.data.job.completedAt, undefined);
  assert.equal(state.data.job.completionTimeUnknown, true);
  assert.equal(api.completionDuration(state.data.job), null);
  assert.deepEqual(actions, ["get_operation", "get_node"]);
  assert.equal(starts, 0);
  assert.equal(svc.notificationCalls.length, 1);
  const next = await svc.send({ action: "start", sourceUrl: "https://scys.com/articleDetail/xq_topic/new-article",
    targetUrl: "https://my.feishu.cn/wiki/Parent", expectedSpaceId: "123" });
  assert.equal(next.ok, true, next.error);
  assert.notEqual(svc.store.feishuWikiClipJob.id, "durable-operation");
  assert.equal(starts, 1);
  assert.equal(svc.store.feishuWikiClipHistory[0].stage, "complete");
});

test("reconciliation keeps uncertain or mismatched journals paused and repeated state polling never rechecks them", async () => {
  for (const patch of [{ found: false }, { content_verified: false }, { phase: "content_ready" }, { wiki_token: "" },
    { source_token: "Other" }, { source_url: "https://scys.com/articleDetail/xq_topic/other" }, { source_url: "" },
    { document: { token: "Other" } }, { target: { space_id: "456", parent_node_token: "Parent" } },
    { target: { space_id: "123", parent_node_token: "Other" } }]) {
    const original = staleJob();
    const svc = service({}, { feishuWikiClipJob: original });
    const actions = operationFixture(svc, savedOperation(patch));
    await svc.send({ action: "state", reconcile: true });
    for (let index = 0; index < 5; index++) await svc.send({ action: "state" });
    await svc.send({ action: "state", reconcile: true });
    svc.startup();
    await new Promise(setImmediate);
    assert.deepEqual(actions, ["get_operation"]);
    assert.deepEqual(svc.store.feishuWikiClipJob, original);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

test("reconciliation requires a live matching wiki node before reporting success", async () => {
  for (const patch of [{ node_token: "Other" }, { obj_token: "Other" }, { parent_node_token: "Other" },
    { space_id: "456" }, { node_type: "shortcut" }]) {
    const original = staleJob();
    const svc = service({}, { feishuWikiClipJob: original });
    const actions = operationFixture(svc, savedOperation(), patch);
    await svc.send({ action: "state", reconcile: true });
    assert.deepEqual(actions, ["get_operation", "get_node"]);
    assert.deepEqual(svc.store.feishuWikiClipJob, original);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

test("reconciliation can recover a Feishu source by its resolved document token when its journal has no web URL", async () => {
  const svc = service({}, { feishuWikiClipJob: staleJob({ source: api.parseSourceUrl("https://my.feishu.cn/wiki/OriginalWiki"),
    sourceToken: "OriginalDocument" }) });
  operationFixture(svc, savedOperation({ source_token: "OriginalDocument", source_url: "" }));
  const state = await svc.send({ action: "state", reconcile: true });
  assert.equal(state.data.job.stage, "complete");
});


function allowParent(svc) {
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    svc.calls.push({ message });
    callback({ ok: true, data: { node: { space_id: "123", node_token: message.params.token, title: "资料", node_type: "origin" } } });
  };
}

const startArticle = (source = "Source", parent = "Parent") => ({ action: "start", sourceUrl: `https://my.feishu.cn/docx/${source}`,
  targetUrl: `https://my.feishu.cn/wiki/${parent}`, expectedSpaceId: "123" });

test("duplicate confirmations of one request reuse one durable operation", async () => {
  let finish, executions = 0;
  const svc = service({ runContentJob: async (job, deps) => {
    executions++; await new Promise(resolve => { finish = resolve; });
    job.stage = "complete"; job.autoRun = false; await deps.save(job);
  } });
  allowParent(svc);
  const request = { ...startArticle(), requestId: "0d0e94bb-242f-45b4-aea7-25b2b90c9801" };
  const [first, second] = await Promise.all([svc.send(request), svc.send(request)]);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(first.data.job.id, second.data.job.id);
  assert.equal(svc.store.feishuWikiClipJobs.length, 1);
  assert.equal(svc.calls.length, 1);
  assert.equal(executions, 1);
  finish(); await new Promise(setImmediate);
});

test("replaying one completed request returns its own result without a new create", async () => {
  const requestId = "0d0e94bb-242f-45b4-aea7-25b2b90c9802";
  const saved = completedJob({ requestId });
  const svc = service({}, { feishuWikiClipHistory: [saved], feishuWikiClipJob: staleJob({ id: "other-operation" }) });
  operationFixture(svc, { found: false });
  await new Promise(setImmediate);
  const result = await svc.send({ ...startArticle(), requestId });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.job.id, saved.id);
  assert.equal(result.data.job.resultUrl, saved.resultUrl);
  assert.equal(result.data.running, false);
  assert.equal(svc.store.feishuWikiClipJobs.length, 2);
  assert.equal((await svc.send({ action: "state", sourceUrl: "https://example.com/unrelated" })).data.job, null);
});

test("replaying one paused request preserves its uncertain create without restarting it", async () => {
  let executions = 0;
  const requestId = "0d0e94bb-242f-45b4-aea7-25b2b90c9803";
  const stopped = activeJob({ requestId, autoRun: false, uncertain: true, error: "新建结果未知", errorCode: "CREATE_UNCERTAIN" });
  const svc = service({ runContentJob: async () => { executions++; } }, { feishuWikiClipJob: stopped });
  const result = await svc.send({ ...startArticle(), requestId });
  assert.equal(result.ok, true);
  assert.equal(result.data.job.id, stopped.id);
  assert.equal(result.data.job.errorCode, "CREATE_UNCERTAIN");
  assert.equal(result.data.running, false);
  assert.equal(executions, 0);
  assert.deepEqual(svc.calls.map(call => call.message.action), ["get_operation"]);
  assert.equal(svc.store.feishuWikiClipJobs.length, 1);
});

test("source pages see only their own progress while another destination can receive the same article", async () => {
  const finish = [];
  const svc = service({ runContentJob: async (job, deps) => {
    await new Promise(resolve => finish.push(resolve));
    job.autoRun = false; job.stage = "complete"; await deps.save(job);
  } });
  allowParent(svc);
  const first = await svc.send(startArticle());
  const unseen = (await svc.send({ action: "state", sourceUrl: "https://my.feishu.cn/docx/Other" })).data;
  assert.equal(unseen.job, null); assert.equal(unseen.running, false); assert.equal(unseen.pendingCount, 1);
  const second = await svc.send(startArticle("Other"));
  assert.equal((await svc.send({ action: "state", sourceUrl: startArticle().sourceUrl })).data.job.id, first.data.job.id);
  const third = await svc.send(startArticle("Source", "AnotherParent"));
  assert.notEqual(first.data.job.id, third.data.job.id);
  assert.equal((await svc.send({ action: "state", sourceUrl: startArticle().sourceUrl, targetUrl: startArticle().targetUrl })).data.job.id, first.data.job.id);
  assert.equal((await svc.send({ action: "state", sourceUrl: startArticle("Other").sourceUrl })).data.job.id, second.data.job.id);
  for (let index = 0; index < 3; index++) { finish.shift()(); await new Promise(setImmediate); }
});

test("a worker restart migrates legacy history and drains all eligible jobs without reviving stopped jobs", async () => {
  const stopped = activeJob({ id: "paused", autoRun: false, error: "权限未授予" });
  const first = activeJob({ id: "first", source: api.parseSourceUrl("https://my.feishu.cn/docx/First") });
  const last = activeJob({ id: "last", source: api.parseSourceUrl("https://my.feishu.cn/docx/Last") });
  const seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id); job.autoRun = false; job.stage = "complete"; await deps.save(job);
  } }, { feishuWikiClipHistory: [stopped, first], feishuWikiClipJob: last });
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["first", "last"]);
  assert.equal(svc.store.feishuWikiClipJobs.length, 3);
  assert.equal(svc.store.feishuWikiClipJob.id, "last");
  assert.equal(svc.store.feishuWikiClipHistory.find(job => job.id === "paused").error, "权限未授予");
  assert.equal(svc.alarms.size, 0);
});

test("a paused job can be ended or resumed by id without affecting a different active article", async () => {
  const paused = activeJob({ id: "paused", autoRun: false, error: "稍后再试" });
  const paused2 = activeJob({ id: "paused-two", autoRun: false, error: "稍后再试" });
  const active = activeJob({ id: "active" });
  const finish = [];
  const svc = service({ runContentJob: async (job, deps) => {
    await new Promise(resolve => finish.push(resolve)); job.autoRun = false; job.stage = "complete"; await deps.save(job);
  } }, { feishuWikiClipHistory: [paused, paused2], feishuWikiClipJob: active });
  await new Promise(setImmediate);
  assert.equal((await svc.send({ action: "end", jobId: "active" })).ok, false);
  const end = await svc.send({ action: "end", jobId: "paused" });
  assert.equal(end.ok, true); assert.equal(end.data.job.stage, "abandoned");
  const resume = await svc.send({ action: "resume", jobId: "paused-two" });
  assert.equal(resume.ok, true); assert.equal(resume.data.queued, true);
  assert.equal((await svc.send({ action: "state", jobId: "active" })).data.running, true);
  finish.shift()(); await new Promise(setImmediate);
  finish.shift()(); await new Promise(setImmediate);
  assert.equal((await svc.send({ action: "state", jobId: "paused" })).data.job.stage, "abandoned");
});

test("native reads from other pages wait for the in-flight native request", async () => {
  const callbacks = [], messages = [];
  const svc = service();
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => { messages.push(message.action); callbacks.push(callback); };
  const first = svc.send({ action: "native", operation: "status" });
  const second = svc.send({ action: "native", operation: "list_spaces" });
  await new Promise(setImmediate);
  assert.deepEqual(messages, ["status"]);
  callbacks.shift()({ ok: true, data: { version: "1.0.88" } });
  await first; await new Promise(setImmediate);
  assert.deepEqual(messages, ["status", "list_spaces"]);
  callbacks.shift()({ ok: true, data: { spaces: [] } });
  assert.equal((await second).ok, true);
});

test("deferred recovery yields to another article and wakes from persisted state with one timer", async () => {
  const deferred = activeJob({ id: "deferred", nextRunAt: Date.now() + 60000,
    progress: { phase: "content_recovering" } });
  const next = activeJob({ id: "next" });
  const seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id); job.stage = "complete"; job.autoRun = false; await deps.save(job);
  } }, { feishuWikiClipJobs: [deferred, next], feishuWikiClipJob: next });
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["next"]);
  assert.equal(svc.timers.size, 1);
  svc.alarm(); svc.startup(); await new Promise(setImmediate);
  assert.equal(svc.timers.size, 1);
  assert.deepEqual(seen, ["next"]);
  assert.equal(svc.alarms.size, 1);
  svc.store.feishuWikiClipJobs.find(job => job.id === "deferred").nextRunAt = 0;
  svc.store.feishuWikiClipHistory.find(job => job.id === "deferred").nextRunAt = 0;
  svc.wake(); await new Promise(setImmediate);
  assert.deepEqual(seen, ["next", "deferred"]);
  assert.equal(svc.timers.size, 0); assert.equal(svc.alarms.size, 0);
});

test("completion of an older queued article preserves the selected article and notification ownership", async () => {
  const first = activeJob({ id: "first", title: "第一篇" });
  const second = activeJob({ id: "second", title: "第二篇", source: api.parseSourceUrl("https://my.feishu.cn/docx/Other") });
  const svc = service({ runContentJob: async (job, deps) => {
    await deps.save({ ...job, stage: "complete", autoRun: false, wikiToken: job.id === "first" ? "FirstSaved" : "SecondSaved",
      resultUrl: `https://my.feishu.cn/wiki/${job.id === "first" ? "FirstSaved" : "SecondSaved"}` });
  } }, { feishuWikiClipJobs: [first, second], feishuWikiClipJob: second });
  await new Promise(setImmediate);
  assert.equal(svc.store.feishuWikiClipJob.id, "second");
  assert.equal(svc.notificationCalls.length, 2);
  assert.match(svc.notificationCalls[0].options.message, /第一篇/);
  assert.match(svc.notificationCalls[1].options.message, /第二篇/);
  svc.clickNotification("feishuClipComplete:first"); await new Promise(setImmediate);
  assert.equal(svc.openedTabs[0].url, "https://my.feishu.cn/wiki/FirstSaved");
});


test("an unexpected failure keeps its recovery record and immediately drains the next queued article", async () => {
  const first = activeJob({ id: "failed", source: api.parseSourceUrl("https://my.feishu.cn/docx/First") });
  const second = activeJob({ id: "next", source: api.parseSourceUrl("https://my.feishu.cn/docx/Next") });
  const seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id);
    if (job.id === "failed") {
      await deps.save({ ...job, copy: { token: "ExistingCopy" } });
      throw Object.assign(new Error("连接中断"), { code: "NATIVE_UNAVAILABLE" });
    }
    job.stage = "complete"; job.autoRun = false; await deps.save(job);
  } }, { feishuWikiClipJobs: [first, second], feishuWikiClipJob: second });
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["failed", "next"]);
  const failed = (await svc.send({ action: "state", jobId: "failed" })).data;
  assert.equal(failed.running, false);
  assert.equal(failed.job.copy.token, "ExistingCopy");
  assert.equal(failed.job.errorCode, "NATIVE_UNAVAILABLE");
  assert.equal((await svc.send({ action: "state", jobId: "next" })).data.job.stage, "complete");
});

test("a deferred result becoming due during another article runs again without waiting for the watchdog", async () => {
  const first = activeJob({ id: "recovering" });
  const next = activeJob({ id: "next" });
  const seen = [];
  let finish;
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id);
    if (job.id === "recovering" && seen.length === 1) {
      await deps.save({ ...job, nextRunAt: Date.now() + 60000, progress: { phase: "content_recovering" } });
      return;
    }
    if (job.id === "next") await new Promise(resolve => { finish = resolve; });
    job.stage = "complete"; job.autoRun = false; await deps.save(job);
  } }, { feishuWikiClipJobs: [first, next], feishuWikiClipJob: next });
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["recovering", "next"]);
  const due = Date.now() - 10;
  svc.store.feishuWikiClipJobs.find(job => job.id === "recovering").nextRunAt = due;
  svc.store.feishuWikiClipHistory.find(job => job.id === "recovering").nextRunAt = due;
  svc.wake(); await new Promise(setImmediate);
  assert.deepEqual(seen, ["recovering", "next"]);
  finish(); await new Promise(setImmediate);
  assert.deepEqual(seen, ["recovering", "next", "recovering"]);
  assert.equal(svc.timers.size, 0);
});


test("a terminal background failure notifies once and opens the correct trusted save page", async () => {
  const original = activeJob({ title: "需要处理的文章" });
  const svc = service({ runContentJob: async (job, deps) => {
    const failed = { ...job, autoRun: false, error: "权限不足", errorCode: "PERMISSION_DENIED", failedStep: "import_step" };
    await deps.save(failed); await deps.save(failed);
  } }, { feishuWikiClipJob: original });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 1);
  const notice = svc.notificationCalls[0];
  assert.match(notice.id, /^feishuClipFailed:/);
  assert.equal(notice.options.title, "这篇文章暂未保存完成");
  assert.match(notice.options.message, /需要处理的文章/);
  assert.equal(svc.alarms.size, 0);
  svc.store[notice.id].url = "https://evil.example/redirect";
  svc.clickNotification(notice.id); await new Promise(setImmediate);
  const page = new URL(svc.openedTabs[0].url);
  assert.equal(page.protocol, "chrome-extension:");
  assert.equal(page.host, svc.id);
  assert.equal(page.pathname, "/feishu-save.html");
  assert.equal(page.searchParams.get("source"), original.source.url);
  assert.equal(page.searchParams.get("target"), original.target.url);
  assert.equal(svc.notifications.has(notice.id), false);
});

test("worker startup never sends historical paused failures as new notifications", async () => {
  for (const autoRun of [false, true]) {
    const paused = activeJob({ autoRun, error: "新建结果未知", errorCode: "CREATE_UNCERTAIN", uncertain: true });
    const svc = service({}, { feishuWikiClipJob: paused });
    await new Promise(setImmediate);
    svc.startup(); svc.alarm(); await new Promise(setImmediate);
    assert.equal(svc.notificationCalls.length, 0);
    assert.equal(svc.store.feishuWikiClipJob.autoRun, false);
  }
});

test("temporary retries and deferred checks stay quiet while exhausted retries produce one failure notice", async () => {
  let finish;
  const svc = service({ runContentJob: async (job, deps) => {
    await deps.save({ ...job, error: "请求暂时超时", errorCode: "CLI_TIMEOUT", retryable: true, autoRun: true });
    await deps.save({ ...job, nextRunAt: Date.now() + 1000, progress: { phase: "content_recovering" } });
    await new Promise(resolve => { finish = resolve; });
    await deps.save({ ...job, autoRun: false, error: "请求暂时超时", errorCode: "CLI_TIMEOUT", retryable: false,
      retryExhausted: true, failedStep: "import_step" });
  } }, { feishuWikiClipJob: activeJob() });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
  finish(); await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 1);
  assert.match(svc.notificationCalls[0].id, /^feishuClipFailed:/);
  const restarted = service({}, svc.store);
  await new Promise(setImmediate);
  assert.equal(restarted.notificationCalls.length, 0);
});

test("an explicit retry that ends with the same failure does not duplicate the notification", async () => {
  const svc = service({ runContentJob: async (job, deps) => {
    await deps.save({ ...job, autoRun: false, error: "权限不足", errorCode: "PERMISSION_DENIED", failedStep: "import_step" });
  } }, { feishuWikiClipJob: activeJob() });
  await new Promise(setImmediate);
  const id = svc.notificationCalls[0].id;
  svc.notifications.delete(id);
  assert.equal((await svc.send({ action: "resume", jobId: "durable-operation" })).ok, true);
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 1);
});

test("invalid source or target metadata cannot generate a failure notification", async () => {
  for (const patch of [{ source: { url: "https://user:secret@example.com/article" } },
    { target: { ...chosenTarget("Parent"), url: "https://evil.example/wiki/Parent" } },
    { target: { ...chosenTarget("Parent"), parentToken: "Other" } },
    { target: { ...chosenTarget("Parent"), origin: "https://other.feishu.cn" } },
    { target: { ...chosenTarget("Parent"), spaceId: "" } }]) {
    const svc = service({ runContentJob: async (job, deps) => {
      await deps.save({ ...job, ...patch, autoRun: false, error: "保存失败", errorCode: "IMPORT_FAILED" });
    } }, { feishuWikiClipJob: activeJob() });
    await new Promise(setImmediate);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

test("a failed notification cannot open an invalid source or target", async () => {
  const svc = service({ runContentJob: async (job, deps) => {
    await deps.save({ ...job, autoRun: false, error: "保存失败", errorCode: "IMPORT_FAILED" });
  } }, { feishuWikiClipJob: activeJob() });
  await new Promise(setImmediate);
  const id = svc.notificationCalls[0].id, record = structuredClone(svc.store[id]);
  for (const patch of [{ targetUrl: "https://evil.example/wiki/Parent" },
    { sourceUrl: "javascript:alert(1)" }, { sourceUrl: "https://user:secret@example.com/article" }, { id: "foreign" }]) {
    svc.store[id] = { ...record, ...patch };
    svc.clickNotification(id); await new Promise(setImmediate);
    assert.equal(svc.openedTabs.length, 0);
  }
});


test("a new terminal failure's notification intent survives a worker stopping before notification delivery", async () => {
  const svc = service({ runContentJob: async (job, deps) => {
    await deps.save({ ...job, autoRun: false, error: "权限不足", errorCode: "PERMISSION_DENIED", failedStep: "import_step" });
  } }, { feishuWikiClipJob: activeJob() });
  svc.chrome.notifications.create = async () => { throw new Error("Worker stopped before notification delivery"); };
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
  const failed = structuredClone(svc.store.feishuWikiClipJob);
  assert.match(failed.failureNotificationKey, /^feishuClipFailed:/);
  assert.equal(failed.errorCode, "PERMISSION_DENIED");
  // Reproduce the narrower shutdown window before even the independent
  // notification record is written: only the atomically persisted job remains.
  const restarted = service({}, { feishuWikiClipJobs: [failed], feishuWikiClipJob: failed });
  await new Promise(setImmediate);
  assert.equal(restarted.notificationCalls.length, 1);
  assert.equal(restarted.notificationCalls[0].id, failed.failureNotificationKey);
  assert.deepEqual(restarted.calls.map(call => call.message.action), ["get_operation"]);
  const again = service({}, restarted.store);
  await new Promise(setImmediate);
  assert.equal(again.notificationCalls.length, 0);
});

test("a pending failure notification visible before worker shutdown is marked delivered without a second alert", async () => {
  const failed = activeJob({ autoRun: false, error: "权限不足", errorCode: "PERMISSION_DENIED", failedStep: "import_step" });
  const key = "feishuClipFailed:" + encodeURIComponent(JSON.stringify([failed.id, failed.errorCode, failed.failedStep]));
  failed.failureNotificationKey = key;
  const svc = service({}, { feishuWikiClipJob: failed }, { [key]: true });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
  assert.ok(svc.store[key].deliveredAt);
  assert.equal(svc.store[key].kind, "failure");
});

test("only an exact persisted failure intent can be delivered after startup", async () => {
  const failed = activeJob({ autoRun: false, error: "权限不足", errorCode: "PERMISSION_DENIED", failedStep: "import_step",
    failureNotificationKey: "feishuClipFailed:unmatched" });
  const svc = service({}, { feishuWikiClipJob: failed });
  await new Promise(setImmediate);
  assert.equal(svc.notificationCalls.length, 0);
});


test("a paused old job without a copy token adopts only its fully saved operation and matching live node", async () => {
  const original = staleJob({ copy: null, error: "新建请求断线", errorCode: "CREATE_UNCERTAIN", uncertain: true });
  const svc = service({}, { feishuWikiClipJob: original });
  const actions = operationFixture(svc, savedOperation());
  const state = await svc.send({ action: "state", reconcile: true, sourceUrl: original.source.url });
  assert.deepEqual(actions, ["get_operation", "get_node"]);
  assert.equal(state.data.job.stage, "complete");
  assert.deepEqual(state.data.job.copy, { token: "Created", url: "https://my.feishu.cn/docx/Created" });
  assert.equal(state.data.job.id, original.id);
  assert.equal(state.data.job.resultUrl, "https://my.feishu.cn/wiki/Saved");
  assert.equal(state.data.job.error, "");
  assert.equal(svc.notificationCalls.length, 1);
  assert.equal(svc.notificationCalls[0].options.title, "已保存到飞书");
});

test("a job missing its copy token never adopts an incomplete, mismatched, source or malformed journal document", async () => {
  for (const patch of [{ found: false }, { content_verified: false }, { phase: "content_ready" }, { wiki_token: "" },
    { source_token: "Other" }, { source_url: "" }, { source_url: "https://scys.com/articleDetail/xq_topic/other" },
    { target: { space_id: "456", parent_node_token: "Parent" } },
    { target: { space_id: "123", parent_node_token: "Other" } },
    { document: null }, { document: {} }, { document: { token: "WebRoot" } },
    { document: { token: "Created?other=value" } }, { document: { token: "../Created" } },
    { document: { token: 12345 } }, { document: { token: "https://evil.example/Created" } }]) {
    const original = staleJob({ copy: null, errorCode: "CREATE_UNCERTAIN", uncertain: true });
    const svc = service({}, { feishuWikiClipJob: original });
    const actions = operationFixture(svc, savedOperation(patch));
    await svc.send({ action: "state", reconcile: true });
    assert.deepEqual(actions, ["get_operation"]);
    assert.deepEqual(svc.store.feishuWikiClipJob, original);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

test("an adopted copy still requires the live wiki node to match its document, source and destination", async () => {
  for (const node of [{ obj_token: "Other" }, { obj_token: "WebRoot" }, { node_token: "Other" },
    { parent_node_token: "Other" }, { space_id: "456" }, { node_type: "shortcut" }, { obj_type: "sheet" }]) {
    const original = staleJob({ copy: null, errorCode: "CREATE_UNCERTAIN", uncertain: true });
    const svc = service({}, { feishuWikiClipJob: original });
    const actions = operationFixture(svc, savedOperation(), node);
    await svc.send({ action: "state", reconcile: true });
    assert.deepEqual(actions, ["get_operation", "get_node"]);
    assert.deepEqual(svc.store.feishuWikiClipJob, original);
    assert.equal(svc.notificationCalls.length, 0);
  }
});


function pausedMigration(patch = {}) {
  return staleJob({ stage: "moving", error: "迁入请求暂时断线", errorCode: "CLI_NETWORK", uncertain: true, ...patch });
}

function recoverableMove(patch = {}) {
  return savedOperation({ phase: "move_uncertain", wiki_token: "", move_recovery: {
    recoverable: true, deadline: Date.now() + 60000, deferred_until: 0, post_attempts: 1 }, ...patch });
}

test("an old paused network migration automatically resumes the exact confirmed journal once and notifies its completion", async () => {
  let observed;
  const original = pausedMigration();
  const svc = service({ runContentJob: async (job, deps) => {
    observed = structuredClone(job);
    await deps.save({ ...job, stage: "complete", autoRun: false, wikiToken: "Saved", resultUrl: "https://my.feishu.cn/wiki/Saved" });
  } }, { feishuWikiClipJob: original });
  const actions = operationFixture(svc, recoverableMove({ task_id: "existing-task-123" }));
  await new Promise(setImmediate);
  assert.deepEqual(actions, ["get_operation"]);
  assert.equal(observed.id, original.id);
  assert.deepEqual(observed.copy, original.copy);
  assert.deepEqual(observed.target, original.target);
  assert.equal(observed.sourceToken, original.sourceToken);
  assert.equal(observed.stage, "moving");
  assert.equal(observed.autoRun, true); assert.equal(observed.error, "");
  assert.equal(observed.migrationRecoveryVersion, 1);
  assert.equal(observed.taskId, "existing-task-123");
  assert.equal(svc.notificationCalls.length, 1);
  assert.equal(svc.notificationCalls[0].options.title, "已保存到飞书");
  const restart = service({}, svc.store);
  await new Promise(setImmediate);
  assert.equal(restart.notificationCalls.length, 0);
  assert.equal(restart.calls.length, 0);
});

test("a legacy move upgrade requires its exact source, copied document, destination and helper recovery capability", async () => {
  for (const patch of [{ found: false }, { content_verified: false }, { source_token: "Other" }, { source_url: "" },
    { source_url: "https://scys.com/articleDetail/xq_topic/other" }, { document: { token: "Other" } },
    { document: { token: "WebRoot" } }, { document: null }, { phase: "move_failed" }, { phase: "content_ready" },
    { target: { space_id: "999", parent_node_token: "Parent" } }, { target: { space_id: "123", parent_node_token: "Other" } },
    { move_recovery: undefined }, { move_recovery: { recoverable: false } },
    { move_recovery: { recoverable: true, deadline: Date.now() - 100 } },
    { move_recovery: { recoverable: true, deadline: "invalid" } }, { task_id: "unexpected/task" }]) {
    let runs = 0;
    const original = pausedMigration();
    const svc = service({ runContentJob: async () => { runs++; } }, { feishuWikiClipJob: original });
    const actions = operationFixture(svc, recoverableMove(patch));
    await svc.send({ action: "state", reconcile: true });
    assert.equal(runs, 0);
    assert.deepEqual(svc.store.feishuWikiClipJob, original);
    assert.deepEqual(actions, ["get_operation"]);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

test("permissions, explicit failures, ended tasks and previously upgraded pauses are never auto-restarted", async () => {
  for (const patch of [{ errorCode: "AUTH_REQUIRED" }, { errorCode: "PERMISSION_DENIED" }, { errorCode: "CONTENT_MISMATCH" },
    { errorCode: "MOVE_RECOVERY_TIMEOUT" }, { errorCode: "MOVE_FORBIDDEN" }, { errorCode: "INVALID_RESPONSE" },
    { stage: "abandoned" }, { migrationRecoveryVersion: 1 }, { stage: "importing" }, { copy: null }, { mode: "copy" }]) {
    let runs = 0;
    const original = pausedMigration(patch);
    const svc = service({ runContentJob: async () => { runs++; } }, { feishuWikiClipJob: original });
    operationFixture(svc, recoverableMove());
    await svc.send({ action: "state", reconcile: true });
    svc.startup(); svc.alarm(); await new Promise(setImmediate);
    assert.equal(runs, 0);
    assert.deepEqual(svc.store.feishuWikiClipJob, original);
    assert.equal(svc.notificationCalls.length, 0);
  }
});

test("deferred legacy recovery lets another article finish and keeps one upgrade across worker restart", async () => {
  const original = pausedMigration();
  const other = activeJob({ id: "next-article", source: api.parseSourceUrl("https://my.feishu.cn/docx/Next") });
  const future = Date.now() + 60000, seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id);
    await deps.save({ ...job, stage: "complete", autoRun: false, wikiToken: "NextSaved", resultUrl: "https://my.feishu.cn/wiki/NextSaved" });
  } }, { feishuWikiClipJobs: [original, other], feishuWikiClipJob: other });
  operationFixture(svc, recoverableMove({ move_recovery: { recoverable: true, deadline: future + 60000, deferred_until: future } }));
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["next-article"]);
  const paused = (await svc.send({ action: "state", jobId: original.id })).data.job;
  assert.equal(paused.migrationRecoveryVersion, 1);
  assert.equal(paused.nextRunAt, future); assert.equal(paused.autoRun, true);
  assert.equal(svc.notificationCalls.length, 1);
  const restartRuns = [];
  const restart = service({ runContentJob: async (job, deps) => {
    restartRuns.push(job.id);
    await deps.save({ ...job, stage: "complete", autoRun: false, wikiToken: "Saved", resultUrl: "https://my.feishu.cn/wiki/Saved" });
  } }, svc.store);
  await new Promise(setImmediate);
  assert.equal(restartRuns.length, 0);
  assert.equal(restart.calls.length, 0);
  assert.equal(restart.timers.size, 1);
  restart.store.feishuWikiClipJobs.find(job => job.id === original.id).nextRunAt = 0;
  restart.store.feishuWikiClipHistory.find(job => job.id === original.id).nextRunAt = 0;
  restart.wake(); await new Promise(setImmediate);
  assert.deepEqual(restartRuns, [original.id]);
  assert.equal(restart.notificationCalls.length, 1);
  assert.equal(restart.notificationCalls[0].id, "feishuClipComplete:" + original.id);
  assert.equal(restart.store.feishuWikiClipJobs.find(job => job.id === original.id).migrationRecoveryVersion, 1);
});

test("ending a paused migration during its journal check wins over the delayed auto-upgrade", async () => {
  let runs = 0, resolveJournal;
  const svc = service({ runContentJob: async () => { runs++; } });
  await new Promise(setImmediate);
  const original = pausedMigration();
  svc.store.feishuWikiClipJob = original;
  svc.chrome.runtime.sendNativeMessage = (_host, message, callback) => {
    assert.equal(message.action, "get_operation"); resolveJournal = callback;
  };
  const checking = svc.send({ action: "state", reconcile: true, jobId: original.id });
  await new Promise(setImmediate);
  const ended = await svc.send({ action: "end", jobId: original.id });
  assert.equal(ended.ok, true);
  resolveJournal({ ok: true, data: recoverableMove() });
  await checking;
  await new Promise(setImmediate);
  assert.equal(runs, 0);
  assert.equal(svc.store.feishuWikiClipJob.stage, "abandoned");
  assert.equal(svc.store.feishuWikiClipJob.migrationRecoveryVersion, undefined);
  assert.equal(svc.alarms.size, 0);
  assert.equal(svc.notificationCalls.length, 0);
});


const independentRequest = number => `3c0c866d-5db5-4c9b-9fd5-${String(number).padStart(12, "0")}`;

test("separate requests save the same article into the same destination independently", async () => {
  const seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id);
    await deps.save({ ...job, stage: "complete", autoRun: false, wikiToken: "Saved" + seen.length,
      resultUrl: `https://my.feishu.cn/wiki/Saved${seen.length}` });
  } });
  allowParent(svc);
  const first = await svc.send({ ...startArticle(), requestId: independentRequest(1) });
  await new Promise(setImmediate);
  const second = await svc.send({ ...startArticle(), requestId: independentRequest(2) });
  await new Promise(setImmediate);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.notEqual(first.data.job.id, second.data.job.id);
  assert.deepEqual(seen, [first.data.job.id, second.data.job.id]);
  assert.equal(svc.store.feishuWikiClipJobs.length, 2);
  assert.equal(svc.notificationCalls.length, 2);
  const a = (await svc.send({ action: "state", requestId: independentRequest(1), sourceUrl: startArticle().sourceUrl })).data;
  const b = (await svc.send({ action: "state", requestId: independentRequest(2), sourceUrl: startArticle().sourceUrl })).data;
  assert.equal(a.job.id, first.data.job.id); assert.equal(b.job.id, second.data.job.id);
  assert.notEqual(a.job.resultUrl, b.job.resultUrl);
});

test("a failed older request cannot become the state or operation of a new request for the same article", async () => {
  const older = activeJob({ requestId: independentRequest(3), autoRun: false, error: "新建结果未知", errorCode: "CREATE_UNCERTAIN" });
  const seen = [];
  const svc = service({ runContentJob: async (job, deps) => {
    seen.push(job.id); await deps.save({ ...job, stage: "complete", autoRun: false });
  } }, { feishuWikiClipJob: older });
  allowParent(svc);
  await new Promise(setImmediate);
  const message = { ...startArticle(), requestId: independentRequest(4) };
  const before = (await svc.send({ ...message, action: "state" })).data;
  assert.equal(before.job, null); assert.equal(before.running, false);
  const started = await svc.send(message); await new Promise(setImmediate);
  assert.equal(started.ok, true);
  assert.notEqual(started.data.job.id, older.id);
  assert.deepEqual(seen, [started.data.job.id]);
  const preserved = svc.store.feishuWikiClipJobs.find(job => job.id === older.id);
  assert.equal(preserved.errorCode, "CREATE_UNCERTAIN");
  assert.equal(preserved.autoRun, false);
});

test("old clients without a request id create a new independent operation for every confirmation", async () => {
  const svc = service({ runContentJob: async (job, deps) => { await deps.save({ ...job, stage: "complete", autoRun: false }); } });
  allowParent(svc);
  const [first, second] = await Promise.all([svc.send(startArticle()), svc.send(startArticle())]);
  await new Promise(setImmediate);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.notEqual(first.data.job.id, second.data.job.id);
  assert.notEqual(first.data.job.requestId, second.data.job.requestId);
  assert.equal(svc.store.feishuWikiClipJobs.length, 2);
});

test("a request id cannot be reused for another source or destination and state never falls back to another job", async () => {
  const svc = service({ runContentJob: async (job, deps) => { await deps.save({ ...job, stage: "complete", autoRun: false }); } });
  allowParent(svc);
  const requestId = independentRequest(5);
  const first = await svc.send({ ...startArticle(), requestId });
  await new Promise(setImmediate);
  for (const patch of [{ sourceUrl: startArticle("Other").sourceUrl }, { targetUrl: startArticle("Source", "OtherParent").targetUrl }]) {
    const conflict = await svc.send({ ...startArticle(), requestId, ...patch });
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /其他文章或位置/);
    const state = await svc.send({ ...startArticle(), action: "state", requestId, ...patch });
    assert.equal(state.ok, true); assert.equal(state.data.job, null); assert.equal(state.data.running, false);
  }
  const missing = (await svc.send({ ...startArticle(), action: "state", requestId: independentRequest(6) })).data;
  assert.equal(missing.job, null); assert.equal(missing.running, false);
  assert.equal(svc.store.feishuWikiClipJobs.length, 1);
  assert.equal(svc.store.feishuWikiClipJob.id, first.data.job.id);
});

test("a page refresh reuses its persisted request while failure notifications link to the exact failed job", async () => {
  const requestId = independentRequest(7);
  const svc = service({ runContentJob: async (job, deps) => {
    await deps.save({ ...job, autoRun: false, error: "权限不足", errorCode: "PERMISSION_DENIED", failedStep: "import_step" });
  } });
  allowParent(svc);
  const first = await svc.send({ ...startArticle(), requestId });
  await new Promise(setImmediate);
  const notice = svc.notificationCalls[0];
  const later = activeJob({ id: "later-job", requestId: independentRequest(8), autoRun: false, stage: "complete" });
  svc.store.feishuWikiClipJobs.push(later);
  svc.store.feishuWikiClipJob = later;
  svc.clickNotification(notice.id); await new Promise(setImmediate);
  const page = new URL(svc.openedTabs[0].url);
  assert.equal(page.searchParams.get("jobId"), first.data.job.id);
  assert.equal(page.searchParams.get("requestId"), requestId);
  const exact = (await svc.send({ action: "state", jobId: page.searchParams.get("jobId"), requestId: independentRequest(8) })).data;
  assert.equal(exact.job.id, first.data.job.id);
  const restart = service({}, svc.store);
  const repeated = await restart.send({ ...startArticle(), requestId });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.data.job.id, first.data.job.id);
  assert.equal(restart.store.feishuWikiClipJobs.length, 2);
  assert.equal(restart.calls.some(call => ["move_doc", "import_step", "get_node"].includes(call.message.action)), false);
});

test("malformed request identifiers cannot create tasks", async () => {
  const svc = service();
  for (const requestId of ["", null, 123, "not-a-uuid", "../../unsafe"]) {
    const result = await svc.send({ ...startArticle(), requestId });
    assert.equal(result.ok, false); assert.match(result.error, /请求标识无效/);
  }
  assert.equal(svc.store.feishuWikiClipJobs.length, 0);
  assert.equal(svc.calls.length, 0);
});


test("legacy migration preserves the helper deadline and accepts its full 256-character task id", async () => {
  let observed;
  const deadline = Date.now() + 10000, taskId = "1".repeat(256);
  const svc = service({ runContentJob: async (job, deps) => {
    observed = structuredClone(job);
    await deps.save({ ...job, autoRun: false, stage: "complete" });
  } }, { feishuWikiClipJob: pausedMigration() });
  operationFixture(svc, recoverableMove({ task_id: taskId,
    move_recovery: { recoverable: true, deadline, deferred_until: 0 } }));
  await new Promise(setImmediate);
  assert.equal(observed.moveRecoveryDeadline, deadline);
  assert.equal(observed.taskId, taskId);
  const restarting = service({}, svc.store);
  await new Promise(setImmediate);
  assert.equal(restarting.store.feishuWikiClipJob.moveRecoveryDeadline, deadline);
});

test("a legacy migration never extends an already recorded earlier deadline or accepts an oversized task id", async () => {
  let observed;
  const priorDeadline = Date.now() + 10000;
  const svc = service({ runContentJob: async (job, deps) => {
    observed = structuredClone(job); await deps.save({ ...job, stage: "complete", autoRun: false });
  } }, { feishuWikiClipJob: pausedMigration({ moveRecoveryDeadline: priorDeadline }) });
  operationFixture(svc, recoverableMove({ move_recovery: { recoverable: true, deadline: priorDeadline + 10000 } }));
  await new Promise(setImmediate);
  assert.equal(observed.moveRecoveryDeadline, priorDeadline);
  const oversized = pausedMigration();
  let runs = 0;
  const rejected = service({ runContentJob: async () => { runs++; } }, { feishuWikiClipJob: oversized });
  operationFixture(rejected, recoverableMove({ task_id: "1".repeat(257) }));
  await new Promise(setImmediate);
  assert.equal(runs, 0);
  assert.deepEqual(rejected.store.feishuWikiClipJob, oversized);
});
