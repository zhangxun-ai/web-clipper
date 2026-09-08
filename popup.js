const BACKGROUND_TAB_SETTLE_DELAY_MS = 1500;
const DEFAULT_HISTORY_RANGE_DAYS = 30;
const DOWNLOAD_STATUS_TIMEOUT_MS = 60 * 1000;
const SCYS_EMBEDDED_FRAME_TIMEOUT_MS = 15 * 1000;
const WECHAT_MP_LOGIN_URL = "https://mp.weixin.qq.com/";
const exportUrlUtils = globalThis.ExportUrlUtils || {};
const exportUiModels = globalThis.ExportUiModels || {};
const obsidianExportApi = globalThis.ObsidianExport || {};
const obsidianVaultStorage = globalThis.ObsidianVaultStorage || {};
const classifyExportUrl = (url) => exportUrlUtils.classifyExportUrl?.(url) || "unsupported";
const isSingleExportUrl = (url) => exportUrlUtils.isSingleExportUrl?.(url) || false;
const isBatchExportUrl = (url) => exportUrlUtils.isBatchExportUrl?.(url) || false;
const isWechatArticleUrl = (url) => exportUrlUtils.isWechatArticleUrl?.(url) || false;
const isWechatMpBackendUrl = (url) => exportUrlUtils.isWechatMpBackendUrl?.(url) || false;
const isScysCourseUrl = (url) => exportUrlUtils.isScysCourseUrl?.(url) || false;
const isScysEmbeddedCourseUrl = (url) => exportUrlUtils.isScysEmbeddedCourseUrl?.(url) || false;
const selectScysCourseFrameTarget = (frames, url) => exportUrlUtils.selectScysCourseFrameTarget?.(frames, url) || null;
const isScysPageUrl = (url) => {
  try {
    return new URL(url).hostname === "scys.com";
  } catch (error) {
    return false;
  }
};
const buildObsidianNoteFile = (payload) => obsidianExportApi.buildObsidianNoteFile?.(payload);
const getPopupCategories = () => exportUiModels.getPopupCategories?.() || [];
const resolvePopupCategory = (value) => exportUiModels.resolvePopupCategory?.(value) || "other";
const resolvePopupPresetState = (value) => exportUiModels.resolvePopupPresetState?.(value) || {
  key: "custom",
  label: "自定义组合"
};
const normalizeOutputTarget = (value, fallback) => exportUiModels.normalizeOutputTarget?.(value, fallback) || "download";
const getOutputTargetState = (value) => exportUiModels.getOutputTargetState?.(value) || {
  key: "download",
  wantsDownload: true,
  wantsObsidian: false,
  label: "仅下载"
};
const buildExportCompletionStatus = (value) => exportUiModels.buildExportCompletionStatus?.(value) || "导出完成。";
const buildPrimaryActionModel = (value) => exportUiModels.buildPrimaryActionModel?.(value) || {
  headline: "当前页",
  summary: "请先打开支持导出的页面。",
  primaryAction: null,
  secondaryAction: null
};
const maybeStripWechatUiNoiseFromMarkdown = (value) => {
  const externalCleaner = globalThis.WechatMarkdownCleanup?.maybeStripWechatUiNoiseFromMarkdown;
  const cleaned = typeof externalCleaner === "function" ? externalCleaner(value) : value;
  return forceStripWechatNoiseTail(cleaned);
};

const statusEl = document.getElementById("status");
const primarySummaryEl = document.getElementById("primarySummary");
const detectedCategoryBadgeEl = document.getElementById("detectedCategoryBadge");
const titleEl = document.getElementById("docTitle");
const typeEl = document.getElementById("docType");
const primaryActionButton = document.getElementById("primaryAction");
const secondaryActionButton = document.getElementById("secondaryAction");
const scysWorkspaceEl = document.getElementById("scysWorkspace");
const scysWorkspaceNoteEl = document.getElementById("scysWorkspaceNote");
const scysExportCourseButton = document.getElementById("scysExportCourse");
const scysExportCurrentButton = document.getElementById("scysExportCurrent");
const batchWorkspaceEl = document.getElementById("batchWorkspace");
const batchWorkspaceTitleEl = document.getElementById("batchWorkspaceTitle");
const batchWorkspaceSummaryEl = document.getElementById("batchWorkspaceSummary");
const batchLinksLabelEl = document.getElementById("batchLinksLabel");
const wechatWorkspaceEl = document.getElementById("wechatWorkspace");
const otherWorkspaceEl = document.getElementById("otherWorkspace");
const otherWorkspaceNoteEl = document.getElementById("otherWorkspaceNote");
const includeImagesInput = document.getElementById("includeImages");
const presetSummaryEl = document.getElementById("presetSummary");
const outputTargetDownloadInput = document.getElementById("outputTargetDownload");
const outputTargetBothInput = document.getElementById("outputTargetBoth");
const outputTargetObsidianInput = document.getElementById("outputTargetObsidian");
const outputTargetInputs = [outputTargetDownloadInput, outputTargetBothInput, outputTargetObsidianInput].filter(Boolean);
const primaryHintEl = document.getElementById("primaryHint");
const obsidianStatusEl = document.getElementById("obsidianStatus");
const obsidianFolderEl = document.getElementById("obsidianFolder");
const obsidianSummaryEl = document.getElementById("obsidianSummary");
const pickObsidianFolderButton = document.getElementById("pickObsidianFolder");
const clearObsidianFolderButton = document.getElementById("clearObsidianFolder");
const includeImagesHelperInput = document.getElementById("includeImagesHelper");
const batchZipOutputInput = document.getElementById("batchZipOutput");
const batchStatusEl = document.getElementById("batchStatus");
const batchLinksInput = document.getElementById("batchLinks");
const batchDownloadLinksButton = document.getElementById("batchDownloadLinks");
const batchLogEl = document.getElementById("batchLog");
const helperStatusEl = document.getElementById("helperStatus");
const helperSeedUrlInput = document.getElementById("helperSeedUrl");
const helperStartDateInput = document.getElementById("helperStartDate");
const helperEndDateInput = document.getElementById("helperEndDate");
const helperCheckButton = document.getElementById("helperCheck");
const openWechatMpLoginButton = document.getElementById("openWechatMpLogin");
const helperDownloadButton = document.getElementById("helperDownload");
const helperLogEl = document.getElementById("helperLog");
const openFeishuSaveButton = document.getElementById("openFeishuSave");
const presetButtons = Array.from(document.querySelectorAll(".preset-card[data-preset]"));
const categoryTabButtons = new Map(
  getPopupCategories().map((item) => [
    item.key,
    document.getElementById(`categoryTab${item.key.charAt(0).toUpperCase()}${item.key.slice(1)}`)
  ])
);

let activeTabId = null;
let pageInfo = null;
let isWechatHistoryRunning = false;
let obsidianBinding = null;
let outputTarget = "download";
let currentExportType = "unsupported";
let detectedCategory = "other";
let activeCategory = "other";
let actionButtonsLocked = false;
let courseExportVisible = false;
let courseExportEnabled = false;
let activeExportTask = null;
let activeContentFrameId = null;
let primaryActionModel = {
  headline: "当前页",
  summary: "正在识别当前页面…",
  primaryAction: null,
  secondaryAction: null
};

init().catch((error) => {
  setStatus(error.message || "初始化失败", "error");
});

primaryActionButton.addEventListener("click", handlePrimaryAction);
secondaryActionButton.addEventListener("click", handleSecondaryAction);
scysExportCourseButton.addEventListener("click", handleCourseExport);
scysExportCurrentButton.addEventListener("click", () => handleExport("markdown"));
batchDownloadLinksButton.addEventListener("click", handleBatchDownloadLinks);
helperCheckButton.addEventListener("click", () => refreshWechatMpStatus({ silent: false }));
openWechatMpLoginButton.addEventListener("click", handleOpenWechatMpLogin);
helperDownloadButton.addEventListener("click", handleWechatHistoryDownload);
includeImagesInput.addEventListener("change", () => syncIncludeImages(true));
includeImagesHelperInput.addEventListener("change", () => syncIncludeImages(false));
outputTargetInputs.forEach((input) => input.addEventListener("change", handleOutputTargetChange));
pickObsidianFolderButton.addEventListener("click", handlePickObsidianFolder);
clearObsidianFolderButton.addEventListener("click", handleClearObsidianFolder);
presetButtons.forEach((button) => {
  button.addEventListener("click", () => handlePresetSelection(button.dataset.preset || ""));
});
categoryTabButtons.forEach((button, key) => {
  button?.addEventListener("click", () => setActiveCategory(key));
  button?.addEventListener("keydown", (event) => {
    const tabs = [...categoryTabButtons.entries()].filter(([, tab]) => tab);
    const index = tabs.findIndex(([category]) => category === key);
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setActiveCategory(tabs[next][0]);
    tabs[next][1].focus();
  });
});
document.getElementById("openExportSettings")?.addEventListener("click", (event) => {
  event.preventDefault();
  focusElement(document.querySelector("#popupAdvancedSettings > summary"));
});
openFeishuSaveButton?.addEventListener("click", async () => {
  try {
    const [tab] = await queryActiveTab();
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) throw new Error("请先打开要保存的文章网页。");
    await injectContentScript(tab.id);
    const url = new URL(chrome.runtime.getURL("feishu-save.html"));
    url.searchParams.set("source", tab.url);
    url.searchParams.set("sourceTabId", String(tab.id));
    url.searchParams.set("requestId", crypto.randomUUID());
    await chrome.tabs.create({ url: url.href });
  } catch (error) { setStatus(error.message || "无法打开飞书剪存页。", "error"); }
});

async function init() {
  initializeHistoryDateRange();
  syncIncludeImages(true);
  await loadPopupPreferences();
  applyOutputTargetToInputs();
  await refreshObsidianBinding({ silent: true });

  const [tab] = await queryActiveTab();
  if (!tab?.id) {
    throw new Error("未找到当前标签页");
  }

  activeTabId = tab.id;
  if (openFeishuSaveButton) openFeishuSaveButton.disabled = !/^https?:\/\//i.test(tab.url || "");
  currentExportType = classifyExportUrl(tab.url || "");
  detectedCategory = resolvePopupCategory({
    exportType: currentExportType,
    isWechatMpBackend: Boolean(tab.url && isWechatMpBackendUrl(tab.url)),
    isScysCourse: Boolean(tab.url && isScysCourseUrl(tab.url)),
    isScysPage: Boolean(tab.url && isScysPageUrl(tab.url))
  });
  activeCategory = detectedCategory;
  setCourseExportAvailability(false, false);

  if (tab.url && isWechatArticleUrl(tab.url)) {
    helperSeedUrlInput.value = tab.url;
  }

  if (tab.url && isWechatMpBackendUrl(tab.url)) {
    pageInfo = {
      title: "公众号后台",
      docType: "公众号后台",
      supports: []
    };
    setPageMeta(pageInfo);
    setStatus("可按日期下载公众号文章。", "ready");
    setButtonsDisabled(true);
  } else if (!tab.url || !isSingleExportUrl(tab.url)) {
    setPageMeta(null);
    setStatus("请先打开飞书、公众号文章，或当前网页正文页面。", "error");
    setButtonsDisabled(true);
  } else {
    try {
      activeContentFrameId = await resolveContentFrameId(activeTabId, tab.url || "");
      pageInfo = await sendMessageToActivePage({ type: "feishu-export:get-page-info" });
      setPageMeta(pageInfo);

      if (!pageInfo?.supports || !pageInfo.supports.includes("markdown")) {
        setStatus("检测到当前页面还在运行旧版脚本，请刷新页面后再试。", "error");
        setButtonsDisabled(true);
        setCourseExportAvailability(Boolean(tab.url && isScysCourseUrl(tab.url)), false);
      } else {
        setStatus("可以导出", "ready");
        setButtonsDisabled(false);
        setCourseExportAvailability(Boolean(tab.url && isScysCourseUrl(tab.url)), Boolean(tab.url && isScysCourseUrl(tab.url)));
      }
    } catch (error) {
      setPageMeta(null);
      setStatus(error.message || "页面检测失败", "error");
      setButtonsDisabled(true);
      setCourseExportAvailability(Boolean(tab.url && isScysCourseUrl(tab.url)), false);
    }
  }

  if (isWechatArticleUrl(helperSeedUrlInput.value.trim())) {
    await refreshWechatMpStatus({ silent: true }).catch(() => null);
  } else {
    helperStatusEl.hidden = true;
  }

  renderPrimarySurface();
  renderCategoryWorkspace();
}

async function handleExport(format) {
  if (!activeTabId) {
    setStatus("当前标签页不可用。", "error");
    return;
  }

  const shouldDownload = wantsDownload();
  const shouldSaveToObsidian = format === "markdown" && wantsObsidian();
  const shouldDownloadSelfContainedMarkdown = shouldDownload && !shouldSaveToObsidian && format === "markdown";

  if (format === "markdown" && wantsObsidian()) {
    const vaultReady = await ensureObsidianReadyIfNeeded();
    if (!vaultReady) {
      return;
    }
  }

  activeExportTask = createExportTask();
  setButtonsDisabled(true);
  setStatus(`正在导出 ${format.toUpperCase()}…`, "loading");

  try {
    const payload = await sendMessageToActivePage({
      type: "feishu-export:export-document",
      format,
      options: {
        includeImages: includeImagesInput.checked,
        localImageAssets: (shouldDownloadSelfContainedMarkdown || shouldSaveToObsidian) && includeImagesInput.checked
      }
    });
    throwIfExportCanceled();
    const normalizedPayload = normalizeWechatMarkdownPayload(payload);

    const filename = normalizeDownloadFilename(normalizedPayload.filename, format);
    let downloadedFilename = "";
    let downloadStarted = false;

    if (shouldDownload) {
      if (shouldDownloadSelfContainedMarkdown) {
        setStatus(
          includeImagesInput.checked
            ? `正在生成带图 Markdown：${filename}。`
            : `正在生成小体积 Markdown：${filename}。`,
          "loading"
        );
        const downloadOutcome = await downloadSelfContainedMarkdownPayload(normalizedPayload, filename);
        throwIfExportCanceled();
        downloadedFilename = downloadOutcome?.filename || filename;
        downloadStarted = downloadOutcome?.started === true;
      } else {
        setStatus(`正在写入下载文件：${filename}，可点击“停止导出”取消。`, "loading");
        const downloadOutcome = await downloadExportPayload(normalizedPayload, filename, format);
        throwIfExportCanceled();
        downloadedFilename = downloadOutcome?.filename || filename;
        downloadStarted = downloadOutcome?.started === true;
      }
    }

    let obsidianMessage = "";
    if (shouldSaveToObsidian) {
      await saveCurrentMarkdownToObsidian({
        title: pageInfo?.title || filename.replace(/\.md$/i, ""),
        sourceUrl: activeTabId ? String((await queryActiveTab())[0]?.url || "") : "",
        markdown: normalizedPayload.content,
        assets: normalizedPayload.assets
      });
      obsidianMessage = "，并已写入 Obsidian";
    }

    setStatus(buildExportCompletionStatus({
      format,
      downloadedFilename,
      downloadStarted,
      savedToObsidian: Boolean(obsidianMessage) || (shouldSaveToObsidian && !shouldDownload)
    }), "ready");
  } catch (error) {
    if (activeExportTask?.canceled) {
      setStatus("已停止导出。", "error");
    } else if (error?.name === "AbortError") {
      setStatus("已取消保存。", "error");
    } else if (format === "markdown" && error.message === "不支持的导出格式") {
      setStatus("当前页面还在运行旧版脚本，请刷新页面后再试。", "error");
    } else {
      setStatus(error.message || "导出失败", "error");
    }
  } finally {
    activeExportTask = null;
    setButtonsDisabled(false);
  }
}

async function handleBatchDownloadLinks() {
  if (isWechatHistoryRunning) {
    return;
  }

  if (wantsObsidian()) {
    const vaultReady = await ensureObsidianReadyIfNeeded();
    if (!vaultReady) {
      return;
    }
  }

  const links = parseBatchLinks(batchLinksInput.value, activeCategory);
  if (links.length === 0) {
    setBatchStatus(
      activeCategory === "wechat"
        ? "请至少粘贴一个公众号文章链接。"
        : "请至少粘贴一个飞书 docx/wiki 链接。",
      "error"
    );
    return;
  }

  try {
    const job = await createStoredBatchJob(links, {
      includeImages: includeImagesInput.checked,
      zipOutput: batchZipOutputInput.checked,
      outputTarget,
      title: activeCategory === "wechat" ? "批量下载公众号文章" : "批量下载飞书文档",
      source: activeCategory === "wechat" ? "manual-wechat-links" : "manual-feishu-links"
    });
    await openBatchRunner(job.id);
    setBatchStatus(`已打开批量任务页，共 ${job.links.length} 篇。后续下载会在任务页继续执行。`, "ready");
    appendBatchLog(`已创建批量任务，共 ${job.links.length} 篇。`);
  } catch (error) {
    setBatchStatus(error.message || "批量下载失败", "error");
  }
}

async function handleCourseExport() {
  if (!activeTabId) {
    setStatus("当前标签页不可用。", "error");
    return;
  }

  if (wantsObsidian()) {
    const vaultReady = await ensureObsidianReadyIfNeeded();
    if (!vaultReady) {
      return;
    }
  }

  setButtonsDisabled(true);
  setCourseExportAvailability(true, false);
  setStatus("正在识别当前专栏目录…", "loading");

  try {
    const outline = await sendMessageToActivePage({
      type: "feishu-export:get-scys-course-outline"
    });
    const job = await createStoredCourseExportJob(outline, {
      includeImages: includeImagesInput.checked,
      outputTarget
    });
    await openBatchRunner(job.id);
    setStatus(`已创建专栏导出任务，共 ${job.chapters.length} 章。任务将在新页面中继续。`, "ready");
  } catch (error) {
    setStatus(error.message || "专栏导出初始化失败", "error");
  } finally {
    setButtonsDisabled(false);
    setCourseExportAvailability(courseExportVisible, courseExportVisible);
  }
}

async function handleWechatHistoryDownload() {
  if (isWechatHistoryRunning) {
    setHelperStatus("当前还有进行中的批量任务，请等待完成后再试。", "error");
    return;
  }

  if (wantsObsidian()) {
    const vaultReady = await ensureObsidianReadyIfNeeded();
    if (!vaultReady) {
      return;
    }
  }

  const seedUrl = String(helperSeedUrlInput.value || "").trim();
  const startDate = String(helperStartDateInput.value || "").trim();
  const endDate = String(helperEndDateInput.value || "").trim();

  if (!isWechatArticleUrl(seedUrl)) {
    setHelperStatus("请粘贴该公众号任意一篇文章的链接。", "error");
    return;
  }

  if (!startDate || !endDate) {
    setHelperStatus("请选择开始和结束日期。", "error");
    return;
  }

  if (startDate > endDate) {
    setHelperStatus("开始日期不能晚于结束日期。", "error");
    return;
  }

  isWechatHistoryRunning = true;
  setHistoryControlsDisabled(true);
  clearHelperLog();
  setHelperStatus("正在查找历史文章…", "loading");

  try {
    const result = await resolveWechatHistoryInBackground(seedUrl, startDate, endDate);

    for (const line of result.logs || []) {
      appendHelperLog(line);
    }

    if (result.loginRequired) {
      await openForegroundTab(WECHAT_MP_LOGIN_URL);
      setHelperStatus("未检测到当前 Chrome 的公众号后台登录态。已为你打开登录页，登录完成后回来重试。", "error");
      appendHelperLog("未检测到后台登录态，已自动打开 `mp.weixin.qq.com` 登录页。", "error");
      return;
    }

    const links = normalizeSupportedLinks(result.links || []);
    if (links.length === 0) {
      setHelperStatus(result.message || "该时间范围没有命中任何历史文章。", "ready");
      appendHelperLog(result.message || "后台没有返回可下载文章。");
      return;
    }

    batchLinksInput.value = links.join("\n");
    appendHelperLog(
      `已匹配公众号: ${formatWechatAccountLabel(result.matchedAccount)}，命中 ${links.length} 篇。`,
      "success"
    );
    setHelperStatus(`已找到 ${links.length} 篇历史文章，开始自动下载。`, "loading");

    const job = await createStoredBatchJob(links, {
      includeImages: includeImagesInput.checked,
      zipOutput: batchZipOutputInput.checked,
      outputTarget,
      title: `公众号历史下载 - ${formatWechatAccountLabel(result.matchedAccount)}`,
      source: "wechat-history",
      account: result.matchedAccount || null,
      dateRange: { startDate, endDate }
    });
    await openBatchRunner(job.id);
    setHelperStatus(`已打开任务页，共 ${links.length} 篇。后续下载会在任务页继续执行。`, "ready");
    appendHelperLog(`已创建历史下载任务，共 ${links.length} 篇。`, "success");
  } catch (error) {
    setHelperStatus(error.message || "公众号历史下载失败", "error");
    appendHelperLog(error.message || "公众号历史下载失败", "error");
  } finally {
    isWechatHistoryRunning = false;
    setHistoryControlsDisabled(false);
  }
}

async function handleOpenWechatMpLogin() {
  await openForegroundTab(WECHAT_MP_LOGIN_URL);
  setHelperStatus("已打开公众号后台登录页。登录完成后回到这里继续。", "ready");
  appendHelperLog("已打开 `mp.weixin.qq.com` 登录页。完成一次登录后，再执行“按范围批量下载”。", "success");
}

async function refreshWechatMpStatus({ silent = false } = {}) {
  const seedUrl = String(helperSeedUrlInput.value || "").trim();
  if (!isWechatArticleUrl(seedUrl)) {
    const message = "请先粘贴一篇公众号文章链接。";
    setHelperStatus(message, "loading");
    helperStatusEl.hidden = silent;
    if (!silent) {
      appendHelperLog(message);
    }
    return null;
  }

  try {
    const payload = await checkWechatMpLoginFromSeed(seedUrl);
    if (payload.loggedIn) {
      const accountName = payload.accountName ? `，账号 ${payload.accountName}` : "";
      setHelperStatus(`已登录${accountName}。`, "ready");
      if (!silent) {
        appendHelperLog(`已检测到公众号后台登录态${accountName}。`, "success");
      }
    } else {
      setHelperStatus("尚未登录，请点击“打开公众号后台”完成登录。", "error");
      if (!silent) {
        appendHelperLog("当前 Chrome 里没有可用的 `mp.weixin.qq.com` 登录态。", "error");
      }
    }
    return payload;
  } catch (error) {
    setHelperStatus(error.message || "检测公众号后台登录失败", "error");
    if (!silent) {
      appendHelperLog(error.message || "检测公众号后台登录失败", "error");
    }
    throw error;
  }
}

async function resolveWechatHistoryInBackground(seedUrl, startDate, endDate) {
  const tabId = await createTab(seedUrl, false);

  try {
    await waitForTabReady(tabId, seedUrl);
    await sleep(BACKGROUND_TAB_SETTLE_DELAY_MS);

    return await sendMessageWithRecovery(tabId, {
      type: "feishu-export:resolve-wechat-mp-history",
      startDate,
      endDate
    });
  } finally {
    await closeTab(tabId);
  }
}

async function checkWechatMpLoginFromSeed(seedUrl) {
  const tabId = await createTab(seedUrl, false);

  try {
    await waitForTabReady(tabId, seedUrl);
    await sleep(BACKGROUND_TAB_SETTLE_DELAY_MS);

    return await sendMessageWithRecovery(tabId, {
      type: "feishu-export:get-wechat-mp-login-status"
    });
  } finally {
    await closeTab(tabId);
  }
}

function sendMessageToActivePage(message) {
  return sendMessageWithRecovery({
    tabId: activeTabId,
    message,
    frameId: activeContentFrameId
  });
}

function sendMessageToTab(tabId, message, frameId = null) {
  return new Promise((resolve, reject) => {
    const callback = (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response) {
        reject(new Error("页面没有返回数据"));
        return;
      }

      if (!response.ok) {
        reject(new Error(response.error || "请求失败"));
        return;
      }

      resolve(response.data);
    };

    if (Number.isInteger(frameId)) {
      chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

async function sendMessageWithRecovery(arg1, arg2) {
  const tabId = typeof arg1 === "number" ? arg1 : arg1?.tabId;
  const message = typeof arg1 === "number" ? arg2 : arg1?.message;
  const frameId = typeof arg1 === "number" ? null : arg1?.frameId;

  if (!tabId || !message) {
    throw new Error("消息发送参数不完整");
  }

  try {
    return await sendMessageToTab(tabId, message, frameId);
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    await injectContentScript(tabId, frameId);
    return sendMessageToTab(tabId, message, frameId);
  }
}

function injectContentScript(tabId, frameId = null) {
  return new Promise((resolve, reject) => {
    const target = Number.isInteger(frameId)
      ? { tabId, frameIds: [frameId] }
      : { tabId };
    chrome.scripting.executeScript(
      {
        target,
        files: ["shared/scys-course-utils.js", "shared/web-markdown-utils.js", "shared/web-feishu-blocks.js", "content-scripts/feishu-exporter.js"]
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve();
      }
    );
  });
}

async function resolveContentFrameId(tabId, sourceUrl, timeoutMs = SCYS_EMBEDDED_FRAME_TIMEOUT_MS) {
  if (!isScysEmbeddedCourseUrl(sourceUrl)) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const frameResults = await inspectFrameUrls(tabId);
    const target = selectScysCourseFrameTarget(frameResults, sourceUrl);
    if (target) {
      return target.frameId;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }
    await sleep(250);
  }

  throw new Error("未找到航海手册正文。请等待正文加载完成后刷新页面，再重新打开插件。");
}

function inspectFrameUrls(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        func: () => location.href
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(results || []);
      }
    );
  });
}

function isMissingReceiverError(error) {
  const message = String(error?.message || "");
  return message.includes("Receiving end does not exist");
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tabs || []);
    });
  });
}

function createTab(url, active) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!tab?.id) {
        reject(new Error("标签页创建失败"));
        return;
      }

      resolve(tab.id);
    });
  });
}

function openForegroundTab(url) {
  return createTab(url, true);
}

async function createStoredBatchJob(links, options = {}) {
  const normalizedLinks = normalizeSupportedLinks(links);
  if (normalizedLinks.length === 0) {
    throw new Error("没有可处理的受支持链接");
  }

  const id = (crypto.randomUUID ? crypto.randomUUID() : `job-${Date.now()}`);
  const job = {
    id,
    title: String(options.title || "批量下载任务"),
    source: String(options.source || "manual"),
    includeImages: options.includeImages !== false,
    zipOutput: options.zipOutput !== false,
    outputTarget: normalizeOutputTarget(options.outputTarget, options.saveToObsidian === true ? "both" : "download"),
    saveToObsidian: normalizeOutputTarget(options.outputTarget, options.saveToObsidian === true ? "both" : "download") !== "download",
    links: normalizedLinks,
    account: options.account || null,
    dateRange: options.dateRange || null,
    createdAt: new Date().toISOString()
  };

  await storageSet({ [`batchJob:${id}`]: job });
  return job;
}

async function createStoredCourseExportJob(outline, options = {}) {
  const chapters = Array.isArray(outline?.chapters) ? outline.chapters.filter(Boolean) : [];
  if (chapters.length === 0) {
    throw new Error("没有可处理的专栏章节");
  }

  const id = (crypto.randomUUID ? crypto.randomUUID() : `job-${Date.now()}`);
  const title = String(outline?.courseTitle || "未命名专栏");
  const job = {
    id,
    type: "course-export",
    source: "scys-course",
    title: `专栏导出 - ${title}`,
    courseTitle: title,
    courseUrl: String(outline?.courseUrl || ""),
    includeImages: options.includeImages !== false,
    outputTarget: normalizeOutputTarget(options.outputTarget, options.saveToObsidian === true ? "both" : "download"),
    saveToObsidian: normalizeOutputTarget(options.outputTarget, options.saveToObsidian === true ? "both" : "download") !== "download",
    chapters,
    createdAt: new Date().toISOString()
  };

  await storageSet({ [`batchJob:${id}`]: job });
  return job;
}

async function openBatchRunner(jobId) {
  const url = chrome.runtime.getURL(`batch-runner.html?jobId=${encodeURIComponent(jobId)}`);
  await openForegroundTab(url);
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!downloadId) {
        reject(new Error("下载未启动。"));
        return;
      }

      activeExportTask?.downloadIds.add(downloadId);
      resolve(downloadId);
    });
  });
}

async function downloadFile(options) {
  const downloadId = await startDownload(options);
  return waitForDownloadCompletion(downloadId, options.filename);
}

function waitForDownloadCompletion(downloadId, fallbackFilename) {
  if (!downloadId || !chrome.downloads?.onChanged?.addListener) {
    return Promise.resolve({ downloadId, filename: getDownloadDisplayFilename(null, fallbackFilename) });
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finish(async () => {
        await cancelDownload(downloadId).catch(() => null);
        reject(new Error("下载超时，已取消这次下载。请重新加载扩展和页面后再试。"));
      });
    }, DOWNLOAD_STATUS_TIMEOUT_MS);

    const listener = (delta) => {
      if (delta?.id !== downloadId || !delta.state?.current) {
        return;
      }

      if (delta.state.current === "complete") {
        finish(async () => {
          const item = await getDownloadItem(downloadId);
          resolve({ downloadId, filename: getDownloadDisplayFilename(item, fallbackFilename) });
        });
      }

      if (delta.state.current === "interrupted") {
        const reason = String(delta.error?.current || "").trim();
        finish(() => reject(new Error(reason ? `下载失败：${reason}` : "下载失败，已中断。")));
      }
    };

    function finish(callback) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      Promise.resolve(callback()).catch(reject);
    }

    chrome.downloads.onChanged.addListener(listener);
    getDownloadItem(downloadId).then((item) => {
      if (item?.state === "complete") {
        finish(() => resolve({ downloadId, filename: getDownloadDisplayFilename(item, fallbackFilename) }));
      } else if (item?.state === "interrupted") {
        finish(() => reject(new Error("下载失败，已中断。")));
      }
    }).catch(() => null);
  });
}

function getDownloadItem(downloadId) {
  return new Promise((resolve, reject) => {
    if (!chrome.downloads?.search) {
      resolve(null);
      return;
    }

    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Array.isArray(items) ? items[0] || null : null);
    });
  });
}

function cancelDownload(downloadId) {
  return new Promise((resolve, reject) => {
    if (!downloadId || !chrome.downloads?.cancel) {
      resolve();
      return;
    }

    chrome.downloads.cancel(downloadId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function getDownloadDisplayFilename(item, fallbackFilename) {
  const raw = String(item?.filename || fallbackFilename || "").trim();
  return raw.split(/[\\/]/).filter(Boolean).pop() || raw || "";
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

async function downloadWithFallback(url, filename, format, saveAs) {
  try {
    return await downloadFile({
      url,
      filename,
      saveAs,
      conflictAction: "uniquify"
    });
  } catch (error) {
    if (!isInvalidFilenameError(error)) {
      throw error;
    }

    return downloadFile({
      url,
      filename: buildFallbackFilename(format),
      saveAs,
      conflictAction: "uniquify"
    });
  }
}

function setButtonsDisabled(disabled) {
  actionButtonsLocked = disabled;
  renderPrimarySurface();
  renderCategoryWorkspace();
}

function createExportTask() {
  return {
    canceled: false,
    downloadIds: new Set()
  };
}

function throwIfExportCanceled() {
  if (activeExportTask?.canceled) {
    throw new Error("已停止导出。");
  }
}

async function cancelActiveExport() {
  if (!activeExportTask) {
    return;
  }

  activeExportTask.canceled = true;
  const downloadIds = Array.from(activeExportTask.downloadIds);
  await Promise.all(downloadIds.map((downloadId) => cancelDownload(downloadId).catch(() => null)));
  setStatus("已停止导出。", "error");
}

function setCourseExportAvailability(visible, enabled) {
  courseExportVisible = visible;
  courseExportEnabled = enabled;
  renderPrimarySurface();
  renderCategoryWorkspace();
}

function setBatchControlsDisabled(disabled) {
  batchDownloadLinksButton.disabled = disabled || isWechatHistoryRunning;
  batchLinksInput.disabled = disabled || isWechatHistoryRunning;
}

function setHistoryControlsDisabled(disabled) {
  helperCheckButton.disabled = disabled;
  openWechatMpLoginButton.disabled = disabled;
  helperDownloadButton.disabled = disabled;
  helperSeedUrlInput.disabled = disabled;
  helperStartDateInput.disabled = disabled;
  helperEndDateInput.disabled = disabled;
  includeImagesHelperInput.disabled = disabled;
}

function setPageMeta(info) {
  titleEl.textContent = info?.title || "请先打开文章或文档";
  typeEl.textContent = info?.docType || "暂无可导出的正文";
}

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.className = `status status-${variant}`;
  renderPrimarySurface();
}

function setBatchStatus(message, variant) {
  batchStatusEl.hidden = false;
  batchStatusEl.textContent = message;
  batchStatusEl.className = `status status-${variant}`;
}

function setHelperStatus(message, variant) {
  helperStatusEl.hidden = false;
  helperStatusEl.textContent = message;
  helperStatusEl.className = `status status-${variant}`;
}

function setObsidianStatus(message, variant) {
  obsidianStatusEl.hidden = false;
  obsidianStatusEl.textContent = message;
  obsidianStatusEl.className = `status status-${variant}`;
}

function appendBatchLog(message, variant = "") {
  const entry = document.createElement("div");
  entry.className = `log-entry${variant ? ` log-entry-${variant}` : ""}`;
  entry.textContent = message;
  batchLogEl.prepend(entry);
}

function appendHelperLog(message, variant = "") {
  const entry = document.createElement("div");
  entry.className = `log-entry${variant ? ` log-entry-${variant}` : ""}`;
  entry.textContent = message;
  helperLogEl.prepend(entry);
}

function clearBatchLog() {
  batchLogEl.innerHTML = "";
}

function clearHelperLog() {
  helperLogEl.innerHTML = "";
}

async function persistOutputTarget() {
  await storageSet({
    outputTarget,
    obsidianSyncEnabled: wantsObsidian()
  });
}

async function handleOutputTargetChange() {
  const nextTarget = normalizeOutputTarget(outputTargetInputs.find((input) => input.checked)?.value, outputTarget);
  if (nextTarget === outputTarget) {
    return;
  }

  const previousTarget = outputTarget;
  outputTarget = nextTarget;
  applyOutputTargetToInputs();

  if (wantsObsidian()) {
    const ready = await ensureObsidianReadyIfNeeded();
    if (!ready) {
      outputTarget = previousTarget;
      applyOutputTargetToInputs();
      await persistOutputTarget();
      renderPrimarySurface();
      return;
    }
  }

  await persistOutputTarget();
  renderPrimarySurface();
  renderCategoryWorkspace();
}

function renderPrimarySurface() {
  renderOutputTargetUi();
  renderPresetUi();
  primaryActionModel = buildPrimaryActionModel({
    isSupportedPage: Boolean(pageInfo?.supports?.includes?.("markdown")),
    isWechatMpBackend: pageInfo?.docType === "公众号后台",
    canExportCourse: courseExportVisible,
    exportType: currentExportType,
    pageInfo
  });

  if (primarySummaryEl) {
    primarySummaryEl.textContent = primaryActionModel.summary || "";
    primarySummaryEl.hidden = primaryActionModel.primaryAction?.key === "export-markdown";
  }
  if (primaryActionButton) {
    const action = primaryActionModel.primaryAction;
    primaryActionButton.hidden = !action;
    if (actionButtonsLocked && activeExportTask && action) {
      primaryActionButton.disabled = false;
      primaryActionButton.textContent = "停止导出";
      primaryActionButton.dataset.actionKey = "cancel-export";
    } else {
      primaryActionButton.disabled = !action
        || (actionButtonsLocked && action.key !== "focus-wechat-history")
        || (action.key === "export-course" && !courseExportEnabled);
      primaryActionButton.textContent = action?.label || "当前页暂不支持";
      primaryActionButton.dataset.actionKey = action?.key || "";
    }
  }
  if (secondaryActionButton) {
    const action = primaryActionModel.secondaryAction;
    secondaryActionButton.hidden = !action;
    secondaryActionButton.disabled = actionButtonsLocked || !action;
    secondaryActionButton.textContent = action?.label || "";
    secondaryActionButton.dataset.actionKey = action?.key || "";
  }
  if (detectedCategoryBadgeEl) {
    const meta = getCategoryMeta(detectedCategory);
    detectedCategoryBadgeEl.textContent = meta.label;
  }
  if (primaryHintEl) {
    const targetState = getActiveOutputTargetState();
    let hint = `当前输出目标：${targetState.label}。`;
    if (targetState.wantsObsidian && obsidianBinding?.meta?.folderName) {
      hint += ` 目标目录：${obsidianBinding.meta.folderName}。`;
    } else if (targetState.wantsObsidian) {
      hint += " 需要先配置 Obsidian 目标目录。";
    }
    primaryHintEl.textContent = hint;
    primaryHintEl.hidden = !targetState.wantsObsidian;
  }
}

function renderOutputTargetUi() {
  const targetState = getActiveOutputTargetState();
  if (batchZipOutputInput) {
    batchZipOutputInput.disabled = !targetState.wantsDownload || isWechatHistoryRunning;
  }
}

function renderPresetUi() {
  const presetState = resolvePopupPresetState({
    outputTarget,
    includeImages: includeImagesInput.checked
  });

  presetButtons.forEach((button) => {
    const key = button.dataset.preset || "";
    const active = key === presetState.key;
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  if (!presetSummaryEl) {
    return;
  }

  presetSummaryEl.hidden = presetState.key !== "custom";
  if (presetState.key === "custom") {
    presetSummaryEl.textContent = "自定义组合";
    return;
  }

  presetSummaryEl.textContent = `已选：${presetState.label}`;
}

async function handlePresetSelection(presetKey) {
  const previousTarget = outputTarget;
  const previousIncludeImages = includeImagesInput.checked;
  let nextTarget = outputTarget;
  let nextIncludeImages = includeImagesInput.checked;

  switch (presetKey) {
    case "quick-export":
      nextTarget = "download";
      nextIncludeImages = false;
      break;
    case "ai-ready":
      nextTarget = "download";
      nextIncludeImages = true;
      break;
    case "obsidian":
      nextTarget = "obsidian";
      nextIncludeImages = true;
      break;
    default:
      return;
  }

  const changed = nextTarget !== outputTarget || nextIncludeImages !== includeImagesInput.checked;
  if (!changed) {
    renderPrimarySurface();
    return;
  }

  outputTarget = nextTarget;
  includeImagesInput.checked = nextIncludeImages;
  includeImagesHelperInput.checked = nextIncludeImages;
  applyOutputTargetToInputs();
  renderPrimarySurface();
  renderCategoryWorkspace();

  if (wantsObsidian()) {
    const ready = await ensureObsidianReadyIfNeeded();
    if (!ready) {
      outputTarget = previousTarget;
      includeImagesInput.checked = previousIncludeImages;
      includeImagesHelperInput.checked = previousIncludeImages;
      applyOutputTargetToInputs();
      renderPrimarySurface();
      renderCategoryWorkspace();
      await persistOutputTarget();
      return;
    }
  }

  await persistOutputTarget();
  renderPrimarySurface();
  renderCategoryWorkspace();
}

function getCategoryMeta(categoryKey) {
  return getPopupCategories().find((item) => item.key === categoryKey) || { key: "other", label: "其它" };
}

function setActiveCategory(categoryKey) {
  activeCategory = getCategoryMeta(categoryKey).key;
  renderCategoryWorkspace();
}

function renderCategoryWorkspace() {
  renderCategoryTabs();
  renderBatchWorkspace();
  renderScysWorkspace();
  renderWechatWorkspace();
  renderOtherWorkspace();
}

function renderCategoryTabs() {
  categoryTabButtons.forEach((button, key) => {
    if (!button) {
      return;
    }
    const selected = key === activeCategory;
    button.dataset.active = selected ? "true" : "false";
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    if (selected) document.getElementById("categoryToolsPanel")?.setAttribute("aria-labelledby", button.id);
  });

}

function renderBatchWorkspace() {
  const showBatch = activeCategory === "wechat" || activeCategory === "feishu";
  if (batchWorkspaceEl) {
    batchWorkspaceEl.hidden = !showBatch;
  }

  if (!showBatch) {
    return;
  }

  if (activeCategory === "wechat") {
    batchWorkspaceTitleEl.textContent = "公众号文章批量下载";
    batchWorkspaceSummaryEl.textContent = "任务将在新页面中执行。";
    batchLinksLabelEl.textContent = "公众号文章链接列表";
    batchLinksInput.placeholder = "每行一个链接：https://mp.weixin.qq.com/s/…";
    batchDownloadLinksButton.textContent = "批量下载公众号文章";
  } else {
    batchWorkspaceTitleEl.textContent = "飞书文档批量下载";
    batchWorkspaceSummaryEl.textContent = "任务将在新页面中执行。";
    batchLinksLabelEl.textContent = "飞书链接列表";
    batchLinksInput.placeholder = "每行一个飞书 docx 或 wiki 链接。";
    batchDownloadLinksButton.textContent = "批量下载飞书文档";
  }
}

function renderScysWorkspace() {
  if (scysWorkspaceEl) {
    scysWorkspaceEl.hidden = activeCategory !== "scys";
  }

  if (activeCategory !== "scys") {
    return;
  }

  scysWorkspaceNoteEl.textContent = courseExportVisible
    ? "已识别当前课程，可导出完整专栏或单篇章节。"
    : "请先打开生财课程的任意章节，再使用专栏导出。";
  scysExportCourseButton.disabled = actionButtonsLocked || !courseExportEnabled;
  scysExportCurrentButton.disabled = actionButtonsLocked || !Boolean(pageInfo?.supports?.includes?.("markdown")) || detectedCategory !== "scys";
}

function renderWechatWorkspace() {
  if (wechatWorkspaceEl) {
    wechatWorkspaceEl.hidden = activeCategory !== "wechat";
  }
}

function renderOtherWorkspace() {
  if (otherWorkspaceEl) {
    otherWorkspaceEl.hidden = activeCategory !== "other";
  }

  if (activeCategory !== "other") {
    return;
  }

  const supported = Boolean(pageInfo?.supports?.includes?.("markdown"));
  otherWorkspaceNoteEl.textContent = supported
    ? "使用上方按钮导出正文，或保存到飞书知识库。"
    : "请先打开文章页面；也可切换分类，粘贴链接批量下载。";
}

async function handlePrimaryAction() {
  const actionKey = primaryActionButton.dataset.actionKey;
  await handleActionByKey(actionKey);
}

async function handleSecondaryAction() {
  const actionKey = secondaryActionButton.dataset.actionKey;
  await handleActionByKey(actionKey);
}

async function handleActionByKey(actionKey) {
  switch (actionKey) {
    case "cancel-export":
      await cancelActiveExport();
      break;
    case "export-markdown":
      await handleExport("markdown");
      break;
    case "export-course":
      await handleCourseExport();
      break;
    case "focus-wechat-history":
      setActiveCategory("wechat");
      focusElement(helperSeedUrlInput);
      break;
    default:
      break;
  }
}

async function loadPopupPreferences() {
  const result = await storageGet(["outputTarget", "obsidianSyncEnabled"]);
  outputTarget = normalizeOutputTarget(
    result.outputTarget,
    result.obsidianSyncEnabled === true ? "both" : "download"
  );
}

function applyOutputTargetToInputs() {
  outputTargetDownloadInput.checked = outputTarget === "download";
  outputTargetBothInput.checked = outputTarget === "both";
  outputTargetObsidianInput.checked = outputTarget === "obsidian";
}

function getActiveOutputTargetState() {
  return getOutputTargetState(outputTarget);
}

function wantsObsidian() {
  return getActiveOutputTargetState().wantsObsidian;
}

function wantsDownload() {
  return getActiveOutputTargetState().wantsDownload;
}

async function refreshObsidianBinding({ silent = false } = {}) {
  if (!obsidianVaultStorage.isSupported?.()) {
    obsidianBinding = null;
    pickObsidianFolderButton.disabled = true;
    clearObsidianFolderButton.disabled = true;
    obsidianFolderEl.textContent = "当前环境不支持";
    obsidianFolderEl.hidden = true;
    if (obsidianSummaryEl) {
      obsidianSummaryEl.textContent = "当前环境不支持";
    }
    setObsidianStatus("当前浏览器环境不支持目录授权，无法直写 Obsidian。", "error");
    renderPrimarySurface();
    return null;
  }

  const binding = await obsidianVaultStorage.getVaultBinding?.();
  obsidianBinding = binding || null;
  clearObsidianFolderButton.disabled = !binding;
  pickObsidianFolderButton.disabled = false;

  if (!binding) {
    obsidianFolderEl.textContent = "";
    obsidianFolderEl.hidden = true;
    if (obsidianSummaryEl) {
      obsidianSummaryEl.textContent = "尚未配置";
    }
    setObsidianStatus("尚未配置 Obsidian 目标目录。", silent ? "loading" : "error");
    obsidianStatusEl.hidden = silent;
    renderPrimarySurface();
    return null;
  }

  const folderName = String(binding.meta?.folderName || binding.handle?.name || "未命名目录");
  const permission = await obsidianVaultStorage.queryVaultPermission?.(binding.handle, "readwrite");
  obsidianFolderEl.textContent = folderName;
  obsidianFolderEl.hidden = false;
  if (obsidianSummaryEl) {
    obsidianSummaryEl.textContent = permission === "granted" ? "已连接" : "需要授权";
  }

  if (permission === "granted") {
    setObsidianStatus(`已连接到目标目录：${folderName}。`, "ready");
    obsidianStatusEl.hidden = silent;
  } else {
    setObsidianStatus(`目录权限已失效：${folderName}。请重新授权。`, "error");
  }

  renderPrimarySurface();

  return {
    ...binding,
    permission
  };
}

async function handlePickObsidianFolder() {
  try {
    const handle = await obsidianVaultStorage.pickDirectory?.();
    const permission = await obsidianVaultStorage.ensureVaultPermission?.(handle, "readwrite");
    if (permission !== "granted") {
      throw new Error("没有拿到 Obsidian 目录写入权限");
    }
    await obsidianVaultStorage.saveVaultBinding?.(handle, {
      folderName: String(handle?.name || "未命名目录")
    });
    await refreshObsidianBinding();
    renderPrimarySurface();
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    setObsidianStatus(error.message || "选择 Obsidian 目录失败", "error");
  }
}

async function handleClearObsidianFolder() {
  try {
    await obsidianVaultStorage.clearVaultBinding?.();
    obsidianBinding = null;
    obsidianFolderEl.textContent = "";
    obsidianFolderEl.hidden = true;
    if (obsidianSummaryEl) {
      obsidianSummaryEl.textContent = "尚未配置";
    }
    setObsidianStatus("已清除 Obsidian 目录授权。", "ready");
    clearObsidianFolderButton.disabled = true;
    if (wantsObsidian()) {
      outputTarget = "download";
      applyOutputTargetToInputs();
      await persistOutputTarget();
    }
    renderPrimarySurface();
  } catch (error) {
    setObsidianStatus(error.message || "清除 Obsidian 授权失败", "error");
  }
}

async function ensureObsidianReadyIfNeeded() {
  if (!wantsObsidian()) {
    return true;
  }

  const binding = await refreshObsidianBinding({ silent: true });
  if (!binding) {
    setStatus("请先选择 Obsidian 目标目录，再使用此导出方式。", "error");
    focusElement(pickObsidianFolderButton);
    return false;
  }

  let permission = binding.permission;
  if (permission !== "granted") {
    permission = await obsidianVaultStorage.ensureVaultPermission?.(binding.handle, "readwrite");
    await refreshObsidianBinding({ silent: true });
  }

  if (permission !== "granted") {
    setStatus("Obsidian 目录授权已失效，请重新授权后再导出。", "error");
    focusElement(pickObsidianFolderButton);
    return false;
  }

  return true;
}

async function saveCurrentMarkdownToObsidian(payload) {
  const binding = await refreshObsidianBinding({ silent: true });
  if (!binding || binding.permission !== "granted") {
    throw new Error("Obsidian 目录不可用，请先重新授权");
  }

  const note = buildObsidianNoteFile?.({
    title: payload.title,
    sourceUrl: payload.sourceUrl,
    exportedAt: new Date().toISOString(),
    markdown: extractBodyMarkdown(payload.markdown)
  });

  if (!note) {
    throw new Error("Obsidian 导出模块未加载");
  }

  await obsidianVaultStorage.writeTextFiles?.(binding.handle, [note]);
  await writeObsidianAssetFiles(binding.handle, note.path, payload.assets);
  setObsidianStatus(`已写入 Obsidian：${note.path}`, "ready");
}

async function writeObsidianAssetFiles(rootHandle, notePath, assets) {
  const validAssets = Array.isArray(assets) ? assets.filter(isValidAssetPayload) : [];
  if (validAssets.length === 0) {
    return;
  }

  const noteDirectory = String(notePath || "").split("/").slice(0, -1);
  for (const asset of validAssets) {
    const assetSegments = [...noteDirectory, ...asset.path.split("/")].filter(Boolean);
    const fileName = assetSegments.pop();
    if (!fileName) {
      continue;
    }

    let directory = rootHandle;
    for (const segment of assetSegments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(base64ToUint8Array(asset.contentBase64));
    } finally {
      await writable.close();
    }
  }
}

function extractBodyMarkdown(markdown) {
  const text = String(markdown || "");
  const separatorIndex = text.indexOf("\n---\n");
  if (separatorIndex < 0) {
    return text.trim();
  }
  return text.slice(separatorIndex + "\n---\n".length).trim();
}

function normalizeWechatMarkdownPayload(payload) {
  if (!payload || payload.mimeType !== "text/markdown;charset=utf-8") {
    return payload;
  }

  return {
    ...payload,
    content: maybeStripWechatUiNoiseFromMarkdown(payload.content)
  };
}

async function downloadExportPayload(payload, filename, format) {
  const assets = Array.isArray(payload?.assets) ? payload.assets.filter(isValidAssetPayload) : [];
  if (assets.length === 0) {
    return downloadGeneratedText(
      payload.content,
      payload.mimeType,
      filename,
      format,
      false
    );
  }

  const folderName = buildAssetBundleFolderName(filename);
  const markdownPath = `${folderName}/document.md`;
  const markdownDownload = await downloadGeneratedBlob(
    new Blob([payload.content], { type: payload.mimeType }),
    markdownPath,
    format,
    false
  );

  for (const asset of assets) {
    await downloadGeneratedBlob(
      new Blob([base64ToUint8Array(asset.contentBase64)], { type: asset.mimeType || "application/octet-stream" }),
      `${folderName}/${asset.path}`,
      format,
      false
    );
  }

  return markdownDownload || { filename: markdownPath };
}

async function downloadSelfContainedMarkdownPayload(payload, markdownFilename) {
  const assets = Array.isArray(payload?.assets) ? payload.assets.filter(isValidAssetPayload) : [];
  const markdown = embedAssetsAsDataUris(payload?.content || "", assets);
  return downloadGeneratedText(markdown, payload?.mimeType, markdownFilename, "markdown", false);
}

async function downloadGeneratedText(content, mimeType, filename, format, saveAs) {
  return downloadTextWithAnchor(content, mimeType, filename, format);
}

async function downloadGeneratedBlob(blob, filename, format, saveAs) {
  const url = URL.createObjectURL(blob);
  try {
    return await downloadWithFallback(url, filename, format, saveAs);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function downloadTextWithAnchor(content, mimeType, filename, format) {
  const safeFilename = String(filename || buildFallbackFilename(format));
  const blob = new Blob([String(content || "")], { type: mimeType || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }

  return Promise.resolve({
    filename: safeFilename,
    started: true
  });
}

function buildAssetBundleFolderName(filename) {
  return String(filename || "feishu-export.md")
    .replace(/\.[^.]+$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g, "_")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    || "feishu-export";
}

function isValidAssetPayload(asset) {
  return Boolean(
    asset
    && typeof asset.path === "string"
    && asset.path
    && typeof asset.contentBase64 === "string"
    && asset.contentBase64
  );
}

function base64ToUint8Array(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function embedAssetsAsDataUris(markdown, assets) {
  let result = String(markdown || "");
  for (const asset of assets) {
    const dataUri = `data:${asset.mimeType || "application/octet-stream"};base64,${asset.contentBase64}`;
    result = result.split(`(${asset.path})`).join(`(${dataUri})`);
  }
  return result;
}

function forceStripWechatNoiseTail(value) {
  const text = String(value || "");
  const markers = [
    "\n\nClose",
    "\n\nName cleared",
    "\n\n微信扫一扫赞赏作者",
    "\n\nLike the Author",
    "\n\nOther Amount"
  ];
  const startIndexes = markers
    .map((marker) => text.lastIndexOf(marker))
    .filter((index) => index >= 0);

  if (startIndexes.length === 0) {
    return text.trim();
  }

  const start = Math.min(...startIndexes);
  const tail = text.slice(start);
  const signals = [
    /Close/i,
    /Name cleared/i,
    /微信扫一扫赞赏作者/i,
    /Like the Author/i,
    /赞赏后展示我的头像/,
    /^作品$/m,
    /暂无作品/,
    /^Back$/m,
    /Other Amount/i
  ];
  const hitCount = signals.filter((pattern) => pattern.test(tail)).length;

  if (hitCount < 3) {
    return text.trim();
  }

  return text.slice(0, start).replace(/\s+$/g, "");
}

function parseBatchLinks(value, categoryKey = activeCategory) {
  return normalizeSupportedLinksForCategory(
    String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    categoryKey
  );
}

function normalizeSupportedLinksForCategory(values, categoryKey = activeCategory) {
  const expectedType = categoryKey === "wechat"
    ? "wechat"
    : categoryKey === "feishu"
      ? "feishu"
      : "";
  const unique = new Set();
  const result = [];

  for (const value of values || []) {
    const link = String(value || "").trim();
    const exportType = classifyExportUrl(link);
    if (!link || !isBatchExportUrl(link) || (expectedType && exportType !== expectedType) || unique.has(link)) {
      continue;
    }

    unique.add(link);
    result.push(link);
  }

  return result;
}

function normalizeSupportedLinks(values) {
  const unique = new Set();
  const result = [];

  for (const value of values || []) {
    const link = String(value || "").trim();
    if (!link || !isBatchExportUrl(link) || unique.has(link)) {
      continue;
    }

    unique.add(link);
    result.push(link);
  }

  return result;
}

function focusElement(element) {
  if (!element) {
    return;
  }

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") parent.open = true;
  }
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ behavior: "instant", block: "nearest" });
  }
  if (typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
}

function normalizeDownloadFilename(filename, format) {
  const extension = format === "json" ? "json" : "md";
  const raw = String(filename || "");
  const withoutExtension = raw.replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g, "_")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);

  if (!cleaned) {
    return buildFallbackFilename(format);
  }

  return `${cleaned}.${extension}`;
}

function buildFallbackFilename(format) {
  const extension = format === "json" ? "json" : "md";
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");

  return `local-export-${timestamp}.${extension}`;
}

function isInvalidFilenameError(error) {
  const message = String(error?.message || "");
  return message.toLowerCase().includes("invalid filename");
}

function waitForTabReady(tabId, sourceUrl, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    const inspectTab = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          cleanup();
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (isTabReadyForExport(tab, sourceUrl)) {
          cleanup();
          resolve();
        }
      });
    };

    const listener = (updatedTabId) => {
      if (updatedTabId !== tabId) {
        return;
      }

      inspectTab();
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        cleanup();
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (isTabReadyForExport(tab, sourceUrl)) {
        cleanup();
        resolve();
        return;
      }

      inspectTab();
    });
  });
}

function closeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTabReadyForExport(tab, sourceUrl) {
  const currentUrl = String(tab?.url || "");
  if (!currentUrl || currentUrl === "about:blank") {
    return false;
  }

  if (tab?.status !== "complete") {
    return false;
  }

  if (currentUrl === sourceUrl) {
    return true;
  }

  return isBatchExportUrl(currentUrl);
}

function initializeHistoryDateRange() {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - DEFAULT_HISTORY_RANGE_DAYS);

  helperStartDateInput.value = toDateInputValue(startDate);
  helperEndDateInput.value = toDateInputValue(endDate);
}

function toDateInputValue(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatWechatAccountLabel(account) {
  if (!account) {
    return "未命名公众号";
  }

  const nickname = String(account.nickname || "").trim();
  const alias = String(account.alias || "").trim();

  if (nickname && alias && alias !== nickname) {
    return `${nickname} (${alias})`;
  }

  return nickname || alias || "未命名公众号";
}

function syncIncludeImages(fromPrimary) {
  const checked = fromPrimary ? includeImagesInput.checked : includeImagesHelperInput.checked;
  includeImagesInput.checked = checked;
  includeImagesHelperInput.checked = checked;
  renderPrimarySurface();
  renderCategoryWorkspace();
}
