const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const exporter = fs.readFileSync(require.resolve("../content-scripts/feishu-exporter.js"), "utf8");

test("an already-open v2 source tab receives the new capture without duplicate export listeners", () => {
  const oldSnapshot = () => { throw new Error("Outdated capture must be replaced"); };
  const oldListener = () => false;
  const listeners = [oldListener];
  const context = vm.createContext({ FeishuWebCapture: { version: 2, snapshot: oldSnapshot },
    chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) } } } });
  vm.runInContext(exporter, context);
  assert.equal(context.FeishuWebCapture.version, 3);
  assert.notEqual(context.FeishuWebCapture.snapshot, oldSnapshot);
  const newSnapshot = context.FeishuWebCapture.snapshot;
  vm.runInContext(exporter, context);
  assert.equal(context.FeishuWebCapture.snapshot, newSnapshot);
  assert.deepEqual(listeners, [oldListener]);
});

test("repeated capture injection in a fresh source tab registers the export listener exactly once", () => {
  const listeners = [];
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) } } } });
  vm.runInContext(exporter, context);
  vm.runInContext(exporter, context);
  assert.equal(listeners.length, 1);
  assert.equal(context.FeishuWebCapture.version, 3);
});
