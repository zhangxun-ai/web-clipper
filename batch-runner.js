const BACKGROUND_TAB_SETTLE_DELAY_MS = 1500;
const INTER_TASK_DELAY_MS = 1200;
const MAX_RETRIES = 2;
const COURSE_EXPORT_WORKER_STAGGER_MS = 900;
const MESSAGE_FETCH_ASSET = "exporter:fetch-asset";
const exportUrlUtils = globalThis.ExportUrlUtils || {};
const exportUiModels = globalThis.ExportUiModels || {};
const courseExportBuilders = globalThis.CourseExportBuilders || {};
const courseExportRuntime = globalThis.CourseExportRuntime || {};
const obsidianExportApi = globalThis.ObsidianExport || {};
const obsidianVaultStorage = globalThis.ObsidianVaultStorage || {};
const isBatchExportUrl = (url) => exportUrlUtils.isBatchExportUrl?.(url) || false;
const isSingleExportUrl = (url) => exportUrlUtils.isSingleExportUrl?.(url) || false;
const isWechatArticleUrl = (url) => exportUrlUtils.isWechatArticleUrl?.(url) || false;
const extractCourseChapterMarkdown = (value) => courseExportBuilders.extractCourseChapterMarkdown?.(value) || String(value || "").trim();
const getCourseChapterMarkdownError = (value, sourceUrl) => courseExportBuilders.getCourseChapterMarkdownError?.(value, sourceUrl) || "";
const buildCourseStoppedMessage = (value) => courseExportRuntime.buildCourseStoppedMessage?.(value) || "专栏导出已停止。";
const extractScysCourseApiMarkdown = (value) => courseExportRuntime.extractScysCourseApiMarkdown?.(value) || "";
const formatElapsedDuration = (value) => courseExportRuntime.formatElapsedDuration?.(value) || "00:00";
const getScysCourseIdFromUrl = (value) => courseExportRuntime.getScysCourseIdFromUrl?.(value) || "";
const getCourseExportExecutionProfileForTotal = (totalCount) => courseExportRuntime.getCourseExportExecutionProfile?.(totalCount) || null;
const getCourseExportWorkerCountForTotal = (totalCount) => courseExportRuntime.getCourseExportWorkerCount?.(totalCount) || 1;
const isScysCourseApiRateLimited = (value) => courseExportRuntime.isScysCourseApiRateLimited?.(value) || false;
const normalizeOutputTarget = (value, fallback) => exportUiModels.normalizeOutputTarget?.(value, fallback) || "download";
const getOutputTargetState = (value) => exportUiModels.getOutputTargetState?.(value) || {
  key: "download",
  wantsDownload: true,
  wantsObsidian: false,
  label: "仅下载"
};
const buildObsidianNoteFile = (payload) => obsidianExportApi.buildObsidianNoteFile?.(payload);
const buildObsidianCourseBundle = (payload) => obsidianExportApi.buildObsidianCourseBundle?.(payload);
const maybeStripWechatUiNoiseFromMarkdown = (value) => {
  const externalCleaner = globalThis.WechatMarkdownCleanup?.maybeStripWechatUiNoiseFromMarkdown;
  const cleaned = typeof externalCleaner === "function" ? externalCleaner(value) : value;
  return forceStripWechatNoiseTail(cleaned);
};

const titleEl = document.getElementById("jobTitle");
const metaEl = document.getElementById("jobMeta");
const statusEl = document.getElementById("jobStatus");
const obsidianRetryPanelEl = document.getElementById("obsidianRetryPanel");
const obsidianRetryCopyEl = document.getElementById("obsidianRetryCopy");
const retryObsidianWriteButton = document.getElementById("retryObsidianWrite");
const progressEl = document.getElementById("jobProgress");
const successEl = document.getElementById("jobSuccess");
const failureEl = document.getElementById("jobFailure");
const workersEl = document.getElementById("jobWorkers");
const elapsedEl = document.getElementById("jobElapsed");
const resultSummaryEl = document.getElementById("resultSummary");
const resultListEl = document.getElementById("resultList");
const resultActionsEl = document.getElementById("resultActions");
const workerDetailsEl = document.getElementById("workerDetails");
const workerPanelEl = document.getElementById("workerPanel");
const workerGridEl = document.getElementById("workerGrid");
const logEl = document.getElementById("jobLog");
let wechatDirectFetchEnabled = true;
let jobStartedAt = Date.now();
let elapsedTimerId = 0;
let workerStates = [];
let pendingObsidianRetry = null;
let cachedObsidianBinding = null;
let cachedObsidianBindingPromise = null;
let stopRequested = false;
const activeTaskTabIds = new Set();
const resultEntryCache = new Set();
const stopTaskButton = createStopTaskButton();

resultActionsEl?.prepend(stopTaskButton);
retryObsidianWriteButton?.addEventListener("click", handleRetryObsidianWrite);

function createStopTaskButton() {
  const button = document.createElement("button");
  button.id = "stopTask";
  button.className = "button button-subtle";
  button.type = "button";
  button.hidden = true;
  button.textContent = "停止任务";
  button.addEventListener("click", handleStopTask);
  return button;
}

function handleStopTask() {
  if (stopRequested) {
    return;
  }

  stopRequested = true;
  setStopTaskActive(true);
  setStatus("正在停止任务，请稍候…", "error");
  appendLog("已请求停止任务：不再领取后续任务，并关闭当前通道。", "error");
  closeActiveTaskTabs();
}

function setStopTaskActive(active) {
  if (!stopTaskButton) {
    return;
  }

  if (!active && !stopRequested) {
    stopTaskButton.hidden = true;
    return;
  }

  stopTaskButton.hidden = false;
  stopTaskButton.disabled = stopRequested || !active;
  stopTaskButton.textContent = stopRequested ? "正在停止" : "停止任务";
}

function closeActiveTaskTabs() {
  for (const tabId of Array.from(activeTaskTabIds)) {
    closeTab(tabId);
  }
}

init().catch((error) => {
  metaEl.textContent = "";
  setStatus(error.message || "任务初始化失败", "error");
  appendLog(error.message || "任务初始化失败", "error");
});

async function init() {
  const jobId = new URL(location.href).searchParams.get("jobId");
  if (!jobId) {
    throw new Error("未找到下载任务，请从插件重新开始。");
  }

  const job = await loadJob(jobId);
  if (!job) {
    throw new Error("下载任务已失效，请从插件重新开始。");
  }

  cachedObsidianBinding = await primeObsidianBinding();

  const totalCount = getJobTotal(job);
  document.getElementById("jobStats").hidden = false;
  jobStartedAt = Date.now();
  titleEl.textContent = job.title || (job.type === "course-export" ? "专栏导出任务" : "批量下载任务");
  metaEl.textContent = buildMeta(job);
  setStatus(`任务已加载，共 ${totalCount} ${getJobUnitLabel(job)}，开始处理。`, "loading");
  updateStats(0, 0, 0, totalCount);
  setStopTaskActive(true);
  startElapsedClock();

  try {
    if (job.type === "course-export") {
      await runCourseExportJob(job);
    } else {
      await runLinkBatchJob(job);
    }
  } finally {
    stopElapsedClock();
    updateElapsedClock();
    setStopTaskActive(false);
    await removeJob(jobId);
  }
}

async function runLinkBatchJob(job) {
  const outputTarget = getJobOutputTargetState(job);
  const zipOutput = job.zipOutput !== false && outputTarget.wantsDownload;
  const zipBuilder = zipOutput ? new SimpleZipBuilder() : null;
  const usedNames = new Set();
  const exportedEntries = [];
  const failedEntries = [];
  const totalCount = getJobTotal(job);
  let successCount = 0;
  let failureCount = 0;
  let completedCount = 0;

  for (let index = 0; index < job.links.length; index += 1) {
    if (stopRequested) {
      break;
    }
    const link = job.links[index];
    updateStats(completedCount, successCount, failureCount, totalCount);
    setStatus(`正在处理 ${index + 1}/${totalCount} 篇`, "loading");
    appendLog(`开始处理 ${index + 1}/${totalCount}: ${link}`);

    try {
      const rawResult = await exportLinkWithRetry(link, {
        format: "markdown",
        includeImages: job.includeImages !== false
      });
      const result = normalizeWechatMarkdownResult(rawResult);

      if (outputTarget.wantsObsidian) {
        try {
          await writeSingleNoteToObsidian(link, result);
        } catch (error) {
          appendLog(`写入 Obsidian 失败：${error.message || "未知错误"}`, "error");
        }
      }

      if (zipBuilder) {
        const entryName = uniquifyZipEntryName(result.filename, usedNames);
        zipBuilder.addText(entryName, result.content);
        exportedEntries.push({
          url: link,
          filename: entryName
        });
        appendLog(`已加入 ZIP: ${entryName}`, "success");
      } else if (outputTarget.wantsDownload) {
        await downloadExportResult(result);
        exportedEntries.push({
          url: link,
          filename: result.filename
        });
        appendLog(`已下载: ${result.filename}`, "success");
      } else {
        exportedEntries.push({
          url: link,
          filename: result.filename
        });
      }

      successCount += 1;
    } catch (error) {
      if (stopRequested) {
        break;
      }
      failureCount += 1;
      failedEntries.push({
        url: link,
        message: error.message || "未知错误"
      });
      appendLog(`失败: ${link} | ${error.message || "未知错误"}`, "error");
    }

    completedCount += 1;
    if (!stopRequested) {
      await sleep(INTER_TASK_DELAY_MS);
    }
  }

  setStopTaskActive(false);

  if (zipBuilder && successCount > 0) {
    setStatus(`正在打包 ZIP，共 ${successCount} 篇。`, "loading");
    const manifestContent = JSON.stringify(
      {
        title: job.title,
        source: job.source,
        includeImages: job.includeImages !== false,
        zipOutput: true,
        account: job.account || null,
        dateRange: job.dateRange || null,
        successCount,
        failureCount,
        exportedEntries,
        failedEntries,
        createdAt: job.createdAt,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
    zipBuilder.addText("manifest.json", manifestContent);
    zipBuilder.addText(
      "articles.txt",
      exportedEntries.length > 0
        ? exportedEntries.map((entry) => `${entry.filename}\t${entry.url}`).join("\n")
        : "本次没有成功导出的文章。"
    );
    if (failedEntries.length > 0) {
      zipBuilder.addText(
        "failed.txt",
        failedEntries.map((entry) => `${entry.url}\t${entry.message}`).join("\n")
      );
    }
    const zipBlob = zipBuilder.buildBlob();
    const zipUrl = URL.createObjectURL(zipBlob);
    const zipFilename = buildZipFilename(job.title || "批量下载任务");

    try {
      await downloadFile({
        url: zipUrl,
        filename: zipFilename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      appendLog(`ZIP 已生成: ${zipFilename}`, "success");
    } finally {
      setTimeout(() => URL.revokeObjectURL(zipUrl), 1000);
    }
  }

  updateStats(completedCount, successCount, failureCount, totalCount);

  if (stopRequested) {
    const skippedCount = Math.max(0, totalCount - completedCount);
    setStatus(`任务已停止，成功 ${successCount} 篇，失败 ${failureCount} 篇，未处理 ${skippedCount} 篇。`, "error");
    appendLog(`任务已停止，未处理 ${skippedCount} 篇。`, "error");
  } else if (failureCount === 0) {
    if (outputTarget.key === "both") {
      setStatus(zipOutput ? `输出完成，已打包 ZIP 并同步 Obsidian，共 ${successCount} 篇。` : `输出完成，已下载并同步 Obsidian，共 ${successCount} 篇。`, "ready");
    } else if (outputTarget.key === "obsidian") {
      setStatus(`输出完成，已写入 Obsidian，共 ${successCount} 篇。`, "ready");
    } else {
      setStatus(zipOutput ? `下载完成，并已打包 ZIP，共 ${successCount} 篇。` : `下载完成，共 ${successCount} 篇。`, "ready");
    }
  } else if (successCount > 0) {
    setStatus(`输出完成，成功 ${successCount} 篇，失败 ${failureCount} 篇。`, "error");
  } else {
    setStatus(`输出失败，共 ${failureCount} 篇。`, "error");
  }
}

async function runCourseExportJob(job) {
  if (typeof courseExportBuilders.buildCourseMarkdownDocument !== "function"
    || typeof courseExportBuilders.buildCourseHtmlDocument !== "function"
    || typeof courseExportBuilders.buildCourseFilename !== "function") {
    throw new Error("专栏导出构建器未加载");
  }

  const totalCount = getJobTotal(job);
  const outputTarget = getJobOutputTargetState(job);
  const scysCourseId = getScysCourseIdForJob(job);
  const executionProfile = scysCourseId
    ? getScysCourseApiExecutionProfile(totalCount)
    : getCourseExportExecutionProfile(job);
  const workerCount = executionProfile.workerCount;
  const exportedChapters = new Array(totalCount);
  const failedChapters = [];
  let completedCount = 0;
  let nextIndex = 0;
  let successCount = 0;
  let failureCount = 0;
  let consecutiveFailures = 0;
  let slowdownMultiplier = 1;

  setWorkerCount(workerCount);
  initializeWorkerPanel(workerCount);

  setStatus("正在导出专栏…", "loading");
  appendLog(`专栏处理配置：${workerCount} 个通道（${executionProfile.label}）。`);

  if (scysCourseId) {
    await runScysCourseApiExport(scysCourseId);
  } else {
    await Promise.all(
      Array.from({ length: workerCount }, (_, workerIndex) => runCourseExportWorker(workerIndex))
    );
  }

  setStopTaskActive(false);
  updateStats(completedCount, successCount, failureCount, totalCount);

  if (stopRequested) {
    const elapsed = formatElapsedDuration(Date.now() - jobStartedAt);
    const skippedCount = Math.max(0, totalCount - completedCount);
    setStatus(buildCourseStoppedMessage({
      successCount,
      failureCount,
      skippedCount,
      elapsed
    }), "error");
    appendLog(`任务已停止，未处理 ${skippedCount} 章。`, "error");
    return;
  }

  if (successCount === 0) {
    const elapsed = formatElapsedDuration(Date.now() - jobStartedAt);
    setStatus(`专栏导出失败，共 ${failureCount} 章，总耗时 ${elapsed}。`, "error");
    appendLog(`任务结束，总耗时 ${elapsed}。`, "error");
    return;
  }

  const exportedAt = new Date().toISOString();
  const title = String(job.courseTitle || job.title || "未命名专栏");
  let markdown = "";
  let html = "";
  let markdownFilename = "";
  let htmlFilename = "";

  if (outputTarget.wantsDownload) {
    setStatus("正在生成 Markdown 和 HTML 文件…", "loading");
    markdown = courseExportBuilders.buildCourseMarkdownDocument({
      title,
      sourceUrl: job.courseUrl,
      exportedAt,
      chapters: exportedChapters.filter(Boolean),
      failedChapters
    });
    html = courseExportBuilders.buildCourseHtmlDocument({
      title,
      sourceUrl: job.courseUrl,
      exportedAt,
      chapters: exportedChapters.filter(Boolean),
      failedChapters
    });

    markdownFilename = courseExportBuilders.buildCourseFilename(title, "md");
    htmlFilename = courseExportBuilders.buildCourseFilename(title, "html");
    await downloadGeneratedText(markdown, "text/markdown;charset=utf-8", markdownFilename, buildFallbackFilenameForExtension("md"));
    appendLog(`已下载: ${markdownFilename}`, "success");
    await downloadGeneratedText(html, "text/html;charset=utf-8", htmlFilename, buildFallbackFilenameForExtension("html"));
    appendLog(`已下载: ${htmlFilename}`, "success");
  } else if (outputTarget.wantsObsidian) {
    setStatus("正在写入 Obsidian 知识库包…", "loading");
  }

  let obsidianOutcome = "";
  if (outputTarget.wantsObsidian) {
    const obsidianPayload = {
      title,
      sourceUrl: job.courseUrl,
      exportedAt,
      chapters: exportedChapters.filter(Boolean),
      failedChapters
    };
    try {
      const writeMessage = await writeCourseBundleToObsidian(obsidianPayload);
      obsidianOutcome = writeMessage ? `，${writeMessage}` : "";
    } catch (error) {
      appendLog(`写入 Obsidian 失败：${error.message || "未知错误"}`, "error");
      obsidianOutcome = "，但写入 Obsidian 失败";
      if (isObsidianPermissionRetryable(error)) {
        setPendingObsidianRetry({
          kind: "course-bundle",
          payload: obsidianPayload,
          successVariant: failureCount === 0 ? "ready" : "error"
        }, "当前任务文件已经导出完成，但写入 Obsidian 时浏览器没有给出可复用的写权限。点击下面的按钮后，可在本页重新授权并补写，无需重跑整次导出。");
        appendLog("已保留 Obsidian 写入内容，可在当前页面点击“授权并重试写入 Obsidian”。", "error");
      }
    }
  }

  const elapsed = formatElapsedDuration(Date.now() - jobStartedAt);
  if (failureCount === 0) {
    setStatus(buildCourseCompletionMessage({
      outputTarget,
      successCount,
      failureCount,
      obsidianOutcome,
      elapsed
    }), "ready");
    appendLog(`任务结束，总耗时 ${elapsed}。`, "success");
  } else {
    setStatus(buildCourseCompletionMessage({
      outputTarget,
      successCount,
      failureCount,
      obsidianOutcome,
      elapsed
    }), "error");
    appendLog(`任务结束，总耗时 ${elapsed}。`, "error");
  }

  async function runScysCourseApiExport(courseId) {
    let apiTabId = null;
    setWorkerState(0, "准备中", "读取生财课程接口");
    appendLog(`生财专栏已切换为接口稳速模式：course_id=${courseId}`);

    try {
      const entryUrl = job.courseUrl || job.chapters.find((chapter) => chapter?.url)?.url;
      apiTabId = await createTab(entryUrl, false);
      activeTaskTabIds.add(apiTabId);
      await waitForTabReady(apiTabId, entryUrl, 45000);

      for (let index = 0; index < job.chapters.length; index += 1) {
        if (stopRequested) {
          setWorkerState(0, "已停止", "不再领取新章节");
          return;
        }

        const chapter = job.chapters[index];
        setWorkerState(0, `正在处理 ${index + 1}/${totalCount}`, chapter.title);
        appendLog(`接口获取 ${index + 1}/${totalCount}: ${chapter.title}`);

        try {
          const markdown = await exportScysCourseChapterWithRetry(courseId, chapter, {
            apiTabId,
            includeImages: job.includeImages !== false,
            maxRetries: executionProfile.maxRetries,
            retryBaseDelayMs: executionProfile.retryBaseDelayMs
          });
          const markdownError = getCourseChapterMarkdownError(markdown, chapter.url);
          if (markdownError) {
            throw new Error(markdownError);
          }

          exportedChapters[index] = {
            order: chapter.order,
            title: chapter.title,
            sectionTitle: chapter.sectionTitle || "",
            sectionId: chapter.sectionId || "",
            sectionOrder: chapter.sectionOrder || 0,
            url: chapter.url,
            markdown
          };
          successCount += 1;
          consecutiveFailures = 0;
          setWorkerState(0, `已完成 ${index + 1}/${totalCount}`, chapter.title);
          appendLog(`已提取: ${chapter.title}`, "success");
        } catch (error) {
          if (stopRequested) {
            setWorkerState(0, "已停止", chapter.title);
            return;
          }
          failureCount += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 2) {
            appendLog("检测到连续失败，已保持单通道并延长接口重试间隔。", "error");
          }
          failedChapters.push({
            title: chapter.title,
            url: chapter.url,
            message: error.message || "未知错误"
          });
          setWorkerState(0, `失败 ${index + 1}/${totalCount}`, chapter.title);
          appendLog(`失败: ${chapter.title} | ${error.message || "未知错误"}`, "error");
        }

        completedCount += 1;
        updateStats(completedCount, successCount, failureCount, totalCount);
        if (completedCount < totalCount) {
          setStatus(`正在导出专栏，已处理 ${completedCount}/${totalCount} 章。`, "loading");
        } else {
          setWorkerState(0, "收尾中", "等待汇总输出");
        }
        if (!stopRequested && completedCount < totalCount) {
          await sleep(executionProfile.interTaskDelayMs);
        }
      }
    } finally {
      if (apiTabId !== null) {
        activeTaskTabIds.delete(apiTabId);
        await closeTab(apiTabId);
      }
    }
  }

  async function runCourseExportWorker(workerIndex) {
    let tabId = null;

    await sleep(workerIndex * executionProfile.workerStaggerMs);

    try {
      tabId = await createTab("about:blank", false);
      activeTaskTabIds.add(tabId);

      while (true) {
        if (stopRequested) {
          setWorkerState(workerIndex, "已停止", "不再领取新章节");
          return;
        }
        const index = nextIndex;
        if (index >= job.chapters.length) {
          setWorkerState(workerIndex, "空闲", "等待其他通道完成");
          return;
        }
        nextIndex += 1;

        const chapter = job.chapters[index];
        setWorkerState(workerIndex, `正在处理 ${index + 1}/${totalCount}`, chapter.title);
        appendLog(`通道 ${workerIndex + 1} 开始处理 ${index + 1}/${totalCount}: ${chapter.title}`);

        try {
          const rawResult = await exportLinkInExistingTabWithRetry(tabId, chapter.url, {
            format: "markdown",
            includeImages: job.includeImages !== false,
            chapterTitle: chapter.title,
            settleDelayMs: executionProfile.settleDelayMs
          }, {
            maxRetries: executionProfile.maxRetries,
            retryBaseDelayMs: executionProfile.retryBaseDelayMs,
            retrySettleDelayMs: executionProfile.retrySettleDelayMs,
            slowdownMultiplier
          });
          const result = normalizeWechatMarkdownResult(rawResult);
          const markdown = extractCourseChapterMarkdown(result.content);
          const markdownError = getCourseChapterMarkdownError(markdown, chapter.url);
          if (markdownError) {
            throw new Error(markdownError);
          }

          exportedChapters[index] = {
            order: chapter.order,
            title: chapter.title,
            sectionTitle: chapter.sectionTitle || "",
            sectionId: chapter.sectionId || "",
            sectionOrder: chapter.sectionOrder || 0,
            url: chapter.url,
            markdown
          };
          successCount += 1;
          consecutiveFailures = 0;
          slowdownMultiplier = Math.max(1, slowdownMultiplier - 0.15);
          setWorkerState(workerIndex, `已完成 ${index + 1}/${totalCount}`, chapter.title);
          appendLog(`已提取: ${chapter.title}`, "success");
        } catch (error) {
          if (stopRequested) {
            setWorkerState(workerIndex, "已停止", chapter.title);
            return;
          }
          failureCount += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 2) {
            slowdownMultiplier = Math.min(4, slowdownMultiplier + 0.5);
            appendLog(`检测到连续失败，当前专栏自动放慢到 ${slowdownMultiplier.toFixed(1)}x 节奏。`, "error");
          }
          failedChapters.push({
            title: chapter.title,
            url: chapter.url,
            message: error.message || "未知错误"
          });
          setWorkerState(workerIndex, `失败 ${index + 1}/${totalCount}`, chapter.title);
          appendLog(`失败: ${chapter.title} | ${error.message || "未知错误"}`, "error");
        }

        completedCount += 1;
        updateStats(completedCount, successCount, failureCount, totalCount);
        if (completedCount < totalCount) {
          setStatus(`正在导出专栏，已处理 ${completedCount}/${totalCount} 章。`, "loading");
        } else {
          setWorkerState(workerIndex, "收尾中", "等待汇总输出");
        }
        const interTaskDelayMs = Math.round((executionProfile.interTaskDelayMs + (workerIndex * 40)) * slowdownMultiplier);
        if (!stopRequested && interTaskDelayMs > 0) {
          await sleep(interTaskDelayMs);
        }
      }
    } finally {
      if (tabId !== null) {
        activeTaskTabIds.delete(tabId);
        await closeTab(tabId);
      }
    }
  }
}

function buildCourseCompletionMessage({ outputTarget, successCount, failureCount, obsidianOutcome, elapsed }) {
  const base = failureCount === 0
    ? `专栏导出完成，共 ${successCount} 章`
    : `专栏导出完成，成功 ${successCount} 章，失败 ${failureCount} 章`;

  if (outputTarget.key === "obsidian") {
    if (obsidianOutcome.includes("失败")) {
      return `${base}，但写入 Obsidian 失败，总耗时 ${elapsed}。`;
    }
    return `${base}，已写入 Obsidian，总耗时 ${elapsed}。`;
  }

  if (outputTarget.key === "both") {
    return `${base}，已生成 Markdown 和 HTML${obsidianOutcome}，总耗时 ${elapsed}。`;
  }

  return `${base}，已生成 Markdown 和 HTML，总耗时 ${elapsed}。`;
}

function getCourseExportExecutionProfile(job) {
  const totalCount = getJobTotal(job);
  const profile = getCourseExportExecutionProfileForTotal(totalCount);
  if (profile) {
    return profile;
  }

  return {
    mode: "browser-fast",
    label: "浏览器加速模式",
    workerCount: getCourseExportWorkerCountForTotal(totalCount),
    settleDelayMs: 0,
    skipInitialSettle: true,
    interTaskDelayMs: 120,
    workerStaggerMs: 180,
    maxRetries: MAX_RETRIES,
    retryBaseDelayMs: 1200,
    retrySettleDelayMs: 900
  };
}

function getCourseExportWorkerCount(job) {
  return getCourseExportExecutionProfile(job).workerCount;
}

function getScysCourseIdForJob(job) {
  if (job?.source !== "scys-course") {
    return "";
  }

  const urls = [job.courseUrl, ...(Array.isArray(job.chapters) ? job.chapters.map((chapter) => chapter?.url) : [])];
  for (const url of urls) {
    const courseId = getScysCourseIdFromUrl(url);
    if (courseId) {
      return courseId;
    }
  }

  return "";
}

function getScysCourseApiExecutionProfile(totalCount) {
  return {
    mode: "scys-api",
    label: "接口稳速模式",
    workerCount: 1,
    interTaskDelayMs: Number(totalCount) > 30 ? 1200 : 900,
    maxRetries: 4,
    retryBaseDelayMs: 1200
  };
}

async function exportScysCourseChapterWithRetry(courseId, chapter, options = {}) {
  const chapterId = getScysChapterId(chapter);
  if (!chapterId) {
    throw new Error("章节缺少 chapterId");
  }

  const maxRetries = Math.max(0, Number(options.maxRetries) || 0);
  const retryBaseDelayMs = Math.max(800, Number(options.retryBaseDelayMs) || 1200);
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (stopRequested) {
      throw new Error("任务已停止");
    }

    try {
      if (attempt > 0) {
        appendLog(`接口重试 ${attempt}/${maxRetries}: ${chapter.title}`);
      }
      const payload = await fetchScysCourseChapterPayload(options.apiTabId, courseId, chapterId);
      const apiFailureMessage = getScysCourseApiFailureMessage(payload);
      if (isScysCourseApiRateLimited(payload)) {
        throw buildScysCourseApiError(apiFailureMessage || "生财接口提示操作过于频繁", "SCYS_API_RATE_LIMIT");
      }
      if (apiFailureMessage) {
        throw buildScysCourseApiError(apiFailureMessage, "SCYS_API_ERROR");
      }

      let markdown = extractScysCourseApiMarkdown(payload);
      if (options.includeImages === false) {
        markdown = stripMarkdownImages(markdown);
      }
      if (!markdown) {
        throw buildScysCourseApiError("接口未返回章节正文", "SCYS_API_EMPTY");
      }
      return markdown;
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || stopRequested) {
        break;
      }

      const delay = getScysCourseApiRetryDelay(error, attempt, retryBaseDelayMs);
      appendLog(`本次接口失败，将在 ${delay}ms 后重试。`, "error");
      await sleep(delay);
    }
  }

  throw lastError || new Error("生财章节接口导出失败");
}

function getScysChapterId(chapter) {
  const explicitId = String(chapter?.chapterId || "").trim();
  if (/^\d+$/.test(explicitId)) {
    return explicitId;
  }

  try {
    const parsed = new URL(String(chapter?.url || ""));
    const chapterId = parsed.searchParams.get("chapterId") || "";
    return /^\d+$/.test(chapterId) ? chapterId : "";
  } catch (_) {
    return "";
  }
}

async function fetchScysCourseChapterPayload(apiTabId, courseId, chapterId) {
  if (!apiTabId) {
    throw new Error("生财接口通道未准备好");
  }

  const result = await executeScysCourseApiFetch(apiTabId, courseId, chapterId);
  if (!result?.ok) {
    const error = buildScysCourseApiError(`生财章节接口请求失败：HTTP ${result?.status || "未知"}`, "SCYS_API_HTTP");
    error.status = result?.status || 0;
    throw error;
  }

  return result.payload;
}

function executeScysCourseApiFetch(tabId, courseId, chapterId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: async (courseIdArg, chapterIdArg) => {
          function readScysToken() {
            const raw = localStorage.getItem("__user_token.v3")
              || localStorage.getItem("user_token")
              || localStorage.getItem("token")
              || "";
            if (!raw) {
              return "";
            }
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed === "string") {
                return parsed;
              }
              return parsed?.token || parsed?.value || parsed?.access_token || raw;
            } catch (_) {
              return raw;
            }
          }

          const headers = { Accept: "application/json, text/plain, */*" };
          const token = readScysToken();
          if (token) {
            headers["x-token"] = token;
          }

          const endpoint = `/search/course/getChapterContent?course_id=${encodeURIComponent(courseIdArg)}&chapter_id=${encodeURIComponent(chapterIdArg)}`;
          const response = await fetch(endpoint, {
            cache: "no-store",
            credentials: "include",
            headers
          });
          const text = await response.text();
          let payload = null;
          try {
            payload = JSON.parse(text);
          } catch (_) {
            payload = {
              status: response.ok ? 0 : response.status,
              message: text
            };
          }
          return {
            ok: response.ok,
            status: response.status,
            payload
          };
        },
        args: [String(courseId), String(chapterId)]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(results?.[0]?.result || null);
      }
    );
  });
}

function getScysCourseApiFailureMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const status = payload.status ?? payload.code ?? payload.errcode;
  if (status === undefined || status === null || String(status) === "0") {
    return "";
  }

  return String(payload.message || payload.msg || payload.error || `接口返回状态 ${status}`);
}

function buildScysCourseApiError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getScysCourseApiRetryDelay(error, attempt, retryBaseDelayMs) {
  const baseDelay = Math.round(retryBaseDelayMs * Math.pow(1.8, attempt));
  if (error?.code === "SCYS_API_RATE_LIMIT") {
    return Math.min(15000, Math.max(3000, baseDelay * 2));
  }
  return Math.min(10000, baseDelay);
}

function stripMarkdownImages(markdown) {
  return String(markdown || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getJobTotal(job) {
  if (job.type === "course-export") {
    return Array.isArray(job.chapters) ? job.chapters.length : 0;
  }
  return Array.isArray(job.links) ? job.links.length : 0;
}

function getJobUnitLabel(job) {
  return job.type === "course-export" ? "章" : "篇";
}

function getJobOutputTargetState(job) {
  const fallback = job?.saveToObsidian === true ? "both" : "download";
  return getOutputTargetState(normalizeOutputTarget(job?.outputTarget, fallback));
}

async function exportLinkWithRetry(url, options) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (stopRequested) {
      throw new Error("任务已停止");
    }
    try {
      if (attempt > 0) {
        appendLog(`重试 ${attempt}/${MAX_RETRIES}: ${url}`);
      }
      return await exportLink(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_RETRIES) {
        break;
      }
      const delay = (attempt + 1) * 1500;
      appendLog(`本次失败，将在 ${delay}ms 后重试。`, "error");
      if (!stopRequested) {
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("导出失败");
}

async function exportLinkInExistingTabWithRetry(tabId, url, options, retryOptions = {}) {
  let lastError = null;
  const maxRetries = Number.isFinite(retryOptions.maxRetries) ? retryOptions.maxRetries : MAX_RETRIES;
  const retryBaseDelayMs = Number(retryOptions.retryBaseDelayMs) || 1500;
  const retrySettleDelayMs = Number(retryOptions.retrySettleDelayMs) || BACKGROUND_TAB_SETTLE_DELAY_MS;
  const slowdownMultiplier = Math.max(1, Number(retryOptions.slowdownMultiplier) || 1);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (stopRequested) {
      throw new Error("任务已停止");
    }
    try {
      if (attempt > 0) {
        appendLog(`重试 ${attempt}/${maxRetries}: ${url}`);
      }
      const settleDelayMs = attempt > 0
        ? Math.round(retrySettleDelayMs * attempt * slowdownMultiplier)
        : Number(options?.settleDelayMs) || 0;
      return await exportLinkInExistingTab(tabId, url, {
        ...options,
        settleDelayMs
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) {
        break;
      }
      const delay = Math.round((attempt + 1) * retryBaseDelayMs * slowdownMultiplier);
      appendLog(`本次失败，将在 ${delay}ms 后重试。`, "error");
      if (!stopRequested) {
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("导出失败");
}

async function exportLink(url, options) {
  if (options.format === "markdown" && isWechatArticleUrl(url) && wechatDirectFetchEnabled) {
    try {
      const result = await exportWechatArticleByHtmlFetch(url, options);
      appendLog(`公众号文章已走 HTML 直抓: ${url}`);
      return result;
    } catch (error) {
      if (error?.code === "WECHAT_VERIFY_PAGE") {
        wechatDirectFetchEnabled = false;
        appendLog("检测到微信对 HTML 直抓返回验证页，当前批次剩余公众号文章将自动改走稳定页面模式。");
      } else {
        appendLog(`公众号 HTML 直抓失败，已回退页面模式: ${error.message || "未知错误"}`);
      }
    }
  }

  return exportLinkInBackground(url, options);
}

async function exportLinkInBackground(url, options) {
  const tabId = await createTab(url, false);

  try {
    activeTaskTabIds.add(tabId);
    await waitForTabReady(tabId, url);
    await sleep(BACKGROUND_TAB_SETTLE_DELAY_MS);

    const payload = await sendMessageWithRecovery(tabId, {
      type: "feishu-export:export-document",
      format: options.format,
      options: {
        includeImages: options.includeImages,
        chapterTitle: options.chapterTitle || ""
      }
    });

    return {
      filename: normalizeDownloadFilename(payload.filename, options.format),
      mimeType: payload.mimeType,
      content: payload.content
    };
  } finally {
    activeTaskTabIds.delete(tabId);
    await closeTab(tabId);
  }
}

async function exportLinkInExistingTab(tabId, url, options) {
  await prepareTabForUrl(tabId, url, { settleDelayMs: options?.settleDelayMs });
  const payload = await sendMessageWithRecovery(tabId, {
    type: "feishu-export:export-document",
    format: options.format,
    options: {
      includeImages: options.includeImages,
      chapterTitle: options.chapterTitle || ""
    }
  });

  return {
    filename: normalizeDownloadFilename(payload.filename, options.format),
    mimeType: payload.mimeType,
    content: payload.content
  };
}

async function prepareTabForUrl(tabId, url, options = {}) {
  const tab = await getTab(tabId);
  if (String(tab?.url || "") === url) {
    await reloadTab(tabId);
  } else {
    await updateTabUrl(tabId, url);
  }
  await waitForTabReady(tabId, url);
  const settleDelayMs = Math.max(0, Number(options?.settleDelayMs) || 0);
  if (settleDelayMs > 0) {
    await sleep(settleDelayMs);
  }
}

async function exportWechatArticleByHtmlFetch(url, options) {
  if (!globalThis.WechatDirectExport?.exportMarkdownFromHtml) {
    throw new Error("公众号 HTML 导出模块未加载");
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`抓取公众号 HTML 失败: ${response.status}`);
  }

  const html = await response.text();
  const finalUrl = normalizeWechatUrl(response.url || url);
  return globalThis.WechatDirectExport.exportMarkdownFromHtml({
    html,
    sourceUrl: url,
    finalUrl,
    includeImages: options.includeImages !== false,
    fetchAssetAsDataUrl: fetchAssetAsDataUrlFromBackground
  });
}

async function downloadExportResult(result) {
  const blob = new Blob([result.content], { type: result.mimeType });
  const objectUrl = URL.createObjectURL(blob);

  try {
    await downloadWithFallback(objectUrl, result.filename, "markdown");
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

function normalizeWechatMarkdownResult(result) {
  if (!result || result.mimeType !== "text/markdown;charset=utf-8") {
    return result;
  }

  return {
    ...result,
    content: maybeStripWechatUiNoiseFromMarkdown(result.content)
  };
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

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
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
    });
  });
}

async function sendMessageWithRecovery(tabId, message) {
  try {
    return await sendMessageToTab(tabId, message);
  } catch (error) {
    if (!String(error?.message || "").includes("Receiving end does not exist")) {
      throw error;
    }

    await injectContentScript(tabId);
    return sendMessageToTab(tabId, message);
  }
}

function injectContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["shared/scys-course-utils.js", "shared/web-markdown-utils.js", "content-scripts/feishu-exporter.js"]
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

function createTab(url, active) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tab?.id) {
        reject(new Error("任务标签页创建失败"));
        return;
      }
      resolve(tab.id);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function updateTabUrl(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function reloadTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
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
    inspectTab();
  });
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
  return isBatchExportUrl(currentUrl) || isSingleExportUrl(currentUrl);
}

function closeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

function normalizeWechatUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "mp.weixin.qq.com" && parsed.protocol === "http:") {
      parsed.protocol = "https:";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return String(url || "");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadFile(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function downloadWithFallback(url, filename, format) {
  try {
    return await downloadFile({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } catch (error) {
    if (!String(error?.message || "").toLowerCase().includes("invalid filename")) {
      throw error;
    }
    return downloadFile({
      url,
      filename: buildFallbackFilename(format),
      saveAs: false,
      conflictAction: "uniquify"
    });
  }
}

async function downloadGeneratedText(content, mimeType, filename, fallbackFilename) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  try {
    return await downloadFile({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } catch (error) {
    if (!String(error?.message || "").toLowerCase().includes("invalid filename")) {
      throw error;
    }
    return downloadFile({
      url: objectUrl,
      filename: fallbackFilename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

async function writeCourseBundleToObsidian(payload) {
  const binding = cachedObsidianBinding || await primeObsidianBinding();
  if (!binding?.handle) {
    throw new Error("未配置 Obsidian 目标目录");
  }

  const permission = await obsidianVaultStorage.ensureVaultPermission?.(binding.handle, "readwrite");
  if (permission !== "granted") {
    throw buildObsidianPermissionError();
  }

  return writeCourseBundleToObsidianWithBinding(payload, binding);
}

async function writeSingleNoteToObsidian(sourceUrl, result) {
  if (typeof buildObsidianNoteFile !== "function") {
    throw new Error("Obsidian 导出模块未加载");
  }

  const binding = cachedObsidianBinding || await primeObsidianBinding();
  if (!binding?.handle) {
    throw new Error("未配置 Obsidian 目标目录");
  }

  const permission = await obsidianVaultStorage.ensureVaultPermission?.(binding.handle, "readwrite");
  if (permission !== "granted") {
    throw buildObsidianPermissionError();
  }

  const title = String(result?.filename || "未命名文档").replace(/\.md$/i, "");
  const note = buildObsidianNoteFile({
    title,
    sourceUrl,
    exportedAt: new Date().toISOString(),
    markdown: extractDocumentBodyMarkdown(result?.content)
  });
  await obsidianVaultStorage.writeTextFiles?.(binding.handle, [note]);
  appendLog(`已写入 Obsidian：${note.path}`, "success");
}

function extractDocumentBodyMarkdown(markdown) {
  const text = String(markdown || "").trim();
  const separatorIndex = text.indexOf("\n---\n");
  if (separatorIndex < 0) {
    return text;
  }
  return text.slice(separatorIndex + "\n---\n".length).trim();
}

function buildObsidianPermissionError() {
  return new Error("Obsidian 目标目录当前不可写，请在当前页面点击“授权并重试写入 Obsidian”，或回到弹窗重新授权。");
}

function isObsidianPermissionRetryable(error) {
  const message = String(error?.message || "");
  return /Obsidian 目标目录/u.test(message)
    && /(权限|不可写|重新授权)/u.test(message);
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
  return buildFallbackFilenameForExtension(extension);
}

function buildFallbackFilenameForExtension(extension) {
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

function buildZipFilename(title) {
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
  const base = String(title || "batch-export")
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 60) || "batch-export";
  return `${base}-${timestamp}.zip`;
}

function loadJob(jobId) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([`batchJob:${jobId}`], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result[`batchJob:${jobId}`] || null);
    });
  });
}

function removeJob(jobId) {
  return new Promise((resolve) => {
    chrome.storage.local.remove([`batchJob:${jobId}`], () => resolve());
  });
}

function buildMeta(job) {
  const outputTarget = getJobOutputTargetState(job);
  if (job.type === "course-export") {
    const pieces = [
      `共 ${getJobTotal(job)} 章`,
      job.courseTitle || "当前专栏",
      job.includeImages === false ? "不含图片" : "包含图片"
    ];
    if (outputTarget.wantsDownload) {
      pieces.push("Markdown + HTML");
    }
    pieces.push(outputTarget.label);
    return pieces.join(" · ");
  }

  const pieces = [`共 ${job.links.length} 篇`];
  if (job.source === "wechat-history" && job.account?.nickname) {
    pieces.push(`公众号 ${job.account.nickname}`);
  }
  if (job.dateRange?.startDate && job.dateRange?.endDate) {
    pieces.push(`${job.dateRange.startDate} ~ ${job.dateRange.endDate}`);
  }
  pieces.push(job.includeImages === false ? "不含图片" : "包含图片");
  if (outputTarget.wantsDownload) {
    pieces.push(job.zipOutput === false ? "逐篇下载" : "ZIP 打包");
  }
  pieces.push(outputTarget.label);
  return pieces.join(" · ");
}

function startElapsedClock() {
  stopElapsedClock();
  updateElapsedClock();
  elapsedTimerId = window.setInterval(updateElapsedClock, 1000);
}

function stopElapsedClock() {
  if (elapsedTimerId) {
    window.clearInterval(elapsedTimerId);
    elapsedTimerId = 0;
  }
}

function updateElapsedClock() {
  if (elapsedEl) {
    elapsedEl.textContent = formatElapsedDuration(Date.now() - jobStartedAt);
  }
}

function setWorkerCount(value) {
  if (workersEl) {
    workersEl.textContent = `${value} 通道`;
  }
}

function initializeWorkerPanel(workerCount) {
  workerStates = Array.from({ length: workerCount }, (_, index) => ({
    title: `通道 ${index + 1}`,
    status: "等待启动",
    detail: "尚未开始"
  }));
  renderWorkerPanel();
}

function setPendingObsidianRetry(retryState, copy) {
  pendingObsidianRetry = retryState || null;
  if (!obsidianRetryPanelEl || !obsidianRetryCopyEl || !retryObsidianWriteButton) {
    return;
  }

  if (!pendingObsidianRetry) {
    obsidianRetryPanelEl.hidden = true;
    obsidianRetryCopyEl.textContent = "";
    retryObsidianWriteButton.disabled = false;
    retryObsidianWriteButton.textContent = "授权并重试写入 Obsidian";
    return;
  }

  obsidianRetryCopyEl.textContent = copy || "当前任务已导出完成，但写入 Obsidian 失败。";
  obsidianRetryPanelEl.hidden = false;
  retryObsidianWriteButton.disabled = false;
  retryObsidianWriteButton.textContent = "授权并重试写入 Obsidian";
}

async function handleRetryObsidianWrite() {
  if (!pendingObsidianRetry || !retryObsidianWriteButton) {
    return;
  }

  const retryState = pendingObsidianRetry;
  retryObsidianWriteButton.disabled = true;
  retryObsidianWriteButton.textContent = "正在授权并重试…";
  setStatus("正在重新授权并写入 Obsidian…", "loading");
  appendLog("开始重新授权 Obsidian 目录并补写导出文件。");

  try {
    const binding = cachedObsidianBinding;
    if (!binding?.handle) {
      throw new Error("未配置 Obsidian 目标目录，请回到弹窗重新选择目录。");
    }

    const permission = await obsidianVaultStorage.promptVaultPermission?.(binding.handle, "readwrite");
    if (permission !== "granted") {
      throw buildObsidianPermissionError();
    }

    switch (retryState.kind) {
      case "course-bundle":
        await writeCourseBundleToObsidianWithBinding(retryState.payload, binding);
        break;
      default:
        throw new Error("当前任务类型暂不支持 Obsidian 重试");
    }

    setPendingObsidianRetry(null);
    setStatus("Obsidian 补写成功，无需重新导出。", retryState.successVariant || "ready");
    appendLog("Obsidian 补写成功，无需重新导出。", "success");
  } catch (error) {
    retryObsidianWriteButton.disabled = false;
    retryObsidianWriteButton.textContent = "授权并重试写入 Obsidian";
    appendLog(`Obsidian 重试失败：${error.message || "未知错误"}`, "error");
    setStatus(error.message || "Obsidian 重试失败", "error");
  }
}

async function writeCourseBundleToObsidianWithBinding(payload, binding) {
  if (typeof buildObsidianCourseBundle !== "function") {
    throw new Error("Obsidian 导出模块未加载");
  }

  if (!binding?.handle) {
    throw new Error("未配置 Obsidian 目标目录");
  }

  const bundle = buildObsidianCourseBundle(payload);
  await obsidianVaultStorage.writeTextFiles?.(binding.handle, bundle.files, {
    skipPermissionCheck: true
  });
  appendLog(`已写入 Obsidian：${bundle.indexPath}`, "success");
  return "并已写入 Obsidian";
}

async function primeObsidianBinding() {
  if (cachedObsidianBindingPromise) {
    return cachedObsidianBindingPromise;
  }

  cachedObsidianBindingPromise = Promise.resolve(obsidianVaultStorage.getVaultBinding?.())
    .then((binding) => {
      cachedObsidianBinding = binding || null;
      return cachedObsidianBinding;
    })
    .finally(() => {
      cachedObsidianBindingPromise = null;
    });

  return cachedObsidianBindingPromise;
}

function setWorkerState(workerIndex, status, detail) {
  if (!workerStates[workerIndex]) {
    return;
  }

  workerStates[workerIndex] = {
    ...workerStates[workerIndex],
    status: String(status || "").trim() || "处理中",
    detail: String(detail || "").trim() || "处理中"
  };
  renderWorkerPanel();
}

function renderWorkerPanel() {
  if (!workerPanelEl || !workerGridEl) {
    return;
  }

  if (workerStates.length === 0) {
    workerPanelEl.hidden = true;
    if (workerDetailsEl) {
      workerDetailsEl.hidden = true;
    }
    workerGridEl.innerHTML = "";
    return;
  }

  workerPanelEl.hidden = false;
  if (workerDetailsEl) {
    workerDetailsEl.hidden = false;
  }
  workerGridEl.innerHTML = workerStates.map((worker) => {
    const detailClass = /^(尚未开始|等待其他通道完成)$/u.test(worker.detail) ? "worker-copy worker-copy-idle" : "worker-copy";
    return [
      '<div class="worker-card">',
      `<div class="worker-title">${escapeHtml(worker.title)}</div>`,
      `<div class="worker-copy">${escapeHtml(worker.status)}</div>`,
      `<div class="${detailClass}">${escapeHtml(worker.detail)}</div>`,
      "</div>"
    ].join("");
  }).join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateStats(doneCount, successCount, failureCount, totalCount) {
  progressEl.textContent = `${doneCount} / ${totalCount}`;
  successEl.textContent = String(successCount);
  failureEl.textContent = String(failureCount);
}

async function fetchAssetAsDataUrlFromBackground(url) {
  const response = await sendRuntimeMessage({
    type: MESSAGE_FETCH_ASSET,
    url
  });
  return response?.dataUrl || "";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "后台请求失败"));
        return;
      }

      resolve(response);
    });
  });
}

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.className = `status status-${variant}`;
}

function appendLog(message, variant = "") {
  const entry = document.createElement("div");
  entry.className = `log-entry${variant ? ` log-entry-${variant}` : ""}`;
  entry.textContent = message;
  logEl.prepend(entry);
  appendResultEntryFromLog(message, variant);
}

function appendResultEntryFromLog(message, variant = "") {
  if (!resultSummaryEl || !resultListEl) {
    return;
  }

  const text = String(message || "").trim();
  if (!text) {
    return;
  }

  const shouldPromote = variant === "success"
    && /^(已下载:|ZIP 已生成:|已写入 Obsidian：|Obsidian 补写成功)/u.test(text);

  if (!shouldPromote || resultEntryCache.has(text)) {
    return;
  }

  resultEntryCache.add(text);
  resultSummaryEl.hidden = false;
  const entry = document.createElement("div");
  entry.className = `result-entry${variant ? ` result-entry-${variant}` : ""}`;
  entry.textContent = text;
  resultListEl.prepend(entry);
}

function uniquifyZipEntryName(filename, usedNames) {
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
  const ext = dotIndex >= 0 ? filename.slice(dotIndex) : "";
  let candidate = filename;
  let counter = 2;

  while (usedNames.has(candidate)) {
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

class SimpleZipBuilder {
  constructor() {
    this.entries = [];
  }

  addText(name, text) {
    const data = new TextEncoder().encode(String(text ?? ""));
    this.entries.push({
      name,
      data,
      crc32: crc32(data),
      date: new Date()
    });
  }

  buildBlob() {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBytes = new TextEncoder().encode(entry.name);
      const { time, date } = toDosDateTime(entry.date);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, time, true);
      localView.setUint16(12, date, true);
      localView.setUint32(14, entry.crc32 >>> 0, true);
      localView.setUint32(18, entry.data.length, true);
      localView.setUint32(22, entry.data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, time, true);
      centralView.setUint16(14, date, true);
      centralView.setUint32(16, entry.crc32 >>> 0, true);
      centralView.setUint32(20, entry.data.length, true);
      centralView.setUint32(24, entry.data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      localChunks.push(localHeader, entry.data);
      centralChunks.push(centralHeader);
      offset += localHeader.length + entry.data.length;
    }

    const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, this.entries.length, true);
    endView.setUint16(10, this.entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localChunks, ...centralChunks, endRecord], { type: "application/zip" });
  }
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let c = index;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[index] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
