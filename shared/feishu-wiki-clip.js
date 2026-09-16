(function (scope) {
  "use strict";

  const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];
  const MOVE_RECOVERY_MS = 15 * 60 * 1000;
  const MOVE_TRANSIENT_CODES = new Set(["CLI_NETWORK", "CLI_TIMEOUT", "CLI_RESPONSE_ERROR",
    "NATIVE_UNAVAILABLE", "MOVE_UNCERTAIN", "BUSY"]);
  const NO_AUTO_RETRY = new Set(["CREATE_UNCERTAIN", "COPY_UNCERTAIN", "MOVE_UNCERTAIN", "CONTENT_MISMATCH",
    "CREATE_RECOVERY_CONFLICT", "PERMISSION_DENIED", "AUTH_REQUIRED", "AUTH_EXPIRED", "AUTH_INCOMPLETE", "MISSING_SCOPE", "INVALID_PARAMS", "UNSUPPORTED_CONTENT"]);

  function retryKey(action, params) {
    // Do not persist image bytes or complete article snapshots a second time.
    return JSON.stringify([action, ...["operation_id", "block_id", "offset", "token", "task_id", "obj_token"]
      .map(key => params?.[key] ?? ""), Boolean(params?.snapshot)]);
  }

  function withRetries(job, deps) {
    if (deps.retryJob === job) return deps;
    const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = deps.now || Date.now;
    const persist = async patch => {
      Object.assign(job, patch, { updatedAt: new Date(now()).toISOString() });
      await deps.save(structuredClone(job));
    };
    return { ...deps, sleep, retryJob: job, call: async (action, params = {}) => {
      const key = retryKey(action, params);
      let attempts = job.retryStepKey === key ? Number(job.retryCount) || 0 : 0;
      await persist({ activeStep: action });
      if (job.retryStepKey === key && job.nextRetryAt > now()) await sleep(job.nextRetryAt - now());
      for (;;) {
        try {
          const result = await deps.call(action, params);
          if (job.retryStepKey === key) await persist({ error: "", errorCode: "", retryable: false,
            retryCount: 0, nextRetryAt: 0, retryStepKey: "", retryExhausted: false, uncertain: false });
          return result;
        } catch (error) {
          error.step = action;
          // retryable is the host's explicit guarantee that its journal or
          // idempotency key makes this exact operation safe to repeat. A lost
          // response may still be uncertain, while safely replayable.
          if (error.retryable !== true || NO_AUTO_RETRY.has(error.code)) throw error;
          if (attempts >= RETRY_DELAYS.length) { error.retryExhausted = true; throw error; }
          const delay = RETRY_DELAYS[attempts++];
          await persist({ error: error.message, errorCode: error.code || "", failedStep: action,
            lastErrorCode: error.code || "", lastFailedStep: action, lastRetryCount: attempts,
            retryStepKey: key, retryCount: attempts, nextRetryAt: now() + delay,
            retryable: true, retryExhausted: false, autoRun: true, uncertain: Boolean(error.uncertain) });
          await sleep(delay);
        }
      }
    } };
  }

  function failureState(job, error) {
    return { error: error.message || "剪存失败，请检查连接和文档权限。", errorCode: error.code || "",
      failedStep: error.step || job.activeStep || job.stage, lastErrorCode: error.code || "",
      lastFailedStep: error.step || job.activeStep || job.stage, uncertain: Boolean(error.uncertain),
      retryable: false, retryExhausted: Boolean(error.retryExhausted), nextRetryAt: 0, autoRun: false };
  }

  function parseDocumentUrl(value, wikiOnly = false) {
    let url;
    try { url = new URL(String(value || "").trim()); } catch (_) { throw new Error("请粘贴完整的飞书文档链接。"); }
    const match = url.pathname.match(/^\/(docx|wiki)\/([A-Za-z0-9]+)\/?$/);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !/(^|\.)(feishu\.cn|larkoffice\.com)$/.test(url.hostname) || !match) {
      throw new Error("请使用飞书 docx / wiki 文档链接。");
    }
    if (wikiOnly && match[1] !== "wiki") throw new Error("目标位置请粘贴知识库中父页面的 wiki 链接。");
    return { url: `${url.origin}/${match[1]}/${match[2]}`, origin: url.origin, type: match[1], token: match[2] };
  }

  function parseSourceUrl(value) {
    try { return parseDocumentUrl(value); } catch (_) { /* Other readable webpages use browser capture. */ }
    let url;
    try { url = new URL(String(value || "").trim()); } catch (_) { throw new Error("请粘贴完整的网页或文档链接。"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
      throw new Error("请使用可在浏览器中打开的 HTTP 或 HTTPS 网页链接。");
    }
    return { url: url.href, origin: url.origin, type: "web", token: "WebRoot" };
  }

  function targetFromNode(node, origin = "https://my.feishu.cn", spaceName = "") {
    if (!node?.space_id || !node?.node_token || node.node_type === "shortcut") {
      throw new Error("请选择知识库中的普通父页面，不能使用快捷方式。");
    }
    const parsed = parseDocumentUrl(`${origin}/wiki/${node.node_token}`, true);
    return { spaceId: String(node.space_id), parentToken: node.node_token,
      title: node.title || "未命名页面", spaceName, origin: parsed.origin, url: parsed.url };
  }

  function createJob(sourceUrl, target, id) {
    const source = parseSourceUrl(sourceUrl);
    if (!target?.spaceId || !target?.parentToken) throw new Error("请先选择保存的父页面。");
    parseDocumentUrl(`${target.origin}/wiki/${target.parentToken}`, true);
    return { version: 2, mode: "content", id, source, target, stage: "ready", copy: null, taskId: "",
      wikiToken: "", error: "", uncertain: false, autoRun: false, retryCount: 0, nextRetryAt: 0, createdAt: new Date().toISOString() };
  }

  function verifyNode(job, node) {
    if (!node || node.obj_type !== "docx" || node.obj_token !== job.copy?.token
      || node.obj_token === job.sourceToken || String(node.space_id) !== job.target.spaceId
      || node.parent_node_token !== job.target.parentToken || node.node_type === "shortcut") {
      throw new Error("副本位置尚未核对成功。请保留当前任务并稍后继续查询，不要重新复制。");
    }
    return node;
  }

  // The native host journals each operation before issuing a write. Reusing an id
  // recovers its result; it must never repeat a write with an unknown outcome.
  async function runJob(job, deps) {
    const { call, save, now = Date.now } = withRetries(job, deps);
    const persist = async (patch) => {
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      await save(structuredClone(job));
    };
    try {
      if (["complete", "abandoned"].includes(job.stage)) return job;
      await persist({ error: job.retryable ? job.error : "", uncertain: job.retryable ? job.uncertain : false, autoRun: true });
      if (job.stage === "ready") {
        const { node: targetNode } = await call("get_node", { token: job.target.parentToken });
        const checkedTarget = targetFromNode(targetNode, job.target.origin, job.target.spaceName);
        if (checkedTarget.spaceId !== job.target.spaceId) throw new Error("目标父页面已移动，请重新选择保存位置。");
        let sourceToken = job.source.token;
        let sourceTitle = "";
        if (job.source.type === "wiki") {
          const { node } = await call("get_node", { token: sourceToken });
          if (node?.obj_type !== "docx") throw new Error("当前知识库节点不是飞书文档；暂不支持表格、多维表格或附件的原格式剪存。");
          sourceToken = node.obj_token;
          sourceTitle = node.title || "";
        }
        const permission = await call("check_copy", { token: sourceToken });
        if (permission.auth_result !== true) {
          throw new Error("当前飞书身份没有创建副本权限。请文档所有者允许创建副本，并确认登录的是有权限的账号。可阅读不代表可复制。");
        }
        const { document } = await call("get_document", { token: sourceToken });
        sourceTitle = document?.title || sourceTitle;
        if (!sourceTitle) throw new Error("未能读取原文标题，已停止剪存。");
        if (new TextEncoder().encode(sourceTitle).length > 256) {
          throw new Error("原文标题超过飞书复制接口的 256 字节限制，无法保持原题创建副本。");
        }
        await persist({ sourceToken, title: sourceTitle, target: checkedTarget, stage: "copying" });
      }
      if (job.stage === "copying") {
        const { file } = await call("copy_doc", { token: job.sourceToken, name: job.title, operation_id: job.id });
        if (!file?.token || file.token === job.sourceToken || file.type !== "docx") {
          const error = new Error("飞书未返回有效的独立副本。请检查云盘，不能直接重试创建。");
          error.uncertain = true;
          throw error;
        }
        // Ignore arbitrary URLs in API responses, and construct a trusted document URL.
        const copyUrl = parseDocumentUrl(`${job.target.origin}/docx/${file.token}`).url;
        await persist({ copy: { token: file.token, url: copyUrl }, stage: "copied" });
      }
      if (["copied", "moving", "pending", "move_failed"].includes(job.stage)) {
        // The helper owns location probes, async tasks and bounded replay of
        // this same document migration. One call per queue turn lets another
        // article run while Feishu is processing or reconnecting.
        await persist({ stage: "moving", nextRunAt: 0, migrationRecoveryVersion: 1,
          moveRecoveryDeadline: job.moveRecoveryDeadline || now() + MOVE_RECOVERY_MS });
        const result = await call("move_doc", { space_id: job.target.spaceId,
          parent_node_token: job.target.parentToken, obj_token: job.copy.token, operation_id: job.id });
        if (result.wiki_token) await persist({ wikiToken: result.wiki_token, stage: "verifying", moveRecovering: false });
        else if (result.task_id || Number.isFinite(result.deferred_until) && result.deferred_until > 0) {
          await persist({ stage: result.task_id ? "pending" : "moving", taskId: result.task_id ? String(result.task_id) : job.taskId,
            nextRunAt: Math.max(now() + 1000, result.deferred_until || now() + 1500), moveRecovering: true,
            error: "", errorCode: "", retryable: false, retryExhausted: false, autoRun: true });
          return job;
        } else {
          throw Object.assign(new Error("迁入响应暂未返回，正在自动恢复保存。"), { code: "MOVE_UNCERTAIN", uncertain: true });
        }
      }
      if (job.stage === "verifying") {
        const { node } = await call("get_node", { token: job.wikiToken });
        verifyNode(job, node);
        const resultUrl = parseDocumentUrl(`${job.target.origin}/wiki/${node.node_token}`, true).url;
        await persist({ resultUrl, stage: "complete", error: "", errorCode: "", autoRun: false,
          retryable: false, nextRetryAt: 0, nextRunAt: 0, moveRecovering: false, uncertain: false, completedAt: new Date().toISOString() });
      }
    } catch (error) {
      const migration = Boolean(job.copy?.token && ["moving", "pending", "verifying"].includes(job.stage));
      const transient = MOVE_TRANSIENT_CODES.has(error.code)
        || error.retryable === true && !NO_AUTO_RETRY.has(error.code);
      const deadline = job.moveRecoveryDeadline || now() + MOVE_RECOVERY_MS;
      if (migration && transient && now() < deadline) {
        const attempts = (job.moveTransportAttempts || 0) + 1;
        await persist({ stage: "moving", autoRun: true, moveRecovering: true, migrationRecoveryVersion: 1,
          moveRecoveryDeadline: deadline, moveTransportAttempts: attempts,
          nextRunAt: Math.min(deadline, now() + [1000, 2000, 4000, 8000, 15000, 30000][Math.min(attempts - 1, 5)]),
          error: "", errorCode: "", retryable: false, retryExhausted: false, retryStepKey: "", retryCount: 0, nextRetryAt: 0,
          lastErrorCode: error.code || "", lastFailedStep: error.step || job.activeStep });
      } else {
        await persist({ ...failureState(job, error), nextRunAt: 0, moveRecovering: false,
          ...(error.code === "MOVE_FAILED" ? { stage: "move_failed" } : {}) });
      }
    }
    return job;
  }

  async function runContentJob(job, deps) {
    deps = withRetries(job, deps);
    if (["copied", "moving", "pending", "move_failed", "verifying"].includes(job.stage)) return runJob(job, deps);
    const { call, save, captureImage, captureWeb } = deps;
    const persist = async (patch) => {
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      await save(structuredClone(job));
    };
    try {
      if (["complete", "abandoned"].includes(job.stage)) return job;
      await persist({ error: job.retryable ? job.error : "", uncertain: job.retryable ? job.uncertain : false, autoRun: true });
      if (job.stage === "ready") {
        const { node } = await call("get_node", { token: job.target.parentToken });
        const target = targetFromNode(node, job.target.origin, job.target.spaceName);
        if (target.spaceId !== job.target.spaceId) throw new Error("目标父页面已移动，请重新选择保存位置。");
        let sourceToken = job.source.token;
        if (job.source.type === "wiki") {
          const { node: source } = await call("get_node", { token: sourceToken });
          if (source?.obj_type !== "docx") throw new Error("当前知识库节点不是可剪存的飞书文档。");
          sourceToken = source.obj_token;
        }
        let plan;
        if (job.source.type === "web") {
          try {
            plan = await call("prepare_web_content", { source_url: job.source.url, operation_id: job.id });
          } catch (error) {
            if (error.code !== "IMPORT_NOT_PREPARED") throw error;
            await persist({ activeStep: "capture_web" });
            const snapshot = await captureWeb(job.source, job.sourceTabId);
            if (snapshot?.source_url !== job.source.url) throw new Error("网页已跳转，请重新打开要保存的页面。");
            plan = await call("prepare_web_content", { source_url: job.source.url, operation_id: job.id, snapshot });
          }
        } else plan = await call("prepare_content", { token: sourceToken, operation_id: job.id });
        if (!plan.title || !Number.isInteger(plan.block_count) || !Array.isArray(plan.images)) throw new Error("未能读取完整正文结构，请稍后重试。");
        await persist({ target, sourceToken, title: plan.title, stage: "collecting",
          counts: { blocks: plan.block_count, images: plan.image_count }, progress: { completed: 0, total: plan.image_count, phase: "collecting" } });
      }
      if (job.stage === "collecting") {
        let plan = job.source.type === "web"
          ? await call("prepare_web_content", { source_url: job.source.url, operation_id: job.id })
          : await call("prepare_content", { token: job.sourceToken, operation_id: job.id });
        if (job.source.type === "web" && plan.refresh_required === true) {
          // The helper only permits this migration before any image bytes or
          // remote writes exist. Re-extract a known old renderer mistake once,
          // keeping ordinary interrupted tasks on their frozen source snapshot.
          await persist({ activeStep: "capture_web", refreshRequestId: job.refreshRequestId || globalThis.crypto.randomUUID() });
          const snapshot = await captureWeb(job.source, job.sourceTabId);
          if (snapshot?.source_url !== job.source.url) throw new Error("网页已跳转，请重新打开要保存的页面。");
          plan = await call("refresh_web_content", { source_url: job.source.url, operation_id: job.id,
            request_id: job.refreshRequestId, snapshot });
          if (!plan.title || !Number.isInteger(plan.block_count) || !Array.isArray(plan.images) || plan.refresh_required) {
            // A received result settles this refresh attempt. A later capture
            // must be allowed to replace it instead of replaying its old ID.
            await persist({ refreshRequestId: "" });
            throw new Error("网页组件尚未更新完成，请刷新原网页后重试。");
          }
          await persist({ title: plan.title, refreshRequestId: "", counts: { blocks: plan.block_count, images: plan.image_count },
            progress: { completed: 0, total: plan.image_count, phase: "collecting" } });
        }
        for (let index = 0; index < plan.images.length; index += 1) {
          const entry = plan.images[index];
          if (!entry.staged) {
            await persist({ activeStep: "capture_image" });
            const asset = await captureImage(job.source, entry, job.sourceTabId);
            if (!asset?.mimeType?.startsWith("image/") || !asset.contentBase64 || !asset.size) throw new Error("图片读取不完整，已停止；不会生成缺图文档。");
            const pixels = {};
            if (job.source.type === "web") {
              if (![asset.pixelWidth, asset.pixelHeight].every(value => Number.isInteger(value) && value > 0 && value <= 100000)) {
                throw Object.assign(new Error("未取得图片的实际尺寸，已停止保存，避免生成过小或变形的图片。"), { code: "IMAGE_INVALID" });
              }
              pixels.pixel_width = asset.pixelWidth; pixels.pixel_height = asset.pixelHeight;
            }
            const encodedChunkSize = 256 * 1024;
            let offset = 0;
            for (let encoded = 0; encoded < asset.contentBase64.length; encoded += encodedChunkSize) {
              const data = asset.contentBase64.slice(encoded, encoded + encodedChunkSize);
              const response = await call("stage_image", { operation_id: job.id, block_id: entry.block_id,
                offset, total_size: asset.size, mime_type: asset.mimeType, data_base64: data, ...pixels });
              const expected = offset + data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
              if (response.next_offset !== expected) throw new Error("图片传输进度不一致，请继续当前任务重新核对。");
              offset = response.next_offset;
              if (encoded + data.length === asset.contentBase64.length && (!response.complete || offset !== asset.size)) {
                throw new Error("图片尚未完整传入本机，已停止创建文档。");
              }
            }
          }
          await persist({ progress: { completed: index + 1, total: plan.image_count, phase: "collecting" } });
        }
        await persist({ stage: "importing" });
      }
      if (job.stage === "importing") {
        // Each native step performs a bounded, journaled unit of work. Chrome
        // can resume the next unit after its service worker or browser restarts.
        for (let step = 0; step < 2000; step += 1) {
          const result = await call("import_step", { operation_id: job.id });
          let copy = job.copy;
          if (result.document?.token) {
            if (result.document.token === job.sourceToken) throw new Error("新建文档标识与原文相同，已停止后续写入。");
            copy = { token: result.document.token, url: parseDocumentUrl(`${job.target.origin}/docx/${result.document.token}`).url };
          }
          const nextRunAt = Number(result.deferred_until) || 0;
          await persist({ copy, progress: result.progress, counts: result.counts || job.counts,
            nextRunAt: nextRunAt > (deps.now || Date.now)() ? nextRunAt : 0 });
          if (job.nextRunAt) return job; // Release the queue while the host checks a lost create response.
          if (result.complete) {
            if (!copy) throw new Error("未找到已完成的新文档，不能迁入知识库。");
            await persist({ stage: "copied" });
            break;
          }
        }
        if (job.stage === "importing") return job; // The durable auto-run alarm continues the next bounded batch.
      }
      // Reuse only the migration/recovery half of the original state machine.
      return runJob(job, deps);
    } catch (error) {
      await persist(failureState(job, error));
      return job;
    }
  }

  const api = { parseDocumentUrl, parseSourceUrl, targetFromNode, createJob, verifyNode, runJob, runContentJob };
  scope.FeishuWikiClip = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
