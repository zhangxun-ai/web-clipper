(function (scope) {
  "use strict";

  const MAX_BLOCKS = 5000;
  const MAX_JSON_BYTES = 700 * 1024;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const IGNORE = new Set(["script", "style", "noscript", "template", "nav", "button", "input", "textarea", "select"]);
  const UNSUPPORTED = new Set(["iframe", "video", "audio", "canvas", "svg", "math", "object", "embed"]);
  const BLOCK_TAGS = new Set(["article", "section", "main", "div", "p", "header", "footer", "aside", "figure", "figcaption", "address", "details", "summary", "dl", "dt", "dd"]);
  const FIELDS = { 2: "text", 12: "bullet", 13: "ordered", 14: "code", 19: "callout", 22: "divider", 27: "image", 31: "table", 32: "table_cell", 34: "quote_container" };
  for (let level = 1; level <= 6; level += 1) FIELDS[level + 2] = `heading${level}`;

  function fail(message, code = "UNSUPPORTED_CONTENT") {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function tag(node) { return String(node?.tagName || "").toLowerCase(); }
  function attr(node, name) { return String(node?.getAttribute?.(name) || ""); }
  function children(node) { return Array.from(node?.childNodes || []); }
  function classes(node) { return String(typeof node?.className === "string" ? node.className : "").split(/\s+/); }
  function hasClass(node, name) { return classes(node).includes(name); }

  function css(node) {
    try {
      return node.ownerDocument?.defaultView?.getComputedStyle?.(node) || node.style || {};
    } catch (_) {
      return node.style || {};
    }
  }

  function ignored(node) {
    if (node?.nodeType !== 1) return false;
    const style = css(node);
    return IGNORE.has(tag(node)) || node.hidden || attr(node, "aria-hidden") === "true"
      || style.display === "none" || style.visibility === "hidden"
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, "style"));
  }

  function checkResource(node) {
    if (UNSUPPORTED.has(tag(node)) || classes(node).some((name) => /^(?:katex|MathJax|mathjax|mjx-container|block-equation|block-file|block-video)(?:$|[-_])/.test(name))) {
      const type = ({ video: "视频", audio: "音频", iframe: "嵌入页面", canvas: "画布", svg: "矢量图", math: "数学公式", object: "嵌入对象", embed: "嵌入资源" })[tag(node)]
        || (classes(node).some(name => /katex|MathJax|mathjax|equation/.test(name)) ? "数学公式"
          : hasClass(node, "block-video") || hasClass(node, "video") ? "视频" : hasClass(node, "audio") ? "音频" : hasClass(node, "block-file") ? "附件" : "特殊资源");
      fail(`正文包含暂不能完整保存的${type}（${tag(node) || "特殊资源"}），未省略该内容，请先处理后再剪存。`);
    }
  }

  function safeUrl(value, base, image = false) {
    const raw = String(value || "").trim();
    if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) fail(image ? "正文图片缺少有效地址，未忽略图片。" : "正文链接地址无效。", "INVALID_CONTENT");
    if (image && /^data:/i.test(raw)) {
      if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-zA-Z0-9+/]*={0,2}$/i.test(raw)) fail("正文包含暂不支持的内嵌图片格式。", "INVALID_CONTENT");
      if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 128) fail("单张图片超过 20 MiB，未创建不完整文档。", "IMPORT_TOO_LARGE");
      return raw;
    }
    let parsed;
    try { parsed = new URL(raw, base); } catch (_) { fail("正文中的资源网址无效。", "INVALID_CONTENT"); }
    const protocols = image ? ["http:", "https:"] : ["http:", "https:", "mailto:"];
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 8192) {
      fail(image ? "正文图片地址不受支持，未忽略图片。" : "正文包含不受支持的链接地址。", "INVALID_CONTENT");
    }
    return parsed.href;
  }

  function fromRoot(root, options = {}) {
    if (!root || ![1, 11].includes(root.nodeType)) fail("未找到网页正文。", "INVALID_CONTENT");
    const sourceUrl = safeUrl(options.sourceUrl, undefined, true);
    if (!/^https?:/i.test(sourceUrl)) fail("网页地址必须使用 HTTP 或 HTTPS。", "INVALID_CONTENT");
    const title = String(options.title || "未命名网页").trim();
    if (!title || title.length > 1024) fail("网页标题为空或过长。", "INVALID_CONTENT");
    const blocks = [{ block_id: "WebRoot", block_type: 1, children: [] }];
    const images = [];
    const isScysSource = /(^|\.)scys\.com$/i.test(new URL(sourceUrl).hostname);
    let counter = 0;
    let visited = 0;
    let textUnits = 0;
    const consumed = new WeakMap();
    const decorations = new WeakSet();
    const expectedText = [];

    function readText(node) {
      consumed.set(node, (consumed.get(node) || 0) + 1);
      return node.textContent || "";
    }

    function inlineProperty(node, name) {
      return attr(node, "style").match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim() || "";
    }

    function whitespace(node) {
      for (let current = node; current; current = current.parentElement) {
        const value = css(current).whiteSpace || inlineProperty(current, "white-space");
        if (value) return value;
        if (current === root) break;
      }
      return "normal";
    }

    function protectedSpacing(node, parent) {
      if ([12, 13, 14, 19, 32, 34].includes(parent.block_type)) return true;
      for (let current = node; current; current = current.parentElement) {
        // Capture remembers authored whitespace separately from inherited
        // editor CSS (Quill uses pre-wrap even for ordinary prose).
        const authored = current.__feishuAuthoredWhitespace ?? inlineProperty(current, "white-space");
        if (["pre", "blockquote", "li", "td", "th"].includes(tag(current))
          || /^(pre|pre-wrap|pre-line|break-spaces)$/.test(authored)) return true;
        if (current.__feishuAuthoredWhitespace === undefined && current === root && !hasClass(root, "ql-editor")
          && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(css(current).whiteSpace)) return true;
        if (current === root) break;
      }
      return false;
    }

    function placeholderParagraph(node) {
      if (tag(node) !== "p") return false;
      let breaks = 0, meaningful = false;
      const scan = part => {
        if (ignored(part)) return;
        if (part.nodeType === 3) { if (!/^[\t\r\n\f ]*$/.test(part.textContent || "")) meaningful = true; return; }
        if (tag(part) === "br") { breaks++; return; }
        if (part !== node && !["span", "b", "strong", "i", "em", "u", "s"].includes(tag(part))) { meaningful = true; return; }
        // Colored/highlighted blank regions and anchored placeholders may
        // carry meaning; only plain editor spacers are disposable.
        if (attr(part, "id") || fontColor(css(part).backgroundColor || inlineProperty(part, "background-color"))
          || inlineProperty(part, "background")) meaningful = true;
        for (const child of children(part)) scan(child);
      };
      scan(node);
      return !meaningful && breaks <= 1;
    }

    function paragraphStyle(node) {
      const align = css(node).textAlign || inlineProperty(node, "text-align") || attr(node, "align");
      const value = ({ left: 1, start: 1, center: 2, right: 3, end: 3 })[align];
      return value && value !== 1 ? { align: value } : undefined;
    }

    function fontColor(value) {
      const named = { red: [255, 0, 0], orange: [255, 165, 0], yellow: [255, 255, 0], green: [0, 128, 0],
        blue: [0, 0, 255], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128] };
      const raw = String(value || "").trim().toLowerCase();
      let rgb = named[raw];
      if (/^#[a-f0-9]{3}$/i.test(raw)) rgb = [...raw.slice(1)].map(c => parseInt(c + c, 16));
      if (/^#[a-f0-9]{6}$/i.test(raw)) rgb = [1, 3, 5].map(i => parseInt(raw.slice(i, i + 2), 16));
      if (/^rgba?\(/.test(raw)) {
        const values = raw.match(/[\d.]+/g)?.map(Number);
        if (values?.length >= 3 && (values.length === 3 || values[3] > 0)) rgb = values.slice(0, 3);
      }
      if (!rgb) return undefined;
      const [r, g, b] = rgb.map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
      // Neutral body text stays in the document theme; explicit mid-gray is
      // retained. Feishu exposes semantic palette colors, not arbitrary RGB.
      if (delta < 0.12) return max > 0.35 && max < 0.8 ? 7 : undefined;
      let hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
      return hue < 15 || hue >= 345 ? 1 : hue < 45 ? 2 : hue < 75 ? 3 : hue < 175 ? 4 : hue < 265 ? 5 : 6;
    }

    function verifyCapture() {
      let scanned = 0;
      const scan = (node, depth = 0) => {
        if (++scanned > 100000 || depth > 80) fail("原文内容核对超过范围。", "IMPORT_TOO_LARGE");
        if (ignored(node) || decorations.has(node)) return;
        if ((node.nodeType === 3 && /\S/.test(node.textContent || "")) || tag(node) === "img") {
          if (consumed.get(node) !== 1) fail("原文中有文字或图片尚未准确转换，已停止保存，避免遗漏或重复。", "CONTENT_MISMATCH");
        }
        for (const child of children(node)) scan(child, depth + 1);
      };
      scan(root);
      const lookup = new Map(blocks.map(block => [block.block_id, block])), seen = new Set(), actual = [];
      const walk = id => {
        const block = lookup.get(id);
        if (!block || seen.has(id)) fail("转换后的段落结构无效。", "CONTENT_MISMATCH");
        seen.add(id);
        for (const run of block[FIELDS[block.block_type]]?.elements || []) actual.push(run.text_run.content);
        for (const child of block.children || []) walk(child);
      };
      walk("WebRoot");
      // HTML's collapsible layout whitespace is excluded here. Meaningful
      // breaks/code whitespace remain in runs and the remote exact comparison.
      const compact = value => value.replace(/[\t\r\n\f ]/g, "");
      if (seen.size !== blocks.length || compact(actual.join("")) !== compact(expectedText.join(""))) {
        fail("转换后的正文内容或顺序未通过核对，已停止保存。", "CONTENT_MISMATCH");
      }
    }

    function add(kind, payload, parent, nested = false) {
      if (blocks.length >= MAX_BLOCKS) fail("网页正文超过 5000 个内容块，未创建不完整文档。", "IMPORT_TOO_LARGE");
      const block = { block_id: `web_${++counter}`, block_type: kind, [FIELDS[kind]]: payload };
      if (nested) block.children = [];
      blocks.push(block);
      parent.children.push(block.block_id);
      return block;
    }

    function visit(node, depth) {
      if (depth > 80 || ++visited > 100000) fail("网页正文结构过大或嵌套过深。", "IMPORT_TOO_LARGE");
      if (!node || ![1, 3, 11].includes(node.nodeType) || ignored(node) || decorations.has(node)) return false;
      if (node.nodeType === 1 && !mediaKind(node)) checkResource(node);
      return true;
    }

    function mediaKind(node) {
      if (["video", "audio"].includes(tag(node))) return tag(node);
      if (isScysSource && hasClass(node, "block-file")) {
        if (hasClass(node, "video")) return "video";
        if (hasClass(node, "audio")) return "audio";
      }
      return "";
    }

    function sourcePageLink(node) {
      const original = new URL(sourceUrl);
      let ancestor = node;
      while (ancestor) {
        const anchor = attr(ancestor, "id");
        if (anchor) { original.hash = anchor; break; }
        if (ancestor === root) break;
        ancestor = ancestor.parentElement;
      }
      return original.href;
    }

    function mediaResource(node) {
      const kind = mediaKind(node);
      if (!kind) return null;
      const type = kind === "video" ? "视频" : "音频";
      const extra = [];
      let media = node;
      let name = "";
      if (tag(node) !== kind) {
        // These are SCYS's file/player components. Only their known icon and
        // play-button images are decorative; other article content survives.
        const title = children(node).find(child => hasClass(child, "title"));
        const player = children(node).find(child => hasClass(child, "player"));
        const players = children(player).filter(child => tag(child) === kind);
        if (!title || players.length !== 1) fail(`生财${type}卡片结构不完整，未忽略该资源。`, "INVALID_CONTENT");
        media = players[0];
        const titleText = (part, depth = 0) => {
          if (!visit(part, depth)) return "";
          if (part.nodeType === 3) return readText(part);
          if (tag(part) === "img") {
            if (!hasClass(part, "icon")) extra.push(part);
            else decorations.add(part);
            return "";
          }
          return children(part).map(child => titleText(child, depth + 1)).join("");
        };
        name = titleText(title).trim();
        if (!name) fail(`生财${type}卡片缺少资源名称，未忽略该资源。`, "INVALID_CONTENT");
        for (const child of children(player)) if (tag(child) === "img" && hasClass(child, "btn")) decorations.add(child);
        extra.push(...children(player).filter(child => child !== media && !(tag(child) === "img" && hasClass(child, "btn"))),
          ...children(node).filter(child => child !== title && child !== player));
      } else name = attr(media, "aria-label") || attr(media, "title") || String(media.textContent || "").trim();
      // Native player fallback text is represented by the named media link.
      decorations.add(media);
      const sources = [media.currentSrc, attr(media, "src"), ...children(media).filter(child => tag(child) === "source").map(child => attr(child, "src"))];
      let url = "";
      for (const value of sources) {
        const raw = String(value || "").trim();
        // Object URLs and inline media are tied to the live player. Preserve
        // access through the article instead of saving an unusable media URL.
        if (!raw || /^(?:blob|data):/i.test(raw)) continue;
        try { url = safeUrl(raw, sourceUrl, true); }
        catch (_) { fail(`${type}地址不受支持，未保存无效的资源链接。`, "INVALID_CONTENT"); }
        break;
      }
      const fallback = !url;
      if (fallback) url = sourcePageLink(node);
      return { label: `${type}${name ? `：${name}` : ""}${fallback ? "（在原网页播放）" : ""}`, url, extra };
    }

    function styleFor(node, inherited) {
      const result = { ...inherited };
      const name = tag(node);
      const style = css(node);
      const inline = attr(node, "style");
      if (["b", "strong"].includes(name) || Number.parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === "bold" || /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(inline)) result.bold = true;
      if (["i", "em"].includes(name) || style.fontStyle === "italic" || /font-style\s*:\s*italic/i.test(inline)) result.italic = true;
      const decoration = `${style.textDecorationLine || style.textDecoration || ""} ${inline}`;
      if (["s", "del", "strike"].includes(name) || /line-through/.test(decoration)) result.strikethrough = true;
      if (name === "u" || /underline/.test(decoration)) result.underline = true;
      if (name === "code") result.inline_code = true;
      const color = style.color || inlineProperty(node, "color");
      if (color) {
        const mapped = fontColor(color);
        if (mapped) result.text_color = mapped;
        else delete result.text_color;
      }
      const background = style.backgroundColor || inlineProperty(node, "background-color");
      const mappedBackground = fontColor(background);
      if (mappedBackground) result.background_color = mappedBackground;
      else if (background && background !== "transparent" && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(background)) delete result.background_color;
      // A file card may be a JavaScript download control with no durable href.
      // Its semantic adapter validates the URL and supplies an explicit fallback.
      if (name === "a" && attr(node, "href") && !hasClass(node, "docx-file-card")) result.link = { url: safeUrl(attr(node, "href"), sourceUrl) };
      return result;
    }

    function scysMentionLabel(node) {
      if (!isScysSource || !hasClass(node, "headPc")) return null;
      // SCYS renders a person mention as an avatar and a visible label. Its
      // avatar src may be a user id, which is not a body image URL. Recognize
      // the complete component rather than discarding images by URL or size.
      const parts = children(node);
      const avatars = parts.filter(child => tag(child) === "img" && hasClass(child, "head_img"));
      const labels = parts.filter(child => tag(child) === "a" && hasClass(child, "aHref") && !ignored(child));
      const extra = parts.filter(child => !avatars.includes(child) && !labels.includes(child)
        && (child.nodeType === 1 ? !ignored(child) : child.nodeType === 3 && String(child.textContent || "").trim()));
      if (extra.length || avatars.length !== 1 || labels.length !== 1 || !String(labels[0].textContent || "").trim()) {
        fail("生财人物提及缺少可保存的显示文字或结构不完整，未忽略该内容。", "INVALID_CONTENT");
      }
      decorations.add(avatars[0]);
      return labels[0];
    }

    function addImage(node, parent) {
      consumed.set(node, (consumed.get(node) || 0) + 1);
      // Lazy-load originals take precedence over a placeholder currently in src.
      const raw = attr(node, "data-original") || attr(node, "data-actualsrc") || attr(node, "data-src") || node.currentSrc || attr(node, "src");
      const url = safeUrl(raw, sourceUrl, true);
      const dimensions = {};
      for (const name of ["width", "height"]) {
        const number = Number(node[name === "width" ? "naturalWidth" : "naturalHeight"] || attr(node, name));
        if (Number.isFinite(number) && number > 0 && number <= 100000) dimensions[name] = Math.round(number);
      }
      const block = add(27, {}, parent);
      block.image = { token: block.block_id, ...dimensions };
      const displayWidth = node.__feishuDisplayWidth;
      images.push({ block_id: block.block_id, url, ...dimensions,
        ...(Number.isFinite(displayWidth) && displayWidth > 0 && displayWidth <= 100000 ? { display_width: displayWidth } : {}) });
    }

    function writer(parent, kind = 2, payloadStyle, inheritedStyle = {}, keepEmpty = false) {
      let runs = [];
      let emitted = false;
      let preserveRuns = false;
      function append(value, style = inheritedStyle, pre = false) {
        let content = String(value || "").replace(/\r\n?/g, "\n");
        expectedText.push(content);
        if (pre && pre !== "break" && content) preserveRuns = true;
        if (pre === "pre-line") content = content.replace(/[\t\f ]+/g, " ");
        else if (!pre) content = content.replace(/[\t\n\r\f ]+/g, " ");
        if (!content) return;
        if (runs.length && !pre && / $/.test(runs[runs.length - 1].text_run.content)) content = content.replace(/^ +/, "");
        textUnits += content.length;
        if (textUnits > MAX_JSON_BYTES) fail("网页正文超过本次 700 KiB 传输限制，未截断原文。", "IMPORT_TOO_LARGE");
        const previous = runs[runs.length - 1];
        const normalizedStyle = Object.keys(style).length ? style : undefined;
        if (previous && JSON.stringify(previous.text_run.text_element_style) === JSON.stringify(normalizedStyle)) previous.text_run.content += content;
        else runs.push({ text_run: { content, ...(normalizedStyle ? { text_element_style: normalizedStyle } : {}) } });
      }
      function flush(force = false) {
        if (kind !== 14 && !preserveRuns && runs.length) {
          runs[0].text_run.content = runs[0].text_run.content.replace(/^ +/, "");
          runs[runs.length - 1].text_run.content = runs[runs.length - 1].text_run.content.replace(/ +$/, "");
          runs = runs.filter((run) => run.text_run.content);
        }
        if (!runs.length && !force) return;
        // Text/Code blocks accept multiple elements; a long paragraph remains
        // one block. Split runs without imposing an undocumented 10,000-character
        // block limit. The complete snapshot still has the byte limit below.
        // https://open.feishu.cn/document/docs/docs/data-structure/block
        const splitRuns = runs.flatMap(({ text_run: run }) => {
          const split = [];
          for (let offset = 0; offset < run.content.length;) {
            let end = Math.min(offset + 2000, run.content.length);
            // Keep surrogate pairs together; separate API text runs must each
            // contain valid Unicode (emoji often cross a chunk boundary).
            if (end < run.content.length && /[\uD800-\uDBFF]/.test(run.content[end - 1])) end--;
            split.push({ text_run: { ...run, content: run.content.slice(offset, end) } });
            offset = end;
          }
          return split;
        });
        add(kind, { elements: splitRuns.length ? splitRuns : [{ text_run: { content: "" } }], ...(payloadStyle ? { style: payloadStyle } : {}) }, parent);
        runs = [];
        preserveRuns = false;
        emitted = true;
      }
      function inline(node, style = inheritedStyle, depth = 0) {
        if (!visit(node, depth)) return;
        if (node.nodeType === 3) {
          const space = whitespace(node.parentElement);
          append(readText(node), style, space === "pre-line" ? space : /^(pre|pre-wrap|break-spaces)$/.test(space)); return;
        }
        const name = tag(node);
        const nextStyle = styleFor(node, style);
        if (mediaKind(node)) { flush(); convert(node, parent, nextStyle, depth + 1); emitted = true; return; }
        const mentionLabel = scysMentionLabel(node);
        if (mentionLabel) { inline(mentionLabel, nextStyle, depth + 1); return; }
        if (hasClass(node, "docx-file-card")) {
          const card = fileCard(node);
          append(card.name, { ...nextStyle, link: { url: card.url } });
          if (card.extra.length) {
            flush();
            for (const extra of card.extra) convert(extra, parent, nextStyle, depth + 1);
            emitted = true;
          }
          return;
        }
        if (name === "br") { append("\n", nextStyle, "break"); return; }
        if (name === "img") { flush(); addImage(node, parent); emitted = true; return; }
        // Some article renderers wrap a heading's text in several divs. Those
        // wrappers do not change the heading into multiple ordinary paragraphs.
        const headingWrapper = kind >= 3 && kind <= 8 && BLOCK_TAGS.has(name);
        if (isBoundary(node) && !headingWrapper) { flush(); convert(node, parent, nextStyle, depth + 1); emitted = true; return; }
        for (const child of children(node)) inline(child, nextStyle, depth + 1);
      }
      return { append, flush, inline, finish() { flush(keepEmpty && !emitted); } };
    }

    function headingLevel(node) {
      if (/^h[1-6]$/.test(tag(node))) return Number(tag(node)[1]);
      if (attr(node, "role") === "heading") return Math.min(6, Math.max(1, Number(attr(node, "aria-level")) || 1));
      const match = classes(node).join(" ").match(/\b(?:heading|block-h|doc-heading-)([1-6])\b/);
      return match ? Number(match[1]) : 0;
    }

    function scysColumns(node) {
      if (!hasClass(node, "table")) return 0;
      const match = classes(node).join(" ").match(/\btable_(\d+)\b/);
      if (match) return Number(match[1]);
      const grid = attr(node.children?.[0], "style").match(/grid-template-columns\s*:\s*([^;]+)/i)?.[1] || "";
      return Number(grid.match(/repeat\(\s*(\d+)\s*,/i)?.[1]) || (grid ? grid.trim().split(/\s+/).length : 0);
    }

    function isBoundary(node) {
      return BLOCK_TAGS.has(tag(node)) || /^(h[1-6]|ul|ol|li|pre|blockquote|table|hr)$/.test(tag(node))
        || headingLevel(node) || scysColumns(node) || hasClass(node, "bullet_container") || hasClass(node, "block-order");
    }

    function findDescendants(node, predicate, stop) {
      const found = [];
      const walk = (parent, depth = 0) => {
        if (depth > 80) fail("网页正文嵌套过深。", "IMPORT_TOO_LARGE");
        for (const child of children(parent)) {
          if (child.nodeType !== 1 || !visit(child, depth)) continue;
          if (predicate(child)) found.push(child);
          if (!stop?.(child)) walk(child, depth + 1);
        }
      };
      walk(node);
      return found;
    }

    function fileCard(node) {
      const extra = [];
      let label = "", foundLabel = false;
      const labelText = (part, depth) => {
        if (!visit(part, depth)) return "";
        if (part.nodeType === 3) return readText(part);
        if (tag(part) === "img" || mediaKind(part) || hasClass(part, "docx-file-card")) {
          extra.push(part);
          return "";
        }
        return children(part).map(child => labelText(child, depth + 1)).join("");
      };
      const collect = (part, depth = 0) => {
        // Only the known card chrome is decoration. Unexpected body content,
        // including a second filename, must remain after the attachment link.
        if (hasClass(part, "docx-file-card__badge") || hasClass(part, "docx-file-card__meta")
          || tag(part) === "svg" && hasClass(part, "docx-file-card__arrow")) { decorations.add(part); return; }
        if (!visit(part, depth)) return;
        if (hasClass(part, "docx-file-card__info")) {
          for (const child of children(part)) collect(child, depth + 1);
        } else if (hasClass(part, "docx-file-card__name") && !foundLabel) {
          foundLabel = true;
          label = labelText(part, depth + 1);
        } else if (part.nodeType !== 3 || String(part.textContent || "").trim()) extra.push(part);
      };
      for (const child of children(node)) collect(child);
      const name = String(label || attr(node, "download")).trim();
      if (!name) fail("网页文件卡片缺少文件名，未省略附件链接。", "INVALID_CONTENT");
      const href = attr(node, "href").trim();
      if (!href || /^(?:blob|data):/i.test(href)) return { name: `附件：${name}（在原网页下载）`, url: sourcePageLink(node), extra };
      return { name, url: safeUrl(href, sourceUrl), extra };
    }

    function convertListItem(node, parent, ordered, index, style, depth) {
      const itemStyle = { ...paragraphStyle(node), ...(ordered ? { sequence: String(index) } : {}) };
      const item = add(ordered ? 13 : 12, { elements: [{ text_run: { content: "" } }],
        ...(Object.keys(itemStyle).length ? { style: itemStyle } : {}) }, parent, true);
      // The first text paragraph is the item itself; later blocks remain children.
      const before = blocks.length;
      const flow = writer(item, 2, undefined, style);
      for (const child of children(node)) flow.inline(child, style, depth + 1);
      flow.finish();
      const first = blocks[before];
      if (first?.block_type === 2 && item.children[0] === first.block_id) {
        item[FIELDS[item.block_type]].elements = first.text.elements;
        if (first.text.style) item[FIELDS[item.block_type]].style = { ...itemStyle, ...first.text.style };
        item.children.shift();
        blocks.splice(before, 1);
      }
      if (!item.children.length) delete item.children;
    }

    function convertTable(node, parent, style, depth) {
      const count = scysColumns(node);
      let rows;
      if (count) {
        const cells = findDescendants(node, (child) => hasClass(child, "table_cell"), (child) => hasClass(child, "table_cell"));
        if (!cells.length || cells.length % count) fail("网页表格行列不完整，未省略单元格。", "INVALID_CONTENT");
        rows = Array.from({ length: cells.length / count }, (_, i) => cells.slice(i * count, (i + 1) * count));
      } else {
        rows = findDescendants(node, (child) => tag(child) === "tr", (child) => tag(child) === "table")
          .map((row) => children(row).filter((cell) => ["td", "th"].includes(tag(cell)) && !ignored(cell)));
      }
      const columns = rows[0]?.length || 0;
      if (!rows.length || !columns || rows.some((row) => row.length !== columns)) fail("网页表格行列不完整，未改写原表格。", "INVALID_CONTENT");
      if (rows.length > 100 || columns > 9) fail("网页表格超过 100 行或 9 列，当前无法完整保存。", "IMPORT_TOO_LARGE");
      for (const cell of rows.flat()) {
        if (["rowspan", "colspan"].some((name) => attr(cell, name) && Number(attr(cell, name)) !== 1)
          || /(?:grid-(?:row|column)(?:-end)?\s*:[^;]*\bspan\s+[2-9]|grid-(?:row|column)\s*:[^;]*\/)/i.test(attr(cell, "style"))) {
          fail("网页含合并单元格，当前无法完整保留表格布局；未创建不完整文档。");
        }
      }
      // Captions are visible content; preserve them before the table.
      for (const child of children(node)) if (tag(child) === "caption") convert(child, parent, style, depth + 1);
      const table = add(31, { property: { row_size: rows.length, column_size: columns, header_row: rows[0].every((cell) => tag(cell) === "th") } }, parent, true);
      for (const row of rows) for (const cell of row) {
        const cellBlock = add(32, {}, table, true);
        const cellStyle = styleFor(cell, style);
        const flow = writer(cellBlock, 2, paragraphStyle(cell), cellStyle, true);
        for (const child of children(cell)) flow.inline(child, cellStyle, depth + 1);
        flow.finish();
      }
    }

    function convertCallout(node, parent, style, depth) {
      // SCYS exposes Feishu callout semantics directly. Only substitute an
      // icon whose complete DOM is a known emoji; unknown icons stay as text.
      const icons = findDescendants(node, child => hasClass(child, "callout-emoji-container"),
        child => hasClass(child, "callout") || hasClass(child, "callout-emoji-container"));
      const emojiIds = { "💡": "bulb", "✅": "white_check_mark", "📝": "memo", "📌": "pushpin", "❗": "exclamation", "🎁": "gift" };
      const icon = icons.length === 1 ? icons[0] : null;
      const emoji = icon && emojiIds[String(icon.textContent || "").trim()];
      const plainIcon = part => part.nodeType === 3 || (["div", "span"].includes(tag(part)) && children(part).every(plainIcon));
      let callout;
      if (emoji && plainIcon(icon)) {
        const payload = { emoji_id: emoji };
        for (const [field, max] of [["background_color", 15], ["border_color", 7], ["text_color", 7]]) {
          const value = Number(classes(node).join(" ").match(new RegExp(`(?:^|\\s)${field}_(\\d+)(?:\\s|$)`))?.[1]);
          if (value >= 1 && value <= max) payload[field] = value;
        }
        callout = add(19, payload, parent, true);
        decorations.add(icon); // The native emoji_id represents this exact glyph.
      } else {
        // A quote preserves grouping and the source icon, without inserting
        // Feishu's default gift icon for an unsupported/absent source emoji.
        callout = add(34, {}, parent, true);
      }
      const flow = writer(callout, 2, undefined, style, true);
      for (const child of children(node)) flow.inline(child, style, depth + 1);
      flow.finish();
      if (!callout.children.length) add(2, { elements: [{ text_run: { content: "" } }] }, callout);
    }

    function convert(node, parent, inheritedStyle = {}, depth = 0) {
      if (!visit(node, depth)) return;
      if (node.nodeType === 3) {
        const flow = writer(parent, 2, undefined, inheritedStyle);
        const space = whitespace(node.parentElement);
        flow.append(readText(node), inheritedStyle, space === "pre-line" ? space : /^(pre|pre-wrap|break-spaces)$/.test(space)); flow.finish(); return;
      }
      const name = tag(node);
      const style = styleFor(node, inheritedStyle);
      if (isScysSource && hasClass(node, "callout")) { convertCallout(node, parent, style, depth); return; }
      const media = mediaResource(node);
      if (media) {
        const flow = writer(parent, 2);
        flow.append(media.label, { ...style, link: { url: media.url } });
        flow.finish();
        for (const extra of media.extra) convert(extra, parent, style, depth + 1);
        return;
      }
      const mentionLabel = scysMentionLabel(node);
      if (mentionLabel) {
        const flow = writer(parent, 2, undefined, style);
        flow.inline(mentionLabel, style, depth + 1);
        flow.finish(); return;
      }
      if (hasClass(node, "docx-file-card")) {
        const card = fileCard(node);
        const flow = writer(parent, 2);
        flow.append(card.name, { ...style, link: { url: card.url } });
        flow.finish();
        for (const extra of card.extra) convert(extra, parent, style, depth + 1);
        return;
      }
      if (name === "img") { addImage(node, parent); return; }
      if (name === "hr") { add(22, {}, parent); return; }
      if (name === "pre") {
        // Keep code whitespace while still checking embedded resources.
        const readCode = (part, level) => {
          if (!visit(part, level)) return "";
          if (part.nodeType === 3) return readText(part);
          if (tag(part) === "img") fail("代码块内包含图片，当前无法完整保留原布局。");
          if (mediaKind(part)) fail(`代码块内包含${mediaKind(part) === "video" ? "视频" : "音频"}，当前无法完整保留原布局。`);
          if (tag(part) === "br") return "\n";
          return children(part).map((child) => readCode(child, level + 1)).join("");
        };
        const flow = writer(parent, 14, { language: 1 }, {}, true);
        flow.append(children(node).map((child) => readCode(child, depth + 1)).join(""), {}, true); flow.finish(); return;
      }
      if (name === "table" || scysColumns(node)) { convertTable(node, parent, style, depth); return; }
      if (name === "blockquote") {
        const quote = add(34, {}, parent, true);
        const flow = writer(quote, 2, undefined, style, true);
        for (const child of children(node)) flow.inline(child, style, depth + 1);
        flow.finish(); return;
      }
      if (["ul", "ol"].includes(name)) {
        let index = Number(attr(node, "start")) || 1;
        for (const child of children(node)) {
          if (tag(child) === "li") {
            index = Number(attr(child, "value")) || index;
            convertListItem(child, parent, name === "ol", index++, styleFor(child, style), depth + 1);
          } else if (child.nodeType === 1 && !ignored(child)) convert(child, parent, style, depth + 1);
          else if (child.nodeType === 3 && String(child.textContent || "").trim()) fail("网页列表结构异常，未忽略正文。", "INVALID_CONTENT");
        }
        return;
      }
      if (name === "li" || hasClass(node, "bullet_container") || hasClass(node, "block-order")) {
        const list = findDescendants(node, (child) => hasClass(child, "list"), (child) => hasClass(child, "list"))[0] || node;
        const marker = findDescendants(node, (child) => hasClass(child, "order-marker"))[0];
        if (list !== node) {
          const listNodes = new Set([list, ...findDescendants(list, () => true)]);
          for (const label of findDescendants(node, child => !listNodes.has(child) && (
            hasClass(child, "marker") || hasClass(child, "order-marker")
            // SCYS also renders bullets as .bullet > .bullet-dot. The
            // native list block represents this glyph; it is not lost prose.
            || (isScysSource && hasClass(child, "bullet-dot") && hasClass(child.parentElement, "bullet")
              && children(child).every(part => part.nodeType === 3)
              && /^[•·●○◦▪▫‣⁃]$/.test(String(child.textContent || "").trim()))
          ))) decorations.add(label);
        }
        convertListItem(list, parent, hasClass(node, "block-order"), Number.parseInt(marker?.textContent || "1", 10) || 1, style, depth + 1); return;
      }
      const level = headingLevel(node);
      if (placeholderParagraph(node)) {
        if (protectedSpacing(node, parent)) add(2, { elements: [{ text_run: { content: "" } }] }, parent);
        return;
      }
      const flow = writer(parent, level ? level + 2 : 2, paragraphStyle(node), style, name === "p");
      for (const child of children(node)) flow.inline(child, style, depth + 1);
      flow.finish();
    }

    convert(root, blocks[0]);
    verifyCapture();
    if (!blocks[0].children.length) fail("当前网页没有可保存的正文。", "INVALID_CONTENT");
    const result = { title, source_url: sourceUrl, blocks, images };
    const metadata = JSON.stringify(result);
    if (new TextEncoder().encode(metadata).byteLength > MAX_JSON_BYTES) fail("网页正文及内嵌图片超过本次 700 KiB 传输限制，未截断原文。", "IMPORT_TOO_LARGE");
    return result;
  }

  const api = { fromRoot };
  scope.WebFeishuBlocks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
