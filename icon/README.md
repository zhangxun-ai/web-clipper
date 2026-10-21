# 图标资产

## 网页剪存品牌图标

`brand.svg` 是可维护的矢量源文件：暖棕色 `#965415` 圆角底、白色叠页和两条正文线，依据用户确认的「A · 叠页归档」设计制作。由基础 SVG 几何组成，无字体、外部图片、滤镜或远程依赖。

`16.png`、`32.png`、`48.png`、`96.png`、`128.png` 是 `manifest.json` 实际引用的图标；其尺寸与文件名一致，圆角以外透明。已有商店截图、商店图标和 `master.html` 是历史资产，本次未更新。

在仓库根目录运行以下命令即可重新生成五个 PNG：

```sh
node icon/render-brand.cjs
```

脚本使用项目已有 Playwright 和 Chromium，直接按目标尺寸栅格化 SVG，`deviceScaleFactor: 1`，不增加依赖。生成后检查 16px、32px 的叠页间隙和两条正文线是否仍可辨认；不应用模糊、阴影或额外缩放。

## 飞书与 Obsidian 服务标志

以下文件用于识别保存目的地，保留官方颜色和图形，不是本扩展的产品标志。均在 2026-09-29 从官方公开静态资产获取，运行时使用本地文件，不请求远程资源。

| 文件 | 官方来源页 | 原始静态资源 |
| --- | --- | --- |
| `feishu.png` | [飞书官网](https://www.feishu.cn/) 的 `og:image` | [官方 CDN PNG，100×100，透明背景](https://p1-hera.feishucdn.com/tos-cn-i-jbbdkfciu3/84a9f036fe2b44f99b899fff4beeb963~tplv-jbbdkfciu3-image:100:100.image) |
| `obsidian.svg` | [Obsidian Brand Guidelines](https://obsidian.md/brand) 的 Icon 下载 | [官方紫晶渐变 SVG](https://obsidian.md/images/obsidian-logo-gradient.svg) |

两份服务标志按官方资源原样保存；不得将其替换成通用纸飞机、空心菱形或品牌棕色版本。图标商标仍归各自权利人所有；Obsidian 来源页另列商业使用联系要求，获取公开资产不等于取得独立商标授权。
