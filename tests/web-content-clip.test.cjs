const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSourceUrl, createJob, targetFromNode, runContentJob } = require("../shared/feishu-wiki-clip.js");

const source = "https://scys.com/articleDetail/xq_topic/55521155258121884";
function fixture() {
  const parent = { space_id: "123", node_token: "Parent", title: "外部内容", node_type: "origin" };
  const job = createJob(source, targetFromNode(parent), "web-operation");
  job.sourceTabId = 42;
  const calls = [];
  let prepared = false, captures = 0;
  const deps = {
    save: async () => {}, sleep: async () => {},
    captureWeb: async (url, tab) => {
      assert.equal(url.url, source); assert.equal(tab, 42); captures++;
      return { source_url: source, title: "网页原题", blocks: [], images: [] };
    },
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === "get_node") return { node: params.token === "Parent" ? parent : {
        ...parent, node_token: "Saved", obj_type: "docx", obj_token: "Created", parent_node_token: "Parent" } };
      if (action === "prepare_web_content") {
        assert.equal(params.source_url, source);
        if (params.snapshot) prepared = true;
        if (!prepared) throw Object.assign(new Error("未准备"), { code: "IMPORT_NOT_PREPARED" });
        return { title: "网页原题", block_count: 2, image_count: 0, images: [] };
      }
      if (action === "import_step") return { complete: true, document: { token: "Created" } };
      if (action === "move_doc") return { wiki_token: "Saved" };
      assert.fail(`Unexpected native operation: ${action}`);
    }
  };
  return { job, deps, calls, captures: () => captures };
}

test("HTTP webpages are sources while Feishu still uses native document capture", () => {
  assert.equal(parseSourceUrl(source).type, "web");
  assert.equal(parseSourceUrl("https://example.com/article?q=a#chapter").url, "https://example.com/article?q=a#chapter");
  assert.equal(parseSourceUrl("https://my.feishu.cn/docx/Doc?from=share").type, "docx");
  for (const url of ["file:///private/file", "javascript:alert(1)", "chrome://settings", "https://user:secret@example.com"]) {
    assert.throws(() => parseSourceUrl(url));
  }
});

test("a webpage snapshot is captured once, then rebuilt and verified under the chosen parent", async () => {
  const f = fixture();
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.equal(f.job.resultUrl, "https://my.feishu.cn/wiki/Saved");
  assert.equal(f.captures(), 1);
  assert.equal(f.calls.filter(c => c.params.snapshot).length, 1);
  assert.equal(f.calls.some(c => ["prepare_content", "check_copy", "copy_doc"].includes(c.action)), false);
});

test("a safe legacy renderer correction refreshes the unstarted snapshot automatically under the same job", async () => {
  const f = fixture(), call = f.deps.call;
  Object.assign(f.job, { stage: "collecting", sourceToken: "WebRoot", error: "图片HTTP400" });
  let refreshed = false, requestId;
  f.deps.call = async (action, params) => {
    if (action === "prepare_web_content") return { title: "网页原题", block_count: 4, image_count: 1, images: [], refresh_required: true };
    if (action === "refresh_web_content") {
      assert.equal(params.operation_id, f.job.id);
      assert.equal(params.request_id, f.job.refreshRequestId);
      assert.equal(params.snapshot.source_url, source);
      requestId = params.request_id; refreshed = true;
      return { title: "网页原题", block_count: 2, image_count: 0, images: [] };
    }
    assert(refreshed, "no document write may precede the corrected snapshot");
    return call(action, params);
  };
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.equal(f.captures(), 1);
  assert.ok(requestId);
  assert.deepEqual(f.job.counts, { blocks: 2, images: 0 });
  assert.equal(f.job.refreshRequestId, "");
});

test("a rejected snapshot refresh preserves the collecting task and performs no write", async () => {
  const f = fixture();
  Object.assign(f.job, { stage: "collecting", sourceToken: "WebRoot" });
  f.deps.call = async action => {
    if (action === "prepare_web_content") return { title: "原题", refresh_required: true, images: [] };
    if (action === "refresh_web_content") throw new Error("图片已经暂存，保留原进度");
    assert.fail("rejected refresh cannot reach document creation");
  };
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "collecting");
  assert.match(f.job.error, /保留原进度/);
  assert.ok(f.job.refreshRequestId);
});

test("a settled refresh that still needs correction permits a new captured snapshot on retry", async () => {
  const f = fixture(), call = f.deps.call, settled = new Map();
  Object.assign(f.job, { stage: "collecting", sourceToken: "WebRoot" });
  const old = { title: "网页原题", block_count: 4, image_count: 1, images: [], refresh_required: true };
  const corrected = { title: "网页原题", block_count: 2, image_count: 0, images: [] };
  f.deps.call = async (action, params) => {
    if (action === "prepare_web_content") return old;
    if (action === "refresh_web_content") {
      if (!settled.has(params.request_id)) settled.set(params.request_id, settled.size ? corrected : old);
      return settled.get(params.request_id);
    }
    return call(action, params);
  };
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "collecting");
  assert.equal(f.job.refreshRequestId, "");
  assert.match(f.job.error, /刷新原网页/);
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.equal(settled.size, 2);
  assert.equal(f.captures(), 2);
});

test("resume uses the frozen snapshot without needing to reread a changed webpage", async () => {
  const f = fixture(), call = f.deps.call;
  let fail = true;
  f.deps.call = async (action, params) => {
    if (action === "import_step" && fail) { fail = false; throw new Error("暂时断网"); }
    return call(action, params);
  };
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "importing");
  f.deps.captureWeb = async () => assert.fail("must reuse frozen content");
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.equal(f.calls.filter(c => c.params.snapshot).length, 1);
});

test("a changed source or extraction failure does not create a document", async () => {
  for (const captureWeb of [async () => ({ source_url: "https://example.com/other" }),
    async () => { throw new Error("正文含暂不支持的视频"); }]) {
    const f = fixture(); f.deps.captureWeb = captureWeb;
    await runContentJob(f.job, f.deps);
    assert.equal(f.job.stage, "ready");
    assert.ok(f.job.error);
    assert.equal(f.calls.some(c => c.params.snapshot || c.action === "import_step"), false);
  }
});
