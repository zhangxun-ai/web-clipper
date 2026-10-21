const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFrameRoutingHelpers(chrome, extras = {}) {
  const sourcePath = path.join(__dirname, "../popup.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const start = source.indexOf("function sendMessageToTab");
  const end = source.indexOf("function isMissingReceiverError");

  assert.ok(start >= 0, "sendMessageToTab not found");
  assert.ok(end > start, "frame routing helper block not found");

  const sandbox = {
    chrome,
    isMissingReceiverError: (error) => String(error?.message || "").includes("Receiving end does not exist"),
    ...extras
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.sendMessageToTab = sendMessageToTab;\nthis.sendMessageWithRecovery = sendMessageWithRecovery;\nthis.injectContentScript = injectContentScript;\nthis.inspectFrameUrls = inspectFrameUrls;\nthis.resolveContentFrameId = resolveContentFrameId;`,
    sandbox,
    { filename: sourcePath }
  );
  return sandbox;
}

(async () => {
  const sentMessages = [];
  const injections = [];
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage(tabId, message, options, callback) {
        sentMessages.push({ tabId, message, options });
        callback({ ok: true, data: { title: "课程章节" } });
      }
    },
    scripting: {
      executeScript(options, callback) {
        injections.push(options);
        callback([]);
      }
    }
  };
  const helpers = loadFrameRoutingHelpers(chrome);

  const response = await helpers.sendMessageToTab(
    42,
    { type: "feishu-export:get-page-info" },
    9
  );
  assert.deepEqual(response, { title: "课程章节" });
  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages)), [{
    tabId: 42,
    message: { type: "feishu-export:get-page-info" },
    options: { frameId: 9 }
  }]);

  await helpers.injectContentScript(42, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(injections[0].target)), { tabId: 42, frameIds: [9] });

  // Older tabs have a listener but do not recognize export-document-v2. The
  // upgrade must happen before sending, without waiting for a missing receiver.
  const upgraded = await helpers.sendMessageWithRecovery({ tabId: 42, frameId: 9,
    message: { type: "feishu-export:export-document-v2", format: "markdown" } });
  assert.deepEqual(upgraded, { title: "课程章节" });
  assert.equal(injections.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(injections[1].target)), { tabId: 42, frameIds: [9] });
  assert(injections[1].files.includes("shared/image-asset.js"));

  await helpers.inspectFrameUrls(42);
  assert.deepEqual(JSON.parse(JSON.stringify(injections[2].target)), { tabId: 42, allFrames: true });
  assert.equal(typeof injections[2].func, "function");

  {
    const recoveryMessages = [];
    const recoveryInjections = [];
    let sendCount = 0;
    const recoveryChrome = {
      runtime: { lastError: null },
      tabs: {
        sendMessage(tabId, message, options, callback) {
          sendCount += 1;
          recoveryMessages.push({ tabId, message, options });
          if (sendCount === 1) {
            recoveryChrome.runtime.lastError = { message: "Receiving end does not exist" };
            callback();
            recoveryChrome.runtime.lastError = null;
            return;
          }
          callback({ ok: true, data: { title: "课程章节" } });
        }
      },
      scripting: {
        executeScript(options, callback) {
          recoveryInjections.push(options);
          callback([]);
        }
      }
    };
    const recoveryHelpers = loadFrameRoutingHelpers(recoveryChrome);

    const recovered = await recoveryHelpers.sendMessageWithRecovery({
      tabId: 42,
      message: { type: "feishu-export:get-page-info" },
      frameId: 9
    });
    assert.deepEqual(recovered, { title: "课程章节" });
    assert.equal(recoveryMessages.length, 2);
    assert.equal(recoveryMessages.every((entry) => entry.options.frameId === 9), true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(recoveryInjections[0].target)),
      { tabId: 42, frameIds: [9] }
    );
  }

  {
    let inspectionCount = 0;
    let selectionCount = 0;
    const waitingChrome = {
      runtime: { lastError: null },
      scripting: {
        executeScript(options, callback) {
          inspectionCount += 1;
          callback([{ frameId: 9, result: "https://scys.com/course/detail/190?chapterId=13368" }]);
        }
      }
    };
    const waitingHelpers = loadFrameRoutingHelpers(waitingChrome, {
      isScysEmbeddedCourseUrl: () => true,
      selectScysCourseFrameTarget: () => {
        selectionCount += 1;
        return selectionCount === 1 ? null : { frameId: 9 };
      },
      sleep: async () => {}
    });

    const frameId = await waitingHelpers.resolveContentFrameId(
      42,
      "https://scys.com/activity/10096/course/190?chapterId=13368",
      1000
    );
    assert.equal(frameId, 9);
    assert.equal(inspectionCount, 2);
  }
})();
