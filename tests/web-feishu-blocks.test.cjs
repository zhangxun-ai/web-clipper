const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fromRoot } = require("../shared/web-feishu-blocks.js");

// Matches the minimal DOM contract used by the exporter, without a browser or
// an additional runtime dependency. The real webpage is checked separately.
class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = text; }
}
class Element {
  constructor(name, attrs = {}, nested = []) {
    this.nodeType = 1;
    this.tagName = name.toUpperCase();
    this.attrs = attrs;
    this.className = attrs.class || "";
    this.hidden = Object.hasOwn(attrs, "hidden");
    this.childNodes = nested.map((child) => typeof child === "string" ? new TextNode(child) : child);
    this.children = this.childNodes.filter((child) => child.nodeType === 1);
    for (const child of this.children) child.parentElement = this;
  }
  getAttribute(name) { return this.attrs[name] || null; }
  get textContent() { return this.childNodes.map((child) => child.textContent || "").join(""); }
}
const el = (name, attrs, ...nested) => new Element(name, attrs, nested.flat());
const sourceUrl = "https://scys.com/articleDetail/xq_topic/55521155258121884";
const capture = (...nodes) => fromRoot(el("article", {}, ...nodes.flat()), { title: "原文标题", sourceUrl });
function text(block) {
  const payload = Object.values(block).find((value) => value && Array.isArray(value.elements));
  return payload ? payload.elements.map((item) => item.text_run.content).join("") : "";
}
function content(snapshot) { return snapshot.blocks.slice(1).map(text).filter(Boolean); }
function reachable(snapshot) {
  const lookup = new Map(snapshot.blocks.map((block) => [block.block_id, block]));
  const visited = new Set();
  const walk = (id) => {
    assert(!visited.has(id), `duplicate ${id}`);
    assert(lookup.has(id), `missing ${id}`);
    visited.add(id);
    for (const child of lookup.get(id).children || []) walk(child);
  };
  walk("WebRoot");
  assert.equal(visited.size, snapshot.blocks.length);
  for (const block of snapshot.blocks) assert.equal(Object.hasOwn(block, "parent_id"), false);
}

test("SCYS bullet-dot markers become native lists without bypassing prose or image coverage", () => {
  const bullet = (...parts) => el("div", { class: "bullet_container" },
    el("div", { class: "bullet" }, el("div", { class: "bullet-dot" }, ...parts)),
    el("div", { class: "list" }, "正文", el("strong", {}, "重点"), el("img", { src: "/body.png" })));
  const result = capture(bullet("•"));
  assert.deepEqual(content(result), ["正文重点"]);
  assert.equal(result.blocks[1].block_type, 12);
  assert.equal(result.images.length, 1);
  reachable(result);
  for (const parts of [["•真实说明"], ["•", el("img", { src: "/extra.png" })]]) {
    assert.throws(() => capture(bullet(...parts)), { code: "CONTENT_MISMATCH" });
  }
  assert.throws(() => fromRoot(bullet("•"), { title: "其他网站", sourceUrl: "https://example.com/article" }), { code: "CONTENT_MISMATCH" });
  const inside = capture(el("div", { class: "bullet_container" }, el("div", { class: "list" },
    el("div", { class: "bullet" }, el("div", { class: "bullet-dot" }, "•")), "正文")));
  assert(content(inside).join("").includes("•"), "a glyph inside list content must still be consumed as content");
});

test("SCYS callouts retain their icon, colors and grouped content without an extra emoji paragraph", () => {
  const callout = (emoji, ...body) => el("div", { class: "callout border_color_2 background_color_2" },
    el("div", { class: "block-icon" }, el("div", { class: "callout-emoji-container" }, el("span", { class: "emoji-text" }, emoji))),
    el("div", {}, ...body));
  const result = capture(el("p", {}, "前文"), callout("💡", el("p", {}, "提示首段"),
    el("p", {}, "提示末段", el("strong", {}, "重点")), el("img", { src: "/figure.png" })), el("p", {}, "后文"));
  const box = result.blocks.find(block => block.block_type === 19);
  assert.deepEqual(box.callout, { emoji_id: "bulb", background_color: 2, border_color: 2 });
  assert.deepEqual(content(result), ["前文", "提示首段", "提示末段重点", "后文"]);
  assert.equal(box.children.length, 3);
  assert.equal(result.images.length, 1);
  assert.equal(result.blocks[0].children.length, 3);
  reachable(result);
  const unknown = capture(callout("🧬", el("p", {}, "未知图标的原文")));
  assert.equal(unknown.blocks[1].block_type, 34);
  assert.deepEqual(content(unknown), ["🧬", "未知图标的原文"]);
  reachable(unknown);
  const extra = capture(callout("💡不能丢弃", el("p", {}, "正文")));
  assert(content(extra).includes("💡不能丢弃"));
});

test("preserves original prose, heading levels and text order without duplicating wrappers", () => {
  const result = capture(el("div", {}, el("section", {}, el("h1", {}, "主标题"), el("h6", {}, "六级标题"), el("p", {}, "英文 hello ", el("span", {}, "world"), "，中文原样。"))), el("p", {}, "下一段"));
  assert.equal(result.title, "原文标题");
  assert.equal(result.source_url, sourceUrl);
  assert.deepEqual(result.blocks.map((block) => block.block_type), [1, 3, 8, 2, 2]);
  assert.deepEqual(content(result), ["主标题", "六级标题", "英文 hello world，中文原样。", "下一段"]);
  reachable(result);
});

test("preserves actual 生财 heading wrappers and native headings with nested divs", () => {
  const result = capture(el("div", { class: "vc-doc-item doc-heading-block doc-heading-2 grid-images-full-height" },
    el("div", {}, el("div", { class: "text align block-header text_align_1 block4-header" },
      el("div", { class: "block4" }, el("span", { class: "text" }, "二、做 AI 自媒体，怎么确定自己的定位"))))),
    el("h2", {}, el("div", {}, el("span", {}, "Native ", el("strong", {}, "heading")))));
  assert.deepEqual(result.blocks.map((block) => block.block_type), [1, 4, 4]);
  assert.deepEqual(content(result), ["二、做 AI 自媒体，怎么确定自己的定位", "Native heading"]);
  assert.equal(result.blocks[2].heading2.elements[1].text_run.text_element_style.bold, true);
  reachable(result);
});

test("keeps inline bold italic strike underline code and absolute links", () => {
  const result = capture(el("p", {}, "a ", el("strong", {}, el("em", {}, "bold italic")), " ", el("del", {}, "deleted"), " ", el("u", {}, "underline"), " ", el("code", {}, "x++"), " ", el("a", { href: "/next#section" }, "next"), " ", el("a", { href: "mailto:hi@example.com" }, "email")));
  const runs = result.blocks[1].text.elements.map((item) => item.text_run);
  assert.deepEqual(runs.find((run) => run.content === "bold italic").text_element_style, { bold: true, italic: true });
  assert.equal(runs.find((run) => run.content === "deleted").text_element_style.strikethrough, true);
  assert.equal(runs.find((run) => run.content === "underline").text_element_style.underline, true);
  assert.equal(runs.find((run) => run.content === "x++").text_element_style.inline_code, true);
  assert.equal(runs.find((run) => run.content === "next").text_element_style.link.url, "https://scys.com/next#section");
  assert.equal(runs.find((run) => run.content === "email").text_element_style.link.url, "mailto:hi@example.com");
});

test("normalizes rendered whitespace without merging English words or inserting words", () => {
  const result = capture(el("p", {}, "  hello \n", el("b", {}, " world "), " next", el("br", {}), "line  "), el("p", {}, "type", el("b", {}, "script")));
  assert.deepEqual(content(result), ["hello world next\nline", "typescript"]);
});

test("images interrupt inline text in the original order and use stable token placeholders", () => {
  const photo = el("img", { src: "/placeholder.png", "data-src": "//cdn.example.com/photo.png", width: "1200", height: "800" });
  const result = capture(el("p", {}, "前文", photo, "后文"), el("figure", {}, el("img", { src: "./second.jpg" }), el("figcaption", {}, "图片说明")));
  assert.deepEqual(result.blocks.map((block) => block.block_type), [1, 2, 27, 2, 27, 2]);
  assert.deepEqual(content(result), ["前文", "后文", "图片说明"]);
  assert.deepEqual(result.images[0], { block_id: "web_2", url: "https://cdn.example.com/photo.png", width: 1200, height: 800 });
  assert.deepEqual(result.blocks[2].image, { token: "web_2", width: 1200, height: 800 });
  assert.equal(result.images[1].url, "https://scys.com/articleDetail/xq_topic/second.jpg");
  reachable(result);
});

test("preserves nested lists and ordered list start/value", () => {
  const result = capture(el("ol", { start: "3" }, el("li", {}, "第三项", el("ul", {}, el("li", {}, "子项"))), el("li", { value: "8" }, el("p", {}, "第八项"), el("p", {}, "续段"))));
  const ordered = result.blocks.filter((block) => block.block_type === 13);
  assert.deepEqual(ordered.map(text), ["第三项", "第八项"]);
  assert.deepEqual(ordered.map((block) => block.ordered.style.sequence), ["3", "8"]);
  assert.equal(result.blocks.find((block) => block.block_type === 12).bullet.elements[0].text_run.content, "子项");
  assert.equal(ordered[1].children.length, 1);
  reachable(result);
});

test("preserves quote children, literal code whitespace and divider", () => {
  const result = capture(el("blockquote", {}, el("p", {}, "引用一"), el("p", {}, "引用二")), el("pre", {}, el("code", {}, "  const x = 1;\n\n    x++;\n")), el("hr", {}));
  assert.deepEqual(result.blocks.map((block) => block.block_type), [1, 34, 2, 2, 14, 22]);
  assert.equal(result.blocks[4].code.elements[0].text_run.content, "  const x = 1;\n\n    x++;\n");
  assert.equal(result.blocks[1].children.length, 2);
  reachable(result);
});

test("preserves table cells including formatting, images and empty cells", () => {
  const result = capture(el("table", {}, el("caption", {}, "数据表"), el("thead", {}, el("tr", {}, el("th", {}, "名称"), el("th", {}, "图片"))), el("tbody", {}, el("tr", {}, el("td", {}, el("strong", {}, "甲")), el("td", {}, el("img", { src: "/a.png" }))), el("tr", {}, el("td", {}), el("td", {}, "末格")))));
  const table = result.blocks.find((block) => block.block_type === 31);
  assert.deepEqual(table.table.property, { row_size: 3, column_size: 2, header_row: true });
  assert.equal(table.children.length, 6);
  assert.equal(result.images.length, 1);
  assert.equal(content(result).filter((value) => value === "数据表").length, 1);
  assert.deepEqual(content(result), ["数据表", "名称", "图片", "甲", "末格"]);
  reachable(result);
});

test("supports rendered 生财 tables and list wrappers without UI marker duplication", () => {
  const cell = (value) => el("div", { class: "vc-doc-item" }, el("div", { class: "table_cell" }, el("div", { class: "block-text" }, value)));
  const result = capture(el("div", { class: "table table_2" }, el("div", {}, cell("用途"), cell("做法"), cell("沉淀"), cell("原样保存"))), el("div", { class: "bullet_container" }, el("div", { class: "row" }, el("span", { class: "marker" }, "•"), el("div", { class: "list" }, "无序项"))), el("div", { class: "block-order" }, el("span", { class: "order-marker" }, "4."), el("div", { class: "list" }, "有序项")));
  assert.deepEqual(content(result), ["用途", "做法", "沉淀", "原样保存", "无序项", "有序项"]);
  assert.equal(result.blocks.find((block) => block.block_type === 13).ordered.style.sequence, "4");
  assert.equal(result.blocks.find((block) => block.block_type === 31).table.property.column_size, 2);
  reachable(result);
});

test("preserves actual 生财 file-card names and download links without decorative labels", () => {
  const href = "https://sphere-search-mobile.oss-cn-shanghai.aliyuncs.com/upload/doc/blocks/Ilhwbl4jJoUykkx3e6FcMmW2nPd";
  const result = capture(el("div", {}, el("a", { class: "docx-file-card", href, download: "AI自媒体商业定位教练_SKILL.md", "data-highlight-ignore": "" },
    el("span", { class: "docx-file-card__badge" }, "FILE"),
    el("span", { class: "docx-file-card__info" }, el("span", { class: "docx-file-card__name" }, "AI自媒体商业定位教练_SKILL.md"), el("span", { class: "docx-file-card__meta" }, "文件 · 点击下载")),
    el("svg", { class: "docx-file-card__arrow", "aria-hidden": "true" }))));
  assert.deepEqual(content(result), ["AI自媒体商业定位教练_SKILL.md"]);
  assert.equal(result.blocks[1].text.elements[0].text_run.text_element_style.link.url, href);
});

test("the actual href-less SCYS ZIP card retains its name and an explicit original-page download entry", () => {
  const card = attrs => el("a", { class: "docx-file-card", "data-highlight-ignore": "", download: "微信公众号批量下载工具3.9.zip", ...attrs },
    el("span", { class: "docx-file-card__badge" }, "ZIP"),
    el("span", { class: "docx-file-card__info" }, el("span", { class: "docx-file-card__name" }, "微信公众号批量下载工具3.9.zip"),
      el("span", { class: "docx-file-card__meta" }, "压缩包 · 点击下载")),
    el("svg", { class: "docx-file-card__arrow" }, el("path", {})));
  const result = capture(card({}), el("img", { src: "/body-near-attachment.png" }));
  assert.deepEqual(content(result), ["附件：微信公众号批量下载工具3.9.zip（在原网页下载）"]);
  assert.equal(links(result)[0].text_element_style.link.url, sourceUrl);
  assert.deepEqual(result.images.map(image => image.url), ["https://scys.com/body-near-attachment.png"]);
  for (const href of ["blob:https://scys.com/local-download", "data:application/zip;base64,AAAA"]) {
    const temporary = capture(el("section", { id: "download-tools" }, card({ href })));
    assert.deepEqual(content(temporary), content(result));
    assert.equal(links(temporary)[0].text_element_style.link.url, `${sourceUrl}#download-tools`);
  }
  const stable = capture(card({ href: "https://cdn.example.com/download.zip" }));
  assert.deepEqual(content(stable), ["微信公众号批量下载工具3.9.zip"]);
  assert.equal(links(stable)[0].text_element_style.link.url, "https://cdn.example.com/download.zip");
  assert.throws(() => capture(card({ href: "javascript:alert(1)" })), { code: "INVALID_CONTENT" });
  assert.throws(() => capture(el("a", { class: "docx-file-card" }, el("svg", { class: "docx-file-card__arrow" }))), { code: "INVALID_CONTENT" });
  assert.throws(() => capture(el("svg", { class: "docx-file-card__arrow" })), { code: "UNSUPPORTED_CONTENT" });
  reachable(result);
});

test("file cards preserve extra body images, audio, video and additional filenames after their attachment link", () => {
  const card = () => el("a", { class: "docx-file-card" }, el("span", { class: "docx-file-card__badge" }, "ZIP"),
    el("span", { class: "docx-file-card__info" }, el("span", { class: "docx-file-card__name" }, "附件.zip"),
      el("span", { class: "docx-file-card__meta" }, "点击下载"), el("img", { src: "/body-diagram.png" }),
      el("audio", { src: "/lecture.mp3", title: "讲解" }), el("span", { class: "docx-file-card__name" }, "另一份说明.pdf")),
    el("video", { src: "/demo.mp4", title: "演示" }), el("svg", { class: "docx-file-card__arrow" }));
  // Exercise both the inline writer and the standalone conversion path.
  for (const result of [capture(card()), fromRoot(card(), { sourceUrl, title: "附件" })]) {
    assert.deepEqual(content(result), ["附件：附件.zip（在原网页下载）", "音频：讲解", "另一份说明.pdf", "视频：演示"]);
    assert.deepEqual(result.images.map(image => image.url), ["https://scys.com/body-diagram.png"]);
    assert.deepEqual(links(result).map(run => run.text_element_style.link.url), [sourceUrl, "https://scys.com/lecture.mp3", "https://scys.com/demo.mp4"]);
    reachable(result);
  }
  const unusualName = capture(el("a", { class: "docx-file-card", href: "/file.zip" },
    el("span", { class: "docx-file-card__name" }, "文件.zip", el("img", { src: "/inside-name.png" }), el("audio", { src: "/inside-name.mp3" }))));
  assert.deepEqual(content(unusualName), ["文件.zip", "音频"]);
  assert.equal(unusualName.images[0].url, "https://scys.com/inside-name.png");
  for (const resource of [el("canvas", {}), el("embed", { src: "/unknown" }), el("span", { class: "katex" }, "x^2")]) {
    assert.throws(() => capture(el("a", { class: "docx-file-card" }, el("span", { class: "docx-file-card__name" }, "附件.zip"), resource)),
      { code: "UNSUPPORTED_CONTENT" });
  }
});

test("removes prose spacers while retaining the required empty quote paragraph", () => {
  const result = capture("\n  ", el("div", {}, " \n "), el("p", {}), el("blockquote", {}), el("p", {}, el("br", {})));
  assert.equal(result.blocks.filter((block) => block.block_type === 2).length, 1);
  assert.equal(text(result.blocks.find(block => block.block_type === 2)), "");
  reachable(result);
});

test("preserves multiple explicit breaks, nonbreaking spaces and authored preformatted spacers", () => {
  const result = capture(el("p", {}, "第一行", el("br", {}), el("br", {}), "下一行"),
    el("p", {}, el("br", {}), el("br", {})), el("p", {}, "\u00a0"),
    el("div", { style: "white-space:pre-wrap" }, el("p", {}, el("br", {}))));
  assert.deepEqual(result.blocks.slice(1).map(text), ["第一行\n\n下一行", "\n\n", "\u00a0", ""]);
  reachable(result);
});

test("maps author colors and text alignment into Feishu semantic styles", () => {
  const result = capture(el("h2", { style: "text-align:center;color:rgb(230, 115, 0)" }, "橙色标题"),
    el("p", { style: "text-align:right" }, el("span", { style: "color:#ff0000" }, "红色"),
      el("span", { style: "background-color:yellow" }, "高亮")));
  assert.equal(result.blocks[1].heading2.style.align, 2);
  assert.equal(result.blocks[1].heading2.elements[0].text_run.text_element_style.text_color, 2);
  assert.equal(result.blocks[2].text.style.align, 3);
  assert.equal(result.blocks[2].text.elements[0].text_run.text_element_style.text_color, 1);
  assert.equal(result.blocks[2].text.elements[1].text_run.text_element_style.background_color, 3);
});

test("source coverage refuses text lost outside recognized table cells or list bodies", () => {
  assert.throws(() => capture(el("table", {}, el("tr", {}, el("td", {}, "单元格")), el("tfoot", {}, "不得遗漏的表格注释"))), { code: "CONTENT_MISMATCH" });
  assert.throws(() => capture(el("div", { class: "bullet_container" }, el("div", { class: "list" }, "列表正文"), el("p", {}, "不得遗漏的补充说明"))), { code: "CONTENT_MISMATCH" });
  assert.throws(() => capture(el("table", {}, el("tr", {}, el("td", {}, "单元格")), el("img", { src: "/footnote.png" }))), { code: "CONTENT_MISMATCH" });
});

test("skips non-body controls, scripts and hidden decorative resources", () => {
  const result = capture(el("nav", {}, "导航"), el("script", {}, "private()"), el("style", {}, ".foo {}"), el("svg", { "aria-hidden": "true" }), el("iframe", { style: "display:none" }), el("button", {}, "复制"), el("p", {}, "正文"));
  assert.deepEqual(content(result), ["正文"]);
});

test("rejects visible unsupported embedded resources and formulas before saving", () => {
  for (const name of ["iframe", "canvas", "svg", "math", "embed", "object"]) {
    assert.throws(() => capture(el("p", {}, "正文", el(name, { src: "/resource" }))), { code: "UNSUPPORTED_CONTENT" });
  }
  assert.throws(() => capture(el("span", { class: "katex" }, "x^2")), { code: "UNSUPPORTED_CONTENT" });
});

const mediaCard = (kind, title, attrs = {}, extra = []) => el("div", { class: `block-file ${kind}` },
  el("div", { class: "title" }, el("img", { class: "icon", src: "/images/docx/link.png" }), el("span", {}, title)),
  el("div", { class: "player" }, el(kind, { class: `${kind}-preview`, preload: "metadata", ...attrs }),
    el("img", { class: "btn", src: "data:image/png;base64,AAAA" }), ...extra));
const links = snapshot => snapshot.blocks.flatMap(block => Object.values(block)
  .flatMap(value => value?.elements || [])).map(item => item.text_run).filter(run => run.text_element_style?.link);

test("keeps both real SCYS video cards as named links without fetching their icon or play button", () => {
  const videoUrl = "https://sphere-search-mobile.oss-cn-shanghai.aliyuncs.com/upload/doc/blocks/H70vbl9lsohaLExbW4fcJ456nhd";
  const result = capture(el("p", {}, "前文"), mediaCard("video", "内容王国操作流程（全程复杂版）.mp4【在线播放】"),
    mediaCard("video", "内容王国操作流程（简化版）.mp4【在线播放】", { src: videoUrl }),
    el("img", { src: "/body.png" }), el("p", {}, "后文"));
  assert.deepEqual(content(result), ["前文", "视频：内容王国操作流程（全程复杂版）.mp4【在线播放】（在原网页播放）",
    "视频：内容王国操作流程（简化版）.mp4【在线播放】", "后文"]);
  assert.deepEqual(links(result).map(run => run.text_element_style.link.url), [sourceUrl, videoUrl]);
  assert.deepEqual(result.images.map(image => image.url), ["https://scys.com/body.png"]);
  reachable(result);
});

test("preserves generic video and audio media semantics with src, currentSrc and source elements", () => {
  const liveVideo = el("video", { title: "播放介绍", src: "blob:https://scys.com/player" });
  liveVideo.currentSrc = "https://cdn.example.com/intro.mp4";
  const result = capture(liveVideo, el("audio", { "aria-label": "语音讲解" }, el("source", { src: "/talk.mp3", type: "audio/mpeg" })),
    el("p", {}, "观看", el("video", { src: "/demo.mp4" }), "后继续"));
  assert.deepEqual(content(result), ["视频：播放介绍", "音频：语音讲解", "观看", "视频", "后继续"]);
  assert.deepEqual(links(result).map(run => run.text_element_style.link.url), ["https://cdn.example.com/intro.mp4", "https://scys.com/talk.mp3", "https://scys.com/demo.mp4"]);
  assert.equal(result.images.length, 0);
  const otherSite = fromRoot(el("article", {}, el("audio", { src: "/audio.mp3", title: "播客" })),
    { sourceUrl: "https://example.com/post", title: "文章" });
  assert.equal(links(otherSite)[0].text_element_style.link.url, "https://example.com/audio.mp3");
});

test("missing, blob and inline media link back to an actual source-page anchor with an explicit playback label", () => {
  const result = capture(el("section", { id: "video-section" }, mediaCard("video", "演示视频", { src: "blob:https://scys.com/opaque" })),
    el("audio", { id: "audio-player", src: "data:audio/mp3;base64,AAAA", title: "语音" }), el("video", {}));
  assert.deepEqual(content(result), ["视频：演示视频（在原网页播放）", "音频：语音（在原网页播放）", "视频（在原网页播放）"]);
  assert.deepEqual(links(result).map(run => run.text_element_style.link.url), [`${sourceUrl}#video-section`, `${sourceUrl}#audio-player`, sourceUrl]);
  assert.equal(result.images.length, 0);
});

test("media-card adaptation preserves additional body images and supports audio cards without changing unrelated attachments", () => {
  const result = capture(mediaCard("audio", "音频示范", { src: "/demo.mp3" }, [el("img", { src: "/inside-player-body.png" })]),
    el("img", { class: "btn", src: "/outside-player-body.png" }), el("a", { href: "/guide.pdf", download: "操作指南.pdf" }, "操作指南.pdf"));
  assert.deepEqual(content(result), ["音频：音频示范", "操作指南.pdf"]);
  assert.deepEqual(result.images.map(image => image.url), ["https://scys.com/inside-player-body.png", "https://scys.com/outside-player-body.png"]);
  assert.deepEqual(links(result).map(run => run.text_element_style.link.url), ["https://scys.com/demo.mp3", "https://scys.com/guide.pdf"]);
  reachable(result);
});

test("media links never preserve executable URLs and unrecognized resources still stop explicitly", () => {
  for (const src of ["javascript:alert(1)", "file:///tmp/video.mp4", "https://user:secret@example.com/video.mp4"]) {
    assert.throws(() => capture(el("video", { src })), error => error.code === "INVALID_CONTENT" && /视频地址/.test(error.message));
  }
  for (const node of [el("div", { class: "block-file" }, "未知附件"), el("span", { class: "katex" }, "x^2"),
    el("canvas", {}), el("embed", { src: "/unknown" }), el("pre", {}, el("video", { src: "/demo.mp4" }))]) {
    assert.throws(() => capture(node), { code: "UNSUPPORTED_CONTENT" });
  }
  assert.throws(() => capture(el("div", { class: "block-file video" }, "只有标题，没有播放器")),
    error => error.code === "INVALID_CONTENT" && /视频卡片结构/.test(error.message));
  assert.throws(() => fromRoot(mediaCard("video", "不是生财组件", { src: "/video.mp4" }),
    { sourceUrl: "https://example.com/post", title: "文章" }), { code: "UNSUPPORTED_CONTENT" });
});

test("rejects missing image sources, unsupported image/link schemes and credentials", () => {
  for (const attrs of [{}, { src: "blob:https://scys.com/opaque" }, { src: "file:///tmp/x.png" }, { src: "https://user:secret@example.com/x" }]) {
    assert.throws(() => capture(el("img", attrs)), { code: "INVALID_CONTENT" });
  }
  for (const href of ["javascript:alert(1)", "data:text/html,a", "file:///tmp/a", "https://u:p@example.com/"]) {
    assert.throws(() => capture(el("a", { href }, "链接")), { code: "INVALID_CONTENT" });
  }
  assert.throws(() => capture(el("img", { src: "data:image/svg+xml;base64,AAAA" })), { code: "INVALID_CONTENT" });
  assert.equal(capture(el("img", { src: "data:image/png;base64,AAAA" })).images[0].url, "data:image/png;base64,AAAA");
  assert.equal(capture(el("img", { src: "/my image.png" })).images[0].url, "https://scys.com/my%20image.png");
});

test("rejects merged, ragged and oversized tables explicitly", () => {
  assert.throws(() => capture(el("table", {}, el("tr", {}, el("td", { colspan: "2" }, "合并")))), { code: "UNSUPPORTED_CONTENT" });
  assert.throws(() => capture(el("table", {}, el("tr", {}, el("td", {}, "a")), el("tr", {}, el("td", {}, "b"), el("td", {}, "c")))), { code: "INVALID_CONTENT" });
  assert.throws(() => capture(el("table", {}, el("tr", {}, Array.from({ length: 10 }, () => el("td", {}, "宽"))))), { code: "IMPORT_TOO_LARGE" });
});

test("bounds total blocks, serialized text bytes and nested DOM size", () => {
  assert.throws(() => capture(el("p", {}, "a".repeat(701 * 1024))), { code: "IMPORT_TOO_LARGE" });
  assert.throws(() => capture(Array.from({ length: 5000 }, () => el("p", {}, "a"))), { code: "IMPORT_TOO_LARGE" });
  assert.throws(() => capture(Array.from({ length: 400 }, () => el("p", {}, "字".repeat(1000)))), { code: "IMPORT_TOO_LARGE" });
  assert.throws(() => capture(el("img", { src: "data:image/png;base64," + "A".repeat(720 * 1024) })), { code: "IMPORT_TOO_LARGE" });
  let nested = el("p", {}, "深层");
  for (let i = 0; i < 100; i++) nested = el("div", {}, nested);
  assert.throws(() => capture(nested), { code: "IMPORT_TOO_LARGE" });
});

test("chunks large text runs without discarding their content", () => {
  const original = "a".repeat(1999) + "😀" + "a".repeat(5000);
  const result = capture(el("p", {}, el("strong", {}, original)));
  assert.equal(text(result.blocks[1]), original);
  assert.equal(result.blocks[1].text.elements.length, 4);
  assert(result.blocks[1].text.elements.every((run) => run.text_run.content.length <= 2000));
  assert(result.blocks[1].text.elements.every((run) => !/[\uD800-\uDBFF]$/.test(run.text_run.content)));
});

test("preserves a 505-line 10410-character code block as one block with multiple runs", () => {
  const lines = Array.from({ length: 505 }, (_, index) => {
    // 19 characters per line, plus 311 preserved trailing spaces.
    const line = "\t  const x = 1;    ";
    assert.equal(line.length, 19);
    return line + (index < 311 ? " " : "");
  });
  const original = lines.join("\n");
  assert.equal(original.length, 10410);
  assert.equal(original.split("\n").length, 505);
  const result = capture(el("p", {}, "代码之前"), el("pre", {}, el("code", {}, original)), el("p", {}, "代码之后"));
  assert.deepEqual(result.blocks.map((block) => block.block_type), [1, 2, 14, 2]);
  assert.equal(text(result.blocks[2]), original);
  assert.equal(result.blocks[2].code.elements.length, 6);
  assert(result.blocks[2].code.elements.every((element) => element.text_run.content.length <= 2000));
  assert.deepEqual(content(result), ["代码之前", original, "代码之后"]);
  reachable(result);
});

test("preserves long rich paragraphs above 10000 characters without splitting their block or styles", () => {
  const plain = "正文内容 " + "a".repeat(9500) + " ";
  const bold = "b".repeat(4500);
  const tail = " 后文😀";
  const result = capture(el("p", {}, plain, el("strong", {}, bold), tail));
  assert.deepEqual(result.blocks.map((block) => block.block_type), [1, 2]);
  assert.equal(text(result.blocks[1]), plain + bold + tail);
  const runs = result.blocks[1].text.elements.map((element) => element.text_run);
  assert.equal(runs.filter((run) => run.text_element_style?.bold).map((run) => run.content).join(""), bold);
  assert(runs.every((run) => run.content.length <= 2000));
  reachable(result);
});


const mentionId = "ou_01b2032de6b0af3a40a92357dac021e8";
const scysMention = (label = mentionId, attrs = {}) => el("div", { class: "headPc" },
  el("img", { src: mentionId, alt: "", class: "head_img" }), el("a", { class: "aHref", ...attrs }, label));

test("preserves the real SCYS person mention inline without downloading its user id as a body image", () => {
  const result = capture(el("div", { class: "block-text headFlex" },
    el("span", { class: "text" }, "去年从零起步，今年与"), scysMention(),
    el("span", { class: "text" }, "成立工作室，搭建内容工厂，跑通1-10。")),
  el("img", { src: "https://cdn.example.com/real-body-image.png" }), el("img", { src: "/another-body-image" }));
  assert.deepEqual(content(result), [`去年从零起步，今年与${mentionId}成立工作室，搭建内容工厂，跑通1-10。`]);
  assert.deepEqual(result.images.map(image => image.url), ["https://cdn.example.com/real-body-image.png", "https://scys.com/another-body-image"]);
  assert.deepEqual(result.blocks.map(block => block.block_type), [1, 2, 27, 27]);
  reachable(result);
});

test("keeps a SCYS mention's visible name, safe link and text emphasis in headings and table cells", () => {
  const result = capture(el("h2", {}, "邀请", scysMention(el("strong", {}, "小明"), { href: "/user/profile/123" }), "加入"),
    el("table", {}, el("tr", {}, el("td", {}, "协作：", scysMention("小王", { href: "https://scys.com/user/profile/456" })))));
  assert.deepEqual(content(result), ["邀请小明加入", "协作：小王"]);
  const named = result.blocks[1].heading2.elements.find(item => item.text_run.content === "小明").text_run;
  assert.equal(named.text_element_style.bold, true);
  assert.equal(named.text_element_style.link.url, "https://scys.com/user/profile/123");
  assert.equal(result.images.length, 0);
  const standalone = fromRoot(scysMention("独立提及"), { sourceUrl, title: "人物" });
  assert.deepEqual(content(standalone), ["独立提及"]);
  reachable(result);
});

test("rejects incomplete SCYS mentions and unsafe links instead of silently losing their content", () => {
  for (const mention of [scysMention(""), scysMention("   "),
    el("div", { class: "headPc" }, el("img", { class: "head_img", src: mentionId })),
    el("div", { class: "headPc" }, el("a", { class: "aHref" }, "缺少头像")),
    el("div", { class: "headPc" }, el("img", { class: "head_img", src: mentionId }), el("a", { class: "aHref" }, "小明"), "未识别正文"),
    scysMention("危险链接", { href: "javascript:alert(1)" })]) {
    assert.throws(() => capture(el("p", {}, "前文", mention, "后文")), { code: "INVALID_CONTENT" });
  }
});

test("mention adaptation never globally removes head_img classes, user-like URLs or dimensionless images", () => {
  const standaloneImage = el("img", { class: "head_img", src: mentionId });
  const result = capture(standaloneImage, el("img", { src: "https://cdn.example.com/ou_body-image" }));
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].url, `https://scys.com/articleDetail/xq_topic/${mentionId}`);
  const otherSite = fromRoot(el("article", {}, scysMention("另一个网站的内容")), { sourceUrl: "https://example.com/post", title: "正文" });
  assert.equal(otherSite.images.length, 1);
  assert.deepEqual(content(otherSite), ["另一个网站的内容"]);
});
