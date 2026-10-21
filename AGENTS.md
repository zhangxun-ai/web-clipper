# 文档导出与飞书剪存

Chrome Manifest V3 扩展，无打包步骤，直接加载项目根目录。产品使用说明见 [README.MD](README.MD)。

## 按任务阅读

- 首页与视觉：`popup.html`、`popup-layout.css`、`shared/ui-tokens.css`；最近飞书任务由 `shared/recent-save-model.js` 整理，popup 的 `overview` 仅允许读取状态。首页保存动作固定点击时显示的目标，已有任务链接保留原请求身份。

- 本地导出：`popup.js`、`content-scripts/feishu-exporter.js` 和 `shared/`。单篇带图下载为根目录 Markdown 加 `assets/<保存标识>/` 相对路径附件，图片完整下载并核对位置后再生成文章；不能退回 Base64 或远程链接冒充离线成功。Obsidian 继续自动写入独立附件目录。飞书本地带图读取完整分辨率预览，`image-asset.js` 必须先于 exporter 注入；更新的导出消息为 `feishu-export:export-document-v2`，用于升级已打开的旧页面。Google Docs 使用原生导出，避免重新依赖画布编辑器 DOM。
- 公众号范围下载：[配置、日期和恢复说明](docs/wechat-history-download.md)。`shared/wechat-history-service.js` 持久化查询列表、勾选及下载时的选项；查询不导出，选文下载仅接受当前已持久化列表内文章；未收集完的列表也可选，下载前核验原文身份和日期，默认本地 ZIP，不继承首页 Obsidian。`helper/wechat_native_host.py` / `tikhub_wechat.py` 独立注册 `com.wechat.clipper`，密钥仅在本机 `.env`。素材时间不得当发表时间，只有供应商末页才确认收集完成。`batch-runner.js` 按实际目的地输出结果统计，Obsidian 写入失败不能计为成功。
- 飞书知识库剪存：[功能、接口和恢复说明](docs/feishu-wiki-clip.md)。从 `shared/feishu-wiki-clip.js` 和 `helper/feishu_native_host.py` 阅读数据完整性边界。图片格式统一由 `shared/image-asset.js` 按字节识别并解码；不能直接把 HTTP Content-Type 当作真实格式。
- 首次连接与安装提示词：[Mac 快速连接](docs/connector-setup.md)，生成逻辑及固定源码校验信息见 `shared/connector-onboarding.js`。Windows 仅本地导出；不能将浏览器系统模拟测试当作本机连接器验收。
- `release-cws/` 和 `release/` 是历史商店产物；开发修改根目录源文件，发布需独立验证和授权。

## 验证命令

在项目根目录运行：

- 全部 JavaScript 回归：`npm test`
- 真实 Chromium 扩展回归：首次 `npm ci`、`npx playwright install chromium --no-shell`，然后 `npm run test:browser`。开发测试需要 Node.js 20+；测试脚本及范围见 [验收说明](docs/feishu-wiki-clip.md#验证)。
- 本机飞书连接器：`python3 -m unittest discover -s tests -p 'feishu*_test.py'`
- 公众号免费回归：`npm run test:wechat`；收费真实验收仅显式运行 `WECHAT_HISTORY_LIVE=1 npm run test:wechat:live`，供应商每次列表请求约 $0.01。
- 语法和补丁：`node --check popup.js`、`node --check background.js`、`node --check feishu-save.js`、`git diff --check`

自动测试不写入真实飞书。浏览器回归加载真实 MV3 扩展，使用真实保存页面、注入、CORS 和 storage，仅模拟飞书响应。浏览器登录、Native Messaging 安装和真实图文写入需要单独验收。实际使用更新代码时刷新扩展及源网页。

## 剪存边界

新任务通过内容块重建和独立图片上传剪存，不依赖原生复制权限。完整性核对通过后，只迁入本次创建且 journal 有记录的文档。新建结果不明时不得自动重发；新版凭持久随机标记及空文档核对自动恢复，旧版无标记任务不能猜测认领。用户明确点击“重新保存到飞书”可开启新创建尝试，使用持久 request_id 去重并保留原图文和旧尝试，不追加确认弹窗。每次插件入口是独立请求，只复用默认目录；同请求双击/刷新沿用进度，旧结果不能串入新请求。各请求持久排队，暂停与查证等待不能阻塞其他请求。已知副本迁入按官方同文档语义查位置并受控恢复，期限与重发次数持久化；细则见功能说明。凭据留在本机 CLI；扩展不接受任意本机命令或来自网页的写入代理请求。
