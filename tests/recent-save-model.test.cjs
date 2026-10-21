const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const clip = require("../shared/feishu-wiki-clip.js");
const { storageKeys, readStoredOverview, buildRecentSaves } = require("../shared/recent-save-model.js");
const base = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const requestId = "11111111-1111-4111-8111-111111111111";
function job(patch = {}) {
  return { id: "job-original", requestId, source: clip.parseSourceUrl("https://example.com/article?a=1&b=2"),
    target: clip.targetFromNode({ space_id: "123", node_token: "Parent", title: "文章" }, "https://my.feishu.cn", "知识库"),
    stage: "ready", autoRun: false, error: "", createdAt: "2026-09-29T01:00:00Z", title: "文章标题", ...patch };
}

test("storage reads retain independent requests and prioritize current snapshots over queue over history", () => {
  const old = job({ title: "历史旧内容" });
  const fresh = job({ title: "队列新内容" });
  const another = job({ id: "job-another", requestId: "22222222-2222-4222-8222-222222222222" });
  const current = { ...another, title: "当前任务" };
  const input = { feishuWikiClipHistory: [old, another], feishuWikiClipJobs: [fresh], feishuWikiClipJob: current,
    feishuWikiClipTarget: fresh.target };
  const before = structuredClone(input);
  const result = readStoredOverview(input);
  assert.deepEqual(storageKeys, ["feishuWikiClipJobs", "feishuWikiClipHistory", "feishuWikiClipJob", "feishuWikiClipTarget"]);
  assert.deepEqual(result.jobs.map(item => item.title), ["队列新内容", "当前任务"]);
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(input, before);
  assert.deepEqual(readStoredOverview({}), { jobs: [], target: null });
});

test("recent rows sort by actual creation time, retain invalid dates, and do not modify records", () => {
  const input = [job({ id: "old" }), job({ id: "unknown", createdAt: undefined }), job({ id: "new", createdAt: "2026-09-29T02:00:00Z" })];
  const before = structuredClone(input);
  const rows = buildRecentSaves(input, base);
  assert.deepEqual(rows.map(row => row.id), ["new", "old", "unknown"]);
  assert.equal(rows.at(-1).createdAt, "");
  assert.deepEqual(input, before);
});

test("task routes preserve job, request, source, destination and optional tab without auto-start", () => {
  for (const request of [requestId, undefined]) {
    const [row] = buildRecentSaves([job({ requestId: request, sourceTabId: 42 })], base);
    const url = new URL(row.href);
    assert.equal(url.protocol, "chrome-extension:");
    assert.equal(url.host, new URL(base).host);
    assert.equal(url.pathname, "/feishu-save.html");
    assert.equal(url.searchParams.get("jobId"), "job-original");
    assert.equal(url.searchParams.get("requestId"), request || null);
    assert.equal(url.searchParams.get("source"), "https://example.com/article?a=1&b=2");
    assert.equal(url.searchParams.get("target"), "https://my.feishu.cn/wiki/Parent");
    assert.equal(url.searchParams.get("sourceTabId"), "42");
    assert.equal(url.searchParams.has("autoStart"), false);
  }
});

test("only a verified completion opens its exact Feishu wiki result", () => {
  const completed = job({ stage: "complete", wikiToken: "Saved", resultUrl: "https://my.feishu.cn/wiki/Saved?from=copy" });
  const [valid] = buildRecentSaves([completed], base);
  assert.equal(valid.href, "https://my.feishu.cn/wiki/Saved");
  assert.equal(valid.completed, true);
  assert.equal(valid.label, "已保存");
  for (const patch of [
    { resultUrl: "javascript:alert(1)" }, { resultUrl: "https://evil.com/wiki/Saved" },
    { resultUrl: "https://my.feishu.cn.evil.com/wiki/Saved" }, { resultUrl: "https://other.feishu.cn/wiki/Saved" },
    { resultUrl: "https://my.feishu.cn/wiki/Different" }, { resultUrl: "https://my.feishu.cn/docx/Saved" },
    { wikiToken: "" }, { error: "核验未通过" }, { stage: "moving" }
  ]) {
    const [row] = buildRecentSaves([{ ...completed, ...patch }], base);
    assert.equal(row.completed, false, JSON.stringify(patch));
    assert.ok(row.href.startsWith(base + "feishu-save.html?"));
  }
});

test("retrying errors remain running while exhausted, paused, and stopped tasks keep distinct states", () => {
  const jobs = [job({ id: "retry", autoRun: true, error: "网络中断", retryable: true }),
    job({ id: "exhausted", autoRun: true, error: "重试耗尽", retryable: true, retryExhausted: true }),
    job({ id: "paused", autoRun: false }), job({ id: "stopped", stage: "abandoned" }),
    job({ id: "queued", autoRun: true })];
  assert.deepEqual(buildRecentSaves(jobs, base).map(row => [row.status, row.label]),
    [["running", "处理中"], ["paused", "需要处理"], ["paused", "需要处理"], ["abandoned", "已停止"], ["running", "处理中"]]);
});

test("invalid routing metadata remains visible without a link and titles remain plain strings", () => {
  for (const patch of [{ source: { url: "javascript:alert(1)" } }, { source: null }, { target: null },
    { target: { ...job().target, url: "https://evil.com/wiki/Parent" } }, { target: { ...job().target, parentToken: "Other" } },
    { id: "bad&id" }, { requestId: "different-request" }]) {
    const [row] = buildRecentSaves([job(patch)], base);
    assert.ok(row);
    assert.equal(row.href, "", JSON.stringify(patch));
  }
  const [row] = buildRecentSaves([job({ title: "<img src=x onerror=alert(1)>" })], base);
  assert.equal(row.title, "<img src=x onerror=alert(1)>"); // caller renders with textContent
  assert.equal(typeof buildRecentSaves([job({ title: {} })], base)[0].title, "string");
  assert.equal(buildRecentSaves([job()], "https://evil.com/")[0].href, "");
});

test("browser UMD uses the existing Feishu parser without Node globals", () => {
  const scope = { FeishuWikiClip: clip, URL };
  vm.runInNewContext(fs.readFileSync(require.resolve("../shared/recent-save-model.js"), "utf8"), scope);
  assert.equal(scope.RecentSaveModel.buildRecentSaves([job()], base)[0].targetLabel, "知识库 / 文章");
});
