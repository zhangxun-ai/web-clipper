const assert = require("node:assert/strict"), test = require("node:test"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../feishu-save.js"), "utf8");
const clipApi = require("../shared/feishu-wiki-clip.js");
const onboarding = require("../shared/connector-onboarding.js");
const requestId = "11111111-1111-4111-8111-111111111111";

async function page(overrides = {}, store = { target: { url: "https://my.feishu.cn/wiki/Parent" } }, environment = {}) {
  class Element {
    constructor() { this.value = ""; this.textContent = ""; this.hidden = true; this.dataset = {}; this.children = []; this.events = {}; }
    addEventListener(name, handler) { this.events[name] = handler; }
    replaceChildren(...children) { this.children = children; }
    appendChild(child) { this.children.push(child); }
    removeAttribute() {}
  }
  const elements = new Map(), calls = [], messages = [], opened = [], delays = [], copied = [];
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const handlers = {
    status: () => ({ available: true }), list_spaces: () => ({ items: [{ space_id: "123", name: "我的知识库" }], has_more: false }),
    get_space: () => ({ space: { space_id: "personal", name: "我的文档库" } }),
    get_node: params => ({ node: { space_id: "123", node_token: params.token, title: "资料", node_type: "origin" } }),
    authorize_start: () => ({ verification_url: "https://accounts.feishu.cn/verify" }),
    state: () => ({ job: store.job || null, running: false, target: store.target }),
    remember_target: message => { store.target = structuredClone(message.target); return store.target; },
    ...overrides
  };
  const location = new URL(`chrome-extension://abcdefghijklmnopabcdefghijklmnop/feishu-save.html?source=https://my.feishu.cn/docx/Source&requestId=${store.requestId || requestId}${store.job ? "&jobId=" + store.job.id : ""}`);
  const context = {
    document: { getElementById: el, createElement: () => new Element() },
    FeishuWikiClip: clipApi, ConnectorOnboarding: onboarding, URL, URLSearchParams, Map, Set, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    location, history: { replaceState(_state, _unused, url) { location.href = url; } }, crypto: require("node:crypto").webcrypto, setInterval() {},
    setTimeout(callback, delay) { delays.push(delay); callback(); },
    chrome: { runtime: { id: environment.extensionId ?? "abcdefghijklmnopabcdefghijklmnop", sendMessage(message, callback) {
      messages.push(message);
      if (message.operation) calls.push(message.operation);
      Promise.resolve().then(() => message.action !== "native" ? handlers[message.action](message)
        : handlers[message.operation](message.params)).then(data => callback({ ok: true, data }),
        error => callback({ ok: false, error: error.message, code: error.code, retryable: error.retryable, uncertain: error.uncertain }));
    } }, tabs: { create: async info => opened.push(info.url) } },
    window: { confirm: () => true }, navigator: { platform: "MacIntel", ...environment.navigator, clipboard: { writeText: async value => copied.push(value) } }
  };
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  return { el, calls, messages, handlers, opened, delays, copied, context, store, click: async id => { await el(id).events.click(); },
    input: (id, value) => { el(id).value = value; el(id).events.input(); } };
}
const failure = (code, message) => () => { throw Object.assign(new Error(message), { code }); };

test("Mac setup copies a bounded Agent prompt for the current ID and selected browser", async () => {
  const p = await page({ status: failure("NATIVE_UNAVAILABLE", "missing") });
  assert.equal(p.el("connectorBrowser").value, "chrome");
  await p.click("copyAgentPrompt");
  assert.equal(p.copied[0], onboarding.buildAgentPrompt({ id: "abcdefghijklmnopabcdefghijklmnop", browser: "chrome" }));
  p.el("connectorBrowser").value = "dia";
  p.el("connectorBrowser").events.change();
  await p.click("copyAgentPrompt");
  assert.match(p.copied[1], /当前浏览器：dia/);
  assert.match(p.copied[1], /--browser dia/);
  assert.equal(p.el("sourceInstall").hidden, false);
  await p.click("copyInstall");
  assert.match(p.copied[2], /--browser dia$/);
  assert.deepEqual(p.calls, ["status"]);
});

test("Mac Edge prompt uses the current extension ID rather than another installed copy", async () => {
  const p = await page({ status: failure("NATIVE_UNAVAILABLE", "missing") }, {}, {
    extensionId: "b".repeat(32), navigator: { userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0 Edg/140.0", platform: "MacIntel" }
  });
  await p.click("copyAgentPrompt");
  assert.equal(p.copied[0], onboarding.buildAgentPrompt({ id: "b".repeat(32), browser: "edge" }));
  assert.doesNotMatch(p.copied[0], /abcdefghijklmnop/);
});

test("Windows Edge shows the support boundary without an unusable prompt or Mac command", async () => {
  const p = await page({ status: failure("NATIVE_UNAVAILABLE", "missing") }, {}, {
    extensionId: "b".repeat(32), navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0", platform: "Win32" }
  });
  assert.equal(p.el("connectorBrowser").value, "edge");
  assert.match(p.el("connectorPlatform").textContent, /本地导出可用；保存到飞书暂仅支持 Mac/);
  assert.doesNotMatch(p.el("connectionStatus").textContent, /复制|安装向导|安装包/);
  assert.equal(p.el("connectorInstallSteps").hidden, true);
  assert.equal(p.el("copyAgentPrompt").disabled, true);
  assert.equal(p.el("sourceInstall").hidden, true);
  assert.equal(p.el("installCommand").textContent, "");
  await p.click("copyInstall");
  await p.click("copyAgentPrompt");
  assert.deepEqual(p.copied, []);
});

test("invalid extension ID cannot be copied into an Agent prompt", async () => {
  const p = await page({}, {}, { extensionId: "invalid;bad-id" });
  assert.equal(p.el("copyAgentPrompt").disabled, true);
  assert.equal(p.el("sourceInstall").hidden, true);
  assert.match(p.el("connectorInstallFeedback").textContent, /无法识别插件/);
  await p.click("copyAgentPrompt");
  assert.deepEqual(p.copied, []);
});

test("a clipboard failure opens the prompt for manual copying", async () => {
  const p = await page({ status: failure("NATIVE_UNAVAILABLE", "missing") });
  p.context.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  await p.click("copyAgentPrompt");
  assert.equal(p.el("agentPromptPreview").open, true);
  assert.match(p.el("copyAgentPrompt").textContent, /下方提示词后手动复制/);
});

test("missing Feishu application guides users to the Agent prompt without starting login", async () => {
  const p = await page({ status: failure("NOT_CONFIGURED", "run init") });
  assert.match(p.el("connectionStatus").textContent, /复制下方安装提示词/);
  assert.doesNotMatch(p.el("connectionStatus").textContent, /run init|安装包/);
  assert.equal(p.el("connect").hidden, true);
  assert.deepEqual(p.calls, ["status"]);
});

test("opening and rechecking reuse login and saved target without starting authorization", async () => {
  const p = await page();
  assert.equal(p.el("connectionPanel").dataset.state, "connected");
  assert.equal(p.el("connect").hidden, true);
  assert.equal(p.el("setup").hidden, true);
  assert.equal(p.el("save").disabled, false);
  assert.match(p.el("targetSummary").textContent, /资料/);
  await p.click("refreshConnection");
  assert.equal(p.el("connectionPanel").dataset.state, "connected");
  assert.equal(p.calls.includes("authorize_start"), false);
  assert.equal(p.messages.some(message => message.action === "remember_target"), false);
  assert.equal(p.calls.includes("list_spaces"), false);
  assert.deepEqual(p.opened, []);
});

test("other webpages can save to the remembered parent without another login or location confirmation", async () => {
  const p = await page();
  p.input("sourceUrl", "https://scys.com/articleDetail/xq_topic/55521155258121884");
  assert.equal(p.el("save").disabled, false);
  assert.equal(p.el("connect").hidden, true);
  assert.equal(p.el("resolveTarget").disabled, true);
  assert.equal(p.calls.includes("authorize_start"), false);
});

test("missing connector explains one-time setup and never offers a futile login button", async () => {
  const p = await page({ status: failure("NATIVE_UNAVAILABLE", "安装一次连接程序") });
  assert.equal(p.el("connectionPanel").dataset.state, "setup");
  assert.equal(p.el("setup").open, true);
  assert.equal(p.el("connect").hidden, true);
  assert.equal(p.el("save").disabled, true);
  assert.deepEqual(p.calls, ["status"]);
});

test("only an actual authorization failure shows login, without auto-opening OAuth", async () => {
  for (const code of ["AUTH_REQUIRED", "MISSING_SCOPE"]) {
    const p = await page({ get_node: failure(code, "需要授权") });
    assert.equal(p.el("connectionPanel").dataset.state, "needs_auth");
    assert.equal(p.el("connect").hidden, false);
    assert.equal(p.el("setup").hidden, true);
    assert.equal(p.calls.includes("authorize_start"), false);
    await p.click("connect");
    assert.equal(p.calls.filter(x => x === "authorize_start").length, 1);
    assert.deepEqual(p.opened, ["https://accounts.feishu.cn/verify"]);
  }
});

test("a network or permission error is not misdiagnosed as expired login", async () => {
  for (const code of ["CLI_TIMEOUT", "PERMISSION_DENIED", "99991400"]) {
    const p = await page({ status: failure(code, "稍后重试") });
    assert.equal(p.el("connectionPanel").dataset.state, "error");
    assert.equal(p.el("connect").hidden, true);
    assert.equal(p.el("setup").hidden, true);
    assert.equal(p.calls.includes("authorize_start"), false);
  }
});

test("login completed in another page is reused even if the stale login button is clicked", async () => {
  const p = await page({ get_node: failure("AUTH_REQUIRED", "需要登录") });
  p.handlers.get_node = params => ({ node: { space_id: "123", node_token: params.token, title: "资料", node_type: "origin" } });
  await p.click("connect");
  assert.equal(p.el("connectionPanel").dataset.state, "connected");
  assert.equal(p.calls.includes("authorize_start"), false);
  assert.deepEqual(p.opened, []);
});

test("a confirmed location is remembered before clipping and restored on the next page", async () => {
  const store = {};
  const p = await page({}, store);
  p.input("targetUrl", "https://my.feishu.cn/wiki/Chosen?fromScene=spaceOverview");
  await p.click("resolveTarget");
  assert.equal(store.target.url, "https://my.feishu.cn/wiki/Chosen");
  assert.equal(p.messages.some(message => message.action === "start"), false);
  assert.equal(p.el("save").disabled, false);
  assert.equal(p.el("resolveTarget").disabled, true);
  const reopened = await page({}, store);
  assert.equal(reopened.el("targetUrl").value, store.target.url);
  assert.equal(reopened.el("save").disabled, false);
  assert.match(reopened.el("targetSummary").textContent, /保存到/);
});

test("invalid or inaccessible locations do not replace the last confirmed location", async () => {
  const p = await page();
  const prior = structuredClone(p.store.target);
  p.input("targetUrl", "https://example.com/wiki/Other");
  await p.click("resolveTarget");
  assert.deepEqual(p.store.target, prior);
  assert.equal(p.el("save").disabled, true);
  p.handlers.get_node = failure("PERMISSION_DENIED", "无法访问此位置");
  p.input("targetUrl", "https://my.feishu.cn/wiki/Other");
  await p.click("resolveTarget");
  assert.deepEqual(p.store.target, prior);
  assert.match(p.el("targetSummary").textContent, /无法访问/);
});

test("a stale location response cannot confirm or remember a link edited during validation", async () => {
  const p = await page();
  const prior = structuredClone(p.store.target);
  let finish;
  p.handlers.get_node = params => new Promise(resolve => { finish = () => resolve({ node: {
    space_id: "123", node_token: params.token, title: "旧响应", node_type: "origin" } }); });
  p.input("targetUrl", "https://my.feishu.cn/wiki/Slow");
  const pending = p.click("resolveTarget");
  await new Promise(setImmediate);
  // Even changing away and back to the same URL invalidates its old response.
  p.input("targetUrl", "https://my.feishu.cn/wiki/Other");
  p.input("targetUrl", "https://my.feishu.cn/wiki/Slow");
  finish();
  await pending;
  assert.deepEqual(p.store.target, prior);
  assert.equal(p.el("save").disabled, true);
  assert.equal(p.el("resolveTarget").disabled, false);
  assert.doesNotMatch(p.el("targetSummary").textContent, /旧响应/);
});

test("a local storage failure is shown instead of claiming the location was remembered", async () => {
  const p = await page();
  const prior = structuredClone(p.store.target);
  p.handlers.remember_target = failure("STORAGE_ERROR", "无法记住保存位置");
  p.input("targetUrl", "https://my.feishu.cn/wiki/Other");
  await p.click("resolveTarget");
  assert.deepEqual(p.store.target, prior);
  assert.equal(p.el("save").disabled, true);
  assert.match(p.el("targetSummary").textContent, /无法记住/);
});

test("restoring an old page cannot overwrite a location just selected in another page", async () => {
  const store = { target: { url: "https://my.feishu.cn/wiki/Old" } };
  let finish;
  await page({ get_node: params => new Promise(resolve => { finish = () => resolve({ node: {
    space_id: "123", node_token: params.token, title: "先前位置", node_type: "origin" } }); }) }, store);
  const newer = await page({}, store);
  newer.input("targetUrl", "https://my.feishu.cn/wiki/Latest");
  await newer.click("resolveTarget");
  finish();
  await new Promise(setImmediate);
  assert.equal(store.target.url, "https://my.feishu.cn/wiki/Latest");
});

test("an automatically recovering task shows its retry progress and never asks for a continue click or OAuth", async () => {
  const p = await page();
  const job = clipApi.createJob("https://my.feishu.cn/docx/Source", clipApi.targetFromNode({ space_id: "123", node_token: "Parent", title: "资料" }), "job-auto-retry");
  Object.assign(job, { requestId, stage: "importing", autoRun: true, retryable: true, retryCount: 3,
    nextRetryAt: Date.now() + 4000, failedStep: "import_step", errorCode: "CLI_TIMEOUT", error: "请求超时" });
  p.context.renderJob({ job, running: false });
  assert.match(p.el("jobStatus").textContent, /自动完成保存.*完成后会通知/);
  assert.doesNotMatch(p.el("jobStatus").textContent, /CLI_TIMEOUT|第 3|继续/);
  assert.match(p.el("jobDetailStatus").textContent, /第 3 \/ 5 次.*CLI_TIMEOUT/);
  assert.equal(p.el("jobDetails").open, false);
  assert.equal(p.el("jobStatus").className, "status status-loading");
  assert.equal(p.el("resume").hidden, true);
  assert.equal(p.calls.includes("authorize_start"), false);
  Object.assign(job, { autoRun: false, retryable: false, retryExhausted: true, retryCount: 5, nextRetryAt: 0 });
  p.context.renderJob({ job, running: false });
  assert.match(p.el("jobStatus").textContent, /连接多次重试后仍未恢复/);
  assert.match(p.el("jobDetailStatus").textContent, /已自动重试 5 次/);
  assert.equal(p.el("save").textContent, "重试保存");
  assert.equal(p.el("save").disabled, false);
  assert.equal(p.el("jobStatus").className, "status status-error");
  assert.equal(p.el("resume").hidden, false);
});

const busy = () => Object.assign(new Error("本机连接正在处理剪存，请稍后重试。"), { code: "BUSY", retryable: true });

test("opening the save page automatically waits through a busy host while restoring login and its default destination", async () => {
  const counts = {};
  const firstBusy = (operation, result) => params => {
    counts[operation] = (counts[operation] || 0) + 1;
    if (counts[operation] === 1) throw busy();
    return typeof result === "function" ? result(params) : result;
  };
  const p = await page({
    status: firstBusy("status", { available: true }),
    list_spaces: firstBusy("list_spaces", { items: [{ space_id: "123", name: "我的知识库" }], has_more: false }),
    get_node: firstBusy("get_node", params => ({ node: { space_id: "123", node_token: params.token, title: "资料", node_type: "origin" } })),
    get_space: firstBusy("get_space", { space: { space_id: "123", name: "我的知识库" } })
  });
  assert.deepEqual(p.delays, [1000, 1000, 1000]);
  assert.deepEqual(counts, { status: 2, get_node: 2, get_space: 2 });
  assert.equal(p.calls.includes("list_spaces"), false);
  assert.equal(p.el("connectionPanel").dataset.state, "connected");
  assert.equal(p.el("targetSummary").className, "status status-ready");
  assert.equal(p.el("targetUrl").value, "https://my.feishu.cn/wiki/Parent");
  assert.equal(p.el("save").disabled, false);
  assert.equal(p.calls.includes("authorize_start"), false);
  assert.deepEqual(p.opened, []);
});

test("read-only directory requests retry at 1, 2, and 4 seconds and then preserve the original failure", async () => {
  const p = await page();
  let calls = 0;
  p.handlers.list_nodes = () => { calls++; throw busy(); };
  await assert.rejects(vm.runInContext('native("list_nodes", {space_id: "123"})', p.context), error => error.code === "BUSY" && error.retryable === true);
  assert.equal(calls, 4);
  assert.deepEqual(p.delays, [1000, 2000, 4000]);
});

test("UI retries exclude authorization, writes, permission failures, and errors without an explicit safe-retry flag", async () => {
  const p = await page();
  for (const operation of ["authorize_start", "authorize_finish", "import_step", "move_doc", "stage_image"]) {
    let calls = 0;
    p.handlers[operation] = () => { calls++; throw busy(); };
    await assert.rejects(vm.runInContext(`native(${JSON.stringify(operation)}, {})`, p.context), error => error.code === "BUSY");
    assert.equal(calls, 1, operation);
  }
  for (const error of [Object.assign(busy(), { retryable: false }), Object.assign(busy(), { retryable: "true" }),
    Object.assign(busy(), { code: "AUTH_REQUIRED" }), Object.assign(busy(), { code: "MISSING_SCOPE" })]) {
    let calls = 0;
    p.handlers.status = () => { calls++; throw error; };
    await assert.rejects(vm.runInContext('native("status", {})', p.context), failure => failure.code === error.code);
    assert.equal(calls, 1);
  }
  assert.deepEqual(p.delays, []);
});


function uiJob(sourceUrl = "https://my.feishu.cn/docx/Source", id = "job-ui") {
  return { ...clipApi.createJob(sourceUrl, clipApi.targetFromNode({ space_id: "123", node_token: "Parent", title: "资料" }), id), requestId };
}

test("remembered setup leaves only article, destination and one save confirmation in the main path", async () => {
  const p = await page({ start: message => {
    const job = uiJob(message.sourceUrl);
    return { job: { ...job, stage: "importing", autoRun: true }, running: true };
  } });
  assert.equal(p.el("sourceSettings").open, false);
  assert.equal(p.el("destinationSettings").open, false);
  assert.equal(p.el("jobPanel").hidden, true);
  assert.equal(p.el("save").textContent, "保存到飞书");
  assert.equal(p.messages.find(message => message.action === "state").sourceUrl, "https://my.feishu.cn/docx/Source");
  await p.click("save");
  assert.equal(p.messages.filter(message => message.action === "start").length, 1);
  assert.equal(p.el("save").disabled, true);
  assert.equal(p.el("jobPanel").hidden, false);
  assert.match(p.el("jobStatus").textContent, /可以关闭此页.*完成后会通知/);
  assert.equal(p.el("resume").hidden, true);
  assert.equal(p.el("endTask").hidden, true);
});

test("another article's failed or running task is never shown and does not disable this save", async () => {
  const other = uiJob("https://scys.com/articleDetail/xq_topic/old", "old-job");
  for (const running of [false, true]) {
    const p = await page({ state: () => ({ job: { ...other, stage: "importing", autoRun: running,
      errorCode: "CONTENT_MISMATCH", error: "上一篇文章失败" }, running, target: { url: "https://my.feishu.cn/wiki/Parent" } }) });
    assert.equal(p.el("jobPanel").hidden, true);
    assert.equal(p.el("jobStatus").textContent, "");
    assert.equal(p.el("save").disabled, false);
    assert.equal(p.el("sourceTitle").textContent, "https://my.feishu.cn/docx/Source");
  }
});

test("editing the article hides the old result immediately and asks for the new article's state", async () => {
  const p = await page();
  p.context.renderJob({ job: { ...uiJob(), stage: "complete", resultUrl: "https://my.feishu.cn/wiki/Saved" }, running: false });
  assert.equal(p.el("jobPanel").hidden, false);
  assert.equal(p.el("save").hidden, true);
  assert.equal(p.el("saveForm").open, false);
  assert.equal(p.el("saveFormSummary").hidden, false);
  // Polling the same completed job must not close a user-reopened source form.
  p.el("saveForm").open = true;
  p.context.renderJob({ job: { ...uiJob(), stage: "complete", resultUrl: "https://my.feishu.cn/wiki/Saved" }, running: false });
  assert.equal(p.el("saveForm").open, true);
  p.input("sourceUrl", "https://scys.com/articleDetail/xq_topic/new");
  assert.equal(p.el("jobPanel").hidden, true);
  assert.equal(p.el("resultLink").hidden, true);
  assert.equal(p.el("save").disabled, false);
  assert.equal(p.el("save").hidden, false);
  assert.equal(p.el("saveForm").open, true);
  assert.equal(p.el("saveFormSummary").hidden, true);
  await new Promise(setImmediate);
  assert.equal(p.messages.filter(message => message.action === "state").at(-1).sourceUrl, "https://scys.com/articleDetail/xq_topic/new");
});

test("a queued article confirms background saving without asking the user to finish a different article", async () => {
  const p = await page();
  p.context.renderJob({ job: { ...uiJob(), autoRun: true }, running: true, queued: true, queuePosition: 2 });
  assert.match(p.el("jobStatus").textContent, /保存队列.*第 2 位.*完成后会通知/);
  assert.equal(p.el("save").textContent, "已加入保存队列");
  assert.equal(p.el("resume").hidden, true);
  assert.equal(p.el("endTask").hidden, true);
});

test("explicit retry and stop target the displayed job, never whichever job ran last", async () => {
  const job = { ...uiJob(), stage: "importing", error: "新建结果待核对", errorCode: "CREATE_UNCERTAIN", autoRun: false };
  const p = await page({ resume: () => ({ job: { ...job, autoRun: true }, running: true }),
    end: () => ({ job: { ...job, stage: "abandoned" }, running: false }) });
  p.context.renderJob({ job, running: false });
  assert.equal(p.el("save").textContent, "重新保存到飞书");
  assert.doesNotMatch(p.el("jobStatus").textContent, /CREATE_UNCERTAIN/);
  await p.click("save");
  assert.equal(p.messages.filter(message => message.action === "resume").at(-1).jobId, job.id);
  assert.equal(p.messages.filter(message => message.action === "resume").at(-1).restartCreation, true);
  assert.equal(p.messages.some(message => message.action === "start"), false);
  p.context.renderJob({ job, running: false });
  await p.click("endTask");
  assert.equal(p.messages.filter(message => message.action === "end").at(-1).jobId, job.id);
});


test("the normal saved destination path verifies the target without listing every wiki", async () => {
  const p = await page({}, { target: { url: "https://my.feishu.cn/wiki/Parent", spaceId: "123", spaceName: "我的知识库" } });
  assert.deepEqual(p.calls, ["status", "get_node"]);
  assert.equal(p.el("save").disabled, false);
  assert.match(p.el("targetSummary").textContent, /我的知识库/);
  p.el("locationPicker").open = true;
  await p.el("locationPicker").events.toggle();
  await new Promise(setImmediate);
  assert.equal(p.calls.includes("list_spaces"), true);
});


test("the main button opens a completed result without another create request or scrolling for the link", async () => {
  const p = await page();
  p.context.renderJob({ job: { ...uiJob(), stage: "complete", resultUrl: "https://my.feishu.cn/wiki/Saved" }, running: false });
  assert.equal(p.el("save").disabled, false);
  assert.equal(p.el("save").textContent, "在飞书中打开");
  await p.click("save");
  assert.deepEqual(p.opened, ["https://my.feishu.cn/wiki/Saved"]);
  assert.equal(p.messages.some(message => ["start", "resume"].includes(message.action)), false);
});


test("changing the destination hides a result saved elsewhere and restores the save action", async () => {
  const p = await page();
  p.context.renderJob({ job: { ...uiJob(), stage: "complete", resultUrl: "https://my.feishu.cn/wiki/Saved" }, running: false });
  p.input("targetUrl", "https://my.feishu.cn/wiki/OtherParent");
  await p.click("resolveTarget");
  assert.equal(p.el("jobPanel").hidden, true);
  assert.equal(p.el("save").textContent, "保存到飞书");
  assert.equal(p.el("save").disabled, false);
});


test("an explicit re-save is the only user step for an uncertain old creation and reuses captured content", async () => {
  for (const code of ["CREATE_UNCERTAIN", "CREATE_RECOVERY_UNAVAILABLE"]) {
    const job = { ...uiJob(), stage: "importing", error: "旧保存没有收到创建结果", errorCode: code, autoRun: false };
    const p = await page({ resume: () => ({ job: { ...job, autoRun: true }, running: true }) });
    p.context.window.confirm = () => { throw new Error("Re-save must not add a confirmation dialog"); };
    p.context.renderJob({ job, running: false });
    assert.equal(p.el("save").textContent, "重新保存到飞书");
    assert.equal(p.el("resume").textContent, "重新保存到飞书");
    assert.match(p.el("saveHint").textContent, /点击重新保存.*图文会复用/);
    assert.doesNotMatch(p.el("saveHint").textContent, /会在后台完成/);
    assert.doesNotMatch(p.el("jobStatus").textContent, /核对|CREATE_/);
    await p.click("save");
    const messages = p.messages.filter(message => message.action === "resume");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].jobId, job.id);
    assert.equal(messages[0].restartCreation, true);
    assert.equal(p.el("resume").hidden, true);
    assert.equal(p.el("endTask").hidden, true);
  }
});

test("detail re-save uses the same explicit restart while ordinary retries never replace a creation", async () => {
  const p = await page({ resume: message => ({ job: { ...uiJob(), stage: "importing", autoRun: true }, running: true }) });
  p.context.renderJob({ job: { ...uiJob(), stage: "importing", error: "创建未知", errorCode: "CREATE_UNCERTAIN" }, running: false });
  await p.click("resume");
  assert.equal(p.messages.filter(message => message.action === "resume").at(-1).restartCreation, true);
  p.context.renderJob({ job: { ...uiJob(), stage: "move_failed", error: "迁入失败", errorCode: "MOVE_FAILED" }, running: false });
  await p.click("save");
  assert.equal(p.messages.filter(message => message.action === "resume").at(-1).restartCreation, undefined);
});

test("a new request for the same article shares only the destination, never the previous job", async () => {
  for (const stage of ["complete", "importing", "moving"]) {
    const prior = { ...uiJob(), requestId: "22222222-2222-4222-8222-222222222222", stage, error: stage === "moving" ? "旧迁入断线" : "" };
    const p = await page({ state: () => ({ job: prior, target: { url: "https://my.feishu.cn/wiki/Parent" }, running: true }),
      start: message => ({ job: { ...uiJob(message.sourceUrl), requestId: message.requestId, autoRun: true }, running: true }) });
    assert.equal(p.el("jobPanel").hidden, true);
    assert.equal(p.el("save").textContent, "保存到飞书");
    assert.equal(p.el("save").disabled, false);
    assert.match(p.el("targetSummary").textContent, /资料/);
    await p.click("save");
    const started = p.messages.filter(m => m.action === "start");
    assert.equal(started.length, 1);
    assert.equal(started[0].requestId, requestId);
    assert.equal(p.messages.some(m => m.action === "resume"), false);
  }
});

test("the request stays in the page URL on reload and changes when the user chooses new content", async () => {
  const p = await page();
  assert.equal(p.context.location.search.includes(requestId), true);
  p.input("sourceUrl", "https://scys.com/articleDetail/xq_topic/22255482858245111");
  await new Promise(setImmediate);
  const updated = new URL(p.context.location.href);
  assert.notEqual(updated.searchParams.get("requestId"), requestId);
  assert.equal(updated.searchParams.get("source"), p.el("sourceUrl").value);
  assert.equal(p.messages.filter(m => m.action === "state").at(-1).requestId, updated.searchParams.get("requestId"));
});

test("a migration reconnect stays automatic without a failure or manual retry button", async () => {
  const p = await page();
  p.context.renderJob({ job: { ...uiJob(), stage: "moving", autoRun: true, moveRecovering: true, nextRunAt: Date.now() + 30000 }, running: true });
  assert.equal(p.el("jobHeading").textContent, "正在后台保存");
  assert.match(p.el("jobStatus").textContent, /自动完成保存/);
  assert.equal(p.el("resume").hidden, true);
  assert.equal(p.el("save").disabled, true);
});

test("choosing a different parent creates a new request even when the first start response was lost", async () => {
  const p = await page({ start: () => { throw new Error("响应丢失"); } });
  await p.click("save");
  const first = p.messages.find(m => m.action === "start");
  vm.runInContext('ancestors = [{ node_token: "OtherParent", title: "新目录" }]', p.context);
  await p.click("useParent");
  await p.click("save");
  const second = p.messages.filter(m => m.action === "start").at(-1);
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.targetUrl, "https://my.feishu.cn/wiki/OtherParent");
});

test("a late poll from an old request cannot clear the newer request panel", async () => {
  const p = await page();
  let release;
  p.handlers.state = () => new Promise(resolve => { release = resolve; });
  const pending = p.context.refreshState();
  await new Promise(setImmediate);
  p.context.newRequest();
  const newId = new URL(p.context.location.href).searchParams.get("requestId");
  p.context.renderJob({ job: { ...uiJob(), requestId: newId, stage: "moving", autoRun: true }, running: true });
  release({ job: { ...uiJob(), stage: "complete" }, running: false });
  await pending;
  assert.equal(p.el("jobPanel").hidden, false);
  assert.equal(p.el("jobHeading").textContent, "正在后台保存");
});


test("content and capture failures expose their concrete reason in the main status without requiring details", async () => {
  for (const [errorCode, error] of [
    ["UNSUPPORTED_CONTENT", "正文包含暂不能完整保存的内容（交互画板），未省略该内容。"],
    ["INVALID_CONTENT", "网页表格行列不完整，未省略单元格。"],
    ["PAGE_CAPTURE_FAILED", "网站暂不允许读取该图片，请保持原网页打开并稍后重试。"]
  ]) {
    const p = await page();
    p.context.renderJob({ job: { ...uiJob(), stage: "ready", autoRun: false, errorCode, error, failedStep: "capture_web" }, running: false });
    assert.equal(p.el("jobPanel").hidden, false);
    assert.equal(p.el("jobStatus").className, "status status-error");
    assert.equal(p.el("jobStatus").textContent, error);
    assert.equal(p.el("jobDetails").open, false);
    assert.doesNotMatch(p.el("jobStatus").textContent, /已有内容|进度已保留|暂存文档|已创建/);
    assert.doesNotMatch(p.el("jobStatus").textContent, new RegExp(errorCode));
    assert.match(p.el("jobDetailStatus").textContent, new RegExp(errorCode));
    assert.equal(p.el("save").textContent, "重新读取并保存");
    assert.equal(p.el("resume").textContent, "重新读取并保存");
    assert.equal(p.el("copyLink").hidden, true);
    assert.equal(p.el("save").disabled, false);
    if (errorCode === "UNSUPPORTED_CONTENT") assert.match(p.el("saveHint").textContent, /需要插件支持/);
    else assert.match(p.el("saveHint").textContent, /读取成功后才会创建文档/);
  }
});

test("a main content error is rendered as literal text and cannot inject markup", async () => {
  const p = await page();
  const message = '无法读取嵌入内容 <img src=x onerror="alert(1)">';
  p.el("jobStatus").innerHTML = "unchanged";
  p.context.renderJob({ job: { ...uiJob(), errorCode: "INVALID_CONTENT", error: message, autoRun: false }, running: false });
  assert.equal(p.el("jobStatus").textContent, message);
  assert.equal(p.el("jobStatus").innerHTML, "unchanged");
  assert.equal(p.opened.length, 0);
});

test("a failed first read never claims a document or captured content already exists", async () => {
  for (const patch of [{ error: "读取失败", errorCode: "UNEXPECTED_FAILURE" },
    { error: "读取超时", errorCode: "CLI_TIMEOUT", retryExhausted: true },
    { stage: "abandoned", previousStage: "ready", error: "" }]) {
    const p = await page();
    p.context.renderJob({ job: { ...uiJob(), stage: "ready", autoRun: false, copy: null, ...patch }, running: false });
    assert.match(p.el("jobStatus").textContent, /尚未创建飞书文档/);
    assert.doesNotMatch(p.el("jobStatus").textContent, /已有内容|已有副本|现有文档|进度已保留/);
    assert.doesNotMatch(p.el("saveHint").textContent, /已有进度|图文会复用/);
    assert.equal(p.el("copyLink").hidden, true);
  }
});

test("image collection failures show the actual image problem and retry the same saved request", async () => {
  const job = { ...uiJob(), stage: "collecting", autoRun: false, sourceToken: "WebRoot",
    errorCode: "IMAGE_INVALID", error: "下载结果不是所声明的图片，未创建文档。", failedStep: "stage_image" };
  const p = await page({ resume: () => ({ job: { ...job, autoRun: true, error: "" }, running: true }) });
  p.context.window.confirm = () => { throw new Error("A content retry must not require an extra confirmation"); };
  p.context.renderJob({ job, running: false });
  assert.equal(p.el("jobStatus").textContent, job.error);
  assert.equal(p.el("save").textContent, "重试保存图片");
  assert.match(p.el("saveHint").textContent, /图片尚未读取完整/);
  assert.doesNotMatch(p.el("jobStatus").textContent, /IMAGE_INVALID/);
  await p.click("save");
  const resume = p.messages.filter(message => message.action === "resume");
  assert.equal(resume.length, 1);
  assert.equal(resume[0].jobId, job.id);
  assert.equal(resume[0].restartCreation, undefined);
  assert.equal(p.messages.some(message => message.action === "start"), false);
});

test("automatically recovering content and migration stay in a normal background status", async () => {
  for (const patch of [{ stage: "collecting", retryable: true, errorCode: "PAGE_CAPTURE_FAILED", error: "临时读取失败" },
    { stage: "moving", moveRecovering: true, errorCode: "NATIVE_UNAVAILABLE", error: "临时连接失败", copy: { token: "Created" } }]) {
    const p = await page();
    p.context.renderJob({ job: { ...uiJob(), autoRun: true, ...patch }, running: true });
    assert.equal(p.el("jobStatus").className, "status status-loading");
    assert.match(p.el("jobStatus").textContent, /自动完成保存/);
    assert.doesNotMatch(p.el("jobStatus").textContent, /临时读取失败|临时连接失败|PAGE_CAPTURE_FAILED|NATIVE_UNAVAILABLE/);
    assert.equal(p.el("resume").hidden, true);
    assert.equal(p.el("save").disabled, true);
  }
});

test("permission and connector diagnostics keep their code out of the main status", async () => {
  for (const errorCode of ["AUTH_REQUIRED", "MISSING_SCOPE", "NATIVE_UNAVAILABLE"]) {
    const p = await page();
    p.context.renderJob({ job: { ...uiJob(), autoRun: false, errorCode, error: "连接不可用", failedStep: "capture_web" }, running: false });
    assert.doesNotMatch(p.el("jobStatus").textContent, new RegExp(errorCode));
    assert.match(p.el("jobDetailStatus").textContent, new RegExp(errorCode));
  }
});
