(function (scope) {
  "use strict";

  const sourceRevision = "d3246b525c36c038e380d983c628bbdbafd1d991";
  const FILES = Object.freeze({
    "feishu_native_host.py": "426bff03a68a30a3fe093ff994f0283e92bbeba49fec1aa859b0e2968eb621c6",
    "feishu_content_import.py": "e4d6ec5ba812b5a7f782e71097e2b029cc89a2f68aa516dc4f5ea5f0a7a484ea",
    "install_feishu_native_host.py": "10c0b28107df65125b924fd5a1d075e1e375adc84dbc8634a835fb4915c6aef3"
  });

  function detectEnvironment(navigator = {}) {
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const userAgent = navigator.userAgent || "";
    const os = /Windows|Win32|Win64/i.test(platform + " " + userAgent) ? "windows"
      : /Mac/i.test(platform + " " + userAgent) && !/iPhone|iPad/i.test(userAgent) && !(navigator.maxTouchPoints > 1) ? "mac" : "unsupported";
    return { os, browser: /Edg\//.test(userAgent) ? "edge" : "chrome" };
  }

  function validateInstallation(extensionId, browser, os) {
    if (!/^[a-p]{32}$/.test(extensionId || "")) throw new Error("无法识别插件安装，请刷新此页后重试。");
    if (os !== "mac") throw new Error("本地导出可用；保存到飞书暂仅支持 Mac。");
    if (!["chrome", "edge", "dia"].includes(browser)) throw new Error("请选择受支持的浏览器。");
  }

  function sourceCommand(extensionId, browser, os) {
    if (os !== "mac") return "";
    validateInstallation(extensionId, browser, os);
    return `python3 helper/install_feishu_native_host.py --extension-id ${extensionId} --browser ${browser}`;
  }

  function buildAgentPrompt({ id, browser, os = "mac" }) {
    validateInstallation(id, browser, os);
    return `请帮我在这台 Mac 上安装并验证 web-clipper 的飞书连接器，让浏览器插件可以保存到飞书知识库。

当前插件 ID：${id}
当前浏览器：${browser}
参考说明：https://github.com/zhangxun-ai/web-clipper/blob/main/docs/connector-setup.md（以下步骤已自包含，参考页尚未发布时仍可按这些步骤安装。）

请按以下要求操作：
1. 下载固定的源码版本 ${sourceRevision}。源码根目录为 ~/Library/Application Support/FeishuClipper/source/${sourceRevision}，将下面三个文件分别放入其 helper 子目录。先检查目录，已存在的相同文件可以复用；内容不同则停止并说明，不覆盖已有内容。逐个核对 SHA-256，全部通过后才执行；下载失败或校验不符时停止，不改用 main 或跳过校验。下载地址与 SHA-256：
${Object.entries(FILES).map(([name, hash]) => `https://raw.githubusercontent.com/zhangxun-ai/web-clipper/${sourceRevision}/helper/${name}\nSHA-256: ${hash}`).join("\n")}
2. 检测当前系统、Python 3.10+、Node.js 20+、lark-cli 以及已有飞书配置。优先复用已有依赖，只安装缺失项，不全局升级或降级工具，不覆盖已有飞书应用、授权或保存记录。缺少 lark-cli 时，可执行 npm install --prefix "$HOME/Library/Application Support/FeishuClipper/tools" @larksuite/cli@1.0.88，不安装任何 AI Skills。把实际 Node.js 所在目录和 tools/node_modules/.bin 加入本次命令的 PATH，使安装脚本能找到依赖；不要改写全局 PATH。缺少 Python 或 Node.js 时使用已有包管理器只安装缺失项；没有包管理器则引导官方安装，不静默安装 Homebrew 等包管理器。组件必须留在上述稳定用户目录，不能依赖 /tmp 或下载目录。
3. 按浏览器 ${browser} 注册当前插件 ID ${id}。从上述固定版本的源码根目录执行（路径包含空格，请正确引用）：
${sourceCommand(id, browser, os)}
4. 优先复用已有飞书应用配置和授权。仅确认缺少应用配置时启动官方配置流程，引导我在官方页面完成；不得覆盖已有应用或授权。不要要求我把密钥粘贴到聊天中，也不要在命令日志、截图或交付说明中输出密钥。
5. 安装后验证当前浏览器的 Native Messaging 只读握手，并读取可访问的知识库。只有实际握手通过且只读知识库读取成功后，才能声称已连接；区分真实验证与仅文件检查。不要替我创建、修改或写入飞书文档。
6. 完成后说明实际验证结果，让我刷新插件保存页并点击“重新检测”；仍缺用户授权或无法完成浏览器验证时，明确说明下一步，不要把安装成功当作已经可以保存。`;
  }

  const api = { detectEnvironment, buildAgentPrompt, sourceCommand, sourceRevision, FILES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else scope.ConnectorOnboarding = api;
})(globalThis);
