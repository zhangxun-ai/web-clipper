# Mac 首次连接：让 Agent 帮你安装

本地导出、带图留档、批量下载和 Obsidian 目录保存不需要本机连接器。只有“保存到飞书知识库”需要安装一次连接器。

当前推荐 Mac 上使用 Chrome、Edge 或 Dia。Windows 上本地导出仍可使用；飞书剪存暂不作为受支持功能。Linux 不作为当前上手流程的验收目标。这里介绍的是现有连接器的安装方式，不需要下载另一个尚未发布的安装包。

## 普通用户怎么做

1. 打开要保存的网页，在插件中点击“保存到飞书”。插件会自动检查连接；已经可用时直接复用。
2. 如果缺少连接程序，选择实际使用的浏览器，点击“复制安装提示词”。把完整提示词粘贴给这台 Mac 上的 Codex、Claude Code 或 WorkBuddy。
3. 让 Agent 完成依赖检查、下载校验和连接器注册。首次飞书配置或授权需要你在官方页面完成；不要把密钥发给 Agent。
4. 回到插件点击“重新检测”，需要时点击“登录飞书”，选择知识库父页面，然后保存。

提示词自动包含当前扩展 ID、浏览器、固定源码版本、下载地址及文件校验值。商店用户无需手动克隆仓库；GitHub 用户也可直接复制这份提示词。Agent 必须能够在本机执行命令：只有文字对话、不能操作电脑的模式无法代装。

成功标志：安装程序能与插件连接、当前身份能读取知识库；选定父页面后，实际保存一篇带图片文章，插件显示“已保存到飞书”，并能打开目标页面。仅有文件或终端显示“安装成功”不等于完整验收。

## 自动检查与系统安装的区别

当前检查发生在打开“保存到飞书”页面时，不会在安装扩展时偷偷装软件。Chrome Web Store 安装的是浏览器扩展；Native Messaging 的本机程序需要另行注册，由浏览器按需启动，并不需要用户一直开着终端。缺少程序时，扩展提供安装提示词；由用户运行命令，或让已获准操作本机的 Agent 执行。

本项目不使用网页发起任意 shell 命令、不额外开放本机 HTTP 写入代理，也不要求关闭浏览器或系统安全设置。参考 [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。

## Agent 执行说明

以下步骤与插件生成的提示词配合使用。以用户实际复制的扩展 ID 和浏览器为准，不能猜测商店 ID。

### 1. 检查并复用依赖

- Python 3.10+、Node.js 20+、`lark-cli`。这些是本机连接器的运行依赖；普通用户不需要安装 Playwright、Go 或 AI Skills。
- 已有可用版本直接复用，不为安装连接器全局升级、降级或替换工具。
- 缺少 Python 或 Node 时，优先使用用户已有的包管理器。已有 Homebrew 的 Mac 可按缺失项执行 `brew install python@3.12` 或 `brew install node@22`；然后使用实际安装路径，不能假定版本化公式已经进入 PATH。没有 Homebrew 时，可使用 [Python 官方安装包](https://www.python.org/downloads/macos/) 和 [Node.js 官方安装指引](https://nodejs.org/en/download)，仅把必要的系统交互交给用户，不静默安装新的包管理器。
- 已有 CLI 直接复用。缺少 CLI 时，建议装到插件的私有工具目录，避免全局安装：

```bash
npm install --prefix "$HOME/Library/Application Support/FeishuClipper/tools" @larksuite/cli@1.0.88
```

执行连接器安装命令时，把实际 Node 所在目录和该目录下的 `node_modules/.bin` 加入**本次命令**的 PATH；不必修改用户 shell 配置。CLI 1.0.88 是当前连接器已验证版本，npm 官方包会下载对应架构的原生程序。不要使用需要安装额外 Skills 的交互安装向导。参考 [飞书 CLI](https://github.com/larksuite/cli/tree/v1.0.88)、[Homebrew Python](https://formulae.brew.sh/formula/python@3.12)、[Homebrew Node](https://formulae.brew.sh/formula/node@22)。

### 2. 下载经过校验的连接器

固定源码提交：`d3246b525c36c038e380d983c628bbdbafd1d991`。这是已发布且与当前上手页面兼容的连接器，不需要跟随页面文案版本重新安装。

下载地址前缀：

```text
https://raw.githubusercontent.com/zhangxun-ai/web-clipper/d3246b525c36c038e380d983c628bbdbafd1d991/helper/
```

只下载以下三个文件，并逐个核对 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `feishu_native_host.py` | `426bff03a68a30a3fe093ff994f0283e92bbeba49fec1aa859b0e2968eb621c6` |
| `feishu_content_import.py` | `e4d6ec5ba812b5a7f782e71097e2b029cc89a2f68aa516dc4f5ea5f0a7a484ea` |
| `install_feishu_native_host.py` | `10c0b28107df65125b924fd5a1d075e1e375adc84dbc8634a835fb4915c6aef3` |

持久保存到 `~/Library/Application Support/FeishuClipper/source/d3246b525c36c038e380d983c628bbdbafd1d991/helper/`。下载先写本次临时文件，校验通过才进入持久目录；已存在的文件先核对，不能覆盖未知内容。下载或校验失败时明确停止，不能改用未校验的 main 分支。

此目录是连接器的运行依赖，不是临时下载目录；安装后不能删除或随意改名。这个位置与用户的 GitHub 克隆目录、浏览器商店安装目录无关。

### 3. 注册到正确浏览器

在上述固定提交目录（`helper/` 的上一层）执行插件生成的命令，使用实际可用的 Python：

```bash
python3 helper/install_feishu_native_host.py --extension-id "从插件复制的32位ID" --browser chrome
```

Edge 使用 `--browser edge`，Dia 使用 `--browser dia`。不能照抄示例 ID。

先检测已有连接器：若已经正常工作，不重复安装。遇到“已有不同配置”时，先只读核对现有 launcher、manifest、扩展 ID、Python/Node/CLI 路径，并备份将更新的连接配置；仅确认是本插件且需要切换到本次 ID/路径后，按用户的安装意图添加 `--force`。保留本机 `state`、已有应用配置和授权；不要删除旧程序或其他浏览器配置。

### 4. 配置与登录

安装脚本不会创建飞书应用，也不会登录。先检查 CLI 是否已有配置；不要打印应用密钥、访问令牌或登录设备码。

仅明确缺少应用配置时，可启动官方引导：

```bash
lark-cli config init --new
```

将官方授权/配置链接交给用户完成，再返回插件点击“登录飞书”。应用可用范围、权限开通或企业管理员审批可能需要用户处理，Agent 不能越过这些步骤。已有应用或授权直接复用，不能为了修复其他错误重复创建应用。

用户身份需要的权限由连接器按业务范围请求，见[权限清单](feishu-wiki-clip.md#一次性连接)，不要使用不必要的全量推荐权限。日后不必每次登录。

### 5. 验证并交还用户

- 检查实际浏览器的 Native Messaging 注册与只读握手，确认连接器可启动、CLI 版本可读取。
- 使用当前授权只读查询知识库，确认实际身份能访问；不要打印内部数据或凭据。
- 若只能运行本机协议测试而不能操作用户浏览器，明确这一步仍需用户在插件点“重新检测”；不能用配置文件存在代替真实验证。
- 不替用户创建、修改或删除飞书文档。首次真实带图保存由用户选定网页及父页面后发起。

## 维护与验证

提示词生成与固定源码校验信息统一放在 `shared/connector-onboarding.js`；变更固定版本时同步本页并重新校验实际下载内容。现有恢复与内容完整性规则没有因安装简化而变化。

上方固定源码包含图片实际尺寸、原生提示框和批量图片绑定支持，与当前扩展配套。旧固定连接器需要更新后才能接收新扩展的图片尺寸参数；从源码安装且 launcher 指向当前工作树的用户可直接使用更新后的 helper。后续修改连接器时，须同步固定提交及校验值，并通过版本一致性回归，避免扩展与连接器不匹配。

回归命令：`npm test`、`npm run test:ui`。首次连接浏览器测试为 `node tests/browser/connector-onboarding.cjs`；Windows 的系统识别仅用浏览器环境模拟，不能据此宣称 Windows 本机飞书剪存已支持。

2026-09-16 验证：同步新版连接器固定提交与文件校验值，224 项 JavaScript、158 项 Python 及首次连接浏览器回归通过。新版真实飞书写入尚未重新验收。

2026-09-08 旧固定版本验证：JavaScript 回归、真实 Chromium 中的提示词复制与窄屏布局通过；从 GitHub 实际下载当时的三份固定源码并核对 SHA-256，在隔离的用户目录注册 Chrome／Edge／Dia、重复安装，并通过真实本机协议读取 CLI 1.0.88，错误扩展 ID 被拒绝。测试复用了本机已有 Python／Node／CLI，没有在全新 Mac 上从零安装这些依赖，也没有重新进行飞书授权或真实图文写入。
