const assert = require("node:assert/strict");
const test = require("node:test");
const { detectEnvironment, buildAgentPrompt, sourceCommand, sourceRevision, FILES } = require("../shared/connector-onboarding.js");

test("desktop browser detection covers Mac, Windows and Edge without treating Linux or mobile as Mac", () => {
  for (const [navigator, expected] of [
    [{ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0" }, { os: "mac", browser: "chrome" }],
    [{ platform: "Win32", userAgent: "Chrome/140.0 Edg/140.0" }, { os: "windows", browser: "edge" }],
    [{ userAgentData: { platform: "Windows" }, userAgent: "Chrome/140.0" }, { os: "windows", browser: "chrome" }],
    [{ platform: "MacIntel", userAgent: "Chrome/140.0 Edg/140.0" }, { os: "mac", browser: "edge" }],
    [{ platform: "Linux x86_64" }, { os: "unsupported", browser: "chrome" }],
    [{ platform: "MacIntel", maxTouchPoints: 5 }, { os: "unsupported", browser: "chrome" }],
    [{ userAgent: "iPhone; CPU iPhone OS 18 like Mac OS X" }, { os: "unsupported", browser: "chrome" }],
    [{}, { os: "unsupported", browser: "chrome" }]
  ]) assert.deepEqual(detectEnvironment(navigator), expected);
});

test("Agent prompt validates extension identity, browser and Mac-only boundary", () => {
  for (const id of ["a".repeat(32), "p".repeat(32)]) {
    assert.match(buildAgentPrompt({ id, browser: "chrome", os: "mac" }), new RegExp(`当前插件 ID：${id}`));
    assert.match(buildAgentPrompt({ id, browser: "dia", os: "mac" }), /当前浏览器：dia/);
  }
  for (const id of [undefined, "", "z".repeat(32), "a".repeat(31), "a".repeat(33), "A".repeat(32), "a".repeat(32) + "\n"]) {
    assert.throws(() => buildAgentPrompt({ id, browser: "chrome", os: "mac" }));
  }
  for (const [browser, os] of [["dia", "windows"], ["chrome", "windows"], ["chrome", "linux"], ["chrome;whoami", "mac"]]) {
    assert.throws(() => buildAgentPrompt({ id: "a".repeat(32), browser, os }));
  }
});

test("Agent instructions pin the source, reuse credentials and require read-only real verification", () => {
  const prompt = buildAgentPrompt({ id: "a".repeat(32), browser: "edge" });
  assert.match(prompt, /https:\/\/github\.com\/zhangxun-ai\/web-clipper\/blob\/main\/docs\/connector-setup\.md/);
  for (const requirement of [/固定的源码版本/, /核对 SHA-256/, /只安装缺失项/, /不全局升级/, /仅确认缺少应用配置时启动官方配置流程/, /不要要求我把密钥粘贴到聊天中/, /Native Messaging 只读握手/, /读取可访问的知识库/, /不要替我创建、修改或写入飞书文档/]) assert.match(prompt, requirement);
  assert.match(prompt, /--extension-id a{32} --browser edge/);
  assert.doesNotMatch(prompt, /Install\.cmd|Install\.command|releases/);
});

test("source command is only offered on Mac and incorporates selected browser", () => {
  assert.equal(sourceCommand("a".repeat(32), "edge", "mac"), `python3 helper/install_feishu_native_host.py --extension-id ${"a".repeat(32)} --browser edge`);
  assert.equal(sourceCommand("a".repeat(32), "edge", "windows"), "");
  assert.equal(sourceCommand("a".repeat(32), "chrome", "unsupported"), "");
});

test("the documented pinned connector matches the files supplied with this extension", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const guide = fs.readFileSync(path.join(__dirname, "../docs/connector-setup.md"), "utf8");
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  assert(guide.includes(sourceRevision));
  for (const [file, expected] of Object.entries(FILES)) {
    const bytes = fs.readFileSync(path.join(__dirname, "../helper", file));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expected,
      `Connector changed: publish a compatible fixed revision and update the onboarding pin for ${file}`);
    assert(guide.includes(file) && guide.includes(expected), "manual and Agent instructions must use the same verified source");
  }
});
