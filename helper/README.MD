# 本机辅助程序

## 飞书知识库剪存连接器

`feishu_native_host.py` 是飞书内容剪存的本机连接器，通过 Native Messaging 调用 `lark-cli --as user`。`feishu_content_import.py` 负责内容块重建、图片暂存和上传、完整性核对。安装和授权说明见 [飞书知识库剪存](../docs/feishu-wiki-clip.md)。

在项目根目录运行剪存页显示的命令：

```bash
python3 helper/install_feishu_native_host.py --extension-id <当前扩展ID>
```

连接器不需要 Python 第三方包，也不启动 HTTP 监听端口。下方历史微信实验与这项功能无关。

## TikHub 公众号列表连接器

当前按日期下载采用 `wechat_native_host.py` 与 `tikhub_wechat.py`，独立注册为 `com.wechat.clipper`。密钥从项目 `.env` 的 `tikhub_api_key` / `TIKHUB_API_KEY` 加载；不传给浏览器。固定调用 TikHub 图文列表 V2，正文和图片仍由扩展导出。

```bash
python3 helper/install_wechat_native_host.py --extension-id <当前扩展ID>
```

不更改飞书连接器，无第三方 Python 依赖、HTTP 监听或代理。接口收费、日期语义、恢复及真实测试见[公众号按日期下载](../docs/wechat-history-download.md)。

## 微信历史页 helper（旧实验）

这个目录保留的是旧的“微信客户端历史页抓取”实验方案。

当前主流程使用上述 TikHub 列表连接器，不需要公众号后台登录、系统代理、mitmproxy 或微信客户端抓包。

所以这里的内容 **不是主路径**，只建议在明确做技术研究时使用。

## 包含内容

- [`wechat_history_helper.py`](./wechat_history_helper.py)
  - 本地 HTTP 服务
  - 保存公众号历史文章缓存
  - 接收日期范围任务并返回链接列表

- [`mitm_wechat_history_addon.py`](./mitm_wechat_history_addon.py)
  - `mitmproxy` 插件
  - 监听微信客户端中的公众号历史列表请求

- [`requirements.txt`](./requirements.txt)
  - helper 依赖

## 启动方式

启动 helper：

```bash
python3 helper/wechat_history_helper.py
```

安装依赖：

```bash
python3 -m pip install -r helper/requirements.txt
```

启动 mitmproxy 插件：

```bash
mitmdump -s helper/mitm_wechat_history_addon.py
```

## 当前边界

- 不负责正文导出
- 不负责 Markdown 转换
- 不负责图片处理
- 依赖系统代理和证书配置
- 容易受其他代理工具干扰

下载公众号文章使用主仓库 README 的“公众号范围批量下载”。
