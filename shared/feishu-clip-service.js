(function () {
  "use strict";
  const HOST = "com.feishu.clipper";
  const JOB_KEY = "feishuWikiClipJob";
  const JOBS_KEY = "feishuWikiClipJobs";
  const HISTORY_KEY = "feishuWikiClipHistory";
  const TARGET_KEY = "feishuWikiClipTarget";
  const NOTIFICATION_PREFIX = "feishuClipComplete:";
  const FAILURE_NOTIFICATION_PREFIX = "feishuClipFailed:";
  const AUTO_ALARM = "feishuClipAutoResume";
  const READ_ACTIONS = new Set(["status", "list_spaces", "get_space", "list_nodes", "get_node", "authorize_start", "authorize_finish"]);
  const api = globalThis.FeishuWikiClip;
  let running = null;
  let starting = false;
  let mutationTail = Promise.resolve();
  let nativeTail = Promise.resolve();
  let wakeTimer = null;
  let wakeAt = 0;
  let imageSourceTabId = null;
  const reconciliationAttempts = new Map();

  // Chrome can resolve executeScript with no result when an injected promise
  // rejects. Catch inside the isolated world so domain errors survive the API.
  async function callPage(tabId, kind, request) {
    const results = await chrome.scripting.executeScript({ target: { tabId },
      func: async (operation, input) => {
        try {
          let data;
          if (operation === "web") {
            if (location.href !== input.sourceUrl) throw Object.assign(new Error("源网页已跳转，请重新选择。"), { code: "SOURCE_CHANGED" });
            if (!globalThis.FeishuWebCapture?.snapshot) throw Object.assign(new Error("网页剪存组件未加载，请重新读取。"), { code: "CAPTURE_UNAVAILABLE" });
            data = await globalThis.FeishuWebCapture.snapshot();
          } else if (operation === "web-image") data = await globalThis.WebImageCapture.capture(input);
          else if (operation === "feishu-image") data = await globalThis.FeishuImageCapture.capture(input);
          else throw new Error("不支持的页面读取操作。");
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: { message: String(error?.message || "页面读取失败，请重新读取。"),
            code: typeof error?.code === "string" ? error.code : "PAGE_CAPTURE_FAILED" } };
        }
      }, args: [kind, request] });
    const response = results?.find(item => item.frameId === 0)?.result || results?.[0]?.result;
    if (!response || typeof response.ok !== "boolean") {
      throw Object.assign(new Error("页面读取连接中断，请保持原网页打开后继续当前任务。"), { code: "CAPTURE_INTERRUPTED" });
    }
    if (!response.ok) throw Object.assign(new Error(response.error?.message || "页面读取失败。"), { code: response.error?.code || "PAGE_CAPTURE_FAILED" });
    if (!response.data) throw Object.assign(new Error("页面未返回完整内容，请重新读取。"), { code: "CAPTURE_EMPTY" });
    return response.data;
  }

  async function sourceTab(source, preferredId) {
    const matches = (tab) => {
      try { return api.parseSourceUrl(tab.url).url === source.url; } catch (_) { return false; }
    };
    let tab = Number.isInteger(preferredId) ? await chrome.tabs.get(preferredId).catch(() => null) : null;
    if (!tab || !matches(tab)) tab = (await chrome.tabs.query({})).find(matches);
    if (!tab) throw new Error("请先打开要保存的网页，再从该页面的插件入口点击“保存到飞书”。");
    for (let attempt = 0; tab.status === "loading" && attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      tab = await chrome.tabs.get(tab.id);
      if (!matches(tab)) throw Object.assign(new Error("原网页已切换，请从要保存的文章重新打开插件。"), { code: "SOURCE_CHANGED" });
    }
    if (tab.status && tab.status !== "complete") throw Object.assign(new Error("网页加载较慢，请保持原网页打开后继续当前任务。"), { code: "PAGE_NOT_READY" });
    return tab;
  }

  async function captureWeb(source, preferredId) {
    const tab = await sourceTab(source, preferredId);
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id },
        files: ["shared/scys-course-utils.js", "shared/web-markdown-utils.js", "shared/web-feishu-blocks.js", "content-scripts/feishu-exporter.js"] });
      return await callPage(tab.id, "web", { sourceUrl: source.url });
    } catch (error) {
      if (/Cannot access|permission|host permission/i.test(error.message)) {
        throw new Error("请回到原网页点击一次插件，再选择“保存到飞书”，即可读取当前网页。");
      }
      throw error;
    }
  }

  async function captureImage(source, entry, preferredId) {
    if (source.type === "web") {
      const tab = await sourceTab(source, preferredId);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared/web-image-capture.js"] });
      try {
        return await callPage(tab.id, "web-image", { sourceUrl: source.url, url: entry.url });
      } catch (error) {
        // Some article CDNs (including WeChat) omit CORS headers. Only use
        // already granted hosts; never prompt for broader access during a save.
        const url = new URL(entry.url);
        if (/不允许读取|Failed to fetch/i.test(error.message) && /^https?:$/.test(url.protocol)
          && await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) {
          await sourceTab(source, tab.id);
          return globalThis.WebImageCapture.capturePublic(entry.url);
        }
        throw error;
      }
    }
    const matchesSource = (tab) => {
      try { return api.parseDocumentUrl(tab.url).url === source.url; } catch (_) { return false; }
    };
    let tab = imageSourceTabId ? await chrome.tabs.get(imageSourceTabId).catch(() => null) : null;
    if (!tab || !matchesSource(tab)) {
      tab = (await chrome.tabs.query({})).find(matchesSource);
      if (!tab) tab = await chrome.tabs.create({ url: source.url, active: false });
      imageSourceTabId = tab.id;
    }
    for (let attempt = 0; tab.status !== "complete" && attempt < 60; attempt += 1) {
      await new Promise((r) => setTimeout(r, 500));
      tab = await chrome.tabs.get(tab.id);
    }
    if (!matchesSource(tab)) throw new Error("源文档页面已跳转，请先在浏览器中打开原文。");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared/feishu-image-capture.js"] });
    return callPage(tab.id, "feishu-image", { sourceUrl: source.url, blockId: entry.block_id,
      token: entry.token, width: entry.width, height: entry.height });
  }

  function nativeCall(action, params = {}) {
    // All save pages share this bridge. Reads must also wait for an in-flight
    // import step because the native helper holds one process-wide journal lock.
    const request = nativeTail.then(() => new Promise((resolve, reject) => {
      chrome.runtime.sendNativeMessage(HOST, { action, params }, (response) => {
        if (chrome.runtime.lastError) {
          const error = new Error("尚未连接本机程序，请按首次连接说明安装一次，再点击重新检测。此问题不需要重新授权飞书。");
          error.code = "NATIVE_UNAVAILABLE";
          error.uncertain = ["copy_doc", "move_doc", "import_step"].includes(action);
          error.retryable = false; // No helper response means no safe-replay guarantee.
          reject(error);
        } else if (!response?.ok) {
          const error = new Error(response?.error || "本机飞书连接返回了无效响应。");
          error.uncertain = Boolean(response?.uncertain);
          error.code = response?.code;
          error.retryable = response?.retryable === true;
          reject(error);
        } else resolve(response.data);
      });
    }));
    nativeTail = request.catch(() => {});
    return request;
  }

  function mutate(operation) {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  }

  async function storedQueue() {
    const state = await chrome.storage.local.get([JOBS_KEY, JOB_KEY, HISTORY_KEY, TARGET_KEY]);
    const jobs = [], positions = new Map();
    // Preserve legacy history and its latest current-job snapshot during the
    // first migration. Subsequent writes keep these compatibility views in sync.
    for (const job of [...(state[JOBS_KEY] || []), ...(state[HISTORY_KEY] || []), state[JOB_KEY]]) {
      if (!job?.id) continue;
      if (positions.has(job.id)) jobs[positions.get(job.id)] = job;
      else { positions.set(job.id, jobs.length); jobs.push(job); }
    }
    return { jobs, selectedId: state[JOB_KEY]?.id || jobs.at(-1)?.id || "", target: state[TARGET_KEY] || null };
  }

  async function persistQueue(queue) {
    const selected = queue.jobs.find(job => job.id === queue.selectedId) || queue.jobs.at(-1) || null;
    await chrome.storage.local.set({ [JOBS_KEY]: queue.jobs, ...(selected ? { [JOB_KEY]: selected } : {}),
      [HISTORY_KEY]: queue.jobs.filter(job => job.id !== selected?.id) });
  }

  function parseRequestId(value) {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error("保存请求标识无效，请从插件重新打开保存页。");
    }
    return value.toLowerCase();
  }

  function matchingJob(queue, options = {}) {
    if (options.jobId) return queue.jobs.find(job => job.id === options.jobId) || null;
    const requestId = options.requestId === undefined ? null : parseRequestId(options.requestId);
    let jobs = requestId ? queue.jobs.filter(job => job.requestId === requestId) : queue.jobs;
    if (options.sourceUrl) {
      const source = api.parseSourceUrl(options.sourceUrl).url;
      jobs = jobs.filter(job => job.source?.url === source);
    }
    if (options.targetUrl) {
      const target = api.parseDocumentUrl(options.targetUrl, true).url;
      jobs = jobs.filter(job => job.target?.url === target);
    }
    if (requestId || options.sourceUrl || options.targetUrl) return jobs.at(-1) || null;
    return jobs.find(job => job.id === queue.selectedId) || jobs.at(-1) || null;
  }

  async function snapshot(options = {}) {
    const queue = await storedQueue();
    const job = matchingJob(queue, options);
    const pending = queue.jobs.filter(autoEligible);
    const queued = Boolean(job && autoEligible(job) && running?.jobId !== job.id
      && (running || (job.stage === "ready" && pending.length > 1)));
    // The selected page owns these fields. A save on a different page must not
    // disable this article's button or display another article's progress.
    const receipt = job ? (await chrome.storage.local.get(NOTIFICATION_PREFIX + job.id))[NOTIFICATION_PREFIX + job.id] : null;
    return { job, completionViewed: Boolean(verifiedCompletion(job) && receipt?.viewedAt),
      target: queue.target, running: Boolean(job && (running?.jobId === job.id || autoEligible(job))),
      queued, queuePosition: queued ? pending.filter(item => item.id !== running?.jobId).findIndex(item => item.id === job.id) + 1 : 0,
      activeJobId: running?.jobId || "", pendingCount: pending.length, jobs: queue.jobs };
  }

  function autoEligible(job) {
    return Boolean(job?.autoRun) && !["complete", "abandoned"].includes(job.stage)
      && !job.retryExhausted && (!job.error || job.retryable === true);
  }

  async function syncAlarm() {
    const pending = (await storedQueue()).jobs.filter(autoEligible);
    const due = pending.map(job => job.nextRunAt || 0).filter(time => time > Date.now());
    const nextWakeAt = due.length ? Math.min(...due) : 0;
    if (nextWakeAt !== wakeAt && globalThis.setTimeout && globalThis.clearTimeout) {
      if (wakeTimer !== null) globalThis.clearTimeout(wakeTimer);
      wakeAt = nextWakeAt;
      wakeTimer = nextWakeAt ? globalThis.setTimeout(() => {
        wakeTimer = null; wakeAt = 0;
        // Read the queue again at wakeup; never replay an old in-memory job.
        recoverAutoJob().catch(() => {});
      }, Math.min(2147483647, Math.max(1, nextWakeAt - Date.now()))) : null;
    }
    if (!chrome.alarms) return;
    if (!pending.length) { await chrome.alarms.clear(AUTO_ALARM); return; }
    // Production Chrome alarms have a 30-second floor. Short retry delays run
    // inside the active worker; this durable watchdog handles worker restarts.
    if (!await chrome.alarms.get(AUTO_ALARM)) {
      const nextRetryAt = Math.min(...pending.map(job => Math.max(job.nextRetryAt || 0, job.nextRunAt || 0)));
      await chrome.alarms.create(AUTO_ALARM, { when: Math.max(Date.now() + 30000, nextRetryAt), periodInMinutes: 0.5 });
    }
  }

  async function saveJob(job, { select = false, notifyFailure = false } = {}) {
    if (notifyFailure && job?.error && !job.autoRun && !["complete", "abandoned"].includes(job.stage)) {
      try {
        const notice = failureNotice(job);
        if (notice) job = { ...job, failureNotificationKey: notice.id };
      } catch (_) { /* Invalid metadata must not prevent preserving the failed job. */ }
    }
    // The notification intent and terminal job share the same storage write.
    // New failures survive worker reclamation; old paused jobs have no intent.
    await mutate(async () => {
      const queue = await storedQueue();
      const index = queue.jobs.findIndex(item => item.id === job.id);
      if (index < 0) queue.jobs.push(job); else queue.jobs[index] = job;
      if (select || !queue.selectedId) queue.selectedId = job.id;
      await persistQueue(queue);
    });
    await syncAlarm();
    await notifyComplete(job);
    if (notifyFailure) await notifyFailed(job);
  }

  function verifiedCompletion(job) {
    if (job?.stage !== "complete" || job.error || !job.id || !job.wikiToken) return null;
    try {
      const result = api.parseDocumentUrl(job.resultUrl, true);
      return result.origin === job.target?.origin && result.token === job.wikiToken ? result : null;
    } catch (_) { return null; }
  }

  function completionPageMatches(url, job) {
    try {
      if (url?.split(/[?#]/)[0] !== chrome.runtime.getURL("feishu-save.html")) return false;
      const params = new URL(url).searchParams;
      if (params.get("source") !== job.source?.url || params.get("target") !== job.target?.url) return false;
      if (params.has("jobId") && params.get("jobId") !== job.id) return false;
      // New saves have request ids before their first job exists. Old recovery
      // pages must name the exact job instead of borrowing a fresh page request.
      return job.requestId ? params.get("requestId") === job.requestId : params.get("jobId") === job.id;
    } catch (_) { return false; }
  }

  function completionSenderMatches(sender, job) {
    // Chrome keeps sender.url at document creation even after replaceState.
    // For top-level extension tabs its browser-supplied tab.url carries the
    // current route. Never borrow that route for a subframe or inactive document.
    if (sender.tab) {
      return sender.frameId === 0 && (!sender.documentLifecycle || sender.documentLifecycle === "active")
        && completionPageMatches(sender.tab.url, job)
        && (!sender.tab.pendingUrl || completionPageMatches(sender.tab.pendingUrl, job));
    }
    return completionPageMatches(sender.url, job);
  }

  async function completionPageInForeground(job) {
    if (!chrome.tabs?.query || !chrome.windows?.get) return false;
    try {
      for (const tab of await chrome.tabs.query({ active: true })) {
        if (!tab.active || !completionPageMatches(tab.url, job)
          || tab.pendingUrl && !completionPageMatches(tab.pendingUrl, job)) continue;
        const window = await chrome.windows.get(tab.windowId);
        if (window.focused && window.state !== "minimized") return true;
      }
    } catch (_) { /* An unavailable tab/window is not evidence that the result is visible. */ }
    return false;
  }

  async function notifyComplete(job) {
    const result = verifiedCompletion(job);
    if (!result || !chrome.notifications) return;
    try {
      await mutate(async () => {
        const id = NOTIFICATION_PREFIX + job.id;
        const record = (await chrome.storage.local.get(id))[id];
        if (record?.deliveredAt || record?.viewedAt) return;
        // Receipts live outside the running job: a late save of the job cannot
        // erase a page acknowledgement or replay an already delivered notice.
        const pending = { ...record, url: result.url, deliveredAt: "" };
        if (await completionPageInForeground(job)) {
          if (!record?.suppressedAt) await chrome.storage.local.set({ [id]: { ...pending, suppressedAt: new Date().toISOString() } });
          return; // Only a rendered-result acknowledgement marks it as viewed.
        }
        await chrome.storage.local.set({ [id]: pending });
        // Stable ids recover a crash between Chrome delivery and this receipt.
        if (!(await chrome.notifications.getAll())[id]) {
          const duration = api.completionDuration(job);
          await chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icon/128.png"), silent: true,
            title: "已保存到飞书", message: `${job.title || "文档"}\n已存入${job.target.title || "所选知识库"}。${duration === null ? "" : `总耗时 ${api.formatDuration(duration)}。`}点击打开。` });
        }
        await chrome.storage.local.set({ [id]: { ...pending, deliveredAt: new Date().toISOString() } });
      });
    } catch (_) {
      // Notification failures must never invalidate a completed, verified save.
      // The durable completed job permits another attempt on worker startup.
    }
  }

  function failureNotice(job) {
    if (typeof job?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id)) return null;
    const source = api.parseSourceUrl(job.source?.url);
    const target = api.parseDocumentUrl(job.target?.url, true);
    if (target.origin !== job.target.origin || target.token !== job.target.parentToken
      || typeof job.target.spaceId !== "string" || !job.target.spaceId) return null;
    const key = JSON.stringify([job.id, job.errorCode || "UNKNOWN", job.failedStep || job.activeStep || job.stage]);
    const url = new URL(chrome.runtime.getURL("feishu-save.html"));
    url.searchParams.set("source", source.url);
    url.searchParams.set("target", target.url);
    url.searchParams.set("jobId", job.id);
    const requestId = job.requestId === undefined ? "" : parseRequestId(job.requestId);
    if (requestId) url.searchParams.set("requestId", requestId);
    return { id: FAILURE_NOTIFICATION_PREFIX + encodeURIComponent(key), url: url.href,
      sourceUrl: source.url, targetUrl: target.url, jobId: job.id, requestId };
  }

  async function notifyFailed(job) {
    if (!job?.error || job.autoRun || ["complete", "abandoned"].includes(job.stage) || !chrome.notifications) return;
    try {
      const notice = failureNotice(job);
      if (!notice || job.failureNotificationKey !== notice.id) return;
      const record = (await chrome.storage.local.get(notice.id))[notice.id];
      if (record?.deliveredAt) return;
      const pending = { kind: "failure", ...notice, deliveredAt: "" };
      await chrome.storage.local.set({ [notice.id]: pending });
      if (!(await chrome.notifications.getAll())[notice.id]) {
        await chrome.notifications.create(notice.id, { type: "basic", iconUrl: chrome.runtime.getURL("icon/128.png"),
          title: "这篇文章暂未保存完成", message: `${job.title || "文章"}\n保存记录已保留，点击查看原因并继续处理。` });
      }
      await chrome.storage.local.set({ [notice.id]: { ...pending, deliveredAt: new Date().toISOString() } });
    } catch (_) {
      // A desktop-notification failure must not discard the resumable job.
    }
  }

  chrome.notifications?.onClicked.addListener(id => {
    if (!id.startsWith(NOTIFICATION_PREFIX) && !id.startsWith(FAILURE_NOTIFICATION_PREFIX)) return;
    (async () => {
      const record = (await chrome.storage.local.get(id))[id];
      if (!record) return;
      let url;
      if (id.startsWith(FAILURE_NOTIFICATION_PREFIX)) {
        if (record.kind !== "failure" || record.id !== id || !record.jobId) return;
        // Construct the trusted extension route ourselves. A stored URL can
        // never turn a failed-save notification into an arbitrary navigation.
        const source = api.parseSourceUrl(record.sourceUrl);
        const target = api.parseDocumentUrl(record.targetUrl, true);
        const page = new URL(chrome.runtime.getURL("feishu-save.html"));
        page.searchParams.set("source", source.url);
        page.searchParams.set("target", target.url);
        if (typeof record.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.jobId)) return;
        page.searchParams.set("jobId", record.jobId);
        if (record.requestId) page.searchParams.set("requestId", parseRequestId(record.requestId));
        url = page.href;
      } else {
        if (!record.url) return;
        url = api.parseDocumentUrl(record.url, true).url;
      }
      await chrome.tabs.create({ url, active: true });
      if (id.startsWith(NOTIFICATION_PREFIX)) {
        await mutate(async () => {
          const latest = (await chrome.storage.local.get(id))[id];
          if (latest?.url === url) await chrome.storage.local.set({ [id]: { ...latest, viewedAt: latest.viewedAt || new Date().toISOString() } });
        });
      }
      await chrome.notifications.clear(id);
    })().catch(() => {});
  });

  function launch(job, attempted) {
    attempted.set(job.id, job.nextRunAt || 0);
    const execution = Promise.resolve().then(() => (job.mode === "content" ? api.runContentJob : api.runJob)(job,
      { call: nativeCall, captureImage, captureWeb, save: value => saveJob(value, { notifyFailure: true }) }));
    running = { jobId: job.id, execution };
    execution.catch(async error => {
      const latest = matchingJob(await storedQueue(), { jobId: job.id }) || job;
      await saveJob({ ...latest, autoRun: false, nextRetryAt: 0, retryable: false,
        error: error.message || "任务执行中断，请检查本机连接。", errorCode: error.code || "" }, { notifyFailure: true });
    }).finally(async () => {
      if (running?.execution === execution) running = null;
      await syncAlarm();
      // A paused item cannot hold up the other articles. A bounded native batch
      // that remains pending waits for the watchdog, avoiding a busy retry loop.
      await recoverAutoJob({ attempted });
    }).catch(() => {});
  }

  async function reconcileCompletedJob(job) {
    if (job?.mode !== "content" || !job.id || !job.sourceToken || !job.error || job.autoRun
      || ["complete", "abandoned"].includes(job.stage)) return job;
    const key = JSON.stringify([job.id, job.stage, job.errorCode, job.copy?.token || "", job.migrationRecoveryVersion || 0]);
    const lastAttempt = reconciliationAttempts.get(key);
    if (lastAttempt && Date.now() - lastAttempt < 30000) return job;
    reconciliationAttempts.set(key, Date.now());
    try {
      // First match the exact journal using reads. A helper-confirmed completed
      // result can be adopted directly; older paused moves need its explicit
      // bounded-recovery contract before they can rejoin the background queue.
      const operation = await nativeCall("get_operation", { operation_id: job.id });
      if (operation?.found !== true || operation.content_verified !== true
        || operation.source_token !== job.sourceToken
        || (job.copy?.token && operation.document?.token !== job.copy.token)
        || ((job.source.type === "web" || operation.source_url) && api.parseSourceUrl(operation.source_url).url !== job.source.url)
        || String(operation.target?.space_id) !== job.target.spaceId
        || operation.target?.parent_node_token !== job.target.parentToken) return job;
      const copiedToken = operation.document?.token;
      if (typeof copiedToken !== "string" || !/^[A-Za-z0-9]+$/.test(copiedToken) || copiedToken === job.sourceToken) return job;
      if (operation.phase !== "moved") {
        const resumableErrors = new Set(["CLI_NETWORK", "CLI_TIMEOUT", "CLI_RESPONSE_ERROR", "NATIVE_UNAVAILABLE", "MOVE_UNCERTAIN", "BUSY"]);
        const resumableStages = new Set(["moving", "pending", "move_failed", "verifying"]);
        const recovery = operation.move_recovery;
        const canResume = current => current?.mode === "content" && current.copy?.token === copiedToken
          && !current.autoRun && !current.migrationRecoveryVersion && current.error
          && resumableStages.has(current.stage) && resumableErrors.has(current.errorCode);
        if (!canResume(job) || !["move_pending", "move_uncertain", "moving"].includes(operation.phase)
          || recovery?.recoverable !== true
          || (recovery.deadline !== undefined && (!Number.isFinite(recovery.deadline) || recovery.deadline <= Date.now()))
          || (recovery.deferred_until !== undefined && !Number.isFinite(recovery.deferred_until))
          || (operation.task_id !== undefined && (typeof operation.task_id !== "string"
            || !/^[A-Za-z0-9_-]{1,256}$/.test(operation.task_id)))) return job;
        let reconciled = job;
        await mutate(async () => {
          const queue = await storedQueue();
          const latest = matchingJob(queue, { jobId: job.id });
          reconciled = latest || job;
          // An explicit stop or manual resume can arrive during get_operation.
          // Never overwrite that newer decision with our earlier paused state.
          if (!canResume(latest) || latest.stage !== job.stage || latest.errorCode !== job.errorCode
            || latest.sourceToken !== job.sourceToken || latest.source?.url !== job.source?.url
            || latest.target?.origin !== job.target.origin || latest.target?.spaceId !== job.target.spaceId
            || latest.target?.parentToken !== job.target.parentToken) return;
          reconciled = { ...latest, stage: "moving", autoRun: true, error: "", errorCode: "", uncertain: false,
            retryable: false, retryExhausted: false, retryCount: 0, retryStepKey: "", nextRetryAt: 0,
            nextRunAt: recovery.deferred_until > Date.now() ? recovery.deferred_until : 0,
            ...(recovery.deadline !== undefined ? { moveRecoveryDeadline: Number.isFinite(latest.moveRecoveryDeadline)
              && latest.moveRecoveryDeadline > 0 ? Math.min(latest.moveRecoveryDeadline, recovery.deadline) : recovery.deadline } : {}),
            migrationRecoveryVersion: 1, ...(operation.task_id ? { taskId: operation.task_id } : {}) };
          queue.jobs[queue.jobs.findIndex(item => item.id === job.id)] = reconciled;
          await persistQueue(queue);
        });
        await syncAlarm();
        return reconciled;
      }
      if (!operation.wiki_token) return job;
      // The exact operation journal may be ahead of the extension even before
      // it received its first copy token. Adopt only its independently moved,
      // verified document, then check the live node against this complete tuple.
      const recovered = { ...job, copy: { ...job.copy, token: copiedToken,
        url: api.parseDocumentUrl(`${job.target.origin}/docx/${copiedToken}`).url } };
      const result = api.parseDocumentUrl(`${job.target.origin}/wiki/${operation.wiki_token}`, true);
      const { node } = await nativeCall("get_node", { token: operation.wiki_token });
      if (node?.node_token !== operation.wiki_token) return job;
      api.verifyNode(recovered, node);
      const complete = { ...recovered, wikiToken: operation.wiki_token, resultUrl: result.url, stage: "complete",
        error: "", errorCode: "", uncertain: false, autoRun: false, retryable: false, retryExhausted: false,
        retryCount: 0, nextRetryAt: 0,
        // The host proves completion, not when the browser last observed it.
        // Discovery after a restart must never become a fabricated total time.
        completionTimeUnknown: api.completionDuration({ ...job, stage: "complete", error: "" }) === null };
      await saveJob(complete);
      return complete;
    } catch (_) {
      // A missing journal, old helper, connection error, or unmatched node is
      // insufficient evidence. Keep the original stopped task and its copy.
      return job;
    }
  }

  async function recoverAutoJob({ reconcile = false, attempted = new Map() } = {}) {
    if (running || starting) return;
    starting = true;
    try {
      let queue = await storedQueue();
      await mutate(async () => persistQueue(await storedQueue()));
      for (const saved of queue.jobs) {
        const job = reconcile ? await reconcileCompletedJob(saved) : saved;
        await notifyComplete(job);
        await notifyFailed(job);
        if (job?.autoRun && !autoEligible(job)) {
          await saveJob({ ...job, autoRun: false, retryable: false, nextRetryAt: 0 });
        }
      }
      await syncAlarm();
      await mutate(async () => {
        queue = await storedQueue();
        const job = queue.jobs.find(item => autoEligible(item) && !(item.nextRunAt > Date.now())
          && (!attempted.has(item.id) || (item.nextRunAt > 0 && item.nextRunAt !== attempted.get(item.id))));
        if (job) launch(job, attempted);
      });
    } finally { starting = false; }
  }

  // Alarms can disappear across browser updates/restarts. Recreate them from
  // the user's durable active-job flag, never from an arbitrary paused job.
  const initialized = Promise.resolve().then(() => recoverAutoJob({ reconcile: true })).catch(() => {});
  chrome.alarms?.onAlarm.addListener(alarm => {
    if (alarm.name === AUTO_ALARM) recoverAutoJob().catch(() => {});
  });
  chrome.runtime.onStartup?.addListener(() => recoverAutoJob({ reconcile: true }).catch(() => {}));

  let completionRefresh = null;
  let completionRefreshAgain = false;
  function refreshCompletionNotices() {
    if (completionRefresh) { completionRefreshAgain = true; return; }
    completionRefresh = Promise.resolve().then(async () => {
      await initialized;
      do {
        completionRefreshAgain = false;
        for (const job of (await storedQueue()).jobs) await notifyComplete(job);
      } while (completionRefreshAgain);
    }).catch(() => {}).finally(() => { completionRefresh = null; });
  }
  // If a page was closed or left before it acknowledged rendering the result,
  // retry only its notice; foreground changes must never resume native writes.
  chrome.tabs?.onActivated?.addListener(refreshCompletionNotices);
  chrome.tabs?.onRemoved?.addListener(refreshCompletionNotices);
  chrome.tabs?.onUpdated?.addListener((_id, changes) => {
    if (changes.url || changes.status === "complete") refreshCompletionNotices();
  });
  chrome.windows?.onFocusChanged?.addListener(refreshCompletionNotices);

  async function dispatch(message, sender, receivedAt) {
    await initialized;
    if (message.action === "state") {
      if (message.reconcile === true) await recoverAutoJob({ reconcile: true });
      return snapshot(message);
    }
    if (message.action === "acknowledge_completion") {
      await mutate(async () => {
        const job = (await storedQueue()).jobs.find(item => item.id === message.jobId);
        const result = verifiedCompletion(job);
        if (!result || message.requestId !== (job.requestId || "") || message.sourceUrl !== job.source?.url
          || message.targetUrl !== job.target?.url || !completionSenderMatches(sender, job)) {
          throw new Error("完成记录与当前保存页面不一致，请刷新后重试。");
        }
        const id = NOTIFICATION_PREFIX + job.id;
        const record = (await chrome.storage.local.get(id))[id];
        await chrome.storage.local.set({ [id]: { ...record, url: result.url, viewedAt: record?.viewedAt || new Date().toISOString() } });
        await chrome.notifications?.clear(id);
      });
      return { completionViewed: true };
    }
    if (message.action === "remember_target") {
      // This is only a local preference from our trusted page after get_node
      // validation. Starting a clip still rechecks the real node and space.
      const value = message.target;
      const parsed = api.parseDocumentUrl(value?.url, true);
      if (value?.parentToken !== parsed.token || value?.origin !== parsed.origin
        || typeof value?.spaceId !== "string" || !value.spaceId
        || typeof value.title !== "string" || typeof value.spaceName !== "string") {
        throw new Error("保存位置无效，请重新确认。");
      }
      const target = api.targetFromNode({ space_id: value.spaceId, node_token: parsed.token,
        title: value.title, node_type: "origin" }, parsed.origin, value.spaceName);
      await chrome.storage.local.set({ [TARGET_KEY]: target });
      return target;
    }
    if (message.action === "native") {
      if (!READ_ACTIONS.has(message.operation)) throw new Error("不支持的飞书操作。");
      if (message.operation.startsWith("authorize_") && (running || (await storedQueue()).jobs.some(autoEligible))) throw new Error("请等待当前剪存结束后再切换授权。");
      return nativeCall(message.operation, message.params);
    }
    if (message.action === "end") {
      let ended;
      await mutate(async () => {
        const queue = await storedQueue();
        const job = matchingJob(queue, message);
        if (!job || ["complete", "abandoned"].includes(job.stage)) throw new Error("没有需要结束的任务。");
        if (running?.jobId === job.id) throw new Error("任务仍在执行，暂时不能结束。");
        ended = { ...job, previousStage: job.stage, previousError: job.error,
          error: "", stage: "abandoned", autoRun: false, retryable: false, nextRetryAt: 0 };
        queue.jobs[queue.jobs.findIndex(item => item.id === job.id)] = ended;
        queue.selectedId = job.id;
        await persistQueue(queue);
      });
      await syncAlarm();
      return snapshot({ jobId: ended.id });
    }
    if (message.action === "start" || message.action === "resume") {
      let selectedId;
      await mutate(async () => {
        const queue = await storedQueue();
        if (message.action === "resume") {
          const previous = matchingJob(queue, message);
          if (!previous) throw new Error("没有可继续的剪存任务。");
          if (["complete", "abandoned"].includes(previous.stage)) throw new Error("此任务已经结束，无需继续。");
          if (running?.jobId === previous.id || autoEligible(previous)) throw new Error("当前任务会自动恢复，无需再次点击继续。");
          if (message.restartCreation === true) {
            if (previous.mode !== "content" || previous.copy?.token
              || !["CREATE_UNCERTAIN", "CREATE_RECOVERY_UNAVAILABLE"].includes(previous.errorCode)) {
              throw new Error("此任务已有可恢复进度，不能重新创建文档。");
            }
            // This is the user's explicit "save again" action, never an alarm
            // or automatic retry. Persist its id before the local helper call
            // so losing that response cannot reset a second creation attempt.
            previous.creationRetryRequestId ||= crypto.randomUUID();
            await persistQueue(queue);
            await nativeCall("retry_content_creation", { operation_id: previous.id,
              request_id: previous.creationRetryRequestId });
            Object.assign(previous, { stage: "importing", progress: null, creationRetryRequestId: "" });
          }
          // Resume the exact journaled operation. It never mints a replacement
          // operation id; explicit new creation attempts remain in its journal.
          Object.assign(previous, { autoRun: true, retryCount: 0, retryStepKey: "", nextRetryAt: 0,
            retryExhausted: false, retryable: false, nextRunAt: 0, error: "", errorCode: "" });
          selectedId = previous.id;
        } else {
          const source = api.parseSourceUrl(message.sourceUrl);
          const parent = api.parseDocumentUrl(message.targetUrl, true);
          // A new confirmation is a new save even for the same article and
          // destination. Only repeats of this exact page request are idempotent.
          const requestId = message.requestId === undefined ? crypto.randomUUID() : parseRequestId(message.requestId);
          const existing = queue.jobs.find(job => job.requestId === requestId);
          if (existing) {
            if (existing.source?.url !== source.url || existing.target?.url !== parent.url) {
              throw new Error("这个保存请求已用于其他文章或位置，请重新开始保存。");
            }
            if (!message.expectedSpaceId || existing.target.spaceId !== message.expectedSpaceId) {
              throw new Error("父页面所在的知识库已改变，请重新确认保存位置。");
            }
            selectedId = existing.id;
          } else {
            const { node } = await nativeCall("get_node", { token: parent.token });
            const target = api.targetFromNode(node, parent.origin, message.spaceName || "");
            if (!message.expectedSpaceId || target.spaceId !== message.expectedSpaceId) {
              throw new Error("父页面所在的知识库已改变，请重新确认保存位置。");
            }
            const job = api.createJob(source.url, target, crypto.randomUUID());
            // Include queueing and the first target check. The trusted message
            // receipt supplies this time; pages cannot backdate a save request.
            job.createdAt = new Date(receivedAt).toISOString();
            job.requestId = requestId;
            if (Number.isInteger(message.sourceTabId) && message.sourceTabId > 0) job.sourceTabId = message.sourceTabId;
            job.autoRun = true;
            queue.jobs.push(job);
            selectedId = job.id;
          }
        }
        queue.selectedId = selectedId;
        await persistQueue(queue);
      });
      await syncAlarm();
      await recoverAutoJob();
      return snapshot({ jobId: selectedId });
    }
    throw new Error("不支持的剪存操作。");
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "feishu-clip") return false;
    // Only our dedicated extension page can access the native host; content
    // scripts and other extensions cannot turn this bridge into a write proxy.
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("feishu-save.html")) {
      sendResponse({ ok: false, error: "此操作只能从插件的飞书剪存页发起。" });
      return false;
    }
    dispatch(message, sender, Date.now()).then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code,
        retryable: error.retryable === true, uncertain: Boolean(error.uncertain) }));
    return true;
  });
})();
