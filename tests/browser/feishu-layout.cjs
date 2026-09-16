// Real Chromium DOM, computed CSS and the shipped capture/conversion code.
// These fixtures never connect to Feishu or write a remote document.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const sourceUrl = "https://example.com/layout-regression";
const code = "  const answer = 42;\n\n\treturn answer;\n";
const poem = "  春眠不觉晓\n\n处处闻啼鸟  ";
const escape = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textOf = block => Object.values(block).find(value => value?.elements)?.elements
  .map(element => element.text_run?.content || "").join("") || "";
const payloadOf = block => Object.values(block).find(value => value?.elements);

(async () => {
  const browser = await chromium.launch({
    channel: "chromium", headless: process.env.HEADED !== "1",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // The image only supplies a real DOM node; no external asset request is needed.
    await page.route("**/*", route => route.abort());
    await page.setContent(`<!doctype html><style>
      article { color: rgb(31, 35, 41); }
      .orange { color: rgb(255, 165, 0); text-align: center; }
      .red { color: rgb(255, 0, 0); }
      .blue { color: rgb(0, 0, 255); }
      .highlight { background-color: rgb(255, 255, 0); }
      .right { text-align: right; }
      .poem { white-space: pre-wrap; }
    </style><article id="article">
      <p><br></p><p></p>
      <h2 class="orange">1.引流到咸鱼</h2>
      <p><br></p>
      <p>首句<strong>加粗</strong>，<span class="red">红字</span>和<span class="highlight">重点</span>。<br>同段第二行<a class="blue" href="/reference">原文链接</a>。</p>
      <p><br></p><p>第二段保留原文顺序。</p>
      <img src="https://example.com/original.png" width="120" height="80" alt="正文图片">
      <p><br></p><p class="right">图片后的说明。</p>
      <ol start="3"><li><p>步骤三</p><p><br></p><p>步骤内另一段</p></li><li>步骤四</li></ol>
      <table><tbody><tr><td><p><br></p></td><td>表格内容</td></tr></tbody></table>
      <blockquote><p>引用首段</p><p><br></p><p>引用末段</p></blockquote>
      <pre>${escape(code)}</pre>
      <div class="poem"><p>${escape(poem)}</p><p><br></p><p>夜来风雨声<br><br>花落知多少</p></div>
      <p><br></p><p>文章结尾。</p><p></p>
    </article>`);
    await page.evaluate(() => {
      window.module = { exports: {} };
      window.chrome = { runtime: { onMessage: { addListener() {} } } };
    });
    await page.addScriptTag({ path: path.join(root, "shared/web-feishu-blocks.js") });
    await page.addScriptTag({ path: path.join(root, "content-scripts/feishu-exporter.js") });
    const result = await page.evaluate(sourceUrl => {
      const live = document.getElementById("article");
      const clone = module.exports.__test.cloneWebCaptureRoot(live);
      const styles = Object.fromEntries([".orange", ".red", ".highlight", ".right", ".poem"]
        .map(selector => [selector, clone.querySelector(selector).getAttribute("style")]));
      return { snapshot: WebFeishuBlocks.fromRoot(clone, { title: "排版回归", sourceUrl }), styles,
        liveText: live.textContent, cloneText: clone.textContent };
    }, sourceUrl);
    assert.equal(result.cloneText, result.liveText, "capture cloning must not edit source text");
    assert.match(result.styles[".orange"], /color:\s*rgb\(255, 165, 0\)/);
    assert.match(result.styles[".orange"], /text-align:\s*center/);
    assert.match(result.styles[".highlight"], /background-color:\s*rgb\(255, 255, 0\)/);
    assert.match(result.styles[".poem"], /white-space:\s*pre-wrap/);
    const { blocks, images } = result.snapshot;
    const byId = new Map(blocks.map(block => [block.block_id, block]));
    const top = blocks[0].children.map(id => byId.get(id));
    const topBlanks = top.filter(block => block.block_type === 2 && !textOf(block).trim());
    assert.equal(topBlanks.length, 1, "only the protected poetry blank remains in the article flow");
    const poetryBlankPosition = top.indexOf(topBlanks[0]);
    assert.equal(textOf(top[poetryBlankPosition - 1]), poem);
    assert.equal(textOf(top[poetryBlankPosition + 1]), "夜来风雨声\n\n花落知多少");
    assert.equal(top[0].block_type, 4, "the heading remains an H2");
    assert.equal(payloadOf(top[0]).style.align, 2);
    assert.equal(payloadOf(top[0]).elements[0].text_run.text_element_style.text_color, 2);
    const paragraph = blocks.find(block => textOf(block).startsWith("首句"));
    assert.equal(textOf(paragraph), "首句加粗，红字和重点。\n同段第二行原文链接。");
    const runContaining = needle => payloadOf(paragraph).elements.find(element => element.text_run.content.includes(needle)).text_run;
    assert.equal(runContaining("加粗").text_element_style.bold, true);
    assert.equal(runContaining("红字").text_element_style.text_color, 1);
    assert.equal(runContaining("重点").text_element_style.background_color, 3);
    assert.equal(runContaining("原文链接").text_element_style.text_color, 5);
    assert.equal(runContaining("原文链接").text_element_style.link.url, "https://example.com/reference");
    assert.equal(payloadOf(blocks.find(block => textOf(block) === "图片后的说明。")).style.align, 3);
    assert.equal(images.length, 1);
    assert.equal(images[0].url, "https://example.com/original.png");
    const imagePosition = top.findIndex(block => block.block_type === 27);
    assert.equal(textOf(top[imagePosition - 1]), "第二段保留原文顺序。");
    assert.equal(textOf(top[imagePosition + 1]), "图片后的说明。");
    const list = blocks.filter(block => block.block_type === 13);
    assert.deepEqual(list.map(textOf), ["步骤三", "步骤四"]);
    assert.deepEqual(list.map(block => block.ordered.style.sequence), ["3", "4"]);
    assert(list[0].children.some(id => !textOf(byId.get(id)).trim()), "empty paragraphs within a list are protected");
    const table = blocks.find(block => block.block_type === 31);
    assert.equal(table.table.property.row_size, 1);
    assert.equal(table.table.property.column_size, 2);
    assert.equal(table.children.length, 2, "empty table cells must not disappear");
    const emptyCell = byId.get(table.children[0]);
    assert(emptyCell.children.length > 0);
    assert(emptyCell.children.every(id => !textOf(byId.get(id)).trim()));
    const quote = blocks.find(block => block.block_type === 34);
    assert.deepEqual(quote.children.map(id => textOf(byId.get(id)).trim()), ["引用首段", "", "引用末段"]);
    assert.equal(textOf(blocks.find(block => block.block_type === 14)), code);
    assert(blocks.some(block => textOf(block) === poem), "CSS pre-wrap preserves indentation and literal blank lines");
    assert(blocks.some(block => textOf(block) === "夜来风雨声\n\n花落知多少"));
    const expectedText = "1.引流到咸鱼首句加粗，红字和重点。同段第二行原文链接。第二段保留原文顺序。图片后的说明。步骤三步骤内另一段步骤四表格内容引用首段引用末段"
      + code + poem + "夜来风雨声花落知多少文章结尾。";
    const semanticText = value => value.replace(/\s+/g, "");
    assert.equal(semanticText(blocks.map(textOf).join("")), semanticText(expectedText),
      "all non-whitespace source characters retain their order without duplication");
    console.log("PASS: real CSS capture, decorative whitespace removal, text order, image placement, list/table/quote boundaries, exact code/poetry whitespace, colors and alignment");

    const edgeCases = await page.evaluate(sourceUrl => {
      const article = document.createElement("article");
      article.innerHTML = "<p>前段</p><p><br><br></p><p>后段</p>";
      document.body.append(article);
      const repeatedBreaks = WebFeishuBlocks.fromRoot(module.exports.__test.cloneWebCaptureRoot(article), { title: "显式空行", sourceUrl });
      const tableHost = document.createElement("article");
      tableHost.innerHTML = "<table><tbody><tr><td>合法单元格</td></tr></tbody></table>";
      // Construct through DOM APIs: HTML parsing would move malformed table text
      // outside the table, concealing the converter's omitted-content boundary.
      const footer = document.createElement("tfoot");
      footer.textContent = "不可静默丢失的表尾文字";
      tableHost.querySelector("table").append(footer);
      document.body.append(tableHost);
      let omittedContentError = null;
      try {
        WebFeishuBlocks.fromRoot(module.exports.__test.cloneWebCaptureRoot(tableHost), { title: "表尾保真", sourceUrl });
      } catch (error) { omittedContentError = { code: error.code, message: error.message }; }
      return { repeatedBreaks, omittedContentError };
    }, sourceUrl);
    assert.deepEqual(edgeCases.repeatedBreaks.blocks.slice(1).map(textOf), ["前段", "\n\n", "后段"]);
    assert(edgeCases.omittedContentError, "unsupported table content must stop capture rather than disappear");
    assert(["CONTENT_MISMATCH", "UNSUPPORTED_CONTENT"].includes(edgeCases.omittedContentError.code));
    console.log("PASS: explicit multiple breaks retained and omitted table text rejected before remote writes");

    const inheritanceCases = await page.evaluate(sourceUrl => {
      const sourceStyle = document.createElement("style");
      sourceStyle.textContent = ".poem-root { white-space: pre-wrap; }";
      document.head.append(sourceStyle);
      const capture = (html, className = "") => {
        const host = document.createElement("article");
        host.className = className;
        host.innerHTML = html;
        document.body.append(host);
        return WebFeishuBlocks.fromRoot(module.exports.__test.cloneWebCaptureRoot(host), { title: "样式继承回归", sourceUrl });
      };
      return {
        rootPoem: capture("<p>第一节</p><p><br></p><p>第二节</p>", "poem-root"),
        backgrounds: capture('<p><span style="background-color:yellow">外层高亮<span style="background-color:white">白底内层</span><span style="background-color:black">黑底内层</span><span style="background-color:transparent">透明内层</span>末尾高亮</span></p>'),
        list: capture('<ol start="5" style="text-align:right"><li><p style="text-align:center">居中列表内容</p><p style="text-align:right">右对齐子段</p></li></ol>')
      };
    }, sourceUrl);
    assert.deepEqual(inheritanceCases.rootPoem.blocks.slice(1).map(textOf), ["第一节", "", "第二节"],
      "stylesheet pre-wrap on an unknown article root protects poetry stanza spacing");
    const backgroundRuns = payloadOf(inheritanceCases.backgrounds.blocks.find(block => block.block_type === 2)).elements;
    const backgroundAt = needle => backgroundRuns.find(element => element.text_run.content.includes(needle))
      ?.text_run.text_element_style?.background_color;
    assert.equal(backgroundAt("外层高亮"), 3);
    assert.equal(backgroundAt("白底内层"), undefined, "opaque white ends the ancestor's yellow highlight");
    assert.equal(backgroundAt("黑底内层"), undefined, "opaque black must not inherit the ancestor's yellow highlight");
    assert.equal(backgroundAt("透明内层"), 3, "transparent spans retain the visible ancestor background");
    assert.equal(backgroundAt("末尾高亮"), 3);
    assert.equal(inheritanceCases.backgrounds.blocks.slice(1).map(textOf).join(""), "外层高亮白底内层黑底内层透明内层末尾高亮");
    const alignedList = inheritanceCases.list.blocks.find(block => block.block_type === 13);
    assert.equal(textOf(alignedList), "居中列表内容");
    assert.equal(alignedList.ordered.style.sequence, "5");
    assert.equal(alignedList.ordered.style.align, 2, "absorbing the first paragraph preserves its alignment and list numbering");
    assert.equal(payloadOf(inheritanceCases.list.blocks.find(block => textOf(block) === "右对齐子段")).style.align, 3);
    console.log("PASS: root-level poem spacing, opaque/transparent background inheritance and first-list-paragraph alignment");

    const scysLists = await page.evaluate(() => {
      const host = document.createElement("article");
      host.innerHTML = '<div class="bullet_container"><div class="row"><div class="bullet" data-highlight-ignore><div class="bullet-dot">•</div></div><div class="list"><p>列表<strong>重点</strong></p><img src="https://example.com/body.png"></div></div></div><div class="block-order"><span class="order-marker">4.</span><div class="list">第四项</div></div>';
      document.body.append(host);
      const capture = () => WebFeishuBlocks.fromRoot(module.exports.__test.cloneWebCaptureRoot(host),
        { title: "生财真实列表结构回归", sourceUrl: "https://scys.com/articleDetail/xq_topic/regression" });
      const snapshot = capture();
      host.querySelector(".bullet-dot").append("不得遗漏的说明");
      let errorCode;
      try { capture(); } catch (error) { errorCode = error.code; }
      return { snapshot, errorCode };
    });
    assert.deepEqual(scysLists.snapshot.blocks.slice(1).map(textOf).filter(Boolean), ["列表重点", "第四项"]);
    assert.equal(scysLists.snapshot.blocks.filter(block => block.block_type === 12).length, 1);
    assert.equal(scysLists.snapshot.blocks.find(block => block.block_type === 13).ordered.style.sequence, "4");
    assert.equal(scysLists.snapshot.images.length, 1);
    assert.equal(scysLists.errorCode, "CONTENT_MISMATCH", "non-marker content must still trigger coverage protection");
    console.log("PASS: actual SCYS bullet-dot layout passes capture; native lists retain text/images and reject unconverted prose");

    const compact = await page.evaluate(sourceUrl => {
      const quillStyle = document.createElement("style");
      quillStyle.textContent = ".ql-editor { white-space: pre-wrap; }";
      document.head.append(quillStyle);
      const host = document.createElement("article");
      host.className = "ql-editor";
      host.innerHTML = "<h2>大文章</h2>" + Array.from({ length: 236 }, (_, i) => `<p><br></p><p>第${i + 1}段原文。</p>`).join("");
      document.body.append(host);
      const clone = module.exports.__test.cloneWebCaptureRoot(host);
      const snapshot = WebFeishuBlocks.fromRoot(clone, { title: "空白块数量回归", sourceUrl });
      return { sourceParagraphs: host.querySelectorAll("p").length, snapshot };
    }, sourceUrl);
    assert.equal(compact.sourceParagraphs, 472);
    assert.equal(compact.snapshot.blocks.length, 238, "236 decorative paragraphs add zero output blocks");
    assert.equal(compact.snapshot.blocks.filter(block => block.block_type === 2).length, 236);
    assert.deepEqual(compact.snapshot.blocks.filter(block => block.block_type === 2).map(textOf),
      Array.from({ length: 236 }, (_, i) => `第${i + 1}段原文。`));
    assert.deepEqual(errors, []);
    console.log("PASS: 236 decorative empty paragraphs omitted under inherited Quill pre-wrap; all 236 content paragraphs retained (fixture block count, not remote save timing)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
