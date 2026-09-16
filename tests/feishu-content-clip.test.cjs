const assert = require("node:assert/strict");
const test = require("node:test");
const { targetFromNode, createJob, runContentJob } = require("../shared/feishu-wiki-clip.js");

function fixture(overrides = {}) {
  const parent = { space_id: "123", node_token: "Parent", node_type: "origin", title: "资料" };
  const final = { ...parent, node_token: "Saved", obj_token: "Created", obj_type: "docx", parent_node_token: "Parent" };
  const job = createJob("https://my.feishu.cn/docx/Source", targetFromNode(parent), "content-operation");
  const calls = [], states = [];
  const bytes = Buffer.alloc(220001, 127);
  let offset = 0, imported = false;
  const handlers = {
    get_node: ({ token }) => ({ node: token === "Parent" ? parent : final }),
    prepare_content: () => ({ title: "原题", block_count: 3, image_count: 1, images: [{ block_id: "Image", token: "SourceImage" }] }),
    stage_image: (p) => { assert.equal(p.offset, offset); offset += Buffer.from(p.data_base64, "base64").length;
      return { next_offset: offset, complete: offset === p.total_size }; },
    import_step: () => { const complete = imported; imported = true;
      return { complete, document: { token: "Created", type: "docx" }, progress: { completed: complete ? 3 : 0, total: 3, phase: "verify" } }; },
    move_doc: () => ({ wiki_token: "Saved" }),
    ...overrides
  };
  const deps = {
    call: async (action, p) => { calls.push({ action, p }); assert.ok(handlers[action], `Unexpected ${action}`); return handlers[action](p); },
    captureImage: async () => ({ mimeType: "image/png", size: bytes.length, contentBase64: bytes.toString("base64") }),
    save: async (state) => states.push(structuredClone(state)), sleep: async () => {}
  };
  return { job, deps, calls, states };
}

test("new tasks rebuild content without checking or requesting source copy permission", async () => {
  const f = fixture();
  assert.equal(f.job.mode, "content");
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.equal(f.job.resultUrl, "https://my.feishu.cn/wiki/Saved");
  assert.equal(f.calls.some(c => ["copy_doc", "check_copy"].includes(c.action)), false);
  assert(f.calls.filter(c => c.action === "prepare_content").every(c => c.p.origin_url === "https://my.feishu.cn/docx/Source"));
  const chunks = f.calls.filter(c => c.action === "stage_image");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].p.offset, 196608);
  assert.ok(f.calls.findIndex(c => c.action === "import_step") > f.calls.findLastIndex(c => c.action === "stage_image"));
  assert.ok(f.states.some(s => s.copy?.token === "Created" && s.stage === "importing"));
});

test("wiki sources retain their original entry URL while reading the resolved document", async () => {
  const f = fixture();
  f.job.source = { type: "wiki", token: "OriginalWiki", url: "https://my.feishu.cn/wiki/OriginalWiki" };
  const original = f.deps.call;
  f.deps.call = async (action, p) => action === "get_node" && p.token === "OriginalWiki"
    ? { node: { obj_type: "docx", obj_token: "Source" } } : original(action, p);
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  const prepare = f.calls.filter(c => c.action === "prepare_content");
  assert.equal(prepare.length, 2);
  assert(prepare.every(c => c.p.token === "Source" && c.p.origin_url === f.job.source.url));
});

test("a failed image download never starts document creation", async () => {
  const f = fixture();
  f.deps.captureImage = async () => { throw new Error("图片暂不可读"); };
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "collecting");
  assert.match(f.job.error, /图片暂不可读/);
  assert.equal(f.calls.some(c => ["import_step", "move_doc"].includes(c.action)), false);
});

test("does not create when staging reports wrong offset or incomplete image", async () => {
  for (const stage_image of [() => ({ next_offset: 1, complete: false }), p => ({ next_offset: p.offset + Buffer.from(p.data_base64, "base64").length, complete: false })]) {
    const f = fixture({ stage_image });
    await runContentJob(f.job, f.deps);
    assert.equal(f.job.stage, "collecting");
    assert.ok(f.job.error);
    assert.equal(f.calls.some(c => c.action === "import_step"), false);
  }
});

test("resume skips staged images and uses the same operation id for import", async () => {
  const f = fixture({ prepare_content: () => ({ title: "原题", block_count: 3, image_count: 1,
    images: [{ block_id: "Image", token: "SourceImage", staged: true }] }) });
  Object.assign(f.job, { stage: "collecting", sourceToken: "Source" });
  f.deps.captureImage = async () => assert.fail("staged image must not be recaptured");
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.equal(f.calls.some(c => c.action === "stage_image"), false);
  assert.ok(f.calls.filter(c => c.action === "import_step").every(c => c.p.operation_id === "content-operation"));
});

test("a content verification error retains the new document and prevents migration", async () => {
  let steps = 0;
  const f = fixture({ import_step: () => {
    if (steps++) throw new Error("正文核对失败");
    return { complete: false, document: { token: "Created" }, progress: { phase: "verify", total: 3, completed: 0 } };
  } });
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "importing");
  assert.equal(f.job.copy.token, "Created");
  assert.match(f.job.error, /核对失败/);
  assert.equal(f.calls.some(c => c.action === "move_doc"), false);
});

test("unknown creation outcome is resumable but never retried in a loop", async () => {
  const f = fixture({ import_step: () => { throw Object.assign(new Error("创建结果未明"), { uncertain: true }); } });
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.uncertain, true);
  assert.equal(f.job.stage, "importing");
  assert.equal(f.calls.filter(c => c.action === "import_step").length, 1);
});

test("lost creation response releases the queue until lookup is due then completes the same operation", async () => {
  let clock = 100000, steps = 0;
  const f = fixture({ import_step: () => ++steps === 1
    ? { complete: false, deferred_until: 101000, progress: { phase: "content_recovering", completed: 1, total: 5 } }
    : { complete: true, document: { token: "Created" }, progress: { phase: "content_ready", completed: 5, total: 5 } }
  });
  f.deps.now = () => clock;
  f.deps.sleep = async () => assert.fail("deferred lookup must release the queue, not hold the worker");
  await runContentJob(f.job, f.deps);
  assert.equal(steps, 1);
  assert.equal(f.job.nextRunAt, 101000);
  assert.equal(f.job.autoRun, true);
  assert.equal(f.job.error, "");
  assert.equal(f.job.stage, "importing");
  assert.equal(f.calls.some(c => c.action === "move_doc"), false);
  clock = 101000;
  const resumed = structuredClone(f.job);
  await runContentJob(resumed, f.deps);
  assert.equal(resumed.stage, "complete", resumed.error);
  assert.equal(resumed.nextRunAt, 0);
  assert.equal(resumed.id, f.job.id);
  assert.equal(steps, 2);
  assert.ok(f.calls.filter(c => c.action === "import_step").every(c => c.p.operation_id === f.job.id));
});

test("invalid new-document identity and missing verified document cannot be migrated", async () => {
  for (const result of [{ complete: true }, { complete: true, document: { token: "Source" } }]) {
    const f = fixture({ import_step: () => result });
    await runContentJob(f.job, f.deps);
    assert.ok(f.job.error);
    assert.equal(f.calls.some(c => c.action === "move_doc"), false);
  }
});

test("pending content tasks retain location recovery when a prior task query failed", async () => {
  const f = fixture({ get_task: () => assert.fail("resolved location must avoid stale task") });
  Object.assign(f.job, { stage: "pending", sourceToken: "Source", copy: { token: "Created" },
    taskId: "old-task", error: "旧任务查询失败" });
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.deepEqual(f.calls.map(c => c.action), ["move_doc", "get_node"]);
});

test("replays a partially staged image after interruption without creating a second task", async () => {
  const bytes = Buffer.alloc(600001, 99);
  let received = Buffer.alloc(0), failOnce = true;
  const f = fixture({ stage_image: p => {
    const chunk = Buffer.from(p.data_base64, "base64");
    if (p.offset === 393216 && failOnce) { failOnce = false; throw new Error("传输中断"); }
    if (p.offset < received.length) assert.deepEqual(received.subarray(p.offset, p.offset + chunk.length), chunk);
    else received = Buffer.concat([received, chunk]);
    return { next_offset: p.offset + chunk.length, complete: received.length === p.total_size };
  } });
  f.deps.captureImage = async () => ({ mimeType: "image/png", size: bytes.length, contentBase64: bytes.toString("base64") });
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "collecting");
  assert.equal(received.length, 393216);
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete", f.job.error);
  assert.deepEqual(received, bytes);
});

const transient = () => Object.assign(new Error("飞书请求暂时中断"), { code: "CLI_TIMEOUT", retryable: true, uncertain: true });

test("safe journaled writes recover automatically with exact backoff and the same operation id", async () => {
  let attempts = 0, clock = 100000;
  const delays = [];
  const f = fixture({ import_step: () => {
    if (attempts++ < 3) throw transient();
    return { complete: true, document: { token: "Created" }, progress: { phase: "content_ready", completed: 3, total: 3 } };
  } });
  f.deps.now = () => clock;
  f.deps.sleep = async delay => { delays.push(delay); clock += delay; };
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete");
  assert.equal(f.job.autoRun, false);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  const retries = f.states.filter(state => state.retryable && state.nextRetryAt);
  assert(retries.some(state => state.retryCount === 3 && state.nextRetryAt === 107000));
  assert(retries.every(state => state.errorCode === "CLI_TIMEOUT" && state.failedStep === "import_step" && state.autoRun));
  assert(f.calls.filter(call => call.action === "import_step").every(call => call.p.operation_id === f.job.id));
  assert.equal(f.calls.filter(call => call.action === "move_doc").length, 1);
  assert.equal(f.job.lastErrorCode, "CLI_TIMEOUT");
  assert.equal(f.job.lastFailedStep, "import_step");
  assert.equal(f.job.lastRetryCount, 3);
});

test("stops after five automatic retries and keeps diagnostics and the existing document", async () => {
  const f = fixture({ import_step: () => { throw transient(); } });
  Object.assign(f.job, { stage: "importing", sourceToken: "Source", copy: { token: "Created" } });
  const delays = [];
  f.deps.sleep = async delay => delays.push(delay);
  await runContentJob(f.job, f.deps);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000]);
  assert.equal(f.calls.filter(call => call.action === "import_step").length, 6);
  assert.equal(f.job.copy.token, "Created");
  assert.equal(f.job.stage, "importing");
  assert.equal(f.job.autoRun, false);
  assert.equal(f.job.retryExhausted, true);
  assert.equal(f.job.retryCount, 5);
  assert.equal(f.job.nextRetryAt, 0);
  assert.equal(f.job.errorCode, "CLI_TIMEOUT");
  assert.equal(f.calls.some(call => call.action === "move_doc"), false);
});

test("creation uncertainty, mismatched content and authorization failures cannot be auto-retried", async () => {
  for (const code of ["CREATE_UNCERTAIN", "COPY_UNCERTAIN", "MOVE_UNCERTAIN", "CONTENT_MISMATCH", "AUTH_REQUIRED", "MISSING_SCOPE", "PERMISSION_DENIED"]) {
    const f = fixture({ import_step: () => { throw Object.assign(transient(), { code }); } });
    f.deps.sleep = async () => assert.fail("unsafe error must not schedule retry");
    await runContentJob(f.job, f.deps);
    assert.equal(f.calls.filter(call => call.action === "import_step").length, 1, code);
    assert.equal(f.job.autoRun, false, code);
    assert.equal(f.job.errorCode, code);
    assert.equal(f.job.nextRetryAt, 0);
  }
});

test("each successfully completed native unit resets its own retry budget", async () => {
  let step = 0;
  const f = fixture({ import_step: () => {
    step++;
    if (step === 1 || step === 3) throw transient();
    return { complete: step === 4, document: { token: "Created" }, progress: { phase: "content_appending", completed: step, total: 4 } };
  } });
  const delays = [];
  f.deps.sleep = async delay => delays.push(delay);
  await runContentJob(f.job, f.deps);
  assert.equal(f.job.stage, "complete");
  assert.deepEqual(delays, [1000, 1000]);
});

test("a worker restart respects the saved retry deadline and cannot reset the five-retry budget", async () => {
  let clock = 0, sleeps = 0;
  const f = fixture({ import_step: () => { throw transient(); } });
  Object.assign(f.job, { stage: "importing", sourceToken: "Source", autoRun: true });
  f.deps.now = () => clock;
  f.deps.sleep = async delay => {
    if (++sleeps === 4) return new Promise(() => {}); // Simulate a terminated worker during its fourth backoff.
    clock += delay;
  };
  runContentJob(f.job, f.deps);
  await new Promise(setImmediate);
  assert.equal(f.job.retryCount, 4);
  const resumedJob = structuredClone(f.job);
  const next = fixture({ import_step: () => { throw transient(); } });
  clock = 10000;
  const waits = [];
  next.deps.now = () => clock;
  next.deps.sleep = async delay => { waits.push(delay); clock += delay; };
  await runContentJob(resumedJob, next.deps);
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(next.calls.filter(call => call.action === "import_step").length, 2);
  assert.equal(resumedJob.retryCount, 5);
  assert.equal(resumedJob.retryExhausted, true);
  assert.equal(resumedJob.autoRun, false);
});
