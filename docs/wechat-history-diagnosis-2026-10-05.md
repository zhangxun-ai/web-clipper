---
template: research-report@v1
title: "公众号按日期批量下载：真实诊断与替代方案"
subtitle: "跨账号后台接口受限；TikHub 已接入并通过真实图文 ZIP 验收"
client: "飞书剪存"
author: "诊断记录"
date: "2026-10-05"
---

按用户要求先核对微信官方 API：**自己的公众号或管理员授权的账号，有官方取数路径；仅凭其他公众号的一篇公开文章链接，官方公开文档没有提供跨账号历史列表接口。** 此次目标「语言即世界language is world」不是当前后台登录账号，不能用当前账号的开发凭据替代目标账号授权。这个结论来自当前服务号、公众号 API 文档的凭据、权限和参数核对，未调用正式业务 API，也未获取 AppSecret。

当前浏览器会话能登录、能搜索目标公众号、能读取自己的发表列表，但旧的跨账号列表接口在第一页就返回 `200013: freq control`。仅调整分页间隔无法解释或解决已经观察到的第一页失败。用户随后明确授权接入 TikHub 及使用项目 `.env` 测试；**现已接入 TikHub 文章列表 V2，并完成真实 Native Messaging → 7 页/69 篇至末页 → 日期筛选 → 正文与 7 张图片 ZIP 下载验收。** 详情见[接入、恢复与测试记录](wechat-history-download.md)。

## 1. 真实请求结果

使用 BrowserSkill 的 Chrome Agent Window，在已有登录态下读取。目标为「语言即世界language is world」，种子为[和曾鸣聊产业史观：我的非共识判断](https://mp.weixin.qq.com/s/KiN29IcdzkNY_Yo4GJus0w)，公开账号标识为 `gh_6990113d8818`。请求串行执行，没有批量扫描。

| 请求或页面 | 观察结果 | 含义 |
| --- | --- | --- |
| 公众号后台首页 | 显示已登录账号 | 登录态存在 |
| `/cgi-bin/searchbiz`，查询「语言即世界」 | HTTP 200，`ret=0`，找到目标账号 | 账号搜索可用 |
| `/cgi-bin/appmsg?action=list_ex`，目标 fakeid，begin=0 | HTTP 200，`ret=200013`，`freq control` | 插件依赖的目标列表通道受限 |
| `/cgi-bin/appmsgpublish`，目标 fakeid，begin=0 | HTTP 200，`ret=200013` | 换成该列表接口仍失败 |
| 编辑器超链接窗口，本账号发表列表 | HTTP 200，`ret=0`，页面显示真实文章 | 不能由目标列表失败推断整个账号被封禁 |
| `/cgi-bin/free_publish`、`/cgi-bin/publish` | HTTP 404 | 被调研代码列出的两个备用端点在此会话下不可用 |
| `/cgi-bin/appms?t=media/appmsg_list_v2` | HTTP 404 | 被调研代码的页面备用路径也不可用 |
| 微信读书 `/web/mp/articles`，正确 bookId `MP_WXS_3198851683` | HTTP 200，`errCode=-2010`，用户不存在 | 当前 Chrome 没有独立的微信读书登录态，不能证明其已登录后的列表能力 |

超链接窗口当前仅有本账号「已发表内容」和「输入链接」，未发现旧教程的「其他公众号」选择入口。以上结果证明当前会话中的跨账号列表查询受限；未确定限制是否永久、是否对所有账号生效，也未确定冷却时间。

## 2. 本地代码的问题

`content-scripts/feishu-exporter.js` 的旧流程是：登录检查 → searchbiz → 扫描候选账号 → 从第一页重新按日期扫描 → 返回链接 → popup 创建正文下载任务。新入口已改为本机 TikHub 连接器；下列问题描述旧实现及初次诊断。

- 每页取 5 条，成功分页后只等待 250 毫秒。
- 候选最多 6 个，每个最多扫描 16 页；日期阶段最多另扫 100 页。理论上限不是本次实际请求数。
- 候选校验获取的页没有复用，日期阶段从 begin=0 重查。
- 错误只返回文本，未保留接口、业务错误码、分页位置及已取得的链接。重试会重新扫描。
- 候选无法验证时会回退到名称最接近的账号，存在账号身份误匹配风险。

原报错发生在正文、图片下载前，关闭图片选项不会改变失败步骤。新实现使用公开 `gh_`/`biz` 直接锁定目标，持久化待处理页与游标，不再反复搜索候选或重扫首页；后台负责完成到任务页，避免 popup 关闭后丢失下载动作。

## 3. 微信官方 API 能否满足需求

通过直读官方页面、真实 Chrome 页面及 Museon 页面提取核对。用户提供的服务号目录和公众号目录均已检查。关键接口如下：

- `/datacube/getarticletotaldetail`：按发表日期返回标题、`content_url`、`ref_date` 及统计数据，2026-03-03 增加标题和链接。是自有或授权账号按日期取链接的优先候选，不能指定其他公众号。
- `/cgi-bin/freepublish/batchget`：分页返回成功发布的图文及 HTML 内容，每页 1–20 条。请求只有 offset、count、no_content，没有目标公众号参数。
- `/cgi-bin/freepublish/getarticle`：通过授权账号发布记录中的 article_id 获取图文详情，不能凭任意公开链接跨账号读取。
- `/cgi-bin/material/batchget_material`：返回素材库列表，包含官网素材管理模块创建的素材。素材库不等于完整发表历史，不作为范围完整性的依据。
- `/cgi-bin/draft/batchget`：返回草稿列表，未发布草稿不满足历史文章下载需求。

**授权边界：** `access_token` 由该账号的 AppID 和 AppSecret 换取；第三方平台使用 `authorizer_access_token`，必须先由目标账号管理员授权。发布列表与日期统计接口都属于权限集 7，服务商仍需该账号自身拥有接口权限。登录自己的公众号后台、微信个人登录或网页授权，都不能据此获得另一个公众号的管理接口权限。

**自有账号路径的限制：** 日期接口仅允许单日查询，结束日期最大为昨日，数据起始日期为 2025-11-01，可能延迟；当前适用范围标明公众号和服务号均要求企业主体已认证。因此一个月范围需要逐日查询，今天发表的文章不能靠该统计接口覆盖。发布列表返回的 `update_time` 是更新时间，不能直接当成发表日期。官方旧发布能力入口还明确说明，2025 年 7 月起个人主体、企业未认证及不支持认证的账号被回收发布相关接口权限；新接口页须结合具体账号后台权限核对，不能笼统承诺所有自有号可用。

**与原报错的关系：** 插件使用的是 `mp.weixin.qq.com` 浏览器后台接口与登录会话；官方 API 使用的是 `api.weixin.qq.com` 服务端接口与账号开发凭据，是不同的接口体系。官方 `clear_quota` 清除的是服务端 API 每日调用额度，文档没有提供用它解除本次后台 `200013` 限制的依据，因此不尝试清零或改变账号配置。

结论：如果需求改为备份自己的或已获得管理员授权的账号，优先采用官方路径，在本机 helper 保存凭据并实测覆盖；当前「输入其他公众号文章链接 → 下载指定日期历史」需求继续评估 TikHub，官方公开接口不能直接替代。

## 4. 路径比较与推荐

| 路线 | 本次证据 | 判断 |
| --- | --- | --- |
| 微信官方日期统计 / 发布列表 API | 真实文档要求目标账号凭据或管理员授权；没有任意账号查询参数 | 自有或授权账号优先；此次其他公众号下载不满足 |
| 旧公众号后台接口 + 慢速重试 | 目标第一页仍被拒绝 | 不作为主要恢复方案 |
| we-mp-rss 的发布端点 / 浏览器备用路径 | 此会话下返回 200013 或 404；9 月的降级修复 PR 仍未合并 | 不能直接复制后承诺可用 |
| 微信读书 `/web/mp/articles` | 维护者源码已有游标分页；当前浏览器缺少独立登录态 | 免费自托管方向的候选；需验证目标收录及日期覆盖，cover 兜底仅最新一篇，不能冒充范围完整 |
| wechatDownload 5.0 本地 MCP | 10 月 2 日发布，作者说明修复批量失败；本机未安装，4545 端口未运行 | 临时桌面备份候选；需安装及微信内会话，尚未在本机验收 |
| TikHub `/api/v1/wechat_mp/v2/fetch_account_articles` | 真实返回目标账号、原始发表时间、原文链接及游标；7 页/69 篇至末页，图文 ZIP 已通过 | 已选定并接入当前插件 |

TikHub 仅负责取列表。正文、图片仍从原文章页面读取并沿用插件现有导出，这样列表采购成本按页计，不需要为每篇正文另购 API。密钥应留在本机 helper 或服务端；不要写入扩展、网页脚本或日志。

官方文档标价 **0.01 美元/次**，建议请求超时 30 秒。本机实现超时 45 秒且不自动重试。分页使用响应的 `next_offset` 原样回传到 POST body，`is_end` 表示末页；`page_size` 当前会被微信忽略，不能据此承诺固定每页条数。

实现保存账号身份、游标和去重后的链接；**仅到供应商末页才标记收集完成**，因为已经读取的页面降序不能证明后续没有范围内文章。分页失败、单次 20 页上限或游标异常保留进度并显示未完成，不能生成「成功 0 篇」。这不证明供应商覆盖所有已删除或未收录文章。

### 接入过程中取得的真实证据

- 项目 `.env` 中小写 `tikhub_api_key` 已被本机读取；浏览器只得到连接状态和公开文章信息。扩展、源码及输出中不包含密钥。
- 默认 Python UA 的首轮请求被拒绝；显式设置 `WebClipper/0.4.9` 后真实返回成功。异常不自动重试，不回显供应商原始错误或 debug 信息。
- `raw=false` 简化结果只有素材 `create_time`/`update_time`。种子创建于 9 月 6 日、更新于 9 月 9 日，原文 `ct` 为 **9 月 7 日**，不能按素材时间筛选。改为 `raw=true` 后图文 `sendTime` 与已核对原文一致；旧页缺少该字段时使用消息 `dateTime` 筛候选，核对相邻日及原文日期，不能用素材时间兜底。
- 部分公开文章需要 URL 中的 `chksm`；当前保留签名、`scene` 与原查询编码，移除跟踪参数。原文无法打开或身份、时间核对失败时保存进度，不猜测成功。
- 真正收费的端到端测试已运行，无 TikHub / 微信 HTTP 或 Native Messaging 模拟：范围 2026-09-05 至 2026-10-05，目标账号 7 页/69 篇至末页，命中《和曾鸣聊产业史观：我的非共识判断》1 篇，发表日 2026-09-07，下载 ZIP 含正文及 7 张原图字节。
- 新增免费回归覆盖接口、日期边界、跨页乱序、错误游标、文章身份、发表时间不符及关闭 popup 后继续下载。没有向真实飞书写入，没有提交、推送或发布；其他账号与供应商全部历史覆盖未逐一验证。

当前 Chrome 的本机连接器已安装，独立 Chrome for Testing 已加载更新扩展并完成真实下载。当前已打开的 Chrome 配置中扩展指向本仓库，但 BrowserSkill 拒绝访问 `chrome://extensions`，系统屏幕处于锁定且自动解锁失败，因此未验证该浏览器的扩展热重载。

来源：

- [微信服务号 API 目录](https://developers.weixin.qq.com/doc/service/api/)
- [微信公众号 API 目录](https://developers.weixin.qq.com/doc/subscription/api/)
- [官方按发表日期获取标题、文章链接接口](https://developers.weixin.qq.com/doc/service/api/wedata/news/api_getarticletotaldetail.html)
- [官方获取已发布消息列表](https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_batchget.html)
- [官方获取已发布图文信息](https://developers.weixin.qq.com/doc/service/api/public/api_freepublishgetarticle.html)
- [官方永久素材列表](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_batchgetmaterial.html)
- [官方接口调用凭据](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html)
- [官方第三方授权凭据说明](https://developers.weixin.qq.com/doc/oplatform/developers/dev/AuthorizerAccessToken)
- [官方第三方代调用接口说明](https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/Before_Develop/call_interface)
- [官方旧发布能力入口及 2025 年权限回收说明](https://developers.weixin.qq.com/doc/offiaccount/Publish/Get_publication_records.html)
- [官方重置 API 调用次数](https://developers.weixin.qq.com/doc/service/api/apimanage/api_clearquota.html)
- [TikHub 公众号文章列表 V2 官方文档](https://tikhub.apifox.cn/472974858e0)
- [TikHub 官方 SDK](https://github.com/TikHub/TikHub-API-Python-SDK/blob/main/src/tikhub/resources/wechat_media_platform_v2.py)
- [we-mp-rss 微信读书采集源码](https://github.com/rachelos/we-mp-rss/blob/main/core/wx/model/weread_mp.py)
- [we-mp-rss 200013 降级修复 PR，当前未合并](https://github.com/rachelos/we-mp-rss/pull/470)
- [wechatDownload 5.0 发布记录](https://github.com/qiye45/wechatDownload/releases/tag/5.0)
- [wechatDownload 官方 MCP Skill，远程服务仅单篇和合集](https://github.com/qiye45/wechatDownload/blob/main/skills/wechat-article-downloader/SKILL.md)
