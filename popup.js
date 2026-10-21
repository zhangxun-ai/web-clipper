const BACKGROUND_TAB_SETTLE_DELAY_MS = 1500;
const DEFAULT_HISTORY_RANGE_DAYS = 30;
const DOWNLOAD_STATUS_TIMEOUT_MS = 60 * 1000;
const SCYS_EMBEDDED_FRAME_TIMEOUT_MS = 15 * 1000;
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
const helperDownloadButton = document.getElementById("helperDownload");
const helperRefreshButton = document.getElementById("helperRefresh");
const helperResultsEl = document.getElementById("helperArticleResults");
const helperArticleSummaryEl = document.getElementById("helperArticleSummary");
const helperListNoticeEl = document.getElementById("helperListNotice");
const helperArticleListEl = document.getElementById("helperArticleList");
const helperArticleEmptyEl = document.getElementById("helperArticleEmpty");
const helperSelectionSummaryEl = document.getElementById("helperSelectionSummary");
const helperSelectAllButton = document.getElementById("helperSelectAll");
const helperSelectNoneButton = document.getElementById("helperSelectNone");
const helperDownloadSelectedButton = document.getElementById("helperDownloadSelected");
const helperOutputFormatInput = document.getElementById("helperOutputFormat");
const helperLogEl = document.getElementById("helperLog");
const openFeishuSaveButton = document.getElementById("openFeishuSave");
const destinationButtons = Array.from(document.querySelectorAll("[data-destination]"));
const destinationValue = document.getElementById("destinationValue");
const connectionIndicator = document.getElementById("destinationConnection");
const popupRoute = new URL(location.href).searchParams;
const recentSaveModel = globalThis.RecentSaveModel;
let destination = "feishu";
let feishuOverview = { jobs: [], target: null, connection: { state: "checking" } };
let recentLimit = 6;
let openingSave = false;
let obsidianSettingsRequested = false;
const categoryTabButtons = new Map(
  getPopupCategories().map((item) => [
    item.key,
    document.getElementById(`categoryTab${item.key.charAt(0).toUpperCase()}${item.key.slice(1)}`)
  ])
);

let activeTabId = null;
let activeTabUrl = "";
let pageInfo = null;
let isWechatHistoryRunning = false;
let isWechatSelectionDownloading = false;
let wechatHistoryView = null;
let wechatHistorySelection = null;
let wechatProgressTimer = 0;
let wechatQueryStartedAt = 0;
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
helperCheckButton.addEventListener("click", () => refreshWechatHistoryStatus({ silent: false }).catch(() => {}));
helperDownloadButton.addEventListener("click", () => handleWechatHistoryList());
helperRefreshButton.addEventListener("click", () => handleWechatHistoryList({ refresh: true }));
helperDownloadSelectedButton.addEventListener("click", handleWechatSelectedDownload);
helperSelectAllButton.addEventListener("click", () => selectWechatArticles(true));
helperSelectNoneButton.addEventListener("click", () => selectWechatArticles(false));
for (const input of [helperSeedUrlInput, helperStartDateInput, helperEndDateInput]) {
  input.addEventListener("input", () => {
    if (!matchesWechatRange(wechatHistoryView)) {
      wechatHistoryView = null; helperStatusEl.hidden = true;
      renderWechatArticles(); setHistoryControlsDisabled(isWechatHistoryRunning || isWechatSelectionDownloading);
    }
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const selection = changes.wechatHistorySelection?.newValue;
  if (selection) wechatHistorySelection = selection;
  const view = changes.wechatHistoryView?.newValue;
  if (view && matchesWechatRange(view)) {
    applyWechatHistoryView(view);
  } else if (selection && selection.listId === wechatHistoryView?.listId) {
    wechatHistoryView = { ...wechatHistoryView, selectedUrls: selection.urls };
    renderWechatArticles();
  }
});
includeImagesInput.addEventListener("change", () => { syncIncludeImages(true); storageSet({ includeImages: includeImagesInput.checked }); });
includeImagesHelperInput.addEventListener("change", () => { syncIncludeImages(false); storageSet({ includeImages: includeImagesInput.checked }); });
outputTargetInputs.forEach((input) => input.addEventListener("change", handleOutputTargetChange));
pickObsidianFolderButton.addEventListener("click", handlePickObsidianFolder);
clearObsidianFolderButton.addEventListener("click", handleClearObsidianFolder);
destinationButtons.forEach(button => {
  button.addEventListener("click", () => selectDestination(button.dataset.destination));
  button.addEventListener("keydown", event => {
    const index = destinationButtons.indexOf(button);
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const next = destinationButtons[(index + offset + destinationButtons.length) % destinationButtons.length];
    next.focus();
    selectDestination(next.dataset.destination);
  });
});
document.getElementById("changeDestination").addEventListener("click", () => {
  if (destination === "feishu") return openSavePage({ editTarget: true });
  focusObsidianSettings();
});
document.getElementById("moreRecentSaves").addEventListener("click", () => {
  recentLimit += 12;
  renderRecentSaves();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && recentSaveModel.storageKeys.some(key => key in changes)) {
    loadCachedOverview().catch(() => {});
  }
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
document.getElementById("openExportSettings")?.addEventListener("click", () => {
  const settings = document.getElementById("popupAdvancedSettings");
  settings.hidden = !settings.hidden;
  settings.open = !settings.hidden;
  document.getElementById("openExportSettings").setAttribute("aria-expanded", String(!settings.hidden));
  if (!settings.hidden) focusElement(settings.querySelector("summary"));
});
openFeishuSaveButton.addEventListener("click", () => openSavePage({ autoStart: true }));

async function openSavePage({ autoStart = false, editTarget = false } = {}) {
  if (openingSave) return;
  const confirmedTargetUrl = feishuOverview.target?.url || "";
  openingSave = true;
  renderPrimarySurface();
  try {
    const [tab] = await queryActiveTab();
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) throw new Error("请先打开要保存的文章网页。");
    const url = new URL(chrome.runtime.getURL("feishu-save.html"));
    url.searchParams.set("source", tab.url);
    url.searchParams.set("sourceTabId", String(tab.id));
    url.searchParams.set("requestId", crypto.randomUUID());
    if (confirmedTargetUrl) url.searchParams.set("target", confirmedTargetUrl);
    if (autoStart && confirmedTargetUrl) url.searchParams.set("autoStart", "1");
    if (editTarget) url.searchParams.set("editTarget", "1");
    await chrome.tabs.create({ url: url.href });
  } catch (error) {
    setStatus(error.message || "无法打开飞书剪存页。", "error");
  } finally {
    openingSave = false;
    renderPrimarySurface();
  }
}

async function init() {
  initializeHistoryDateRange();
  syncIncludeImages(true);
  await Promise.all([loadPopupPreferences(), loadCachedOverview()]);
  loadFeishuOverview();
  applyOutputTargetToInputs();
  await refreshObsidianBinding({ silent: true });

  const [tab] = await queryActiveTab();
  if (!tab?.id) {
    throw new Error("未找到当前标签页");
  }

  activeTabId = tab.id;
  activeTabUrl = tab.url || "";
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
  const savedRange = (await storageGet(["wechatHistoryInput"])).wechatHistoryInput;
  if (savedRange && (!helperSeedUrlInput.value || helperSeedUrlInput.value === savedRange.seedUrl)
    && isWechatArticleUrl(savedRange.seedUrl) && /^\d{4}-\d{2}-\d{2}$/.test(savedRange.startDate || "")
    && /^\d{4}-\d{2}-\d{2}$/.test(savedRange.endDate || "")) {
    helperSeedUrlInput.value = savedRange.seedUrl;
    helperStartDateInput.value = savedRange.startDate;
    helperEndDateInput.value = savedRange.endDate;
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
    await refreshWechatHistoryStatus({ silent: true }).catch(() => null);
  } else {
    helperStatusEl.hidden = true;
  }

  const savedHistory = await storageGet(["wechatHistoryView", "wechatHistorySelection"]);
  const previousView = savedHistory.wechatHistoryView;
  wechatHistorySelection = savedHistory.wechatHistorySelection || null;
  if (matchesWechatRange(previousView)) {
    applyWechatHistoryView(previousView);
    if (previousView.state === "loading") setHelperStatus("查询进度已保留，可先查看已有文章；点击“继续获取”可接续查询。", "loading");
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
  const shouldDownloadMarkdown = shouldDownload && format === "markdown";

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
      type: "feishu-export:export-document-v2",
      format,
      options: {
        includeImages: includeImagesInput.checked,
        localImageAssets: (shouldDownloadMarkdown || shouldSaveToObsidian) && includeImagesInput.checked
      }
    });
    throwIfExportCanceled();
    const normalizedPayload = await materializeWebImageAssets(normalizeWechatMarkdownPayload(payload), activeTabId);
    throwIfExportCanceled();

    const filename = normalizeDownloadFilename(normalizedPayload.filename, format);
    let downloadedFilename = "";
    let downloadStarted = false;

    if (shouldDownload) {
      setStatus(`正在保存 ${format.toUpperCase()}${normalizedPayload.assets?.length ? " 与图片附件" : ""}：${filename}。`, "loading");
      const downloadOutcome = await downloadExportPayload(normalizedPayload, filename, format);
      throwIfExportCanceled();
      downloadedFilename = downloadOutcome?.filename || filename;
      downloadStarted = downloadOutcome?.started === true;
    }

    let obsidianMessage = "";
    if (shouldSaveToObsidian) {
      await saveCurrentMarkdownToObsidian({
        title: normalizedPayload.title || pageInfo?.title || filename.replace(/\.md$/i, ""),
        sourceUrl: normalizedPayload.sourceUrl || (activeTabId ? String((await queryActiveTab())[0]?.url || "") : ""),
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

function hasWechatArticlesView(view = wechatHistoryView) {
  return Boolean(view?.listId && Array.isArray(view.articles) && matchesWechatRange(view));
}

function applyWechatHistoryView(view) {
  // Legacy saved views have no listId; two missing IDs must not match.
  const selection = view.listId && wechatHistorySelection?.listId === view.listId ? wechatHistorySelection.urls : view.selectedUrls;
  wechatHistoryView = { ...view, selectedUrls: Array.isArray(selection) ? selection : [] };
  renderWechatArticles();
  if (!isWechatHistoryRunning && !isWechatSelectionDownloading) setHistoryControlsDisabled(false);
  if (!isWechatSelectionDownloading) renderWechatHistoryStatus();
  if (view.state !== "loading" && wechatProgressTimer) {
    clearInterval(wechatProgressTimer); wechatProgressTimer = 0;
  }
}

function renderWechatHistoryStatus() {
  const view = wechatHistoryView;
  if (!view || !matchesWechatRange(view) || isWechatSelectionDownloading) return;
  const pages = Number(view.pageCount) || 0, scanned = Number(view.scannedCount) || 0;
  const count = view.articles?.length || 0;
  if (view.state === "error") {
    const details = view.errorDetails || view.details || {};
    const httpStatus = details.httpStatus || view.httpStatus || /^TIKHUB_HTTP_(\d+)$/.exec(view.errorCode || "")?.[1];
    const diagnostics = [httpStatus ? `HTTP ${httpStatus}` : "", Number.isFinite(details.elapsedMs) ? `本次请求 ${(details.elapsedMs / 1000).toFixed(1)} 秒` : ""].filter(Boolean).join("，");
    const prefix = diagnostics ? `${diagnostics}。` : "";
    setHelperStatus(`${prefix}${view.error || "获取未完成。"} 已读取 ${pages} 页、${scanned} 篇；${count ? `保留 ${count} 篇可查看文章，可先下载所选或继续获取。` : "进度已保留，可继续获取。"}`, "error");
  } else if (view.state === "loading") {
    const elapsed = wechatQueryStartedAt ? `，已用 ${Math.floor((Date.now() - wechatQueryStartedAt) / 1000)} 秒` : "";
    setHelperStatus(pages || scanned
      ? `正在${view.refreshing ? "刷新" : "获取"}第 ${pages + 1} 页，已读取 ${scanned} 篇${elapsed}。已有文章可先查看和下载。`
      : `正在识别公众号并获取首批文章${elapsed}…`, "loading");
  } else {
    setHelperStatus(`${view.cached ? "已从本地历史筛选" : "历史列表已收集完成"}，${count} 篇可查看。${view.cached ? "需要最新内容可刷新账号历史。" : "可勾选后下载。"}`, "ready");
  }
}

async function handleWechatHistoryList({ refresh = false } = {}) {
  if (isWechatHistoryRunning || isWechatSelectionDownloading) return;
  const seedUrl = String(helperSeedUrlInput.value || "").trim();
  const startDate = String(helperStartDateInput.value || "").trim();
  const endDate = String(helperEndDateInput.value || "").trim();
  if (!isWechatArticleUrl(seedUrl)) { setHelperStatus("请粘贴该公众号任意一篇文章的链接。", "error"); return; }
  if (!startDate || !endDate) { setHelperStatus("请选择开始和结束日期。", "error"); return; }
  if (startDate > endDate) { setHelperStatus("开始日期不能晚于结束日期。", "error"); return; }

  const resume = !refresh && ["error", "loading"].includes(wechatHistoryView?.state) && wechatHistoryView?.refreshing === true;
  isWechatHistoryRunning = true; wechatQueryStartedAt = Date.now();
  clearHelperLog();
  const previous = matchesWechatRange(wechatHistoryView) ? wechatHistoryView : {};
  wechatHistoryView = { ...previous, seedUrl, startDate, endDate, state: "loading", refreshing: refresh || resume,
    articles: previous.articles || [], selectedUrls: previous.selectedUrls || [] };
  renderWechatArticles(); setHistoryControlsDisabled(true); renderWechatHistoryStatus();
  clearInterval(wechatProgressTimer);
  wechatProgressTimer = setInterval(() => renderWechatHistoryStatus(), 1000);
  try {
    const result = await callWechatHistoryService("list", { seedUrl, startDate, endDate, ...(refresh ? { refresh: true } : {}), ...(resume ? { resume: true } : {}) });
    for (const line of result.logs || []) appendHelperLog(line);
    applyWechatHistoryView({ ...wechatHistoryView, ...result, state: result.complete ? "ready" : "loading", refreshing: false });
  } catch (error) {
    // Storage can contain newer partial results than the original message callback.
    const saved = (await storageGet(["wechatHistoryView"]).catch(() => ({}))).wechatHistoryView;
    if (matchesWechatRange(saved)) wechatHistoryView = saved;
    applyWechatHistoryView({ ...wechatHistoryView, state: "error", error: error.message || "公众号文章查询失败", errorCode: error.code,
      errorDetails: error.details || wechatHistoryView?.errorDetails });
    appendHelperLog(error.message || "公众号文章查询失败", "error");
  } finally {
    clearInterval(wechatProgressTimer); wechatProgressTimer = 0;
    isWechatHistoryRunning = false; setHistoryControlsDisabled(isWechatSelectionDownloading);
  }
}

function matchesWechatRange(view) {
  return Boolean(view && view.seedUrl === helperSeedUrlInput.value.trim()
    && view.startDate === helperStartDateInput.value && view.endDate === helperEndDateInput.value);
}

function selectedWechatUrls() {
  const selected = new Set(wechatHistoryView?.selectedUrls || []);
  return (wechatHistoryView?.articles || []).filter(article => selected.has(article.url)).map(article => article.url);
}

function updateWechatSelectionControls() {
  const total = hasWechatArticlesView() ? wechatHistoryView.articles.length : 0;
  const count = selectedWechatUrls().length;
  helperSelectionSummaryEl.textContent = `已选 ${count} / ${total} 篇`;
  helperDownloadSelectedButton.textContent = isWechatSelectionDownloading ? "正在核验并创建下载…" : count ? `下载所选 ${count} 篇` : "勾选文章后下载";
  helperDownloadSelectedButton.disabled = isWechatSelectionDownloading || !count || !hasWechatArticlesView();
  helperSelectAllButton.disabled = isWechatSelectionDownloading || !total;
  helperSelectNoneButton.disabled = isWechatSelectionDownloading || !count;
  for (const checkbox of helperArticleListEl.querySelectorAll("input[type=checkbox]")) checkbox.disabled = isWechatSelectionDownloading;
  helperRefreshButton.hidden = !hasWechatArticlesView();
  helperRefreshButton.disabled = isWechatHistoryRunning || isWechatSelectionDownloading;
}

function persistWechatSelection(urls) {
  wechatHistoryView = { ...wechatHistoryView, selectedUrls: urls };
  wechatHistorySelection = { listId: wechatHistoryView.listId, urls };
  // Selection has its own key so a click cannot overwrite a newer background page.
  storageSet({ wechatHistorySelection }).catch(() => setHelperStatus("文章选择未能保存，请保持弹窗打开后下载。", "error"));
}

function renderWechatArticles() {
  const visible = hasWechatArticlesView();
  helperResultsEl.hidden = !visible;
  const activeLabel = helperArticleListEl.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
  helperArticleListEl.replaceChildren();
  if (!visible) { updateWechatSelectionControls(); return; }
  const view = wechatHistoryView;
  const uncertain = view.articles.filter(article => !article.publishDate || article.candidateDate || article.publicationSource === "message" && !article.dateVerified).length;
  helperArticleSummaryEl.textContent = `${formatWechatAccountLabel(view.matchedAccount)} · ${view.startDate} ～ ${view.endDate} · ${view.articles.length} 篇${uncertain ? `（${uncertain} 篇日期待核验）` : ""}`;
  const collected = view.lastCompleteAt || view.queriedAt;
  const collectedDate = collected ? new Date(collected) : null;
  const collectedText = collectedDate && Number.isFinite(collectedDate.getTime()) ? `历史采集于 ${collectedDate.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}。` : "";
  helperListNoticeEl.textContent = view.refreshing
    ? `${collectedText}保留上次历史，并陆续补入本次取得的文章；刷新尚未完成。`
    : view.complete
    ? `${collectedText}${view.refreshing ? "当前显示上次完整历史，正在补充新内容。" : "已读取供应商全部历史页；下载前核验所选文章日期。"}`
    : "历史尚未收集完，已有文章可先查看和下载；日期将在下载前核验。";
  helperArticleEmptyEl.hidden = view.articles.length > 0;
  helperArticleEmptyEl.textContent = view.complete ? "已有历史在此日期范围内没有文章，可调整日期或刷新账号历史。" : "暂未找到此范围的文章，历史尚未收集完，可继续获取。";
  const selected = new Set(view.selectedUrls || []);
  for (const article of view.articles) {
    const row = document.createElement("li"); row.className = "history-article";
    const label = document.createElement("label"); label.className = "history-article-check";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox";
    checkbox.checked = selected.has(article.url);
    checkbox.setAttribute("aria-label", `选择 ${article.title}`);
    checkbox.addEventListener("change", () => {
      const urls = new Set(wechatHistoryView.selectedUrls || []);
      if (checkbox.checked) urls.add(article.url); else urls.delete(article.url);
      persistWechatSelection([...urls]); updateWechatSelectionControls();
    });
    label.append(checkbox);
    const copy = document.createElement("div"); copy.className = "history-article-copy";
    const link = document.createElement("a"); link.className = "history-article-link";
    link.textContent = article.title || "未命名文章"; link.href = article.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const date = document.createElement("time"); date.className = "history-article-date";
    if (article.publishDate) date.dateTime = article.publishDate;
    date.textContent = article.publishDate ? `${article.publishDate}${article.candidateDate || article.publicationSource === "message" && !article.dateVerified ? "（待核验）" : ""}` : "发表日期待核验";
    copy.append(link, date); row.append(label, copy); helperArticleListEl.append(row);
  }
  updateWechatSelectionControls();
  if (activeLabel) for (const checkbox of helperArticleListEl.querySelectorAll("input[type=checkbox]")) {
    if (checkbox.getAttribute("aria-label") === activeLabel) { checkbox.focus({ preventScroll: true }); break; }
  }
}

function selectWechatArticles(all) {
  if (!hasWechatArticlesView() || isWechatSelectionDownloading) return;
  persistWechatSelection(all ? wechatHistoryView.articles.map(article => article.url) : []);
  renderWechatArticles();
}

async function handleWechatSelectedDownload() {
  if (isWechatSelectionDownloading || !hasWechatArticlesView()) return;
  const articleUrls = selectedWechatUrls();
  if (!articleUrls.length) { setHelperStatus("请先勾选要下载的文章。", "error"); return; }
  const request = { listId: wechatHistoryView.listId, articleUrls,
    options: { includeImages: includeImagesHelperInput.checked, zipOutput: helperOutputFormatInput.value === "zip", outputTarget: "download" } };
  isWechatSelectionDownloading = true; setHistoryControlsDisabled(true);
  setHelperStatus(`正在核验所选 ${articleUrls.length} 篇文章并创建本地下载任务…`, "loading");
  try {
    const result = await callWechatHistoryService("download-selected", request);
    const format = request.options.zipOutput ? "ZIP" : "Markdown";
    setHelperStatus(`已打开本地 ${format} 下载任务，共 ${result.links.length} 篇。`, "ready");
  } catch (error) { setHelperStatus(error.message || "创建下载任务失败", "error"); }
  finally { isWechatSelectionDownloading = false; setHistoryControlsDisabled(isWechatHistoryRunning); }
}

async function refreshWechatHistoryStatus({ silent = false } = {}) {
  try {
    const payload = await callWechatHistoryService("status");
    const message = payload.configured ? "下载连接已就绪，无需登录公众号后台。"
      : "未配置下载服务，请在本机项目 .env 中设置 TIKHUB_API_KEY。";
    setHelperStatus(message, payload.configured ? "ready" : "error");
    if (!silent) appendHelperLog(message, payload.configured ? "success" : "error");
    return payload;
  } catch (error) {
    setHelperStatus(error.message || "检测下载连接失败", "error");
    if (!silent) appendHelperLog(error.message || "检测下载连接失败", "error");
    throw error;
  }
}

function callWechatHistoryService(action, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "wechat-history", action, params }, response => {
      if (chrome.runtime.lastError) return reject(new Error("下载连接中断，请刷新扩展后重试。"));
      if (!response?.ok) return reject(Object.assign(new Error(response?.error || "公众号列表请求失败。"), { code: response?.code, details: response?.details }));
      resolve(response.data);
    });
  });
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

  // An older page has a receiver, but does not recognize the updated export
  // message. Upgrade before reading instead of waiting for a missing-port error.
  if (message.type === "feishu-export:export-document-v2") {
    await injectContentScript(tabId, frameId);
    return sendMessageToTab(tabId, message, frameId);
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
        files: ["shared/scys-course-utils.js", "shared/web-markdown-utils.js", "shared/web-feishu-blocks.js", "shared/image-asset.js", "content-scripts/feishu-exporter.js"]
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
    const sourceId = activeTabId || Number(popupRoute.get("sourceTabId"));
    if (Number.isInteger(sourceId) && sourceId > 0) {
      chrome.tabs.get(sourceId, tab => {
        if (chrome.runtime.lastError || !tab) return reject(new Error("原文章页已关闭，请从文章页重新打开插件。"));
        const requestedSource = popupRoute.get("source");
        if (requestedSource && tab.url !== requestedSource) return reject(new Error("原文章页已切换，请从文章页重新打开插件。"));
        resolve([tab]);
      });
      return;
    }
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
          resolve({ downloadId, filename: getDownloadDisplayFilename(item, fallbackFilename), path: item?.filename || "" });
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
        finish(() => resolve({ downloadId, filename: getDownloadDisplayFilename(item, fallbackFilename), path: item?.filename || "" }));
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
  helperDownloadButton.disabled = disabled;
  helperSeedUrlInput.disabled = disabled;
  helperStartDateInput.disabled = disabled;
  helperEndDateInput.disabled = disabled;
  includeImagesHelperInput.disabled = isWechatSelectionDownloading;
  helperOutputFormatInput.disabled = isWechatSelectionDownloading;
  helperDownloadButton.textContent = isWechatHistoryRunning ? "正在获取历史…"
    : matchesWechatRange(wechatHistoryView) && (wechatHistoryView.state === "loading" || wechatHistoryView.state === "error") ? "继续获取" : "获取文章列表";
  updateWechatSelectionControls();
}

function setPageMeta(info) {
  titleEl.textContent = info?.title || "请先打开文章或文档";
  typeEl.textContent = detectedCategory === "scys" ? "生财有术"
    : detectedCategory === "wechat" && info?.docType !== "公众号后台" ? "微信公众号"
    : info?.docType || "暂无可导出的正文";
}

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.className = `status status-${variant}`;
  statusEl.hidden = variant === "ready" && message === "可以导出";
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
  outputTarget = normalizeOutputTarget(outputTargetInputs.find(input => input.checked)?.value, outputTarget);
  destination = outputTarget === "download" ? "local" : "obsidian";
  applyOutputTargetToInputs();
  await Promise.all([persistOutputTarget(), storageSet({ clipperDestination: destination })]);
  renderPrimarySurface();
  renderCategoryWorkspace();
}

function renderPrimarySurface() {
  renderOutputTargetUi();

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
    primaryActionButton.hidden = !action || (destination === "feishu" && action.key !== "focus-wechat-history" && !activeExportTask);
    if (actionButtonsLocked && activeExportTask && action) {
      primaryActionButton.disabled = false;
      primaryActionButton.textContent = "停止导出";
      primaryActionButton.dataset.actionKey = "cancel-export";
    } else {
      primaryActionButton.disabled = !action
        || (actionButtonsLocked && action.key !== "focus-wechat-history")
        || (action.key === "export-course" && !courseExportEnabled);
      primaryActionButton.textContent = action?.label || "当前页暂不支持";
      if (action?.key === "export-markdown" && destination === "obsidian") {
        primaryActionButton.textContent = !obsidianBinding ? "选择 Obsidian 目录" : "保存到 Obsidian";
      } else if (action?.key === "export-markdown" && destination === "local") {
        primaryActionButton.textContent = "导出 Markdown";
      }
      primaryActionButton.dataset.actionKey = action?.key || "";
    }
  }
  if (secondaryActionButton) {
    const action = primaryActionModel.secondaryAction;
    secondaryActionButton.hidden = !action || destination === "feishu";
    secondaryActionButton.disabled = actionButtonsLocked || !action;
    secondaryActionButton.textContent = action?.label || "";
    secondaryActionButton.dataset.actionKey = action?.key || "";
  }
  renderDestinationUi();
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
  if (destination === "obsidian" && !obsidianBinding && ["export-markdown", "export-course"].includes(actionKey)) {
    focusObsidianSettings();
    await handlePickObsidianFolder();
    return;
  }
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
  const result = await storageGet(["outputTarget", "obsidianSyncEnabled", "clipperDestination", "includeImages"]);
  const requested = popupRoute.get("destination");
  destination = ["feishu", "obsidian", "local"].includes(requested) ? requested
    : ["feishu", "obsidian", "local"].includes(result.clipperDestination) ? result.clipperDestination : "feishu";
  if (typeof result.includeImages === "boolean") {
    includeImagesInput.checked = result.includeImages;
    includeImagesHelperInput.checked = result.includeImages;
  }
  outputTarget = normalizeOutputTarget(
    result.outputTarget,
    result.obsidianSyncEnabled === true ? "both" : "download"
  );
  if (destination === "local") outputTarget = "download";
  if (destination === "obsidian" && outputTarget === "download") outputTarget = "obsidian";
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
      outputTarget = destination === "obsidian" ? "obsidian" : "download";
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
    focusObsidianSettings();
    return false;
  }

  let permission = binding.permission;
  if (permission !== "granted") {
    permission = await obsidianVaultStorage.ensureVaultPermission?.(binding.handle, "readwrite");
    await refreshObsidianBinding({ silent: true });
  }

  if (permission !== "granted") {
    setStatus("Obsidian 目录授权已失效，请重新授权后再导出。", "error");
    focusObsidianSettings();
    return false;
  }

  return true;
}

async function saveCurrentMarkdownToObsidian(payload) {
  const binding = await refreshObsidianBinding({ silent: true });
  if (!binding || binding.permission !== "granted") {
    throw new Error("Obsidian 目录不可用，请先重新授权");
  }

  const archived = obsidianExportApi.namespaceObsidianAssets(payload.markdown, payload.assets, crypto.randomUUID());
  const note = buildObsidianNoteFile?.({
    title: payload.title,
    sourceUrl: payload.sourceUrl,
    exportedAt: new Date().toISOString(),
    markdown: extractBodyMarkdown(archived.markdown)
  });

  if (!note) {
    throw new Error("Obsidian 导出模块未加载");
  }

  note.path = await availableObsidianNotePath(binding.handle, note.path);
  // Publish the note only after all of its images have been written. Failed
  // image writes cannot replace an existing complete note with a broken one.
  await writeObsidianAssetFiles(binding.handle, note.path, archived.assets);
  await obsidianVaultStorage.writeTextFiles?.(binding.handle, [note]);
  setObsidianStatus(`已写入 Obsidian：${note.path}`, "ready");
}

async function availableObsidianNotePath(rootHandle, notePath) {
  const parts = notePath.split("/");
  const filename = parts.pop();
  let directory = rootHandle;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  let candidate = filename;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error.name === "NotFoundError") return [...parts, candidate].join("/");
      throw error;
    }
    candidate = filename.replace(/\.md$/i, `-${crypto.randomUUID().slice(0, 8)}.md`);
  }
  throw new Error("Obsidian 同名笔记较多，请更换保存位置后重试。");
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

async function materializeWebImageAssets(payload, tabId) {
  const requests = Array.isArray(payload?.imageRequests) ? payload.imageRequests : [];
  if (!requests.length) return payload;
  let content = String(payload.content || "");
  const assets = [...(Array.isArray(payload.assets) ? payload.assets : [])];
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
  for (const [index, entry] of requests.entries()) {
    if (!/^assets\/web-image-\d+$/.test(entry.reference || "")) throw new Error("图片留档路径无效，未生成不完整文件。");
    throwIfExportCanceled();
    setStatus(`正在读取原图 ${index + 1}/${requests.length}…`, "loading");
    const response = await chrome.runtime.sendMessage({ type: "exporter:capture-web-image",
      sourceUrl: payload.sourceUrl, url: entry.url, tabId });
    if (!response?.ok) throw new Error(`第 ${index + 1} 张图片未保存：${response?.error || "图片读取失败"}`);
    const image = response.data;
    const extension = extensions[image?.mimeType];
    if (!extension || !image.contentBase64) throw new Error(`第 ${index + 1} 张图片数据无效，未生成缺图留档。`);
    const path = `${entry.reference}.${extension}`;
    assets.push({ path, mimeType: image.mimeType, contentBase64: image.contentBase64 });
    content = content.split(`(${entry.reference})`).join(`(${path})`);
  }
  return { ...payload, content, assets, imageRequests: [] };
}

async function downloadExportPayload(payload, filename, format) {
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  if (assets.length === 0) {
    return downloadGeneratedText(
      payload.content,
      payload.mimeType,
      filename,
      format,
      false
    );
  }

  // Reuse the Obsidian attachment convention, with a fresh namespace for each
  // save so duplicate article titles cannot overwrite earlier images.
  const archived = obsidianExportApi.namespaceObsidianAssets(payload.content, assets, crypto.randomUUID());
  const files = archived.assets.map(asset => ({ ...asset, bytes: base64ToUint8Array(asset.contentBase64) }));
  let downloadDirectory = "";
  for (const [index, asset] of files.entries()) {
    throwIfExportCanceled();
    setStatus(`正在保存图片 ${index + 1}/${files.length}…`, "loading");
    const result = await downloadGeneratedBlob(new Blob([asset.bytes], { type: asset.mimeType || "application/octet-stream" }),
      asset.path, format, false, true);
    const actualPath = String(result?.path || "").replace(/\\/g, "/");
    if (!actualPath.endsWith(`/${asset.path}`)) throw new Error("图片保存位置发生变化，已停止生成文章，避免图片路径失效。请检查浏览器下载设置后重试。");
    const directory = actualPath.slice(0, -asset.path.length);
    if (downloadDirectory && downloadDirectory !== directory) throw new Error("图片保存到了不同目录，已停止生成不完整文章。");
    downloadDirectory = directory;
  }
  throwIfExportCanceled();
  setStatus(`图片已保存，正在生成文章：${filename}。`, "loading");
  const result = await downloadGeneratedBlob(new Blob([archived.markdown], { type: payload.mimeType }), filename, format, false, true);
  const notePath = String(result?.path || "").replace(/\\/g, "/");
  if (notePath.slice(0, notePath.lastIndexOf("/") + 1) !== downloadDirectory) {
    throw new Error("文章与图片保存位置不一致，请将文章放回图片目录旁边；此次未确认为完整保存。");
  }
  return { ...result, started: true };
}

async function downloadGeneratedText(content, mimeType, filename, format, saveAs) {
  return downloadTextWithAnchor(content, mimeType, filename, format);
}

async function downloadGeneratedBlob(blob, filename, format, saveAs, preservePath = false) {
  const url = URL.createObjectURL(blob);
  try {
    // A fallback filename would silently break Markdown attachment references.
    return preservePath ? await downloadFile({ url, filename, saveAs, conflictAction: "uniquify" })
      : await downloadWithFallback(url, filename, format, saveAs);
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

async function selectDestination(value) {
  if (!["feishu", "obsidian", "local"].includes(value) || activeExportTask || openingSave) return;
  destination = value;
  obsidianSettingsRequested = false;
  if (value === "local") outputTarget = "download";
  if (value === "obsidian") outputTarget = outputTarget === "both" ? "both" : "obsidian";
  applyOutputTargetToInputs();
  renderPrimarySurface();
  renderCategoryWorkspace();
  await Promise.all([persistOutputTarget(), storageSet({ clipperDestination: value })]);
}

function focusObsidianSettings() {
  obsidianSettingsRequested = true;
  const dock = document.getElementById("obsidianDock");
  dock.hidden = false;
  focusElement(pickObsidianFolderButton);
}

function renderDestinationUi() {
  const feishu = destination === "feishu";
  const backend = pageInfo?.docType === "公众号后台";
  document.getElementById("workspaceShell").dataset.destination = destination;
  destinationButtons.forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.destination === destination));
    button.disabled = Boolean(activeExportTask || openingSave);
  });
  document.getElementById("changeDestination").hidden = destination === "local" || backend;
  document.getElementById("changeDestination").disabled = Boolean(activeExportTask || openingSave);
  document.getElementById("changeDestinationLabel").textContent = "更改";
  document.getElementById("contentOptions").hidden = feishu || backend;
  document.getElementById("obsidianDock").hidden = destination !== "obsidian" && !obsidianSettingsRequested;
  if (feishu) {
    const target = feishuOverview.target;
    destinationValue.textContent = target ? [target.spaceName, target.title].filter(Boolean).join(" / ") : "选择知识库位置";
    if (!target) document.getElementById("changeDestinationLabel").textContent = "选择";
    const state = feishuOverview.connection?.state || "checking";
    connectionIndicator.dataset.state = state;
    connectionIndicator.textContent = ({ connected: "连接器已就绪", checking: "正在检测连接…", setup: "需要首次连接", needs_auth: "需要恢复授权", error: "连接暂不可用" })[state];
    connectionIndicator.hidden = backend;
  } else {
    destinationValue.textContent = obsidianBinding?.meta?.folderName || obsidianBinding?.handle?.name || "选择 Obsidian 目录";
    if (outputTarget === "both" && obsidianBinding) destinationValue.textContent += " · 同时下载到本地";
    connectionIndicator.hidden = true;
  }
  openFeishuSaveButton.hidden = !feishu || backend || Boolean(activeExportTask);
  openFeishuSaveButton.disabled = openingSave || !/^https?:\/\//i.test(activeTabUrl);
  openFeishuSaveButton.textContent = openingSave ? "正在打开…" : "保存到飞书";
}

async function loadCachedOverview() {
  const cached = recentSaveModel.readStoredOverview(await storageGet(recentSaveModel.storageKeys));
  feishuOverview = { ...feishuOverview, ...cached };
  renderRecentSaves();
  renderPrimarySurface();
}

async function loadFeishuOverview() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "feishu-clip", action: "overview" });
    if (!result?.ok) throw new Error(result?.error || "无法读取连接状态");
    feishuOverview = result.data;
  } catch (_) {
    // A connector check must never hide locally retained save results.
    feishuOverview.connection = { state: "error" };
  }
  renderRecentSaves();
  renderPrimarySurface();
}

function renderRecentSaves() {
  const rows = recentSaveModel.buildRecentSaves(feishuOverview.jobs, chrome.runtime.getURL(""));
  const pending = rows.filter(row => row.status === "running").length;
  const paused = rows.filter(row => row.status === "paused").length;
  const summary = document.getElementById("recentSummary");
  summary.textContent = pending ? `${pending} 项处理中` : paused ? `${paused} 项需处理` : "";
  summary.dataset.attention = String(paused > 0);
  const list = document.getElementById("recentSaveList");
  // Preserve focus and scroll while the background updates the same tasks.
  const visible = rows.slice(0, recentLimit);
  const signature = JSON.stringify(visible);
  if (list.dataset.signature !== signature) {
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.jobId : null;
    list.replaceChildren(...visible.map(row => {
      const item = document.createElement("li");
      const link = document.createElement(row.href ? "a" : "div");
      link.className = "recent-save";
      link.dataset.jobId = row.id;
      if (row.href) { link.href = row.href; link.target = "_blank"; link.rel = "noopener noreferrer"; }
      const title = document.createElement("span");
      title.className = "recent-title";
      title.textContent = row.title;
      const state = document.createElement("span");
      state.className = `recent-state recent-state-${row.status}`;
      state.textContent = row.label;
      const target = document.createElement("span");
      target.className = "recent-target";
      target.textContent = row.targetLabel ? `飞书 · ${row.targetLabel}` : "飞书";
      link.append(title, state, target);
      item.append(link);
      return item;
    }));
    list.dataset.signature = signature;
    if (focusedId) Array.from(list.querySelectorAll("a")).find(link => link.dataset.jobId === focusedId)?.focus({ preventScroll: true });
  }
  document.getElementById("recentEmpty").hidden = rows.length > 0;
  document.getElementById("moreRecentSaves").hidden = rows.length <= recentLimit;
}
