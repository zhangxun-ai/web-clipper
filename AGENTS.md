# 文档导出与飞书剪存

Chrome Manifest V3 扩展，无打包步骤，直接加载项目根目录。产品使用说明见 [README.MD](README.MD)。

## 按任务阅读

- 本地导出：`popup.js`、`content-scripts/feishu-exporter.js` 和 `shared/`。Google Docs 使用原生导出，避免重新依赖画布编辑器 DOM。
- 飞书知识库剪存：[功能、接口和恢复说明](docs/feishu-wiki-clip.md)。从 `shared/feishu-wiki-clip.js` 和 `helper/feishu_native_host.py` 阅读数据完整性边界。
- 首次连接与安装提示词：[Mac 快速连接](docs/connector-setup.md)，生成逻辑及固定源码校验信息见 `shared/connector-onboarding.js`。Windows 仅本地导出；不能将浏览器系统模拟测试当作本机连接器验收。
- `release-cws/` 和 `release/` 是历史商店产物；开发修改根目录源文件，发布需独立验证和授权。

## 验证命令

在项目根目录运行：

- 全部 JavaScript 回归：`npm test`
- 真实 Chromium 扩展回归：首次 `npm ci`、`npx playwright install chromium --no-shell`，然后 `npm run test:browser`。开发测试需要 Node.js 20+；测试脚本及范围见 [验收说明](docs/feishu-wiki-clip.md#验证)。
- 本机飞书连接器：`python3 -m unittest discover -s tests -p 'feishu*_test.py'`
- 语法和补丁：`node --check popup.js`、`node --check background.js`、`node --check feishu-save.js`、`git diff --check`

自动测试不写入真实飞书。浏览器回归加载真实 MV3 扩展，使用真实保存页面、注入、CORS 和 storage，仅模拟飞书响应。浏览器登录、Native Messaging 安装和真实图文写入需要单独验收。实际使用更新代码时刷新扩展及源网页。

## 剪存边界

新任务通过内容块重建和独立图片上传剪存，不依赖原生复制权限。完整性核对通过后，只迁入本次创建且 journal 有记录的文档。新建结果不明时不得自动重发；新版凭持久随机标记及空文档核对自动恢复，旧版无标记任务不能猜测认领。用户明确点击“重新保存到飞书”可开启新创建尝试，使用持久 request_id 去重并保留原图文和旧尝试，不追加确认弹窗。每次插件入口是独立请求，只复用默认目录；同请求双击/刷新沿用进度，旧结果不能串入新请求。各请求持久排队，暂停与查证等待不能阻塞其他请求。已知副本迁入按官方同文档语义查位置并受控恢复，期限与重发次数持久化；细则见功能说明。凭据留在本机 CLI；扩展不接受任意本机命令或来自网页的写入代理请求。
