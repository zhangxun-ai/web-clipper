"use strict";

const clipApi = globalThis.FeishuWikiClip;
const $ = (id) => document.getElementById(id);
let selectedTarget = null;
let latestState = { job: null, running: false };
let spaceMap = new Map();
let ancestors = [];
let nodePageToken = "";
let pickerGeneration = 0;
let uiBusy = false;
let polling = false;
let connectionPhase = "checking";
let targetGeneration = 0;
let targetNeedsRemember = false;
let sourceTitle = "";
let sourceTitleUrl = "";
let rememberedTarget = null;
// A new save page is a new user request, even for the same article. Reloading
// this page or following its failure notification stays on the exact request.
const route = new URL(location.href);
let requestedJobId = route.searchParams.get("jobId") || "";
let activeRequestId = route.searchParams.get("requestId") || crypto.randomUUID();
route.searchParams.set("requestId", activeRequestId);
history.replaceState(null, "", route.href);

function newRequest() {
  activeRequestId = crypto.randomUUID();
  requestedJobId = "";
  const url = new URL(location.href);
  url.searchParams.set("requestId", activeRequestId);
  url.searchParams.delete("jobId");
  url.searchParams.set("source", $("sourceUrl").value);
  if (selectedTarget) url.searchParams.set("target", selectedTarget.url);
  history.replaceState(null, "", url.href);
  latestState = { job: null, running: false };
}

function matchesRequest(job) {
  return Boolean(job && (requestedJobId ? job.id === requestedJobId : job.requestId === activeRequestId));
}

const AUTH_ERRORS = new Set(["AUTH_REQUIRED", "MISSING_SCOPE", "AUTH_EXPIRED", "AUTH_INCOMPLETE"]);
const SETUP_ERRORS = new Set(["NATIVE_UNAVAILABLE", "CLI_UNAVAILABLE", "NOT_CONFIGURED"]);
const CREATION_RESTART_ERRORS = new Set(["CREATE_UNCERTAIN", "CREATE_RECOVERY_UNAVAILABLE"]);

function showConnection(phase, message) {
  connectionPhase = phase;
  $("connectionPanel").dataset.state = phase;
  $("connectionHeading").textContent = phase === "connected" ? "飞书已连接" : "连接飞书";
  $("connect").hidden = phase !== "needs_auth";
  $("connect").textContent = "登录飞书";
  $("setup").hidden = phase !== "setup";
  $("setup").open = phase === "setup";
  $("refreshConnection").textContent = phase === "connected" ? "刷新连接" : "重新检测";
  if (phase !== "authorizing") {
    $("authLink").hidden = true;
    $("finishAuth").hidden = true;
  }
  status("connectionStatus", message, phase === "connected" ? "ready" : ["setup", "error", "needs_auth"].includes(phase) ? "error" : "loading");
  $("connectionStatus").hidden = phase === "connected";
  updateSaveButton();
}

function connectionError(error) {
  showConnection(AUTH_ERRORS.has(error.code) ? "needs_auth" : SETUP_ERRORS.has(error.code) ? "setup" : "error", error.message);
}

function status(id, message, kind = "loading") {
  $(id).textContent = message;
  $(id).className = `status status-${kind}`;
}

function request(action, details = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "feishu-clip", action,
      ...(["state", "start"].includes(action) ? { requestId: activeRequestId, ...(action === "state" && requestedJobId ? { jobId: requestedJobId } : {}) } : {}), ...details }, (response) => {
      if (chrome.runtime.lastError) return reject(Object.assign(new Error("插件连接已中断，请刷新剪存页后重试。"), { code: "EXTENSION_RELOADED" }));
      if (!response?.ok) return reject(Object.assign(new Error(response?.error || "飞书操作失败。"),
        { code: response?.code, retryable: response?.retryable === true, uncertain: Boolean(response?.uncertain) }));
      resolve(response.data);
    });
  });
}

const READ_ONLY_NATIVE = new Set(["status", "list_spaces", "get_space", "list_nodes", "get_node"]);
const native = async (operation, params = {}) => {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try { return await request("native", { operation, params }); }
    catch (error) {
      // The importer may briefly hold the host lock while this page restores
      // login or lists destinations. Retry only explicitly safe read requests;
      // authorization and writes always retain their separate user/job flow.
      if (!READ_ONLY_NATIVE.has(operation) || error.retryable !== true || AUTH_ERRORS.has(error.code)
        || SETUP_ERRORS.has(error.code) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
};

function trustedLink(element, value) {
  try {
    const { url } = clipApi.parseDocumentUrl(value);
    element.href = url;
    element.hidden = false;
  } catch (_) {
    element.hidden = true;
    element.removeAttribute("href");
  }
}

async function withUi(action, errorTarget = "connectionStatus") {
  if (uiBusy) return;
  uiBusy = true;
  updateSaveButton();
  try { await action(); }
  catch (error) {
    if (AUTH_ERRORS.has(error.code) || SETUP_ERRORS.has(error.code) || connectionPhase === "authorizing") connectionError(error);
    else { $(errorTarget).hidden = false; status(errorTarget, error.message, "error"); }
  }
  finally { uiBusy = false; updateSaveButton(); }
}

function currentSourceUrl() {
  try { return clipApi.parseSourceUrl($("sourceUrl").value).url; } catch (_) { return ""; }
}

function currentJob() {
  const job = latestState.job;
  if (!matchesRequest(job) || job.source?.url !== currentSourceUrl()) return null;
  if (selectedTarget && job.target?.url !== selectedTarget.url) return null;
  return job;
}

function updateSourceTitle() {
  const source = currentSourceUrl();
  const job = currentJob();
  $("sourceTitle").textContent = job?.title || (source === sourceTitleUrl && sourceTitle) || source || "请添加要保存的文章";
}

const CONTENT_FAILURE_CODES = new Set(["UNSUPPORTED_CONTENT", "INVALID_CONTENT", "PAGE_CAPTURE_FAILED",
  "CAPTURE_UNAVAILABLE", "CAPTURE_INTERRUPTED", "CAPTURE_EMPTY", "PAGE_NOT_READY", "SOURCE_CHANGED",
  "IMPORT_TOO_LARGE", "IMAGE_FORBIDDEN", "IMAGE_CONFLICT", "IMAGE_OFFSET", "IMAGE_INVALID", "IMAGES_NOT_READY", "IMAGE_UPLOAD_UNCERTAIN"]);

function isContentFailure(job) {
  return CONTENT_FAILURE_CODES.has(job?.errorCode)
    || (!job?.errorCode && ["capture_web", "capture_image"].includes(job?.failedStep || job?.activeStep));
}

function preservedProgress(job) {
  if (job.copy?.token) return "已创建的文档和保存进度已保留。";
  if ((job.previousStage || job.stage) === "ready") return "尚未创建飞书文档。";
  return "本次保存记录已保留。";
}

function retryLabel(job) {
  if (CREATION_RESTART_ERRORS.has(job.errorCode)) return "重新保存到飞书";
  if (isContentFailure(job) && job.stage === "ready" && !job.copy?.token) return "重新读取并保存";
  if (isContentFailure(job) && job.stage === "collecting") return "重试保存图片";
  return "重试保存";
}

function retryHint(job) {
  if (CREATION_RESTART_ERRORS.has(job.errorCode)) return "点击重新保存即可继续，已读取的图文会复用。";
  if (job.errorCode === "UNSUPPORTED_CONTENT") return "当前内容需要插件支持后才能完整保存。";
  if (isContentFailure(job) && job.stage === "ready" && !job.copy?.token) return "重新读取会使用当前网页内容；正文读取成功后才会创建文档。";
  if (isContentFailure(job) && job.stage === "collecting") return "图片尚未读取完整；重试会继续读取图片。";
  return `${preservedProgress(job)}重试会继续这次保存。`;
}

function updateSaveButton() {
  const job = currentJob();
  const source = currentSourceUrl();
  const alreadySaved = job?.stage === "complete";
  const active = Boolean(job && (latestState.running || job.autoRun));
  const paused = Boolean(job && !active && !["complete", "abandoned"].includes(job.stage));
  const form = $("saveForm");
  if (form.dataset.complete !== String(alreadySaved)) {
    form.open = !alreadySaved;
    form.dataset.complete = String(alreadySaved);
  }
  $("saveFormSummary").hidden = !alreadySaved;
  $("save").hidden = alreadySaved;
  $("save").disabled = connectionPhase !== "connected" || uiBusy || active || !source || !selectedTarget;
  $("save").textContent = alreadySaved ? "在飞书中打开" : active ? (latestState.queued ? "已加入保存队列" : "正在后台保存…")
    : paused ? retryLabel(job) : "保存到飞书";
  $("saveHint").hidden = alreadySaved;
  $("saveHint").textContent = alreadySaved ? ""
    : paused ? retryHint(job)
    : "读取图文时请保持原网页打开，完成后会通知你。";
  updateSourceTitle();
}

function failureMessage(job) {
  if (CREATION_RESTART_ERRORS.has(job.errorCode)) return "上次保存没有完成。点击“重新保存到飞书”，插件会复用已读取的正文和图片继续保存。";
  if (AUTH_ERRORS.has(job.errorCode)) return "飞书授权需要更新。重新连接后，可继续完成这次保存。";
  // Converter and capture errors already describe the affected content. Keep
  // that concrete reason in the main status, using textContent at the caller.
  // Diagnostic codes remain in the expandable details below.
  if (isContentFailure(job)) return String(job.error || "网页内容尚未读取完整，请重新读取。");
  if (["CONTENT_MISMATCH", "IMPORT_VERIFICATION_FAILED"].includes(job.errorCode)) return `这篇文章尚未完整保存。${preservedProgress(job)}`;
  if (job.retryExhausted) return `连接多次重试后仍未恢复。${preservedProgress(job)}`;
  if (job.stage === "move_failed" && job.copy?.token) return "文章已写入飞书，但暂未保存到所选位置。重试会使用已有文档。";
  return `暂未保存成功。${preservedProgress(job)}详细原因见处理详情。`;
}

function renderJob(state) {
  // State responses may arrive after the article field was edited, or from an
  // older extension worker. Never show another article's result in this page.
  const candidate = state.job;
  const job = matchesRequest(candidate) && candidate.source?.url === currentSourceUrl()
    && (!selectedTarget || candidate.target?.url === selectedTarget.url) ? candidate : null;
  latestState = { ...state, job, running: Boolean(job && state.running), queued: Boolean(job && state.queued) };
  $("jobPanel").hidden = !job;
  if (!job) {
    $("jobTitle").textContent = "";
    $("jobStatus").textContent = "";
    $("resultLink").hidden = true;
    $("copyLink").hidden = true;
    $("resume").hidden = true;
    $("endTask").hidden = true;
    $("jobDetails").open = false;
    updateSaveButton();
    return;
  }
  $("jobTitle").textContent = `${job.title || job.source.url} → ${job.target.spaceName ? `${job.target.spaceName} / ` : ""}${job.target.title}`;
  const descriptions = {
    ready: "正在读取原文结构并确认目标位置…", copying: "正在恢复已有的副本任务…",
    collecting: `正在保存原文图片 ${job.progress?.completed || 0} / ${job.counts?.images || 0}…`,
    importing: `正在${({ content_prepared: "准备新建文档", content_recovering: "自动核对保存结果", content_titling: "恢复文章标题", content_appending: "写入正文", content_images: "上传图片", content_bookmarks: "还原链接卡片", content_links: "连接文内章节", content_verifying: "核对正文与图片", content_ready: "完成内容核对" })[job.progress?.phase] || "写入并核对文档"} ${job.progress?.completed || 0} / ${job.progress?.total || 0}…`,
    copied: "已创建独立副本，准备移入知识库…", moving: "正在将副本移入所选父页面…",
    pending: "飞书正在处理迁入任务，将自动查询并核对保存位置…",
    verifying: "正在核对副本及其保存位置…", complete: "已核对正文、图片及保存位置。",
    move_failed: `迁入失败。${preservedProgress(job)}`, abandoned: `已停止处理。${preservedProgress(job)}`
  };
  const autoRetry = job.autoRun && job.retryable;
  const retrySeconds = Math.max(0, Math.ceil(((job.nextRetryAt || 0) - Date.now()) / 1000));
  let detail = job.error || descriptions[job.stage] || "等待处理。";
  if (job.moveRecovering && job.autoRun) detail = "文章已写入，正在自动完成知识库保存。连接恢复后会继续，无需手动重试。";
  else if (autoRetry) detail = `正在自动恢复（第 ${job.retryCount || 1} / 5 次，${retrySeconds ? `${retrySeconds} 秒后重试` : "正在重试"}）。${detail}`;
  else if (job.retryExhausted) detail = `已自动重试 5 次。${detail}`;
  if (job.errorCode && job.error) detail += `（${job.errorCode}）`;
  $("jobDetailStatus").textContent = detail;
  const completed = job.stage === "complete";
  const abandoned = job.stage === "abandoned";
  const paused = !completed && !abandoned && !state.running && !job.autoRun;
  $("jobHeading").textContent = completed ? "已保存到飞书" : abandoned ? "已停止保存" : paused ? "这篇文章暂未保存完成" : "正在后台保存";
  const message = completed ? "保存成功，已核对图文与位置。" : abandoned ? `已停止保存。${preservedProgress(job)}` : state.queued
    ? `已加入保存队列${state.queuePosition ? `，排在第 ${state.queuePosition} 位` : ""}。可以关闭此页，完成后会通知你。`
    : (autoRetry || job.moveRecovering && job.autoRun) ? "正在自动完成保存。可以关闭此页，完成后会通知你。"
    : paused ? failureMessage(job) : "正文和图片正在保存。可以关闭此页，完成后会通知你。";
  status("jobStatus", message, paused ? "error" : completed ? "ready" : "loading");
  const stages = { ready: 0, collecting: 0, importing: 1, copying: 1, copied: 2, moving: 2, pending: 2, move_failed: 2, verifying: 3, complete: 4, abandoned: -1 };
  Array.from($("steps").children).forEach((item, index) => {
    item.dataset.active = String(index === stages[job.stage]);
    item.dataset.done = String(index < stages[job.stage]);
  });
  $("resume").hidden = !paused;
  $("endTask").hidden = !paused;
  $("resume").textContent = retryLabel(job);
  trustedLink($("resultLink"), completed ? job.resultUrl : "");
  trustedLink($("copyLink"), job.copy?.url);
  if (completed) $("copyLink").hidden = true;
  updateSaveButton();
}

async function refreshState() {
  if (polling) return;
  polling = true;
  const sourceUrl = currentSourceUrl();
  const requestIdentity = `${activeRequestId}:${requestedJobId}`;
  try {
    const state = await request("state", { sourceUrl, ...(selectedTarget ? { targetUrl: selectedTarget.url } : {}) });
    if (currentSourceUrl() === sourceUrl && requestIdentity === `${activeRequestId}:${requestedJobId}`) renderJob(state);
  } finally { polling = false; }
}

async function confirmTarget({ remember = true } = {}) {
  const generation = ++targetGeneration;
  selectedTarget = null;
  $("resolveTarget").textContent = "使用此位置";
  $("resolveTarget").disabled = false;
  updateSaveButton();
  try {
    const parsed = clipApi.parseDocumentUrl($("targetUrl").value, true);
    const { node } = await native("get_node", { token: parsed.token });
    // Do not let a delayed response confirm a URL that the user has since edited.
    if (generation !== targetGeneration || clipApi.parseDocumentUrl($("targetUrl").value, true).url !== parsed.url) return;
    let spaceName = rememberedTarget?.spaceId === String(node.space_id) ? rememberedTarget.spaceName || "" : "";
    if (!spaceName) {
      try { const result = await native("get_space", { space_id: String(node.space_id) }); spaceName = result.space?.name || ""; }
      catch (_) { /* The node already contains the authoritative space id. */ }
    }
    if (generation !== targetGeneration || clipApi.parseDocumentUrl($("targetUrl").value, true).url !== parsed.url) return;
    const target = clipApi.targetFromNode(node, parsed.origin, spaceName);
    // Remember a confirmed choice even when no clip is started. An unfinished
    // job keeps its own target and must not replace this preference on resume.
    const remembered = remember ? await request("remember_target", { target }) : target;
    if (generation !== targetGeneration) return;
    if (latestState.job && latestState.job.target?.url !== remembered.url) newRequest();
    selectedTarget = remembered;
    rememberedTarget = remembered;
    const url = new URL(location.href);
    url.searchParams.set("target", selectedTarget.url);
    history.replaceState(null, "", url.href);
    targetNeedsRemember = false;
    $("targetUrl").value = selectedTarget.url;
    $("resolveTarget").textContent = "已设为默认位置";
    $("resolveTarget").disabled = true;
    status("targetSummary", `保存到：${spaceName ? `${spaceName} / ` : ""}${selectedTarget.title}`, "ready");
    $("destinationSettings").open = false;
    $("destinationSummary").textContent = "更改保存位置";
    renderJob(latestState);
  } catch (error) {
    if (generation !== targetGeneration) return;
    status("targetSummary", error.message, "error");
    $("destinationSettings").open = true;
    if (AUTH_ERRORS.has(error.code) || SETUP_ERRORS.has(error.code)) connectionError(error);
  }
  updateSaveButton();
}

async function loadSpaces() {
  const items = [];
  const seen = new Set();
  let token = "";
  do {
    const data = await native("list_spaces", token ? { page_token: token } : {});
    items.push(...(data.items || []));
    if (!data.has_more) break;
    if (!data.page_token || seen.has(data.page_token) || seen.size >= 200) throw new Error("知识库列表分页异常，请使用父页面链接选择位置。");
    token = data.page_token;
    seen.add(token);
  } while (true);
  try {
    const { space } = await native("get_space", { space_id: "my_library" });
    if (space?.space_id) items.unshift(space);
  } catch (_) { /* Some organizations do not enable a personal library. */ }
  spaceMap = new Map(items.map((space) => [String(space.space_id), space]));
  const placeholder = new Option("请选择知识库", "");
  $("spaces").replaceChildren(placeholder, ...Array.from(spaceMap.values(), (space) => new Option(space.name || "未命名知识库", String(space.space_id))));
  ancestors = [];
  $("nodes").replaceChildren();
  $("parentLevel").disabled = true;
  $("useParent").disabled = true;
  $("moreNodes").hidden = true;
  showConnection("connected", "已有授权已恢复，可直接保存。");
}

async function loadNodes(append = false) {
  const generation = ++pickerGeneration;
  const spaceId = $("spaces").value;
  if (!spaceId) return;
  const parent = ancestors.at(-1);
  const data = await native("list_nodes", { space_id: spaceId,
    ...(parent ? { parent_node_token: parent.node_token } : {}), ...(append && nodePageToken ? { page_token: nodePageToken } : {}) });
  if (generation !== pickerGeneration || spaceId !== $("spaces").value) return;
  if (!append) $("nodes").replaceChildren();
  for (const node of data.items || []) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = `${node.title || "未命名页面"}${node.node_type === "shortcut" ? "（快捷方式）" : node.has_child ? "　›" : ""}`;
    button.disabled = node.node_type === "shortcut";
    button.addEventListener("click", () => withUi(async () => { ancestors.push(node); await loadNodes(); }));
    li.appendChild(button);
    $("nodes").appendChild(li);
  }
  nodePageToken = data.has_more && data.page_token ? data.page_token : "";
  $("moreNodes").hidden = !nodePageToken;
  $("parentLevel").disabled = !ancestors.length;
  $("useParent").disabled = !parent;
  $("pickerPath").textContent = [spaceMap.get(spaceId)?.name || "知识库", ...ancestors.map((node) => node.title || "未命名页面")].join(" / ");
}

async function checkConnection() {
  showConnection("checking", "正在恢复已有登录状态…");
  try {
    await native("status");
    if ($("targetUrl").value) {
      // The saved destination is sufficient for the normal save path. Listing
      // every wiki is only needed when the user actually opens the picker.
      showConnection("connected", "已有授权已恢复，正在确认保存位置…");
      await confirmTarget({ remember: targetNeedsRemember });
      if (connectionPhase === "connected") showConnection("connected", selectedTarget ? "已有授权已恢复，可直接保存。" : "飞书已连接，请选择可访问的保存位置。");
    } else {
      status("connectionStatus", "正在验证已有授权…");
      await loadSpaces();
    }
    return connectionPhase === "connected";
  } catch (error) {
    connectionError(error);
    return false;
  }
}

$("sourceUrl").addEventListener("input", () => {
  newRequest();
  renderJob(latestState);
  refreshState().catch(() => {});
});
$("targetUrl").addEventListener("input", () => {
  newRequest();
  targetGeneration += 1;
  targetNeedsRemember = true;
  selectedTarget = null;
  $("resolveTarget").textContent = "使用此位置";
  $("resolveTarget").disabled = false;
  status("targetSummary", "位置已修改，确认后将记为下次的默认位置。");
  updateSaveButton();
});
$("resolveTarget").addEventListener("click", () => withUi(confirmTarget));
$("refreshConnection").addEventListener("click", () => withUi(checkConnection));
$("loadSpaces").addEventListener("click", () => withUi(loadSpaces));
$("locationPicker").addEventListener("toggle", () => {
  if ($("locationPicker").open && connectionPhase === "connected" && !spaceMap.size) withUi(loadSpaces);
});
$("spaces").addEventListener("change", () => withUi(async () => { ancestors = []; await loadNodes(); }));
$("parentLevel").addEventListener("click", () => withUi(async () => { ancestors.pop(); await loadNodes(); }));
$("moreNodes").addEventListener("click", () => withUi(() => loadNodes(true)));
$("useParent").addEventListener("click", () => withUi(async () => {
  const parent = ancestors.at(-1);
  if (!parent) return;
  const url = `https://my.feishu.cn/wiki/${parent.node_token}`;
  if ($("targetUrl").value !== url) newRequest();
  $("targetUrl").value = url;
  targetNeedsRemember = true;
  await confirmTarget();
}));
$("save").addEventListener("click", () => withUi(async () => {
  if (!selectedTarget) throw new Error("请先确认保存位置。");
  $("saveFeedback").hidden = true;
  const job = currentJob();
  if (job?.stage === "complete") {
    await chrome.tabs.create({ url: clipApi.parseDocumentUrl(job.resultUrl, true).url });
    return;
  }
  if (job && !["complete", "abandoned"].includes(job.stage)) {
    renderJob(await request("resume", { jobId: job.id, ...(CREATION_RESTART_ERRORS.has(job.errorCode) ? { restartCreation: true } : {}) }));
    return;
  }
  if (job?.stage === "abandoned") newRequest();
  const state = await request("start", { sourceUrl: $("sourceUrl").value, targetUrl: selectedTarget.url,
    spaceName: selectedTarget.spaceName, expectedSpaceId: selectedTarget.spaceId,
    sourceTabId: Number(new URLSearchParams(location.search).get("sourceTabId")) || undefined });
  renderJob(state);
}, "saveFeedback"));
$("resume").addEventListener("click", () => withUi(async () => {
  const job = currentJob();
  if (!job) return;
  renderJob(await request("resume", { jobId: job.id, ...(CREATION_RESTART_ERRORS.has(job.errorCode) ? { restartCreation: true } : {}) }));
}, "saveFeedback"));
$("endTask").addEventListener("click", () => withUi(async () => {
  if (!window.confirm("结束此任务会保留已创建的副本和记录，不会撤销飞书正在处理的操作。若结果尚不明确，再次剪存可能生成另一份文档。确定结束？")) return;
  renderJob(await request("end", { jobId: latestState.job?.id }));
}));
$("connect").addEventListener("click", () => withUi(async () => {
  // Another tab may have completed login since this page was opened. Probe
  // the existing session before asking the user to authorize again.
  if (await checkConnection() || connectionPhase !== "needs_auth") return;
  showConnection("authorizing", "正在打开飞书登录页…");
  const data = await native("authorize_start");
  const url = new URL(data.verification_url);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !/(^|\.)(feishu\.cn|larkoffice\.com)$/.test(url.hostname)) throw new Error("飞书授权地址无效，请检查本机连接。");
  $("authLink").href = url.href;
  $("authLink").hidden = false;
  $("finishAuth").hidden = false;
  await chrome.tabs.create({ url: url.href });
  status("connectionStatus", "请在新页面完成飞书授权，然后回到这里点击“已完成授权，继续”。");
}));
$("finishAuth").addEventListener("click", () => withUi(async () => {
  status("connectionStatus", "正在确认飞书授权…");
  await native("authorize_finish");
  $("authLink").hidden = true;
  $("finishAuth").hidden = true;
  await checkConnection();
}));
$("copyInstall").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("installCommand").textContent); $("copyInstall").textContent = "已复制"; }
  catch (_) { $("copyInstall").textContent = "请选中上方命令后手动复制"; }
});

async function init() {
  $("installCommand").textContent = `python3 helper/install_feishu_native_host.py --extension-id ${chrome.runtime.id}`;
  const params = new URLSearchParams(location.search);
  $("sourceUrl").value = params.get("source") || "";
  $("sourceSettings").open = !currentSourceUrl();
  updateSourceTitle();
  const sourceTabId = Number(params.get("sourceTabId"));
  if (sourceTabId && typeof chrome.tabs.get === "function") {
    chrome.tabs.get(sourceTabId).then(tab => {
      if (clipApi.parseSourceUrl(tab.url).url !== currentSourceUrl()) return;
      sourceTitle = tab.title || ""; sourceTitleUrl = currentSourceUrl(); updateSourceTitle();
    }).catch(() => {});
  }
  const state = await request("state", { sourceUrl: currentSourceUrl(), reconcile: true });
  rememberedTarget = state.target || null;
  $("targetUrl").value = params.get("target") || state.target?.url || "";
  targetNeedsRemember = Boolean(params.get("target"));
  $("destinationSettings").open = !$("targetUrl").value;
  renderJob(state);
  await checkConnection();
}

init().catch(connectionError);
setInterval(() => refreshState().catch(() => {}), 2000);
