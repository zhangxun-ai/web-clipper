(function (scope) {
  "use strict";
  const clip = typeof module !== "undefined" && module.exports
    ? require("./feishu-wiki-clip.js") : scope.FeishuWikiClip;
  const storageKeys = Object.freeze(["feishuWikiClipJobs", "feishuWikiClipHistory", "feishuWikiClipJob", "feishuWikiClipTarget"]);
  const text = value => typeof value === "string" ? value : "";
  const list = value => Array.isArray(value) ? value : [];

  function readStoredOverview(storage = {}) {
    const jobs = [], positions = new Map();
    // The queue is authoritative over legacy history; the current-job view is
    // the most recent snapshot of its own ID. Never merge by source URL.
    for (const job of [...list(storage.feishuWikiClipHistory), ...list(storage.feishuWikiClipJobs), storage.feishuWikiClipJob]) {
      if (!job || typeof job.id !== "string" || !job.id) continue;
      if (positions.has(job.id)) jobs[positions.get(job.id)] = job;
      else { positions.set(job.id, jobs.length); jobs.push(job); }
    }
    return { jobs, target: storage.feishuWikiClipTarget || null };
  }

  function verifiedResult(job) {
    if (job.stage !== "complete" || job.error || !job.id || !job.wikiToken) return null;
    try {
      const result = clip.parseDocumentUrl(job.resultUrl, true);
      return result.origin === job.target?.origin && result.token === job.wikiToken ? result : null;
    } catch (_) { return null; }
  }

  function taskLink(job, extensionBaseUrl, result) {
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(text(job.id))) return "";
      if (job.requestId != null && job.requestId !== ""
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(job.requestId))) return "";
      const source = clip.parseSourceUrl(job.source?.url);
      const target = clip.parseDocumentUrl(job.target?.url, true);
      if (target.origin !== job.target.origin || target.token !== job.target.parentToken
        || !text(job.target.spaceId)) return "";
      if (result) return result.url;
      const base = new URL(extensionBaseUrl);
      if (base.protocol !== "chrome-extension:" || !/^[a-p]{32}$/.test(base.hostname)
        || base.username || base.password || base.port) return "";
      const url = new URL("/feishu-save.html", base);
      url.searchParams.set("jobId", job.id);
      if (job.requestId) url.searchParams.set("requestId", job.requestId);
      url.searchParams.set("source", source.url);
      url.searchParams.set("target", target.url);
      if (Number.isInteger(job.sourceTabId) && job.sourceTabId > 0) url.searchParams.set("sourceTabId", String(job.sourceTabId));
      return url.href;
    } catch (_) { return ""; }
  }

  function buildRecentSaves(jobs, extensionBaseUrl) {
    return list(jobs).filter(job => job && typeof job === "object").map(job => {
      const result = verifiedResult(job);
      const completed = Boolean(result);
      const running = Boolean(job.autoRun) && !["complete", "abandoned"].includes(job.stage)
        && !job.retryExhausted && (!job.error || job.retryable === true);
      const status = completed ? "complete" : job.stage === "abandoned" ? "abandoned" : running ? "running" : "paused";
      return {
        id: text(job.id),
        title: text(job.title) || text(job.source?.url) || "未命名文章",
        targetLabel: [text(job.target?.spaceName), text(job.target?.title)].filter(Boolean).join(" / ") || "未记录保存位置",
        status,
        label: { complete: "已保存", running: "处理中", paused: "需要处理", abandoned: "已停止" }[status],
        href: taskLink(job, extensionBaseUrl, result),
        completed,
        createdAt: text(job.createdAt)
      };
    }).sort((a, b) => {
      const first = Date.parse(a.createdAt), second = Date.parse(b.createdAt);
      const left = Number.isFinite(first) ? first : -Infinity;
      const right = Number.isFinite(second) ? second : -Infinity;
      return left === right ? 0 : left > right ? -1 : 1;
    });
  }

  const api = { storageKeys, readStoredOverview, buildRecentSaves };
  scope.RecentSaveModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
