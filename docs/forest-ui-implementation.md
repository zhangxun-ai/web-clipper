# 森林版 UI 实施记录 · 2026-10-30

用户确认 C 森林版 UX v2 及两张 GPT Image 效果图后，按“实施”指令接入正式 MV3 扩展。设计依据为 `output/ui-design/clipper-20261029-v1/forest-ux-v2/` 的交互原型、规格、截图及效果图；模拟授权、模拟查询和模拟保存没有移入正式代码。

## 正式改动

- `popup.html`、`popup.js`、`popup-layout.css`、`shared/popup-navigation.js`：剪存、工具、记录、设置独立视图，保留真实表单节点及返回上下文。`popupToolDraft` 保存链接来源、链接、ZIP、图片、本次输出、课程范围和公众号查询草稿。新任务默认输出与已填任务分开；首页 Obsidian 选项仅写入 Obsidian，双输出在工具任务中明确选择。
- 公众号保留上次结果的真实账号、日期和选择；编辑条件不重新标记旧列表，提交查询后才切换。单选、全选、清空局部更新，保留列表节点、滚动和焦点。展开页为 `popup.html?view=wechat-manage&sourceTabId=…&source=…`，使用同一持久列表和选择；原网页关闭或切换后仍能管理本地列表，不读取其他当前网页。桌面下载选项在固定侧栏，窄屏主动作固定在底部。
- 链接批量就近显示输入错误，明确本次来源、输出、图片和格式；课程显示当前章 / 全专栏范围及只读目录预览，再交给原任务接口执行。
- `feishu-save.html/css/js`：主任务与固定来源、目标分列，窄屏纵向排列。保留请求身份、恢复去重、位置校验和真实安装引导。未知创建不显示运行步骤，状态失联不冒充正在运行，排队与读取时提示保留原网页。知识库选择的“使用此位置”只配置位置。
- `batch-runner.html/css/js`：逐篇显示实际来源及各目的地状态，本地、Obsidian 分别统计；停止或终态无残留“处理中”。补写沿用已保留内容和原目录，只处理失败的 Obsidian，不重新采集或下载。课程输出失败使用失败状态，其他目的地补写成功不能掩盖本地下载失败。
- `shared/ui-tokens.css` 与 `icon/brand.svg`、16/32/48/96/128 PNG：森林绿、纸白及原创叶片书签。服务标志保持现有本地资产，无新增字体或运行时图片请求。PNG 通过现有 `node icon/render-brand.cjs` 生成。

旧创建尝试由既有本机 journal 留存，但现有接口没有提供旧尝试清单；页面展示当前真实请求和保存记录，以及保留说明，没有模拟一份历史列表。批量结果与补写缓存仍留在当前任务页；关闭后不会自动承诺后台补写或可恢复的任务历史。

## 验证与证据

实际浏览器使用真实 Chromium MV3、storage、页面注入和下载；Native / 飞书 / 文章网络响应由测试提供，无真实账号写入或收费查询。

- `npm test`：309 项中 308 通过，1 项既有失败。`tests/connector-onboarding.test.cjs` 固定源码校验指出本轮开始前已有修改的 `helper/feishu_content_import.py` 与发布固定 SHA-256 不符。本次 UI 实施未修改该文件、发布固定版本或放宽检查。
- `npm run test:ui`：整套通过（exit 0）。覆盖正式 popup、原请求记录、草稿与管理页、批量/课程、连接引导、保存进度与完成、布局、保真、本地图片、X 与大文档。新增原网页关闭后仍管理本地列表、禁止误读其他页和禁用当前页保存动作的回归。
- `npm run test:wechat`：12 项 Python 测试及完整 MV3 公众号回归通过。包含实际 ZIP 图片字节、分页和日期核验、部分结果续传、缓存、跨页面选择和关闭 popup 后的固定选项。
- `image-format.cjs`、`feishu-extension.cjs`、`feishu-recovery.cjs`：通过。恢复覆盖创建回包丢失、内容核验、未知创建显式恢复、三请求独立保存以及迁入断线 / 轮询 / 后台重启与错误目标。
- 与开始前快照核对：`openSavePage`、`readExportTransfer`、`downloadExportPayload`、`materializeWebImageAssets` 函数保持原样；manifest 权限未修改。
- `node --check`：popup、navigation、feishu-save、batch-runner 通过；`git diff --check` 通过。
- popup 检查 452 / 390 / 320；管理页 1120 / 800 / 360 / 320；保存页桌面 / 390 / 320；批量页 1280 / 800 / 360 / 320。实际查看首页、管理列表、窄屏下载入口、未知结果和双目的地失败截图，并修正观察到的问题。

证据目录：`output/implementation-forest-ui-20261030/`，包括开始前快照 `before/`、各回归日志、`screenshots/`、`save-evidence/`、`batch-evidence/`。

## 使用与边界

本地刷新扩展，再刷新原文章页面。查看“剪存 / 工具 / 记录”和新任务页即可使用新 UI。商店包、`release/` 与 `release-cws/` 保持原状；未提交、推送、部署或发布。真实本机连接器安装、账号授权、真实飞书写入、真实 Obsidian Vault 和收费供应商请求未作本轮验收。
