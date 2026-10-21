const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const exporter = fs.readFileSync(require.resolve("../content-scripts/feishu-exporter.js"), "utf8");

for (const version of [2, 3, 4, 5, 6]) test(`an already-open v${version} source tab upgrades capture and receives one non-conflicting v2 export listener`, async () => {
  const oldSnapshot = () => { throw new Error("Outdated capture must be replaced"); };
  const oldListener = () => false;
  const listeners = [oldListener];
  const context = vm.createContext({ FeishuWebCapture: { version, snapshot: oldSnapshot },
    chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) } } } });
  vm.runInContext(exporter, context);
  assert.equal(context.FeishuWebCapture.version, 7);
  assert.notEqual(context.FeishuWebCapture.snapshot, oldSnapshot);
  const newSnapshot = context.FeishuWebCapture.snapshot;
  vm.runInContext(exporter, context);
  assert.equal(context.FeishuWebCapture.snapshot, newSnapshot);
  assert.equal(listeners.length, 2);
  assert.equal(listeners[0], oldListener);
  assert.equal(listeners[1]({ type: "feishu-export:export-document" }, {}, () => { throw new Error("Old protocol is owned by old listener"); }), false);
  const calls = [];
  context.FeishuWebCapture.handleMessage = async message => { calls.push(message); return { upgraded: true }; };
  const response = await new Promise(resolve => assert.equal(listeners[1](
    { type: "feishu-export:export-document-v2", format: "markdown" }, {}, resolve), true));
  assert.equal(response.ok, true);
  assert.equal(response.data.upgraded, true);
  assert.equal(calls.length, 1);
});

test("repeated capture injection in a fresh source tab registers the export listener exactly once", () => {
  const listeners = [];
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) } } } });
  vm.runInContext(exporter, context);
  vm.runInContext(exporter, context);
  assert.equal(listeners.length, 1);
  assert.equal(context.FeishuWebCapture.version, 7);
});

test("fresh v7 export listener accepts the original and updated protocols through the current dispatcher", async () => {
  const listeners = [];
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) } } } });
  vm.runInContext(exporter, context);
  context.FeishuWebCapture.handleMessage = async message => message.type;
  for (const type of ["feishu-export:export-document", "feishu-export:export-document-v2"]) {
    const response = await new Promise(resolve => listeners[0]({ type }, {}, resolve));
    assert.equal(response.ok, true); assert.equal(response.data, type);
  }
});
