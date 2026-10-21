(function () {
  "use strict";
  const HOST = "com.wechat.clipper";
  const MAX_PAGES_PER_RUN = 20;
  const RESULT_TTL = 5 * 60 * 1000;
  const running = new Map();
  const downloads = new Map();
  const listing = new Map();
  const indexScans = new Map();
  const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

  function fail(message, code = "WECHAT_HISTORY_INCOMPLETE") {
    return Object.assign(new Error(message), { code });
  }

  function publishDate(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp < 946684800 || timestamp > 4102444800) {
      throw fail("原文没有返回有效发表时间，已保留进度，未创建下载任务。", "WECHAT_PUBLISH_TIME_MISSING");
    }
    const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp * 1000)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function validateDates(params) {
    for (const value of [params.startDate, params.endDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || !Number.isFinite(Date.parse(`${value}T00:00:00+08:00`))
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail("日期格式无效。", "INVALID_PARAMS");
    }
    if (params.startDate > params.endDate) throw fail("开始日期不能晚于结束日期。", "INVALID_PARAMS");
  }

  function validateInput(params) {
    const seed = params?.seedMeta;
    if (!seed || !/^gh_[A-Za-z0-9]{1,64}$/.test(seed.username || "") || !/^Mz[A-Za-z0-9+/=]{4,126}$/.test(seed.biz || "")) {
      throw fail("未能从原文识别公众号身份，请确认文章可以正常打开。", "WECHAT_ACCOUNT_MISSING");
    }
    validateDates(params);
    return seed;
  }

  function nativeCall(action, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail("本机列表请求超时，未自动重试；再次点击将从保留进度继续。", "TIKHUB_NETWORK")), 65000);
      chrome.runtime.sendNativeMessage(HOST, { action, params }, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(fail("尚未连接支持 TikHub 的本机程序，请从当前项目安装连接器。", "NATIVE_UNAVAILABLE"));
        } else if (!response?.ok) {
          reject(Object.assign(fail(response?.code === "UNKNOWN_ACTION" ? "当前连接器版本不支持 TikHub，请从当前项目更新连接器。"
            : response?.error || "本机列表连接返回无效响应。", response?.code || "TIKHUB_NATIVE_ERROR"), { details: response?.details }));
        } else resolve(response.data);
      });
    });
  }

  async function articleMeta(url) {
    const parsed = new URL(url);
    if (parsed.origin !== "https://mp.weixin.qq.com" || !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(parsed.pathname) || parsed.username || parsed.password) {
      throw fail("文章链接无效。", "WECHAT_ARTICLE_INVALID");
    }
    const tab = await chrome.tabs.create({ url, active: false });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const current = await chrome.tabs.get(tab.id);
        if (current.status === "complete") { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw fail("文章加载超时，已保留列表进度。", "WECHAT_ARTICLE_TIMEOUT");
      let response;
      try { response = await chrome.tabs.sendMessage(tab.id, { type: "feishu-export:get-wechat-history-seed" }); }
      catch (_) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["wechat-markdown-cleanup.js", "shared/web-markdown-utils.js", "content-scripts/feishu-exporter.js"] });
        response = await chrome.tabs.sendMessage(tab.id, { type: "feishu-export:get-wechat-history-seed" });
      }
      if (!response?.ok || !response.data) throw fail("无法读取原文发表时间，请确认文章没有验证或删除提示。列表进度已保留。", "WECHAT_ARTICLE_UNAVAILABLE");
      return response.data;
    } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
  }

  async function jobKey(params) {
    const bytes = new TextEncoder().encode(JSON.stringify([4, params.seedMeta.username, params.seedMeta.biz, params.startDate, params.endDate]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return "wechatHistory:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function result(job) {
    const articles = job.articles.filter(article => article.publishDate >= job.startDate && article.publishDate <= job.endDate)
      .sort((left, right) => right.publishTimestamp - left.publishTimestamp);
    return { complete: true, source: "tikhub", links: articles.map(article => article.url), articles,
      matchedAccount: job.account, pageCount: job.pageCount, logs: [
        `已通过 TikHub 读取 ${job.pageCount} 页、${job.articles.length} 篇，核对 ${job.verifiedCount} 篇原文发表时间。`,
        "日期按北京时间及原文发表时间筛选，未使用素材创建或更新时间。"
      ] };
  }

  async function collect(params, key) {
    const seed = validateInput(params);
    let job = (await chrome.storage.local.get(key))[key];
    if (job?.complete && Date.now() - job.updatedAt < RESULT_TTL) return result(job);
    if (!job || job.complete) job = { account: { username: seed.username, fakeid: seed.biz, nickname: seed.nickname || seed.username },
      startDate: params.startDate, endDate: params.endDate, offset: "", seenOffsets: [], pageCount: 0,
      articles: [], pending: null, verifiedCount: 0, complete: false };
    const persist = async () => { job.updatedAt = Date.now(); await chrome.storage.local.set({ [key]: job }); };
    for (let runPages = 0; runPages < MAX_PAGES_PER_RUN; runPages += 1) {
      if (!job.pending) {
        const page = await nativeCall("tikhub_article_page", { username: seed.username, biz: seed.biz, ...(job.offset ? { offset: job.offset } : {}) });
        if (page?.account?.username !== seed.username || page.account.fakeid !== seed.biz || !Array.isArray(page.articles)
          || typeof page.isEnd !== "boolean" || (!page.isEnd && (!page.articles.length || !page.nextOffset
            || page.nextOffset === job.offset || job.seenOffsets.includes(page.nextOffset)))) {
          throw fail("公众号身份或分页游标异常，未创建下载任务。", "TIKHUB_CURSOR_INVALID");
        }
        job.pending = { page, index: 0 };
        await persist();
      }
      const pending = job.pending;
      while (pending.index < pending.page.articles.length) {
        const article = pending.page.articles[pending.index];
        const url = new URL(article.url);
        if (url.origin !== "https://mp.weixin.qq.com" || url.pathname !== "/s" || url.searchParams.get("__biz") !== seed.biz) {
          throw fail("TikHub 返回文章账号不符，已停止下载。", "TIKHUB_ACCOUNT_MISMATCH");
        }
        const isSeed = seed.mid && seed.idx && seed.mid === url.searchParams.get("mid") && seed.idx === url.searchParams.get("idx");
        let timestamp = article.publishTimestamp;
        const providerDate = Number.isFinite(timestamp) ? publishDate(timestamp) : null;
        // Older pages omit per-article sendTime but retain the published
        // message dateTime. Check both adjacent dates against original ct;
        // message and individual article timestamps can differ near midnight.
        const candidates = article.publicationSource === "message" && providerDate
          ? [publishDate(timestamp - 86400), providerDate, publishDate(timestamp + 86400)] : [providerDate];
        let title = article.title;
        if (isSeed || !providerDate || candidates.some(date => date >= job.startDate && date <= job.endDate)) {
          const meta = isSeed ? seed : await articleMeta(article.url);
          if (meta.biz !== seed.biz || meta.username !== seed.username) throw fail("原文所属公众号不符，已停止下载。", "WECHAT_ACCOUNT_MISMATCH");
          if (String(meta.mid) !== url.searchParams.get("mid") || String(meta.idx) !== url.searchParams.get("idx")
            || String(meta.sn).toLowerCase() !== url.searchParams.get("sn")?.toLowerCase()) {
            throw fail("原文文章身份不符，已停止并保留进度。", "WECHAT_ARTICLE_MISMATCH");
          }
          const originalTime = Number(meta.publishTimestamp);
          publishDate(originalTime);
          if (providerDate && article.publicationSource !== "message" && originalTime !== timestamp) throw fail("列表发表时间与原文不符，已停止并保留进度。", "WECHAT_PUBLISH_TIME_MISMATCH");
          if (providerDate && article.publicationSource === "message" && Math.abs(originalTime - timestamp) > 86400) {
            throw fail("消息发表时间与原文相差超过一天，已停止并保留进度。", "WECHAT_PUBLISH_TIME_MISMATCH");
          }
          timestamp = originalTime; title = meta.title || title; job.verifiedCount += 1;
        }
        const date = publishDate(timestamp);
        if (!job.articles.some(item => item.url === article.url)) job.articles.push({ title,
          url: article.url, publishTimestamp: timestamp, publishDate: date });
        pending.index += 1;
        await persist();
      }
      job.pageCount += 1;
      // The provider orders material records, not verified publication dates.
      // Only its explicit end marker establishes a complete account history.
      if (pending.page.isEnd) {
        job.complete = true; job.pending = null;
        await persist();
        return result(job);
      }
      job.seenOffsets.push(job.offset);
      job.offset = pending.page.nextOffset;
      job.pending = null;
      await persist();
    }
    throw fail("本次已读取 20 页，范围尚未收集完成。进度已保留，再次点击将继续；未创建不完整的下载任务。", "WECHAT_HISTORY_PAGE_LIMIT");
  }

  async function resolve(params) {
    validateInput(params);
    const key = await jobKey(params);
    if (running.has(key)) return running.get(key);
    const request = collect(params, key).finally(() => running.delete(key));
    running.set(key, request);
    return request;
  }

  function seedInput(params) {
    validateDates(params || {});
    const url = new URL(params?.seedUrl);
    if (url.origin !== "https://mp.weixin.qq.com" || !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)
      || url.username || url.password || url.href.length > 8192) throw fail("文章链接无效。", "INVALID_PARAMS");
    return { seedUrl: url.href, startDate: params.startDate, endDate: params.endDate };
  }

  async function inputKey(prefix, input) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    return prefix + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function articleIdentity(article, seed) {
    let url;
    try { url = new URL(article.url); } catch (_) { throw fail("文章链接无效。", "WECHAT_ARTICLE_INVALID"); }
    if (url.origin !== "https://mp.weixin.qq.com" || url.pathname !== "/s" || url.username || url.password
      || url.searchParams.get("__biz") !== seed.biz || !url.searchParams.get("mid")
      || !url.searchParams.get("idx") || !url.searchParams.get("sn")) {
      throw fail("TikHub 返回文章账号或身份不符。", "TIKHUB_ACCOUNT_MISMATCH");
    }
    return [seed.username, seed.biz, url.searchParams.get("mid"), url.searchParams.get("idx"), url.searchParams.get("sn").toLowerCase()];
  }

  async function verifiedArticle(article, seed) {
    const identity = articleIdentity(article, seed);
    const key = await inputKey("wechatArticleMeta:", identity);
    let meta = (await chrome.storage.local.get(key))[key];
    if (!meta) {
      const isSeed = String(seed.mid) === identity[2] && String(seed.idx) === identity[3]
        && String(seed.sn).toLowerCase() === identity[4];
      meta = isSeed ? seed : await articleMeta(article.url);
    }
    if (meta.biz !== seed.biz || meta.username !== seed.username) throw fail("原文所属公众号不符。", "WECHAT_ACCOUNT_MISMATCH");
    if (String(meta.mid) !== identity[2] || String(meta.idx) !== identity[3] || String(meta.sn).toLowerCase() !== identity[4]) {
      throw fail("原文文章身份不符，未创建下载任务。", "WECHAT_ARTICLE_MISMATCH");
    }
    const timestamp = Number(meta.publishTimestamp);
    const date = publishDate(timestamp);
    if (Number.isFinite(article.publishTimestamp) && (article.publicationSource === "message"
      ? Math.abs(timestamp - article.publishTimestamp) > 86400 : timestamp !== article.publishTimestamp)) {
      throw fail("列表发表时间与原文不符，未创建下载任务。", "WECHAT_PUBLISH_TIME_MISMATCH");
    }
    await chrome.storage.local.set({ [key]: meta });
    return { ...article, title: meta.title || article.title, publishTimestamp: timestamp, publishDate: date, dateVerified: true, needsVerification: false, candidateDate: false };
  }

  function listedResult(job, input) {
    const articles = job.articles.filter(article => {
      if (!article.publishDate) return true;
      if (article.publicationSource === "message" && !article.dateVerified) {
        return publishDate(article.publishTimestamp + 86400) >= input.startDate && publishDate(article.publishTimestamp - 86400) <= input.endDate;
      }
      return article.publishDate >= input.startDate && article.publishDate <= input.endDate;
    }).map(article => ({ ...article, candidateDate: !article.dateVerified && (!article.publishDate || article.publicationSource === "message") }))
      .sort((a, b) => (b.publishTimestamp || 0) - (a.publishTimestamp || 0));
    return { ...input, complete: job.complete, source: "tikhub", articles, links: articles.map(article => article.url),
      matchedAccount: job.account, pageCount: job.pageCount, scannedCount: job.articles.length,
      queriedAt: job.collectedAt || null, lastCompleteAt: job.lastCompleteAt || (job.complete ? job.collectedAt : null),
      logs: [job.complete ? "已收到供应商末页；下载前核验所选文章原文。" : "正在收集历史，当前文章不是范围全量。",
        "消息日期和未知日期仅用于候选展示，下载前按北京时间核验原文发表日期。"] };
  }

  async function accountIndex(key, seed, allowRestart) {
    const existing = (await chrome.storage.local.get(key))[key];
    if (existing) return existing;
    const stored = await chrome.storage.local.get(null);
    const candidates = Object.entries(stored).filter(([legacyKey, job]) => /^wechatHistory:[a-f0-9]{64}$/.test(legacyKey)
      && job && job.version !== 5 && job.account?.username === seed.username && job.account.fakeid === seed.biz);
    const valid = [];
    for (const [legacyKey, original] of candidates) {
      try {
        if (!Array.isArray(original.articles) || !Number.isInteger(original.pageCount) || original.pageCount < 0
          || typeof original.complete !== "boolean") continue;
        const job = structuredClone(original);
        for (const article of job.articles) {
          articleIdentity(article, seed);
          article.publishDate = publishDate(article.publishTimestamp);
          // Legacy jobs did not retain per-article verification/source flags.
          // Keep their timestamps, but conservatively treat dates as candidates.
          article.publicationSource = "message";
          article.dateVerified = false; article.needsVerification = true;
        }
        if (job.complete) {
          if (job.pending) continue;
          const completedAt = Number(job.updatedAt);
          job.collectedAt = job.collectedAt || (Number.isFinite(completedAt) && completedAt > 0
            ? new Date(completedAt).toISOString() : null);
        } else {
          if (typeof job.offset !== "string" || !Array.isArray(job.seenOffsets)
            || job.seenOffsets.some(offset => typeof offset !== "string")
            || (job.pageCount > 0 && !job.offset) || !("pending" in job)) continue;
          if (job.pending !== null) {
            const pending = job.pending, page = pending?.page;
            if (!Number.isInteger(pending?.index) || pending.index < 0 || !Array.isArray(page?.articles)
              || pending.index > page.articles.length || page.account?.username !== seed.username
              || page.account.fakeid !== seed.biz || typeof page.isEnd !== "boolean"
              || (!page.isEnd && (!page.articles.length || typeof page.nextOffset !== "string" || !page.nextOffset
                || page.nextOffset === job.offset || job.seenOffsets.includes(page.nextOffset)))) continue;
            for (const article of page.articles) articleIdentity(article, seed);
          }
        }
        valid.push({ legacyKey, job });
      } catch (_) { /* Invalid identity or checkpoint must never be resumed. */ }
    }
    valid.sort((a, b) => (Number(b.job.updatedAt) || 0) - (Number(a.job.updatedAt) || 0) || b.job.pageCount - a.job.pageCount);
    const snapshot = valid.find(item => item.job.complete);
    const progress = valid.find(item => !item.job.complete);
    if (!snapshot && !progress && candidates.length && !allowRestart) {
      throw fail("旧列表的续传信息不完整，未重新请求收费列表。请点击刷新列表从头获取。", "WECHAT_HISTORY_CHECKPOINT_INVALID");
    }
    const record = { snapshot: snapshot?.job || null, progress: progress?.job || null,
      migratedFrom: [snapshot?.legacyKey, progress?.legacyKey].filter(Boolean) };
    await chrome.storage.local.set({ [key]: record });
    return record;
  }

  async function scanIndex(seed, key, refresh, project) {
    if (indexScans.has(key)) {
      const active = indexScans.get(key);
      active.listeners.add(project);
      return active.promise;
    }
    const listeners = new Set([project]);
    const operation = (async () => {
      const record = (await chrome.storage.local.get(key))[key] || {};
      let job = !refresh && record.progress;
      if (!job) job = { account: { username: seed.username, fakeid: seed.biz, nickname: seed.nickname || seed.username },
        offset: "", seenOffsets: [], pageCount: 0, articles: [], pending: null, complete: false };
      const persist = async () => {
        job.updatedAt = Date.now(); record.progress = job;
        if (job.complete) { job.collectedAt = new Date().toISOString(); record.snapshot = structuredClone(job); record.progress = null; }
        await chrome.storage.local.set({ [key]: record });
        await Promise.all([...listeners].map(listener => listener(job, record.snapshot)));
      };
      await persist();
      try {
        for (let runPages = 0; runPages < MAX_PAGES_PER_RUN; runPages += 1) {
          if (!job.pending) {
            const page = await nativeCall("tikhub_article_page", { username: seed.username, biz: seed.biz, ...(job.offset ? { offset: job.offset } : {}) });
            if (page?.account?.username !== seed.username || page.account.fakeid !== seed.biz || !Array.isArray(page.articles)
              || typeof page.isEnd !== "boolean" || (!page.isEnd && (!page.articles.length || !page.nextOffset
                || page.nextOffset === job.offset || job.seenOffsets.includes(page.nextOffset)))) {
              throw fail("公众号身份或分页游标异常，进度已保留。", "TIKHUB_CURSOR_INVALID");
            }
            job.pending = { page, index: 0 }; await persist();
          }
          const pending = job.pending;
          while (pending.index < pending.page.articles.length) {
            const raw = pending.page.articles[pending.index];
            const identity = articleIdentity(raw, seed);
            let timestamp = null, date = null;
            try { date = publishDate(raw.publishTimestamp); timestamp = raw.publishTimestamp; } catch (_) { /* Unknown remains explicit. */ }
            const article = { title: raw.title, url: raw.url, publishTimestamp: timestamp, publishDate: date,
              publicationSource: raw.publicationSource || (date ? "article" : "unknown"), dateVerified: false, needsVerification: true };
            if (!job.articles.some(item => JSON.stringify(articleIdentity(item, seed)) === JSON.stringify(identity))) job.articles.push(article);
            pending.index += 1;
          }
          job.pageCount += 1;
          job.complete = pending.page.isEnd;
          if (!job.complete) { job.seenOffsets.push(job.offset); job.offset = pending.page.nextOffset; }
          job.pending = null;
          await persist();
          if (job.complete) return job;
        }
        throw fail("本次已读取 20 页，尚未收集完成。可下载已取得文章，或点击继续获取。", "WECHAT_HISTORY_PAGE_LIMIT");
      } catch (error) { await persist(); throw error; }
    })().finally(() => indexScans.delete(key));
    indexScans.set(key, { promise: operation, listeners });
    return operation;
  }

  async function list(params) {
    const input = seedInput(params);
    const key = await inputKey("wechatQuery:", input);
    if (listing.has(key)) return listing.get(key);
    const operation = (async () => {
      let query = (await chrome.storage.local.get(key))[key] || { ...input };
      const requestId = crypto.randomUUID();
      const listId = query.listId || await inputKey("wechatHistory:", [requestId, input]);
      let view = { ...input, requestId, listId, state: "loading", phase: "seed", complete: false, selectedUrls: [], articles: [] };
      const saveView = async data => {
        const stored = await chrome.storage.local.get(["wechatHistoryView", "wechatHistorySelection"]);
        const current = stored.wechatHistoryView;
        view = { ...view, ...data };
        if (current?.requestId !== requestId) return;
        const selection = stored.wechatHistorySelection;
        view.selectedUrls = selection?.listId === view.listId ? selection.urls : current.selectedUrls || [];
        await chrome.storage.local.set({ wechatHistoryView: view });
      };
      await chrome.storage.local.set({ wechatHistoryInput: input, wechatHistoryView: view });
      try {
        const seedKey = await inputKey("wechatSeed:", input.seedUrl);
        const seedMeta = (await chrome.storage.local.get(seedKey))[seedKey] || query.seedMeta || await articleMeta(input.seedUrl);
        validateInput({ seedMeta, ...input });
        await chrome.storage.local.set({ [seedKey]: seedMeta });
        query = { ...input, seedMeta, listId, state: "loading" };
        await chrome.storage.local.set({ [key]: query });
        const indexKey = await inputKey("wechatAccountIndex:", [1, seedMeta.username, seedMeta.biz]);
        const record = await accountIndex(indexKey, seedMeta, params.refresh === true);
        const project = async (progress, snapshot) => {
          let shown = progress;
          if (snapshot && !progress.complete) {
            const merged = new Map(snapshot.articles.map(article => [JSON.stringify(articleIdentity(article, seedMeta)), article]));
            for (const article of progress.articles) merged.set(JSON.stringify(articleIdentity(article, seedMeta)), article);
            shown = { ...progress, articles: [...merged.values()], complete: false, lastCompleteAt: snapshot.collectedAt || null };
          }
          const data = { ...listedResult(shown, input), listId, cached: false,
            phase: progress.complete ? "complete" : "scanning", refreshing: !!snapshot && !progress.complete,
            pageCount: progress.pageCount, scannedCount: progress.articles.length,
            lastCompleteAt: snapshot?.collectedAt || null };
          await chrome.storage.local.set({ [listId]: { ...shown, ...input, seedMeta, version: 5 } });
          await saveView({ ...data, state: progress.complete ? "ready" : "loading" });
        };
        if (record.snapshot && !params.refresh && !params.resume) {
          await chrome.storage.local.set({ [listId]: { ...record.snapshot, ...input, seedMeta, version: 5 } });
          await saveView({ ...listedResult(record.snapshot, input), listId, cached: true, state: "ready", phase: "complete", refreshing: false });
        } else {
          if (record.snapshot || record.progress) await project(record.progress || { ...record.snapshot, complete: false }, record.snapshot);
          const connection = await nativeCall("tikhub_status");
          if (!connection.configured) throw fail("未配置下载服务，请在本机项目 .env 中设置 TIKHUB_API_KEY。", "TIKHUB_NOT_CONFIGURED");
          await scanIndex(seedMeta, indexKey, params.refresh === true, project);
        }
        query.state = "complete"; await chrome.storage.local.set({ [key]: query });
        return view;
      } catch (error) {
        query.state = "error"; await chrome.storage.local.set({ [key]: query });
        await saveView({ state: "error", phase: "error", error: error.message, errorCode: error.code, errorDetails: error.details, httpStatus: error.details?.httpStatus });
        throw error;
      }
    })().finally(() => listing.delete(key));
    listing.set(key, operation);
    return operation;
  }

  function downloadOptions(options) {
    if (options?.outputTarget !== "download" || typeof options.includeImages !== "boolean" || typeof options.zipOutput !== "boolean") {
      throw fail("公众号文章仅按当前选择下载到本地，请刷新扩展后重新选择 ZIP 或 Markdown。", "INVALID_PARAMS");
    }
    return { includeImages: options.includeImages, zipOutput: options.zipOutput, outputTarget: "download" };
  }

  async function openDownloadJob(id, data, options, createdAt) {
    const job = { id, title: `公众号历史下载 - ${data.matchedAccount.nickname || data.matchedAccount.username}`,
      source: "wechat-history", ...options, outputTarget: "download", saveToObsidian: false,
      links: data.links, account: data.matchedAccount, dateRange: { startDate: data.startDate, endDate: data.endDate }, createdAt };
    await chrome.storage.local.set({ [`batchJob:${id}`]: job });
    const runnerUrl = chrome.runtime.getURL(`batch-runner.html?jobId=${encodeURIComponent(id)}`);
    const existing = (await chrome.tabs.query({})).find(tab => tab.url === runnerUrl);
    if (existing) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url: runnerUrl, active: true });
  }

  async function downloadSelected(params) {
    const options = downloadOptions(params?.options);
    if (!/^wechatHistory:[a-f0-9]{64}$/.test(params?.listId || "") || !Array.isArray(params?.articleUrls)
      || !params.articleUrls.length || params.articleUrls.length > 10000 || params.articleUrls.some(url => typeof url !== "string")) {
      throw fail("请先获取文章列表并勾选要下载的文章。", "INVALID_PARAMS");
    }
    const selected = new Set(params.articleUrls);
    const job = (await chrome.storage.local.get(params.listId))[params.listId];
    if (!job || (!job.complete && job.version !== 5)) throw fail("请重新获取文章列表。", "WECHAT_HISTORY_INCOMPLETE");
    const data = job.version === 5 ? listedResult(job, job) : result(job);
    if ([...selected].some(url => !data.links.includes(url))) throw fail("所选文章不属于当前公众号和日期范围，请重新获取列表。", "WECHAT_SELECTION_INVALID");
    const articles = data.articles.filter(article => selected.has(article.url));
    const input = { listId: params.listId, articleUrls: articles.map(article => article.url), options };
    const key = await inputKey("wechatDownload:", input);
    if (downloads.has(key)) return downloads.get(key);
    const operation = (async () => {
      const intent = { ...input, id: crypto.randomUUID(), state: "starting", createdAt: new Date().toISOString() };
      await chrome.storage.local.set({ [key]: intent });
      try {
        const verified = [];
        for (const article of articles) {
          const checked = job.version === 5 ? await verifiedArticle(article, job.seedMeta) : article;
          if (checked.publishDate < job.startDate || checked.publishDate > job.endDate) {
            throw fail("所选文章原文发表日期不在当前范围内，请取消勾选后重试。", "WECHAT_SELECTION_DATE_MISMATCH");
          }
          verified.push(checked);
        }
        const selectedData = { ...data, articles: verified, links: input.articleUrls, startDate: job.startDate, endDate: job.endDate };
        await openDownloadJob(intent.id, selectedData, options, intent.createdAt);
        intent.state = "complete"; await chrome.storage.local.set({ [key]: intent });
        return { ...selectedData, jobId: intent.id };
      } catch (error) {
        intent.state = "error"; intent.error = error.message; await chrome.storage.local.set({ [key]: intent }); throw error;
      }
    })().finally(() => downloads.delete(key));
    downloads.set(key, operation);
    return operation;
  }

  async function download(params) {
    const seed = seedInput(params);
    const options = downloadOptions(params.options);
    // Store the click-time options before reading the seed. Closing the popup
    // cannot change the destination or orphan a completed collection.
    const input = { ...seed, options };
    const key = await inputKey("wechatDownload:", input);
    if (downloads.has(key)) return downloads.get(key);
    const operation = (async () => {
      let intent = (await chrome.storage.local.get(key))[key];
      if (!intent || intent.state === "complete") intent = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const persist = async () => { intent.updatedAt = Date.now(); await chrome.storage.local.set({ [key]: intent }); };
      intent.state = "collecting"; intent.error = ""; await persist();
      try {
        const connection = await nativeCall("tikhub_status");
        if (!connection.configured) throw fail("未配置下载服务，请在本机项目 .env 中设置 TIKHUB_API_KEY。", "TIKHUB_NOT_CONFIGURED");
        const seedMeta = intent.seedMeta || await articleMeta(input.seedUrl);
        validateInput({ seedMeta, startDate: input.startDate, endDate: input.endDate });
        intent.seedMeta = seedMeta; await persist();
        const data = await resolve({ seedMeta, startDate: input.startDate, endDate: input.endDate });
        if (data.links.length) {
          await openDownloadJob(intent.id, { ...data, ...seed }, options, intent.createdAt);
        }
        intent.state = "complete"; await persist();
        return { ...data, jobId: data.links.length ? intent.id : null };
      } catch (error) {
        intent.state = "error"; intent.error = error.message; await persist(); throw error;
      }
    })().finally(() => downloads.delete(key));
    downloads.set(key, operation);
    return operation;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "wechat-history") return false;
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ ok: false, code: "FORBIDDEN", error: "公众号范围下载只能从插件弹出页发起。" });
      return false;
    }
    const operation = message.action === "status" ? nativeCall("tikhub_status")
      : message.action === "resolve" ? resolve(message.params)
      : message.action === "list" ? list(message.params)
      : message.action === "download-selected" ? downloadSelected(message.params)
      : message.action === "download" ? download(message.params) : Promise.reject(fail("不支持的公众号操作。", "INVALID_PARAMS"));
    operation.then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message, code: error.code || "WECHAT_HISTORY_ERROR", details: error.details }));
    return true;
  });
})();
