const assert = require("node:assert/strict");
const test = require("node:test");
const { parseDocumentUrl, targetFromNode, createJob, runJob, completionDuration, formatDuration } = require("../shared/feishu-wiki-clip.js");

const targetNode = { space_id: "1234567890123456789", node_token: "ParentToken", node_type: "origin", title: "剪存资料" };
const target = targetFromNode(targetNode);
const finalNode = { ...targetNode, node_token: "SavedWiki", obj_token: "CopiedDoc", obj_type: "docx", parent_node_token: "ParentToken" };

test("completion durations require reliable complete timestamps and share one Chinese formatter", () => {
  const job = { stage: "complete", createdAt: "2026-09-16T00:00:00.000Z", completedAt: "2026-09-16T00:02:03.456Z" };
  assert.equal(completionDuration(job), 123456);
  assert.equal(formatDuration(completionDuration(job)), "2 分 3 秒");
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(59999), "59 秒");
  assert.equal(formatDuration(60000), "1 分 0 秒");
  assert.equal(formatDuration(3661000), "1 小时 1 分");
  for (const value of [null, undefined, "1000", NaN, Infinity, -1]) assert.equal(formatDuration(value), "");
  for (const patch of [{ stage: "verifying" }, { error: "尚未核对" }, { completionTimeUnknown: true },
    { createdAt: undefined }, { completedAt: undefined }, { completedAt: "invalid" },
    { completedAt: "2026-09-15T23:59:59Z" }]) assert.equal(completionDuration({ ...job, ...patch }), null);
  assert.equal(completionDuration(null), null);
});

test("verified completion captures its actual observation time and later resumes do not change it", async () => {
  const { job, deps } = fixture();
  job.createdAt = "2026-09-16T00:00:00.000Z";
  job.completionTimeUnknown = true;
  let now = Date.parse("2026-09-16T00:02:03.000Z");
  deps.now = () => now;
  await runJob(job, deps);
  assert.equal(job.completedAt, "2026-09-16T00:02:03.000Z");
  assert.equal(job.completionTimeUnknown, false);
  assert.equal(completionDuration(job), 123000);
  now += 600000;
  await runJob(job, deps);
  assert.equal(completionDuration(job), 123000);
});

function fixture(overrides = {}, source = "https://my.feishu.cn/docx/SourceDoc") {
  const calls = [];
  const saved = [];
  const job = createJob(source, target, "fixed-operation-id");
  const handlers = {
    get_node: ({ token }) => ({ node: token === "ParentToken" ? targetNode : token === "SourceWiki"
      ? { ...targetNode, node_token: token, obj_type: "docx", obj_token: "SourceDoc", title: "原文" } : finalNode }),
    check_copy: () => ({ auth_result: true }),
    get_document: () => ({ document: { title: "原文：图片与表格" } }),
    copy_doc: () => ({ file: { token: "CopiedDoc", type: "docx", url: "javascript:alert(1)" } }),
    move_doc: () => ({ wiki_token: "SavedWiki" }),
    get_task: () => ({ task: { move_result: [{ status: 0, node: finalNode }] } }),
    ...overrides
  };
  const deps = {
    call: async (action, params) => { calls.push({ action, params }); return handlers[action](params); },
    save: async (state) => saved.push(structuredClone(state)),
    sleep: async () => {}, pollLimit: 2
  };
  return { job, calls, saved, deps };
}

test("only accepts exact supported HTTPS document URLs", () => {
  assert.equal(parseDocumentUrl("https://my.feishu.cn/docx/ABC?from=share#text").url, "https://my.feishu.cn/docx/ABC");
  for (const value of ["https://feishu.cn.evil.com/docx/ABC", "https://evilfeishu.cn/docx/ABC", "javascript:alert(1)",
    "http://my.feishu.cn/docx/ABC", "https://user:pass@my.feishu.cn/docx/ABC", "https://my.feishu.cn:8443/wiki/A",
    "https://my.feishu.cn/docx/A/other", "https://my.feishu.cn/docx/%2f", "https://example.larksuite.com/wiki/ABC"]) {
    assert.throws(() => parseDocumentUrl(value));
  }
  assert.throws(() => parseDocumentUrl("https://my.feishu.cn/docx/ABC", true), /父页面/);
  assert.throws(() => targetFromNode({ ...targetNode, node_type: "shortcut" }), /快捷方式/);
});

test("copies original title and moves only the new doc under the exact chosen parent", async () => {
  const { job, deps, calls, saved } = fixture();
  await runJob(job, deps);
  assert.equal(job.stage, "complete");
  assert.equal(job.resultUrl, "https://my.feishu.cn/wiki/SavedWiki");
  assert.equal(job.copy.url, "https://my.feishu.cn/docx/CopiedDoc");
  assert.deepEqual(calls.find((c) => c.action === "copy_doc").params,
    { token: "SourceDoc", name: "原文：图片与表格", operation_id: job.id });
  assert.deepEqual(calls.find((c) => c.action === "move_doc").params,
    { space_id: target.spaceId, parent_node_token: "ParentToken", obj_token: "CopiedDoc", operation_id: job.id });
  assert.ok(saved.some((state) => state.stage === "copying" && !state.copy));
  assert.ok(saved.some((state) => state.stage === "copied" && state.copy.token === "CopiedDoc"));
  assert.ok(calls.every((c) => c.action !== "move_doc" || c.params.obj_token !== "SourceDoc"));
});

test("resolves a wiki source to docx before checking or copying", async () => {
  const { job, deps, calls } = fixture({}, "https://my.feishu.cn/wiki/SourceWiki");
  await runJob(job, deps);
  assert.equal(job.stage, "complete");
  assert.equal(calls.find((c) => c.action === "check_copy").params.token, "SourceDoc");
});

test("denied copy permission performs no writes and does not downgrade content", async () => {
  for (const auth_result of [false, undefined, "true"]) {
    const { job, deps, calls } = fixture({ check_copy: () => ({ auth_result }) });
    await runJob(job, deps);
    assert.equal(job.stage, "ready");
    assert.match(job.error, /没有创建副本权限/);
    assert.equal(calls.some((c) => ["copy_doc", "move_doc"].includes(c.action)), false);
  }
});

test("does not create a copy if the target space has changed or the source is not docx", async () => {
  const moved = fixture({ get_node: () => ({ node: { ...targetNode, space_id: "98765" } }) });
  await runJob(moved.job, moved.deps);
  assert.match(moved.job.error, /目标父页面已移动/);
  assert.equal(moved.calls.some((c) => c.action === "copy_doc"), false);
  const sheet = fixture({ get_node: ({ token }) => ({ node: token === "ParentToken" ? targetNode : { obj_type: "sheet" } }) }, "https://my.feishu.cn/wiki/SourceWiki");
  await runJob(sheet.job, sheet.deps);
  assert.match(sheet.job.error, /不是飞书文档/);
  assert.equal(sheet.calls.some((c) => c.action === "copy_doc"), false);
});

test("does not silently truncate a long original title", async () => {
  const { job, deps, calls } = fixture({ get_document: () => ({ document: { title: "长".repeat(86) } }) });
  await runJob(job, deps);
  assert.match(job.error, /256 字节/);
  assert.equal(calls.some((c) => c.action === "copy_doc"), false);
});

test("an uncertain copy response is recorded without an automatic retry or move", async () => {
  const { job, deps, calls } = fixture({ copy_doc: () => { throw Object.assign(new Error("连接中断"), { uncertain: true }); } });
  await runJob(job, deps);
  assert.equal(job.stage, "copying");
  assert.equal(job.uncertain, true);
  assert.equal(calls.filter((c) => c.action === "copy_doc").length, 1);
  assert.equal(calls.some((c) => c.action === "move_doc"), false);
});

test("a disconnected migration remains scheduled under the same copy without blocking the queue", async () => {
  const f = fixture({ move_doc: () => { throw Object.assign(new Error("迁入请求断线"), { code: "CLI_NETWORK", uncertain: true, retryable: false }); } });
  f.deps.now = () => 1000;
  Object.assign(f.job, { stage: "moving", sourceToken: "SourceDoc", copy: { token: "CopiedDoc" }, autoRun: true });
  await runJob(f.job, f.deps);
  assert.deepEqual(f.calls.map(call => call.action), ["move_doc"]);
  assert.equal(f.job.stage, "moving");
  assert.equal(f.job.autoRun, true);
  assert.equal(f.job.nextRunAt, 2000);
  assert.equal(f.job.error, "");
  assert.equal(f.job.lastErrorCode, "CLI_NETWORK");
  const next = fixture(); next.deps.now = () => 2000;
  await runJob(structuredClone(f.job), next.deps);
  assert.deepEqual(next.calls.map(call => call.action), ["move_doc", "get_node"]);
  assert.equal(next.calls[0].params.obj_token, "CopiedDoc");
});

test("never moves a copy response containing the source token", async () => {
  const { job, deps, calls } = fixture({ copy_doc: () => ({ file: { token: "SourceDoc", type: "docx" } }) });
  await runJob(job, deps);
  assert.equal(job.uncertain, true);
  assert.equal(calls.some((c) => c.action === "move_doc"), false);
});

test("resumes a journaled copy with the same id after browser storage was interrupted", async () => {
  const { job, deps, calls } = fixture();
  Object.assign(job, { stage: "copying", sourceToken: "SourceDoc", title: "原文" });
  await runJob(job, deps);
  assert.equal(job.stage, "complete");
  assert.equal(calls[0].action, "copy_doc");
  assert.equal(calls[0].params.operation_id, "fixed-operation-id");
});

test("resumes migration of the saved copy without copying again", async () => {
  const { job, deps, calls } = fixture({ move_doc: () => { throw new Error("目标暂无编辑权限"); } });
  await runJob(job, deps);
  assert.equal(job.stage, "moving");
  assert.equal(job.copy.token, "CopiedDoc");
  const next = fixture({ get_node: ({ token }) => {
    if (token === "CopiedDoc") throw new Error("不在知识库中");
    return { node: token === "ParentToken" ? targetNode : finalNode };
  } });
  await runJob(structuredClone(job), next.deps);
  assert.equal(next.calls.some((c) => c.action === "copy_doc"), false);
  assert.equal(next.calls.find((c) => c.action === "move_doc").params.obj_token, "CopiedDoc");
});

test("retains the full async task id and keeps processing distinct from success", async () => {
  const id = "7037044037068177428-075c9481e6a0007c1df689dfbe5b55a08b6b06f7";
  const { job, deps, calls } = fixture({ move_doc: () => ({ task_id: id }), get_task: () => ({ task: { move_result: [{ status: 1 }] } }) });
  await runJob(job, deps);
  assert.equal(job.stage, "pending");
  assert.equal(job.taskId, id);
  assert.equal(job.resultUrl, undefined);
  assert.equal(calls.filter((c) => c.action === "get_task").length, 0);
  assert.ok(job.nextRunAt > 0);
  assert.equal(job.autoRun, true);
  const next = fixture();
  await runJob(job, next.deps);
  assert.equal(job.stage, "complete");
  assert.equal(next.calls[0].action, "move_doc");
  assert.equal(next.calls.some((c) => c.action === "copy_doc"), false);
});

test("does not report success for wrong parent, wrong space, wrong document, or shortcut", async () => {
  for (const patch of [{ parent_node_token: "OtherParent" }, { space_id: "999" }, { obj_token: "SourceDoc" }, { node_type: "shortcut" }]) {
    const { job, deps } = fixture({ get_node: ({ token }) => ({ node: token === "ParentToken" ? targetNode : { ...finalNode, ...patch } }) });
    await runJob(job, deps);
    assert.equal(job.stage, "verifying");
    assert.match(job.error, /位置尚未核对成功/);
    assert.equal(job.resultUrl, undefined);
  }
});

test("async failure keeps the existing copy and task for inspection", async () => {
  const { job, deps } = fixture({ move_doc: () => { throw Object.assign(new Error("迁入失败"), { code: "MOVE_FAILED" }); } });
  await runJob(job, deps);
  assert.equal(job.stage, "move_failed");
  assert.equal(job.copy.token, "CopiedDoc");
  assert.match(job.error, /迁入失败/);
  assert.equal(job.resultUrl, undefined);
});

test("recovers when the user manually moved a failed copy to the chosen parent", async () => {
  const { job, deps } = fixture({ move_doc: () => { throw Object.assign(new Error("迁入失败"), { code: "MOVE_FAILED" }); } });
  await runJob(job, deps);
  const recovery = fixture();
  await runJob(job, recovery.deps);
  assert.equal(job.stage, "complete");
  assert.deepEqual(recovery.calls.map((c) => c.action), ["move_doc", "get_node"]);
  assert.equal(recovery.calls[0].params.obj_token, "CopiedDoc");
});

test("known failed migration can retry the same copy after checking its location", async () => {
  const { job, deps } = fixture({ move_doc: () => { throw Object.assign(new Error("迁入失败"), { code: "MOVE_FAILED" }); } });
  await runJob(job, deps);
  const recovery = fixture({ get_node: ({ token }) => {
    if (token === "CopiedDoc") throw new Error("不在知识库中");
    return { node: finalNode };
  } });
  await runJob(job, recovery.deps);
  assert.equal(job.stage, "complete");
  assert.equal(recovery.calls.some((c) => c.action === "copy_doc"), false);
  assert.equal(recovery.calls.find((c) => c.action === "move_doc").params.obj_token, "CopiedDoc");
});

test("a native deferred migration releases the queue and keeps its task and deadline through restart", async () => {
  const f = fixture({ move_doc: () => ({ recovering: true, deferred_until: 5000, task_id: "long-task-123" }) });
  f.deps.now = () => 1000;
  Object.assign(f.job, { stage: "moving", sourceToken: "SourceDoc", copy: { token: "CopiedDoc" } });
  await runJob(f.job, f.deps);
  assert.equal(f.job.nextRunAt, 5000);
  assert.equal(f.job.taskId, "long-task-123");
  assert.equal(f.job.autoRun, true);
  const deadline = f.job.moveRecoveryDeadline;
  const persisted = structuredClone(f.job);
  f.deps.now = () => 5000;
  await runJob(persisted, f.deps);
  assert.equal(persisted.moveRecoveryDeadline, deadline);
  assert.equal(f.calls.filter(c => c.action === "move_doc").length, 2);
  assert.equal(f.calls.some(c => ["copy_doc", "get_task"].includes(c.action)), false);
});

test("transport recovery stays bounded across restarts and does not retry permanent failures", async () => {
  for (const code of ["NATIVE_UNAVAILABLE", "CLI_NETWORK", "MOVE_UNCERTAIN", "PERMISSION_DENIED", "TARGET_MISMATCH", "131007"]) {
    const f = fixture({ move_doc: () => { throw Object.assign(new Error("保存未完成"), { code, uncertain: true }); } });
    f.deps.now = () => 1000;
    Object.assign(f.job, { stage: "moving", sourceToken: "SourceDoc", copy: { token: "CopiedDoc" }, moveRecoveryDeadline: 2000 });
    await runJob(f.job, f.deps);
    assert.equal(f.job.autoRun, ["NATIVE_UNAVAILABLE", "CLI_NETWORK", "MOVE_UNCERTAIN"].includes(code));
    const restored = structuredClone(f.job);
    f.deps.now = () => 2000;
    await runJob(restored, f.deps);
    assert.equal(restored.autoRun, false);
    assert.equal(restored.moveRecoveryDeadline, 2000);
    assert.equal(restored.resultUrl, undefined);
    assert.equal(f.calls.some(c => c.action === "copy_doc"), false);
  }
});
