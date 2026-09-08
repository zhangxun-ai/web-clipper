(function () {
  // Dynamic injection can happen again when the user opens the save page.
  const previousCapture = globalThis.FeishuWebCapture;
  if (previousCapture?.version === 3) return;
  const MESSAGE_GET_PAGE_INFO = "feishu-export:get-page-info";
  const MESSAGE_EXPORT_DOCUMENT = "feishu-export:export-document";
  const MESSAGE_GET_SCYS_COURSE_OUTLINE = "feishu-export:get-scys-course-outline";
  const MESSAGE_GET_WECHAT_HISTORY_SEED = "feishu-export:get-wechat-history-seed";
  const MESSAGE_GET_WECHAT_MP_LOGIN_STATUS = "feishu-export:get-wechat-mp-login-status";
  const MESSAGE_RESOLVE_WECHAT_MP_HISTORY = "feishu-export:resolve-wechat-mp-history";
  const MESSAGE_FETCH_ASSET = "exporter:fetch-asset";
  const WECHAT_MP_LOGIN_URL = "https://mp.weixin.qq.com/";
  const stripWechatUiNoiseFromMarkdown = globalThis.WechatMarkdownCleanup?.stripWechatUiNoiseFromMarkdown || ((value) => value);
  const scysCourseUtils = globalThis.ScysCourseUtils || {};
  const webMarkdownUtils = globalThis.WebMarkdownUtils || {};
  const isScysCourseParsedUrl = (parsed) => scysCourseUtils.isScysCourseParsedUrl?.(parsed) || false;
  const extractScysCourseApiTitle = (payload) => scysCourseUtils.extractScysCourseApiTitle?.(payload) || "";
  const flattenScysCourseApiChapters = (payload) => scysCourseUtils.flattenScysCourseApiChapters?.(payload) || [];
  const normalizeScysCourseEntries = (entries, baseUrl) => scysCourseUtils.normalizeScysCourseEntries?.(entries, baseUrl) || [];
  const joinInlineFragments = (fragments) => webMarkdownUtils.joinInlineFragments?.(fragments) || fragments.filter(Boolean).join("");
  const formatReadableMarkdown = (markdown, options) => webMarkdownUtils.formatReadableMarkdown?.(markdown, options) || markdown;
  const WECHAT_MP_SEARCH_COUNT = 10;
  const WECHAT_MP_ARTICLE_PAGE_SIZE = 5;
  const WECHAT_MP_CANDIDATE_LIMIT = 6;
  const WECHAT_MP_SEED_SCAN_LIMIT = 80;
  const WECHAT_MP_HISTORY_SCAN_LIMIT = 500;
  const WECHAT_MP_PAGE_DELAY_MS = 250;
  const FEISHU_API_TIMEOUT_MS = 30000;
  const FEISHU_IMAGE_FETCH_TIMEOUT_MS = 5000;
  const GOOGLE_DOCS_EXPORT_TIMEOUT_MS = 120000;
  let googleDocsTrustedHtmlPolicy = null;
  const TYPE_MAP = {
    22: "docx",
    2: "docs",
    3: "sheets",
    8: "base",
    12: "file"
  };
  const STYLE_WHITELIST = [
    "display",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "font",
    "font-size",
    "font-weight",
    "font-style",
    "font-family",
    "line-height",
    "letter-spacing",
    "color",
    "background",
    "background-color",
    "text-align",
    "text-decoration",
    "text-indent",
    "white-space",
    "word-break",
    "overflow-wrap",
    "list-style",
    "list-style-type",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-radius",
    "box-sizing",
    "width",
    "height",
    "max-width",
    "min-width",
    "vertical-align",
    "gap",
    "grid-template-columns",
    "justify-content",
    "align-items"
  ];
  const ATTRIBUTE_WHITELIST = new Set([
    "href",
    "src",
    "alt",
    "colspan",
    "rowspan"
  ]);
  const INVISIBLE_TEXT_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
  const SCYS_LOAD_MORE_MARKERS = [
    "向上滚动加载更多内容",
    "继续滚动加载更多内容",
    "加载中..."
  ];
  const EXPORT_SKIP_SELECTOR = [
    ".catalogue-container",
    ".catalogue",
    ".catalogue__main",
    ".catalogue__main-wrapper",
    ".catalogue__scroller",
    ".doc-cover-toolbar",
    "#docCommentContainer",
    ".docx-comment-numbers",
    ".docx-comment__first-comment-btn",
    "#ai-suggestion-container",
    ".rangecode-bomb-container-bottom",
    "iframe",
    "script",
    "style",
    "noscript"
  ].join(",");
  const WECHAT_REMOVE_SELECTOR = [
    "script",
    "style",
    "noscript",
    ".js_mp_wording_wrp",
    ".js_ad_link",
    ".js_product_container",
    ".js_product_loop_content",
    ".js_minipro_dialog_container",
    ".weapp_display_element",
    ".wx_profile_card_inner",
    ".wx_profile_card",
    ".original_area_primary",
    ".original_primary_card_tips",
    ".js_reward_area",
    ".reward_area",
    ".reward_qrcode_area",
    ".js_like_container",
    ".js_praise_area",
    ".rich_media_area_extra",
    ".reward_wrapper",
    ".discuss_container",
    ".js_comment_area",
    ".js_tags_area",
    ".js_unread_area",
    ".js_related_article",
    ".js_recommend_container",
    ".mp_profile_iframe_wrp",
    ".js_img_loading"
  ].join(",");
  const GENERIC_REMOVE_SELECTOR = [
    "script",
    "style",
    "noscript",
    "header",
    "footer",
    "nav",
    "aside",
    "form",
    "dialog",
    "button",
    "input",
    "textarea",
    "select",
    "label",
    "canvas",
    "iframe",
    "svg",
    "template",
    ".toolbar",
    ".sidebar",
    ".sidenav",
    ".catalog",
    ".toc",
    ".breadcrumb",
    ".breadcrumbs",
    ".share",
    ".social",
    ".related",
    ".recommend",
    ".comments",
    ".comment",
    ".advertisement",
    ".advert",
    ".ads",
    ".popup",
    ".modal",
    ".mask"
  ].join(",");

  // Upgrade capture in already-open tabs without registering a second export
  // listener. The export protocol is unchanged; clipping reads the global API.
  if (!previousCapture) chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || ![
      MESSAGE_GET_PAGE_INFO,
      MESSAGE_EXPORT_DOCUMENT,
      MESSAGE_GET_SCYS_COURSE_OUTLINE,
      MESSAGE_GET_WECHAT_HISTORY_SEED,
      MESSAGE_GET_WECHAT_MP_LOGIN_STATUS,
      MESSAGE_RESOLVE_WECHAT_MP_HISTORY
    ].includes(message.type)) {
      return false;
    }

    handleMessage(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "处理失败" }));

    return true;
  });

  globalThis.FeishuWebCapture = { version: 3, snapshot: captureWebSnapshot };

  async function captureWebSnapshot() {
    if (!globalThis.WebFeishuBlocks?.fromRoot) throw new Error("网页剪存组件未加载，请刷新扩展和原网页后重试。");
    const sourceUrl = location.href;
    let liveRoot;
    let meta;
    if (isGoogleDocsPage()) {
      meta = getGoogleDocsMeta();
      const exported = parseGoogleDocsExportHtml(await fetchGoogleDocsExportHtml(buildGoogleDocsExportUrl(sourceUrl)));
      liveRoot = exported.querySelector("body.doc-content, .doc-content") || exported.body;
      normalizeGoogleDocsExportRoot(liveRoot);
    } else {
      liveRoot = await waitForWebCaptureRoot(sourceUrl);
      meta = isWechatArticlePage() ? getWechatArticleMeta() : getGenericWebMeta();
    }
    if (!liveRoot || !String(liveRoot.textContent || "").trim()) throw new Error("未读取到文章正文，请先在原网页打开完整内容。");
    const root = cloneWebCaptureRoot(liveRoot);
    if (location.href !== sourceUrl) throw new Error("原网页已切换，请从要保存的网页重新打开插件。");
    return globalThis.WebFeishuBlocks.fromRoot(root, { title: meta.title, sourceUrl });
  }

  async function waitForWebCaptureRoot(sourceUrl, timeoutMs = 15000) {
    const isScysArticle = /(^|\.)scys\.com$/i.test(location.hostname) && /^\/articleDetail\//.test(location.pathname);
    let priorRoot, priorSignature = "", stableSince = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (location.href !== sourceUrl) throw Object.assign(new Error("原网页已切换，请从要保存的文章重新打开插件。"), { code: "SOURCE_CHANGED" });
      const root = isWechatArticlePage() ? document.querySelector("#js_content") : isScysArticle
        ? document.querySelector("main .feishu-doc-content") || document.querySelector("main .content-container")
        : getGenericExportRoot();
      const content = String(root?.textContent || "").trim();
      const loading = !content || /^(?:正在加载|加载中|请稍候|请先登录|登录后查看)/.test(content)
        || Boolean(root?.matches?.('[aria-busy="true"], [role="progressbar"]'))
        || Boolean(root?.querySelector('[aria-busy="true"], [role="progressbar"]'));
      if (root && !loading) {
        const images = Array.from(root.querySelectorAll("img")).map(node => node.getAttribute("data-src") || node.currentSrc || node.getAttribute("src") || "").join("\n");
        const signature = content + "\u0000" + images;
        if (root === priorRoot && signature === priorSignature) {
          if (Date.now() - stableSince >= 750) return root;
        } else { priorRoot = root; priorSignature = signature; stableSince = Date.now(); }
      } else { priorRoot = null; priorSignature = ""; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Object.assign(new Error("文章正文尚未加载完成，请在原网页确认能看到完整内容，再继续当前任务。"), { code: "PAGE_NOT_READY" });
  }

  function cloneWebCaptureRoot(liveRoot) {
    const originals = [liveRoot, ...liveRoot.querySelectorAll("*")];
    if (originals.length > 100000) throw new Error("网页正文结构过大，请缩小保存范围。");
    const clone = liveRoot.cloneNode(true);
    const copies = [clone, ...clone.querySelectorAll("*")];
    // Preserve visible inline emphasis before detaching the article from its CSS.
    originals.forEach((original, index) => {
      const copy = copies[index];
      const style = original.ownerDocument?.defaultView?.getComputedStyle(original);
      if (style && copy.style) {
        for (const key of ["fontWeight", "fontStyle", "textDecorationLine", "whiteSpace"]) {
          if (style[key]) copy.style[key] = style[key];
        }
        if (style.display === "none" || style.visibility === "hidden") copy.hidden = true;
      }
      if (original.tagName?.toLowerCase() === "img") {
        const url = original.getAttribute("data-original") || original.getAttribute("data-actualsrc") || original.getAttribute("data-src") || original.currentSrc || original.getAttribute("src");
        if (url) copy.setAttribute("src", url);
        if (original.naturalWidth) copy.setAttribute("width", original.naturalWidth);
        if (original.naturalHeight) copy.setAttribute("height", original.naturalHeight);
      }
      // cloneNode drops currentSrc. Keep the resource selected by the browser
      // instead of choosing an unsupported first <source> from a media player.
      if (["video", "audio"].includes(original.tagName?.toLowerCase()) && original.currentSrc) {
        copy.setAttribute("src", original.currentSrc);
      }
    });
    for (const node of clone.querySelectorAll("script, style, noscript, template, nav, form, dialog, .block-code-header")) node.remove();
    return clone;
  }

  async function handleMessage(message) {
    if (message.type === MESSAGE_GET_PAGE_INFO) {
      return getPageInfo();
    }

    if (message.type === MESSAGE_EXPORT_DOCUMENT) {
      return exportDocument(message.format, message.options || {});
    }

    if (message.type === MESSAGE_GET_SCYS_COURSE_OUTLINE) {
      return getScysCourseOutline();
    }

    if (message.type === MESSAGE_GET_WECHAT_HISTORY_SEED) {
      return getWechatHistorySeed();
    }

    if (message.type === MESSAGE_GET_WECHAT_MP_LOGIN_STATUS) {
      return getWechatMpLoginStatus();
    }

    if (message.type === MESSAGE_RESOLVE_WECHAT_MP_HISTORY) {
      return resolveWechatMpHistory(message.startDate, message.endDate);
    }

    throw new Error("不支持的消息类型");
  }

  async function getPageInfo() {
    if (isFeishuPage()) {
      const meta = await getDocumentMeta({ resolveWiki: false });

      return {
        title: meta.title,
        docType: meta.pageType,
        supports: ["markdown", "json"]
      };
    }

    if (isWechatArticlePage()) {
      const meta = getWechatArticleMeta();

      return {
        title: meta.title,
        docType: meta.pageType,
        supports: ["markdown", "json"]
      };
    }

    if (isWechatMpBackendPage()) {
      return {
        title: "公众号后台",
        docType: "公众号后台",
        supports: []
      };
    }

    if (isGoogleDocsPage()) {
      const meta = getGoogleDocsMeta();

      return {
        title: meta.title,
        docType: meta.pageType,
        supports: ["markdown", "json"]
      };
    }

    if (isScysCoursePage()) {
      const meta = getScysCourseChapterMeta();

      return {
        title: meta.title,
        docType: meta.pageType,
        supports: ["markdown", "json"]
      };
    }

    if (isGenericWebPage()) {
      const meta = getGenericWebMeta();

      return {
        title: meta.title,
        docType: meta.pageType,
        supports: ["markdown", "json"]
      };
    }

    throw new Error("当前页面不是受支持的导出页面");
  }

  async function exportDocument(format, options) {
    if (!["markdown", "json"].includes(format)) {
      throw new Error("不支持的导出格式");
    }

    if (isFeishuPage()) {
      return exportFeishuDocument(format, options);
    }

    if (isWechatArticlePage()) {
      return exportWechatDocument(format, options);
    }

    if (isGoogleDocsPage()) {
      return exportGoogleDocsDocument(format, options);
    }

    if (isScysCoursePage()) {
      return exportScysCourseDocument(format, options);
    }

    if (isGenericWebPage()) {
      return exportGenericWebDocument(format, options);
    }

    throw new Error("当前页面不是受支持的导出页面");
  }

  async function getScysCourseOutline() {
    if (!isScysCoursePage()) {
      throw new Error("当前页面不是生财课程章节页");
    }

    const sidebarEntries = extractScysCourseEntriesFromSidebar();
    const structuredEntries = sidebarEntries.length > 0 ? [] : extractScysCourseEntriesFromStructuredState();
    let fallbackEntries = sidebarEntries.length > 0
      ? sidebarEntries
      : structuredEntries.length > 0
        ? structuredEntries
        : extractScysCourseEntriesFromDom();
    let apiPayload = null;
    if (fallbackEntries.length === 0) {
      apiPayload = await fetchScysCourseDetailPayload();
      fallbackEntries = flattenScysCourseApiChapters(apiPayload);
    }
    const chapters = normalizeScysCourseEntries(fallbackEntries, location.href);

    if (chapters.length === 0) {
      throw new Error("未识别到当前专栏目录");
    }

    return {
      courseTitle: await getScysCourseOutlineTitle(apiPayload),
      courseUrl: location.href,
      chapters
    };
  }

  async function exportScysCourseDocument(format, options) {
    await waitForScysCourseChapterReady({ chapterTitle: options.chapterTitle });
    const meta = getScysCourseChapterMeta(options);
    const liveRoot = getScysCourseExportRoot(options);
    const rawHtml = liveRoot.innerHTML;
    const clonedRoot = liveRoot.cloneNode(true);

    sanitizeScysCourseArticle(clonedRoot, { includeImages: options.includeImages !== false });
    let markdownBody = cleanupMarkdown(convertBlock(clonedRoot, 0));
    if (options.includeImages === false) {
      markdownBody = stripMarkdownImages(markdownBody);
    }
    markdownBody = stripScysCourseNoiseFromMarkdown(markdownBody);

    if (!markdownBody) {
      throw new Error("未提取到课程正文");
    }

    if (containsScysCourseNoise(markdownBody)) {
      throw new Error("章节正文仍包含页面加载噪音");
    }

    if (format === "markdown") {
      return {
        filename: buildFilename(meta.title, "md"),
        mimeType: "text/markdown;charset=utf-8",
        content: buildMarkdownDocument(meta, markdownBody)
      };
    }

    return {
      filename: buildFilename(meta.title, "json"),
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify({
        meta: {
          title: meta.title,
          pageType: meta.pageType,
          sourceUrl: location.href,
          exportedAt: new Date().toISOString()
        },
        articleHtml: rawHtml,
        cleanedHtml: clonedRoot.innerHTML
      }, null, 2)
    };
  }

  async function exportFeishuDocument(format, options) {
    const meta = await getDocumentMeta({ resolveWiki: true });

    if (format === "markdown") {
      const clientVars = await fetchClientVars(meta.exportToken, meta.jssdkSession);
      const assets = [];
      let markdownBody = await convertClientVarsToMarkdown(meta, clientVars, {
        ...options,
        assets
      });
      markdownBody = maybeReplaceFeishuMarkdownWithDom(markdownBody);
      if (options.includeImages === false) {
        markdownBody = stripMarkdownImages(markdownBody);
      }
      const markdown = buildMarkdownDocument(meta, markdownBody);

      return {
        filename: buildFilename(meta.title, "md"),
        mimeType: "text/markdown;charset=utf-8",
        content: markdown,
        assets
      };
    }

    const clientVars = await fetchClientVars(meta.exportToken, meta.jssdkSession);
    const payload = {
      meta: {
        title: meta.title,
        pageType: meta.pageType,
        exportType: meta.exportType,
        sourceUrl: location.href,
        exportedAt: new Date().toISOString()
      },
      clientVars
    };

    return {
      filename: buildFilename(meta.title, "json"),
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify(payload, null, 2)
    };
  }

  function maybeReplaceFeishuMarkdownWithDom(clientVarsMarkdown) {
    if (!hasVisibleFeishuTable()) {
      return clientVarsMarkdown;
    }

    const domMarkdown = extractDocumentMarkdown();
    if (!domMarkdown) {
      return clientVarsMarkdown;
    }

    const structuredHasTable = containsMarkdownTable(clientVarsMarkdown);
    const domHasTable = containsMarkdownTable(domMarkdown);

    if (!structuredHasTable && domHasTable) {
      return domMarkdown;
    }

    return clientVarsMarkdown;
  }

  function hasVisibleFeishuTable() {
    try {
      const root = findExportRoot();
      return Boolean(root?.querySelector?.("table"));
    } catch (error) {
      return false;
    }
  }

  function containsMarkdownTable(markdown) {
    const lines = String(markdown || "").split("\n");
    for (let index = 0; index < lines.length - 1; index += 1) {
      const current = lines[index].trim();
      const next = lines[index + 1].trim();
      if (!current.startsWith("|") || !current.endsWith("|")) {
        continue;
      }
      if (/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(next)) {
        return true;
      }
    }
    return false;
  }

  async function exportWechatDocument(format, options) {
    const meta = getWechatArticleMeta();
    const liveRoot = getWechatArticleRoot();
    const rawHtml = liveRoot.innerHTML;

    if (format === "markdown") {
      const clonedRoot = liveRoot.cloneNode(true);
      await sanitizeWechatArticle(clonedRoot, { includeImages: options.includeImages !== false });
      let markdownBody = cleanupMarkdown(convertBlock(clonedRoot, 0));
      if (options.includeImages === false) {
        markdownBody = stripMarkdownImages(markdownBody);
      }
      markdownBody = stripWechatUiNoiseFromMarkdown(markdownBody);

      if (!markdownBody) {
        throw new Error("未提取到公众号正文");
      }

      return {
        filename: buildFilename(meta.title, "md"),
        mimeType: "text/markdown;charset=utf-8",
        content: buildMarkdownDocument(meta, markdownBody)
      };
    }

    const clonedRoot = liveRoot.cloneNode(true);
    await sanitizeWechatArticle(clonedRoot, { includeImages: false });

    const payload = {
      meta: {
        title: meta.title,
        pageType: meta.pageType,
        sourceUrl: location.href,
        author: meta.author || "",
        publishTime: meta.publishTime || "",
        exportedAt: new Date().toISOString()
      },
      articleHtml: rawHtml,
      cleanedHtml: clonedRoot.innerHTML
    };

    return {
      filename: buildFilename(meta.title, "json"),
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify(payload, null, 2)
    };
  }

  function isFeishuPage() {
    return /(^|\.)((feishu\.cn)|(larksuite\.com)|(larkoffice\.com))$/.test(location.hostname)
      && /^\/(docx|wiki)\//.test(location.pathname);
  }

  function isWechatArticlePage() {
    return location.hostname === "mp.weixin.qq.com" && /^\/s(?:$|\/)/.test(location.pathname);
  }

  function isWechatMpBackendPage() {
    return location.hostname === "mp.weixin.qq.com" && /^\/cgi-bin\//.test(location.pathname);
  }

  function isGoogleDocsPage() {
    return location.hostname === "docs.google.com"
      && /^\/document\/d\/[^/]+(?:\/|$)/.test(location.pathname);
  }

  function isGenericWebPage() {
    return /^https?:$/.test(location.protocol)
      && !isFeishuPage()
      && !isWechatArticlePage()
      && !isWechatMpBackendPage()
      && !isGoogleDocsPage();
  }

  function isScysCoursePage() {
    try {
      return isScysCourseParsedUrl(new URL(location.href));
    } catch (error) {
      return false;
    }
  }

  function getScysCourseTitle() {
    return normalizeGenericTitle(
      document.querySelector('meta[property="og:title"]')?.getAttribute("content")
      || document.querySelector('meta[name="twitter:title"]')?.getAttribute("content")
      || extractVisibleTitle()
      || document.title
    );
  }

  function getScysCourseChapterMeta(options = {}) {
    const chapterId = getCurrentScysChapterId();
    const title = cleanupInline(
      getCurrentScysChapterHeading()?.textContent
      || findScysCourseHeadingByTitle(options.chapterTitle)?.textContent
      || document.getElementById(`sidebar-level3-${chapterId}`)?.textContent
      || options.chapterTitle
      || extractVisibleTitle()
      || document.title
    ) || getScysCourseTitle() || "未命名章节";

    return {
      pageType: "生财课程章节",
      exportType: "scys-course",
      title,
      author: "",
      publishTime: ""
    };
  }

  function getCurrentScysChapterId() {
    try {
      const chapterId = new URL(location.href).searchParams.get("chapterId") || "";
      return /^\d+$/.test(chapterId) ? chapterId : "";
    } catch (error) {
      return "";
    }
  }

  function getCurrentScysChapterHeading() {
    const chapterId = getCurrentScysChapterId();
    if (!chapterId) {
      return null;
    }

    return document.getElementById(`chapter-title-${chapterId}`)
      || Array.from(document.querySelectorAll(`[data-chapter-id="${chapterId}"]`)).find((node) => {
        const tagName = node.tagName?.toLowerCase();
        return /^h[1-6]$/.test(tagName || "") || node.getAttribute?.("role") === "heading";
      })
      || null;
  }

  function getScysCourseExportRoot(options = {}) {
    const heading = getCurrentScysChapterHeading() || findScysCourseHeadingByTitle(options.chapterTitle);
    if (!heading) {
      const genericRoot = getGenericExportRoot();
      if (genericRoot && genericRoot !== document.body) {
        return genericRoot;
      }
      throw new Error("未定位到当前章节标题");
    }

    const section = heading.closest(".level3-section") || heading.parentElement;
    if (!section) {
      throw new Error("未定位到当前章节容器");
    }

    return section.querySelector(".document-container") || section.querySelector(".feishu-doc-content") || section;
  }

  function findScysCourseHeadingByTitle(title) {
    const expected = cleanupInline(title);
    if (!expected) {
      return null;
    }

    const candidates = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading'], [class*='title']"));
    return candidates.find((node) => {
      if (!isVisible(node) || shouldSkipGenericElement(node) || node.closest("aside, nav, header, footer")) {
        return false;
      }
      const text = cleanupInline(node.textContent || "");
      return text === expected || text.includes(expected) || expected.includes(text);
    }) || null;
  }

  function extractScysCourseEntriesFromSidebar() {
    const sidebarRoot = getScysSidebarRoot();
    if (!sidebarRoot) {
      return [];
    }

    const orderedNodes = Array.from(sidebarRoot.querySelectorAll('[id^="sidebar-level2-"], [id^="sidebar-level3-"]'));
    if (orderedNodes.length > 0) {
      const entries = [];
      let currentSectionTitle = "";
      let currentSectionId = "";
      let currentSectionOrder = 0;

      for (const node of orderedNodes) {
        const nodeId = String(node.id || "");
        const title = cleanupInline(node.getAttribute("title") || node.textContent || "");
        if (!title) {
          continue;
        }

        if (nodeId.startsWith("sidebar-level2-")) {
          currentSectionTitle = title;
          currentSectionId = getScysChapterIdFromNode(node);
          currentSectionOrder += 1;
          continue;
        }

        if (!nodeId.startsWith("sidebar-level3-")) {
          continue;
        }

        entries.push({
          chapterId: getScysChapterIdFromNode(node),
          title,
          sectionTitle: currentSectionTitle,
          sectionId: currentSectionId,
          sectionOrder: currentSectionOrder
        });
      }

      if (entries.length > 0) {
        return entries;
      }
    }

    return Array.from(sidebarRoot.querySelectorAll('a[href*="chapterId="]')).map((node) => ({
      chapterId: getScysChapterIdFromNode(node),
      title: cleanupInline(node.getAttribute("title") || node.textContent || "")
    }));
  }

  function getScysSidebarRoot() {
    return document.querySelector(".course-sidebar")
      || document.querySelector("aside.sidebar")
      || document.querySelector("aside");
  }

  function getScysChapterIdFromNode(node) {
    const nodeId = String(node?.id || "");
    const nodeIdMatch = nodeId.match(/sidebar-level3-(\d+)/);
    if (nodeIdMatch) {
      return nodeIdMatch[1];
    }

    const dataChapterId = String(node?.getAttribute?.("data-chapter-id") || "").trim();
    if (/^\d+$/.test(dataChapterId)) {
      return dataChapterId;
    }

    const href = node?.getAttribute?.("href");
    if (!href) {
      return "";
    }

    try {
      return new URL(href, location.href).searchParams.get("chapterId") || "";
    } catch (error) {
      return "";
    }
  }

  function extractScysCourseEntriesFromStructuredState() {
    const roots = [
      globalThis.__NUXT__,
      globalThis.__INITIAL_STATE__,
      globalThis.__NEXT_DATA__,
      globalThis.__PINIA__
    ].filter(Boolean);
    const entries = [];
    const seen = new WeakSet();

    for (const root of roots) {
      collectScysEntriesFromValue(root, entries, seen, 0);
      if (entries.length >= 200) {
        break;
      }
    }

    return entries;
  }

  function collectScysEntriesFromValue(value, entries, seen, depth) {
    if (!value || depth > 5 || entries.length >= 200) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectScysEntriesFromValue(item, entries, seen, depth + 1);
        if (entries.length >= 200) {
          return;
        }
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    const explicitChapterId = value.chapterId || value.chapter_id || value.chapterID;
    const explicitTitle = value.title || value.name || value.chapterTitle;
    if (explicitChapterId && explicitTitle) {
      entries.push({
        chapterId: explicitChapterId,
        title: explicitTitle
      });
    }

    const urlCandidate = typeof value.url === "string"
      ? value.url
      : typeof value.href === "string"
        ? value.href
        : "";
    if (urlCandidate) {
      try {
        const parsed = new URL(urlCandidate, location.href);
        if (parsed.pathname === location.pathname && parsed.searchParams.has("chapterId")) {
          entries.push({
            chapterId: parsed.searchParams.get("chapterId"),
            title: explicitTitle || value.label || value.text || ""
          });
        }
      } catch (error) {
        // ignore malformed state urls
      }
    }

    for (const child of Object.values(value)) {
      collectScysEntriesFromValue(child, entries, seen, depth + 1);
      if (entries.length >= 200) {
        return;
      }
    }
  }

  function extractScysCourseEntriesFromDom() {
    const entries = [];
    const anchorNodes = Array.from(document.querySelectorAll('a[href*="chapterId="]'));

    for (const anchor of anchorNodes) {
      if (!isVisible(anchor)) {
        continue;
      }

      try {
        const parsed = new URL(anchor.getAttribute("href"), location.href);
        if (parsed.pathname !== location.pathname || !parsed.searchParams.has("chapterId")) {
          continue;
        }

        entries.push({
          chapterId: parsed.searchParams.get("chapterId"),
          title: cleanupInline(anchor.textContent || anchor.getAttribute("title") || "")
        });
      } catch (error) {
        // ignore malformed href values
      }
    }

    if (entries.length > 0) {
      return entries;
    }

    const chapterNodes = Array.from(document.querySelectorAll("[data-chapter-id]"));
    for (const node of chapterNodes) {
      if (!isVisible(node)) {
        continue;
      }

      entries.push({
        chapterId: node.getAttribute("data-chapter-id"),
        title: cleanupInline(node.textContent || node.getAttribute("title") || "")
      });
    }

    return entries;
  }

  async function fetchScysCourseEntriesFromApi() {
    return flattenScysCourseApiChapters(await fetchScysCourseDetailPayload());
  }

  async function fetchScysCourseDetailPayload() {
    const courseId = getCurrentScysCourseId();
    if (!courseId) {
      return null;
    }

    const headers = {};
    const token = String(localStorage.getItem("__user_token.v3") || "").trim();
    if (token) {
      headers["x-token"] = token;
    }

    const response = await fetch(`/search/course/getCourseDetail?course_id=${encodeURIComponent(courseId)}`, {
      credentials: "include",
      headers
    });
    if (!response.ok) {
      throw new Error(`生财课程目录接口请求失败：${response.status}`);
    }

    return response.json();
  }

  async function getScysCourseOutlineTitle(apiPayload) {
    const apiTitle = extractScysCourseApiTitle(apiPayload);
    if (apiTitle) {
      return apiTitle;
    }

    try {
      const payload = await fetchScysCourseDetailPayload();
      return extractScysCourseApiTitle(payload) || getScysCourseTitle();
    } catch (error) {
      return getScysCourseTitle();
    }
  }

  function getCurrentScysCourseId() {
    const pathname = location.pathname || "";
    const detailMatch = pathname.match(/^\/course\/detail\/(\d+)/);
    if (detailMatch) {
      return detailMatch[1];
    }

    const deepseaMatch = pathname.match(/^\/deepsea\/\d+\/course\/(\d+)/);
    return deepseaMatch ? deepseaMatch[1] : "";
  }

  function sanitizeScysCourseArticle(root, options) {
    sanitizeGenericArticle(root, options);

    for (const node of Array.from(root.querySelectorAll("*"))) {
      const text = cleanupInline(node.textContent || "");
      if (SCYS_LOAD_MORE_MARKERS.includes(text)) {
        node.remove();
      }
    }

    cleanupEmptyGenericNodes(root);
  }

  function stripScysCourseNoiseFromMarkdown(value) {
    const lines = String(value || "").split(/\r?\n/);
    return cleanupMarkdown(
      lines.filter((line) => !SCYS_LOAD_MORE_MARKERS.includes(cleanupInline(line || ""))).join("\n")
    );
  }

  function containsScysCourseNoise(value) {
    return SCYS_LOAD_MORE_MARKERS.some((marker) => String(value || "").includes(marker));
  }

  async function waitForScysCourseChapterReady(options = {}, timeoutMs = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      let root = null;
      try {
        root = getScysCourseExportRoot(options);
      } catch (error) {
        root = null;
      }
      const text = cleanupInline(root?.innerText || "");
      const pageText = cleanupInline(`${text} ${extractVisibleTitle() || ""} ${document.title || ""}`);
      if (root && text.length > 20 && isExpectedScysChapterText(pageText, options.chapterTitle) && !containsScysCourseNoise(text)) {
        return;
      }
      await sleep(250);
    }

    throw new Error("未定位到当前章节标题");
  }

  function isExpectedScysChapterText(text, title) {
    const expected = cleanupInline(title);
    return !expected || text.includes(expected);
  }

  async function exportGoogleDocsDocument(format, options) {
    const meta = getGoogleDocsMeta();
    const exportUrl = buildGoogleDocsExportUrl(location.href);
    const exportedHtml = await fetchGoogleDocsExportHtml(exportUrl);
    let exportedDocument;
    try {
      exportedDocument = parseGoogleDocsExportHtml(exportedHtml);
    } catch (error) {
      return exportGoogleDocsPlainTextDocument(format, meta, error);
    }

    const liveRoot = exportedDocument.querySelector("body.doc-content, .doc-content") || exportedDocument.body;

    if (!liveRoot || !cleanupInline(liveRoot.textContent || "")) {
      return exportGoogleDocsPlainTextDocument(
        format,
        meta,
        new Error("Google 文档 HTML 导出结果没有正文")
      );
    }

    try {
      const rawHtml = liveRoot.innerHTML || "";
      const clonedRoot = liveRoot.cloneNode(true);
      normalizeGoogleDocsExportRoot(clonedRoot);
      sanitizeGenericArticle(clonedRoot, { includeImages: options.includeImages !== false });
      let markdownBody = cleanupMarkdown(
        Array.from(clonedRoot.childNodes)
          .map((child) => convertBlock(child, 0))
          .filter(Boolean)
          .join("\n\n")
      );

      if (options.includeImages === false) {
        markdownBody = stripMarkdownImages(markdownBody);
      }

      if (!markdownBody) {
        throw new Error("未提取到 Google 文档正文");
      }

      if (format === "markdown") {
        return {
          filename: buildFilename(meta.title, "md"),
          mimeType: "text/markdown;charset=utf-8",
          content: buildMarkdownDocument(meta, markdownBody)
        };
      }

      return {
        filename: buildFilename(meta.title, "json"),
        mimeType: "application/json;charset=utf-8",
        content: JSON.stringify({
          meta: {
            title: meta.title,
            pageType: meta.pageType,
            sourceUrl: location.href,
            exportedAt: new Date().toISOString()
          },
          articleHtml: rawHtml,
          cleanedHtml: clonedRoot.innerHTML
        }, null, 2)
      };
    } catch (error) {
      return exportGoogleDocsPlainTextDocument(format, meta, error);
    }
  }

  function parseGoogleDocsExportHtml(html) {
    if (typeof DOMParser !== "function") {
      throw new Error("当前浏览器不支持 HTML 解析");
    }

    let parseInput = String(html || "");
    const trustedTypesApi = globalThis.trustedTypes;
    if (trustedTypesApi?.createPolicy) {
      if (!googleDocsTrustedHtmlPolicy) {
        // The value comes from Google's native export endpoint and is parsed in a detached document.
        // It is never assigned to the live Google Docs DOM.
        googleDocsTrustedHtmlPolicy = trustedTypesApi.createPolicy(
          `local-export-google-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          { createHTML: (value) => value }
        );
      }
      parseInput = googleDocsTrustedHtmlPolicy.createHTML(parseInput);
    }

    return new DOMParser().parseFromString(parseInput, "text/html");
  }

  async function exportGoogleDocsPlainTextDocument(format, meta, htmlError) {
    const textUrl = buildGoogleDocsExportUrl(location.href, "txt");
    const textBody = normalizeGoogleDocsPlainText(await fetchGoogleDocsExportPlainText(textUrl));
    if (!textBody) {
      throw new Error("Google 文档原生导出结果没有正文，请确认当前账号有查看权限");
    }

    if (format === "markdown") {
      const fallbackNote = "> 提示：当前浏览器未能解析 Google 文档格式，已自动使用纯文本正文；图片和部分格式未保留。";
      return {
        filename: buildFilename(meta.title, "md"),
        mimeType: "text/markdown;charset=utf-8",
        content: buildMarkdownDocument(meta, `${fallbackNote}\n\n${textBody}`)
      };
    }

    return {
      filename: buildFilename(meta.title, "json"),
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify({
        meta: {
          title: meta.title,
          pageType: meta.pageType,
          sourceUrl: location.href,
          exportedAt: new Date().toISOString(),
          extractionMode: "plain-text-fallback",
          htmlError: String(htmlError?.message || "HTML 解析失败")
        },
        textContent: textBody
      }, null, 2)
    };
  }

  function normalizeGoogleDocsPlainText(value) {
    return cleanupMarkdown(
      stripInvisibleText(String(value || ""))
        .replace(/\f/g, "\n\n")
    );
  }

  function getGoogleDocsMeta() {
    const titleNode = document.querySelector('[aria-label="重命名"]')
      || document.querySelector('[aria-label="Rename"]')
      || document.querySelector(".docs-title-input");
    const title = normalizeGoogleDocsTitle(
      titleNode?.value
      || titleNode?.textContent
      || document.title
    );

    return {
      pageType: "Google 文档",
      exportType: "google-docs",
      title,
      author: "",
      publishTime: ""
    };
  }

  function normalizeGoogleDocsTitle(value) {
    return stripInvisibleText(String(value || ""))
      .replace(/\s+-\s+Google\s+(?:文档|Docs).*$/iu, "")
      .trim() || "未命名 Google 文档";
  }

  function buildGoogleDocsExportUrl(sourceUrl = location.href, format = "html") {
    let parsed;
    try {
      parsed = new URL(String(sourceUrl || ""));
    } catch (error) {
      throw new Error("Google 文档链接无效");
    }

    const match = parsed.pathname.match(/^\/document\/d\/([^/]+)(?:\/|$)/);
    if (parsed.hostname !== "docs.google.com" || !match?.[1]) {
      throw new Error("当前页面不是受支持的 Google 文档");
    }

    const exportUrl = new URL(`/document/d/${encodeURIComponent(match[1])}/export`, parsed.origin);
    exportUrl.searchParams.set("format", format === "txt" ? "txt" : "html");
    const tabId = parsed.searchParams.get("tab");
    if (tabId) {
      exportUrl.searchParams.set("tab", tabId);
    }

    return exportUrl.toString();
  }

  async function fetchGoogleDocsExportHtml(url) {
    return fetchGoogleDocsExportContent(url, /text\/html/i, "HTML");
  }

  async function fetchGoogleDocsExportPlainText(url) {
    return fetchGoogleDocsExportContent(url, /text\/plain/i, "纯文本");
  }

  async function fetchGoogleDocsExportContent(url, expectedContentType, formatLabel) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, GOOGLE_DOCS_EXPORT_TIMEOUT_MS);

    try {
      const request = fetch(url, {
        // Send Docs cookies to the same-origin export route, but omit credentials after its
        // signed cross-origin redirect so the googleusercontent.com CORS response remains valid.
        credentials: "same-origin",
        redirect: "follow",
        ...(controller ? { signal: controller.signal } : {})
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Google 文档原生导出失败: ${response.status}`);
        }

        const finalUrl = String(response.url || "");
        if (/^https:\/\/accounts\.google\.com\//i.test(finalUrl)) {
          throw new Error("Google 文档需要重新登录或当前账号没有查看权限");
        }

        const contentType = String(response.headers?.get?.("content-type") || "");
        if (contentType && !expectedContentType.test(contentType)) {
          throw new Error(`Google 文档${formatLabel}导出返回了不支持的格式: ${contentType}`);
        }

        return response.text();
      });

      if (controller) {
        return await request;
      }

      return await Promise.race([
        request,
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error("Google 文档原生导出超时")), GOOGLE_DOCS_EXPORT_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      if (timedOut || error?.name === "AbortError") {
        throw new Error("Google 文档原生导出超时，请稍后重试");
      }
      if (String(error?.message || "").startsWith("Google 文档")) {
        throw error;
      }
      throw new Error(`Google 文档原生导出请求失败: ${getNetworkErrorMessage(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function normalizeGoogleDocsExportRoot(root) {
    for (const paragraph of Array.from(root.querySelectorAll("p.title"))) {
      const heading = root.ownerDocument.createElement("h1");
      if (paragraph.id) {
        heading.id = paragraph.id;
      }
      while (paragraph.firstChild) {
        heading.appendChild(paragraph.firstChild);
      }
      paragraph.replaceWith(heading);
    }

    for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
      try {
        const target = new URL(anchor.getAttribute("href"), location.href);
        if ((target.hostname === "www.google.com" || target.hostname === "google.com")
          && target.pathname === "/url"
          && target.searchParams.get("q")) {
          anchor.setAttribute("href", target.searchParams.get("q"));
        }
      } catch (error) {
        // Keep the original link when Google exported a non-standard href.
      }
    }
  }

  async function exportGenericWebDocument(format, options) {
    const meta = getGenericWebMeta();
    const liveRoot = getGenericExportRoot();
    const rawHtml = liveRoot?.innerHTML || "";
    const clonedRoot = liveRoot.cloneNode(true);

    sanitizeGenericArticle(clonedRoot, { includeImages: options.includeImages !== false });
    let markdownBody = cleanupMarkdown(convertBlock(clonedRoot, 0));

    if (options.includeImages === false) {
      markdownBody = stripMarkdownImages(markdownBody);
    }

    markdownBody = formatReadableMarkdown(markdownBody, {
      siteHint: getGenericReadableSiteHint(location.hostname)
    });

    if (!markdownBody) {
      throw new Error("未提取到网页正文");
    }

    if (format === "markdown") {
      return {
        filename: buildFilename(meta.title, "md"),
        mimeType: "text/markdown;charset=utf-8",
        content: buildMarkdownDocument(meta, markdownBody)
      };
    }

    const payload = {
      meta: {
        title: meta.title,
        pageType: meta.pageType,
        sourceUrl: location.href,
        author: meta.author || "",
        publishTime: meta.publishTime || "",
        exportedAt: new Date().toISOString()
      },
      articleHtml: rawHtml,
      cleanedHtml: clonedRoot.innerHTML
    };

    return {
      filename: buildFilename(meta.title, "json"),
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify(payload, null, 2)
    };
  }

  function getGenericWebMeta() {
    const title = normalizeGenericTitle(
      extractGenericPageTitle()
      || document.querySelector('meta[property="og:title"]')?.getAttribute("content")
      || document.querySelector('meta[name="twitter:title"]')?.getAttribute("content")
      || extractVisibleTitle()
      || document.title
    );
    const author = cleanupInline(
      document.querySelector('meta[name="author"]')?.getAttribute("content")
      || document.querySelector('[rel="author"]')?.textContent
      || document.querySelector('[itemprop="author"]')?.textContent
      || document.querySelector(".author, .byline, .article-author")?.textContent
      || ""
    );
    const publishTime = cleanupInline(
      document.querySelector('meta[property="article:published_time"]')?.getAttribute("content")
      || document.querySelector('meta[name="pubdate"]')?.getAttribute("content")
      || document.querySelector("time[datetime]")?.getAttribute("datetime")
      || document.querySelector("time")?.textContent
      || ""
    );

    return {
      pageType: "网页文章",
      exportType: "generic-web",
      title: title || "未命名网页",
      author,
      publishTime
    };
  }

  function getGenericReadableSiteHint(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    if (normalized === "x.com" || normalized.endsWith(".x.com") || normalized === "twitter.com" || normalized.endsWith(".twitter.com")) {
      return "x";
    }

    return "generic";
  }

  function getGenericExportRoot() {
    const selectors = [
      "article",
      "[itemprop='articleBody']",
      "main article",
      "[role='main'] article",
      "main",
      "[role='main']",
      ".article-content",
      ".article__content",
      ".post-content",
      ".entry-content",
      ".markdown-body",
      ".rich-text",
      ".ql-editor",
      ".ProseMirror",
      "[class*='article']",
      "[class*='content']",
      "[id*='article']",
      "[id*='content']"
    ];

    for (const selector of selectors) {
      const best = pickBestGenericNode(
        Array.from(document.querySelectorAll(selector)).filter((node) => isVisible(node) && !shouldSkipGenericElement(node))
      );
      if (best) {
        return best;
      }
    }

    const fallbackCandidates = Array.from(document.querySelectorAll("article, main, section, div"))
      .filter((node) => isVisible(node) && !shouldSkipGenericElement(node))
      .slice(0, 1200);

    return pickBestGenericNode(fallbackCandidates) || document.body;
  }

  function pickBestGenericNode(nodes) {
    let best = null;
    let bestScore = 0;

    for (const node of nodes) {
      const score = scoreGenericNode(node);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }

    return best;
  }

  function scoreGenericNode(node) {
    const textLength = cleanupInline(stripInvisibleText(node.innerText || "")).length;
    if (textLength < 80) {
      return 0;
    }

    const paragraphCount = node.querySelectorAll("p").length;
    const listCount = node.querySelectorAll("li").length;
    const headingCount = node.querySelectorAll("h1, h2, h3, h4").length;
    const imageCount = node.querySelectorAll("img").length;
    const noiseCount = node.querySelectorAll("nav, header, footer, aside, form, dialog").length;
    const identity = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
    const semanticBoost = /article|post|entry|content|detail|rich|markdown|正文/i.test(identity) ? 320 : 0;
    const roleBoost = node.matches("article, main, [role='main'], [itemprop='articleBody']") ? 520 : 0;

    return textLength
      + (paragraphCount * 120)
      + (listCount * 40)
      + (headingCount * 80)
      + (imageCount * 20)
      + semanticBoost
      + roleBoost
      - (noiseCount * 180);
  }

  function sanitizeGenericArticle(root, options) {
    for (const node of Array.from(root.querySelectorAll(GENERIC_REMOVE_SELECTOR))) {
      node.remove();
    }

    for (const node of Array.from(root.querySelectorAll("*"))) {
      if (shouldSkipGenericElement(node)) {
        node.remove();
        continue;
      }

      if (node.hidden || node.getAttribute("aria-hidden") === "true") {
        node.remove();
        continue;
      }

      const style = node.getAttribute("style") || "";
      if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
        node.remove();
      }
    }

    for (const media of Array.from(root.querySelectorAll("video, audio"))) {
      const src = media.getAttribute("src") || media.querySelector("source")?.getAttribute("src") || "";
      if (!src) {
        media.remove();
        continue;
      }

      const link = root.ownerDocument.createElement("a");
      link.href = toAbsoluteUrl(src);
      link.textContent = "媒体链接";
      media.replaceWith(link);
    }

    for (const image of Array.from(root.querySelectorAll("img"))) {
      const src = image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src") || image.getAttribute("data-original") || "";

      if (!options.includeImages || !src) {
        image.remove();
        continue;
      }

      image.setAttribute("src", toAbsoluteUrl(src));
      image.setAttribute("alt", cleanupInline(image.getAttribute("alt") || image.getAttribute("title") || "网页图片") || "网页图片");
      image.removeAttribute("srcset");
      image.removeAttribute("loading");
      image.removeAttribute("decoding");
    }

    cleanupEmptyGenericNodes(root);
  }

  function cleanupEmptyGenericNodes(root) {
    const removableSelectors = ["p", "section", "div", "span"];
    let changed = true;

    while (changed) {
      changed = false;
      const nodes = Array.from(root.querySelectorAll(removableSelectors.join(",")));
      for (const node of nodes) {
        const hasMedia = node.querySelector("img, video, audio, table, pre, ul, ol");
        const text = cleanupInline(node.textContent || "");
        if (!hasMedia && !text && node.children.length === 0) {
          node.remove();
          changed = true;
        }
      }
    }
  }

  function shouldSkipGenericElement(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const identity = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
    return /\b(comment|footer|header|nav|sidebar|aside|share|social|related|recommend|advert|ads|banner|popup|modal|subscribe|breadcrumb|catalog|toc|toolbar|toolbox)\b/i.test(identity);
  }

  async function getDocumentMeta(options) {
    const parsed = parseCurrentUrl();
    const title = extractVisibleTitle() || normalizeTitle(document.title);
    const jssdkSession = extractJssdkSession();
    const meta = {
      pageType: parsed.type,
      exportType: parsed.type,
      pageToken: parsed.token,
      exportToken: parsed.token,
      title,
      jssdkSession
    };

    if (parsed.type === "wiki" && options.resolveWiki) {
      const wikiInfo = await resolveWikiToken(parsed.token, jssdkSession);
      if (wikiInfo.docType !== "docx") {
        throw new Error("当前 wiki 页面不是 docx 文档，MVP 暂不支持");
      }

      meta.exportType = wikiInfo.docType;
      meta.exportToken = wikiInfo.docToken;
      meta.title = normalizeTitle(wikiInfo.title || title);
    }

    return meta;
  }

  function parseCurrentUrl() {
    const match = location.pathname.match(/^\/(docx|wiki)\/([^/?#]+)/);
    if (!match) {
      throw new Error("当前页面不是受支持的飞书 docx/wiki 页面");
    }

    return {
      type: match[1],
      token: match[2]
    };
  }

  function extractJssdkSession() {
    const patterns = [
      /__jssdkSession__\s*=\s*['"]([^'"]+)['"]/,
      /"__jssdkSession__"\s*:\s*"([^"]+)"/,
      /"jssdkSession"\s*:\s*"([^"]+)"/
    ];

    for (const script of Array.from(document.scripts)) {
      const content = script.textContent || "";
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    }

    return null;
  }

  async function resolveWikiToken(wikiToken, jssdkSession) {
    const url = `${location.origin}/space/api/wiki/v2/tree/get_node/?wiki_token=${encodeURIComponent(wikiToken)}`;
    let response;
    try {
      response = await fetchWithTimeout(url, {
        credentials: "include",
        headers: buildHeaders(jssdkSession)
      }, FEISHU_API_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`获取 wiki 信息失败: ${getNetworkErrorMessage(error)}`);
    }

    if (!response.ok) {
      throw new Error(`获取 wiki 信息失败: ${response.status}`);
    }

    const payload = await response.json();
    if (payload.code !== 0 || !payload.data) {
      throw new Error(payload.msg || "获取 wiki 信息失败");
    }

    return {
      docType: TYPE_MAP[payload.data.obj_type] || "unsupported",
      docToken: payload.data.obj_token || wikiToken,
      title: payload.data.title || ""
    };
  }

  async function fetchClientVars(docToken, jssdkSession) {
    const url = `${location.origin}/space/api/docx/pages/client_vars?id=${encodeURIComponent(docToken)}`;
    let response;
    try {
      response = await fetchWithTimeout(url, {
        credentials: "include",
        headers: buildHeaders(jssdkSession)
      }, FEISHU_API_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`获取 docx 数据失败: ${getNetworkErrorMessage(error)}`);
    }

    if (!response.ok) {
      throw new Error(`获取 docx 数据失败: ${response.status}`);
    }

    const payload = await response.json();
    if (payload.code !== 0) {
      throw new Error(payload.msg || "获取 docx 数据失败");
    }

    return payload;
  }

  function buildHeaders(jssdkSession) {
    return jssdkSession ? { "jssdk-session": jssdkSession } : {};
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const normalizedTimeoutMs = Number(timeoutMs) || 0;
    if (normalizedTimeoutMs <= 0) {
      return fetch(url, options);
    }

    if (typeof AbortController === "function") {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, normalizedTimeoutMs);

      try {
        return await fetch(url, {
          ...options,
          signal: controller.signal
        });
      } catch (error) {
        if (timedOut) {
          throw new Error("请求超时");
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    return Promise.race([
      fetch(url, options),
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("请求超时")), normalizedTimeoutMs);
      })
    ]);
  }

  function getNetworkErrorMessage(error) {
    return error?.message || error?.name || "网络请求失败";
  }

  function getWechatArticleMeta() {
    const title = normalizeWechatTitle(
      document.querySelector("#activity-name .js_title_inner")?.textContent
      || document.querySelector("#activity-name")?.textContent
      || document.querySelector('meta[property="og:title"]')?.getAttribute("content")
      || document.title
    );
    const author = cleanupInline(
      document.querySelector("#js_name")?.textContent
      || document.querySelector(".rich_media_meta_nickname")?.textContent
      || ""
    );
    const publishTime = cleanupInline(document.querySelector("#publish_time")?.textContent || "");

    return {
      pageType: "公众号文章",
      exportType: "wechat-article",
      title: title || "未命名文章",
      author,
      publishTime
    };
  }

  function getWechatHistorySeed() {
    if (!isWechatArticlePage()) {
      throw new Error("当前页面不是微信公众号文章页面");
    }

    const meta = getWechatArticleMeta();
    const biz = extractWechatBiz();
    const identity = extractWechatArticleIdentity();

    if (!biz) {
      throw new Error("未能识别当前文章的公众号 biz");
    }

    return {
      seedUrl: location.href,
      biz,
      nickname: meta.author || "",
      title: meta.title,
      publishTime: meta.publishTime || "",
      publishTimestamp: identity.publishTimestamp || 0,
      canonicalUrl: identity.canonicalUrl || location.href,
      articleKey: identity.articleKey || "",
      articleId: identity.articleId || "",
      mid: identity.mid || "",
      idx: identity.idx || "",
      sn: identity.sn || "",
      profileUrl: buildWechatProfileUrl(biz)
    };
  }

  async function getWechatMpLoginStatus() {
    const session = await getWechatMpSession();
    return {
      loggedIn: session.loggedIn,
      token: session.token || "",
      accountName: session.accountName || "",
      homeUrl: session.homeUrl || "",
      loginUrl: WECHAT_MP_LOGIN_URL
    };
  }

  async function resolveWechatMpHistory(startDate, endDate) {
    if (!isWechatArticlePage()) {
      throw new Error("请在微信公众号种子文章页中发起范围下载");
    }

    if (!startDate || !endDate) {
      throw new Error("缺少开始或结束日期");
    }

    const seedMeta = getWechatHistorySeed();
    const session = await getWechatMpSession();
    const logs = [];

    if (!session.loggedIn || !session.token) {
      logs.push("未检测到当前 Chrome 的公众号后台登录态。");
      return {
        loginRequired: true,
        loginUrl: WECHAT_MP_LOGIN_URL,
        seedMeta,
        links: [],
        logs,
        message: "未检测到当前 Chrome 的公众号后台登录态，请先登录 mp.weixin.qq.com。"
      };
    }

    logs.push(`已检测到公众号后台登录态${session.accountName ? ` (${session.accountName})` : ""}。`);

    const result = await resolveWechatHistoryLinksWithMpBackend(seedMeta, session, startDate, endDate, logs);
    return {
      ...result,
      loginRequired: false,
      loginUrl: WECHAT_MP_LOGIN_URL,
      seedMeta,
      logs
    };
  }

  function getWechatArticleRoot() {
    const selectors = [
      "#js_content",
      "#img-content #js_content",
      "#js_article #js_content"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        return node;
      }
    }

    throw new Error("未找到公众号正文节点 #js_content");
  }

  function extractWechatBiz() {
    const directCandidates = [
      new URL(location.href).searchParams.get("__biz"),
      document.querySelector('meta[property="og:url"]')?.getAttribute("content") || ""
    ];

    for (const candidate of directCandidates) {
      const value = extractBizFromString(candidate);
      if (value) {
        return value;
      }
    }

    const patterns = [
      /(?:var|let|const)\s+biz\s*=\s*["']([^"']+)["']/,
      /window\.biz\s*=\s*["']([^"']+)["']/,
      /"biz"\s*:\s*"([^"]+)"/,
      /__biz=([^&"'\\]+)/,
      /nickname=decodeURIComponent\("([^"]+)"\)/
    ];

    for (const script of Array.from(document.scripts)) {
      const content = script.textContent || "";
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (!match?.[1]) {
          continue;
        }

        const value = extractBizFromString(match[1]);
        if (value) {
          return value;
        }
      }
    }

    return "";
  }

  function extractBizFromString(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    try {
      const parsed = new URL(raw);
      return parsed.searchParams.get("__biz") || "";
    } catch (error) {
      return raw.startsWith("Mz") ? raw : "";
    }
  }

  function buildWechatProfileUrl(biz) {
    return `https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=${encodeURIComponent(biz)}#wechat_redirect`;
  }

  async function getWechatMpSession() {
    const response = await fetch(WECHAT_MP_LOGIN_URL, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store"
    });
    const html = await response.text();
    const finalUrl = response.url || WECHAT_MP_LOGIN_URL;
    const token = extractWechatMpToken(finalUrl) || extractWechatMpToken(html);

    return {
      loggedIn: Boolean(token),
      token,
      homeUrl: token ? buildWechatMpHomeUrl(token) : finalUrl,
      accountName: extractWechatMpAccountName(html),
      finalUrl
    };
  }

  async function resolveWechatHistoryLinksWithMpBackend(seedMeta, session, startDate, endDate, logs) {
    const searchQuery = seedMeta.nickname || "";
    if (!searchQuery) {
      throw new Error("未能从种子文章中识别公众号名称");
    }

    const candidates = await searchWechatMpAccounts(searchQuery, session);
    if (candidates.length === 0) {
      throw new Error(`公众号后台没有搜到“${searchQuery}”对应的公众号`);
    }

    logs.push(`后台搜索“${searchQuery}”返回 ${candidates.length} 个候选公众号。`);

    const matchedAccount = await resolveWechatMpAccountCandidate(candidates, seedMeta, session, logs);
    if (!matchedAccount) {
      throw new Error(`未能在公众号后台里定位到“${searchQuery}”对应账号`);
    }

    logs.push(`已匹配目标公众号：${formatWechatMpAccount(matchedAccount)}。`);

    const articles = await fetchWechatMpArticlesInRange(matchedAccount.fakeid, session, startDate, endDate, logs);
    const links = uniqueStrings(
      articles
        .map((article) => article.url)
        .filter((url) => typeof url === "string" && /^https:\/\/mp\.weixin\.qq\.com\/s/.test(url))
    );

    return {
      matchedAccount,
      links,
      message: links.length > 0
        ? `已从公众号后台定位到 ${links.length} 篇历史文章。`
        : "该时间范围没有命中任何历史文章。"
    };
  }

  async function searchWechatMpAccounts(query, session) {
    const payload = await fetchWechatMpJson(
      "/cgi-bin/searchbiz",
      {
        action: "search_biz",
        token: session.token,
        lang: "zh_CN",
        f: "json",
        ajax: "1",
        random: Math.random().toString(),
        query,
        begin: "0",
        count: String(WECHAT_MP_SEARCH_COUNT)
      },
      session
    );

    return Array.isArray(payload.list)
      ? payload.list
        .map((item) => ({
          fakeid: String(item.fakeid || "").trim(),
          nickname: cleanupInline(item.nickname || ""),
          alias: cleanupInline(item.alias || "")
        }))
        .filter((item) => item.fakeid)
      : [];
  }

  async function resolveWechatMpAccountCandidate(candidates, seedMeta, session, logs) {
    const targetName = normalizeSearchText(seedMeta.nickname);
    const sorted = candidates
      .slice()
      .sort((left, right) => scoreWechatMpAccount(right, targetName) - scoreWechatMpAccount(left, targetName));

    for (const candidate of sorted.slice(0, WECHAT_MP_CANDIDATE_LIMIT)) {
      logs.push(`正在校验公众号候选：${formatWechatMpAccount(candidate)}。`);
      const matched = await candidateContainsSeedArticle(candidate, seedMeta, session);
      if (matched) {
        return candidate;
      }
    }

    if (sorted.length > 0) {
      logs.push(`未找到与种子文章完全匹配的候选，回退到最接近的公众号：${formatWechatMpAccount(sorted[0])}。`);
      return sorted[0];
    }

    return null;
  }

  async function candidateContainsSeedArticle(candidate, seedMeta, session) {
    for (let begin = 0; begin < WECHAT_MP_SEED_SCAN_LIMIT; begin += WECHAT_MP_ARTICLE_PAGE_SIZE) {
      const page = await fetchWechatMpArticlesPage(candidate.fakeid, session, begin);
      if (page.articles.length === 0) {
        return false;
      }

      for (const article of page.articles) {
        if (isWechatSeedArticleMatch(article, seedMeta)) {
          return true;
        }
      }

      const oldestTimestamp = page.articles[page.articles.length - 1]?.publishTimestamp || 0;
      if (seedMeta.publishTimestamp && oldestTimestamp && oldestTimestamp < seedMeta.publishTimestamp - (120 * 24 * 60 * 60)) {
        return false;
      }

      if (page.articles.length < WECHAT_MP_ARTICLE_PAGE_SIZE) {
        return false;
      }

      await sleep(WECHAT_MP_PAGE_DELAY_MS);
    }

    return false;
  }

  async function fetchWechatMpArticlesInRange(fakeid, session, startDate, endDate, logs) {
    const startTimestamp = toWechatRangeStart(startDate);
    const endTimestamp = toWechatRangeEnd(endDate);
    const matches = [];

    for (let begin = 0; begin < WECHAT_MP_HISTORY_SCAN_LIMIT; begin += WECHAT_MP_ARTICLE_PAGE_SIZE) {
      const page = await fetchWechatMpArticlesPage(fakeid, session, begin);
      if (page.articles.length === 0) {
        break;
      }

      for (const article of page.articles) {
        if (!article.publishTimestamp) {
          continue;
        }

        if (article.publishTimestamp >= startTimestamp && article.publishTimestamp <= endTimestamp) {
          matches.push(article);
        }
      }

      const oldestTimestamp = page.articles[page.articles.length - 1]?.publishTimestamp || 0;
      if (oldestTimestamp && oldestTimestamp < startTimestamp) {
        break;
      }

      if (page.articles.length < WECHAT_MP_ARTICLE_PAGE_SIZE) {
        break;
      }

      await sleep(WECHAT_MP_PAGE_DELAY_MS);
    }

    logs.push(`按日期范围筛选后命中 ${matches.length} 篇历史文章。`);
    return matches;
  }

  async function fetchWechatMpArticlesPage(fakeid, session, begin) {
    const payload = await fetchWechatMpJson(
      "/cgi-bin/appmsg",
      {
        token: session.token,
        lang: "zh_CN",
        f: "json",
        ajax: "1",
        random: Math.random().toString(),
        action: "list_ex",
        begin: String(begin),
        count: String(WECHAT_MP_ARTICLE_PAGE_SIZE),
        query: "",
        fakeid,
        type: "9"
      },
      session
    );

    return {
      total: safeNumber(payload.app_msg_cnt),
      articles: parseWechatMpArticleList(payload)
    };
  }

  async function fetchWechatMpJson(path, params, session) {
    const url = new URL(path, WECHAT_MP_LOGIN_URL);
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      searchParams.set(key, String(value));
    }

    url.search = searchParams.toString();

    const response = await fetch(url.toString(), {
      credentials: "include",
      cache: "no-store",
      referrer: session.homeUrl || WECHAT_MP_LOGIN_URL,
      referrerPolicy: "strict-origin-when-cross-origin"
    });

    if (!response.ok) {
      throw new Error(`公众号后台接口请求失败: ${response.status}`);
    }

    const payload = await response.json();
    assertWechatMpPayloadOkay(payload);
    return payload;
  }

  function assertWechatMpPayloadOkay(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("公众号后台返回了无效数据");
    }

    if (payload.base_resp?.ret && Number(payload.base_resp.ret) !== 0) {
      throw new Error(payload.base_resp.err_msg || "公众号后台接口返回失败");
    }

    if (typeof payload.ret !== "undefined" && Number(payload.ret) !== 0) {
      throw new Error(payload.msg || payload.errmsg || "公众号后台接口返回失败");
    }

    if (payload.errmsg && !/^(ok|success)$/i.test(String(payload.errmsg))) {
      throw new Error(payload.errmsg);
    }
  }

  function parseWechatMpArticleList(payload) {
    if (Array.isArray(payload.app_msg_list)) {
      return payload.app_msg_list
        .map(parseWechatMpArticleItem)
        .filter(Boolean);
    }

    return [];
  }

  function parseWechatMpArticleItem(item) {
    const url = normalizeWechatArticleUrl(item?.link || item?.url || "");
    const title = cleanupInline(item?.title || "");
    const publishTimestamp = safeNumber(item?.update_time || item?.create_time);

    if (!url || !title || !publishTimestamp) {
      return null;
    }

    const identity = parseWechatArticleIdentityFromUrl(url);

    return {
      title,
      url,
      publishTimestamp,
      articleKey: buildWechatArticleKey(identity),
      articleId: buildWechatArticleId(identity)
    };
  }

  function isWechatSeedArticleMatch(article, seedMeta) {
    if (!article || !seedMeta) {
      return false;
    }

    if (seedMeta.articleKey && article.articleKey && seedMeta.articleKey === article.articleKey) {
      return true;
    }

    if (seedMeta.articleId && article.articleId && seedMeta.articleId === article.articleId) {
      return true;
    }

    const sameTitle = normalizeSearchText(article.title) === normalizeSearchText(seedMeta.title);
    if (!sameTitle) {
      return false;
    }

    if (seedMeta.publishTimestamp && article.publishTimestamp) {
      return Math.abs(article.publishTimestamp - seedMeta.publishTimestamp) <= (3 * 24 * 60 * 60);
    }

    return true;
  }

  function scoreWechatMpAccount(candidate, targetName) {
    const nickname = normalizeSearchText(candidate.nickname);
    const alias = normalizeSearchText(candidate.alias);

    if (!targetName) {
      return 0;
    }

    if (nickname === targetName || alias === targetName) {
      return 100;
    }

    if (nickname.includes(targetName) || targetName.includes(nickname)) {
      return 60;
    }

    if (alias.includes(targetName) || targetName.includes(alias)) {
      return 40;
    }

    return 0;
  }

  function extractWechatMpToken(value) {
    const match = String(value || "").match(/(?:^|[?&#])token=(\d+)/);
    return match?.[1] || "";
  }

  function buildWechatMpHomeUrl(token) {
    return `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=${encodeURIComponent(token)}`;
  }

  function extractWechatMpAccountName(html) {
    const patterns = [
      /nick_name['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
      /user_name['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
      /account_name['"]?\s*[:=]\s*['"]([^'"]+)['"]/
    ];

    for (const pattern of patterns) {
      const match = String(html || "").match(pattern);
      if (match?.[1]) {
        return cleanupInline(match[1]);
      }
    }

    return "";
  }

  function extractWechatArticleIdentity() {
    const candidateUrls = [
      location.href,
      document.querySelector('meta[property="og:url"]')?.getAttribute("content") || ""
    ];
    const identity = {
      biz: "",
      mid: "",
      idx: "",
      sn: "",
      publishTimestamp: extractWechatPublishTimestamp(),
      canonicalUrl: "",
      articleKey: "",
      articleId: ""
    };

    for (const candidateUrl of candidateUrls) {
      const parsed = parseWechatArticleIdentityFromUrl(candidateUrl);
      if (parsed.biz || parsed.mid || parsed.idx || parsed.sn) {
        Object.assign(identity, parsed);
        break;
      }
    }

    for (const script of Array.from(document.scripts)) {
      const content = script.textContent || "";
      identity.biz = identity.biz || extractScriptValue(content, /(?:var|let|const)\s+biz\s*=\s*["']([^"']+)["']/);
      identity.mid = identity.mid || extractScriptValue(content, /(?:var|let|const)\s+mid\s*=\s*["']?(\d+)["']?/);
      identity.idx = identity.idx || extractScriptValue(content, /(?:var|let|const)\s+idx\s*=\s*["']?(\d+)["']?/);
      identity.sn = identity.sn || extractScriptValue(content, /(?:var|let|const)\s+sn\s*=\s*["']([^"']+)["']/);
      if (!identity.publishTimestamp) {
        identity.publishTimestamp = safeNumber(extractScriptValue(content, /(?:var|let|const)\s+ct\s*=\s*["']?(\d+)["']?/));
      }
    }

    identity.canonicalUrl = buildCanonicalWechatArticleUrl(identity) || candidateUrls.find(Boolean) || location.href;
    identity.articleKey = buildWechatArticleKey(identity);
    identity.articleId = buildWechatArticleId(identity);
    return identity;
  }

  function extractWechatPublishTimestamp() {
    for (const script of Array.from(document.scripts)) {
      const value = extractScriptValue(script.textContent || "", /(?:var|let|const)\s+ct\s*=\s*["']?(\d+)["']?/);
      if (value) {
        return safeNumber(value);
      }
    }

    return 0;
  }

  function parseWechatArticleIdentityFromUrl(url) {
    const normalized = normalizeWechatArticleUrl(url);
    if (!normalized) {
      return { biz: "", mid: "", idx: "", sn: "", canonicalUrl: "" };
    }

    try {
      const parsed = new URL(normalized);
      return {
        biz: parsed.searchParams.get("__biz") || "",
        mid: parsed.searchParams.get("mid") || "",
        idx: parsed.searchParams.get("idx") || "",
        sn: parsed.searchParams.get("sn") || "",
        canonicalUrl: normalized
      };
    } catch (error) {
      return { biz: "", mid: "", idx: "", sn: "", canonicalUrl: normalized };
    }
  }

  function buildCanonicalWechatArticleUrl(identity) {
    if (!identity?.biz || !identity?.mid || !identity?.idx) {
      return "";
    }

    const url = new URL("https://mp.weixin.qq.com/s");
    url.searchParams.set("__biz", identity.biz);
    url.searchParams.set("mid", identity.mid);
    url.searchParams.set("idx", identity.idx);
    if (identity.sn) {
      url.searchParams.set("sn", identity.sn);
    }
    return url.toString();
  }

  function buildWechatArticleKey(identity) {
    if (identity?.mid && identity?.idx) {
      return `${identity.mid}:${identity.idx}`;
    }
    if (identity?.sn) {
      return `sn:${identity.sn}`;
    }
    return "";
  }

  function buildWechatArticleId(identity) {
    if (identity?.biz && identity?.mid && identity?.idx) {
      return `${identity.biz}:${identity.mid}:${identity.idx}`;
    }
    return identity?.biz && identity?.sn ? `${identity.biz}:sn:${identity.sn}` : "";
  }

  function normalizeWechatArticleUrl(url) {
    const raw = String(url || "").trim().replace(/&amp;/g, "&");
    if (!raw) {
      return "";
    }

    const absolute = toAbsoluteUrl(raw);
    try {
      const parsed = new URL(absolute);
      if (parsed.hostname === "mp.weixin.qq.com" && parsed.protocol === "http:") {
        parsed.protocol = "https:";
      }
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return absolute;
    }
  }

  function extractScriptValue(content, pattern) {
    const match = String(content || "").match(pattern);
    return match?.[1] || "";
  }

  function normalizeSearchText(value) {
    return cleanupInline(String(value || "")).replace(/\s+/g, "").toLowerCase();
  }

  function formatWechatMpAccount(account) {
    if (!account) {
      return "未命名公众号";
    }
    return account.alias && account.alias !== account.nickname
      ? `${account.nickname} (${account.alias})`
      : (account.nickname || account.alias || "未命名公众号");
  }

  function safeNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function toWechatRangeStart(value) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : 0;
  }

  function toWechatRangeEnd(value) {
    const date = new Date(`${value}T23:59:59`);
    return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : 0;
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sanitizeWechatArticle(root, options) {
    removeWechatNoise(root);
    replaceWechatEmbeds(root);
    await hydrateWechatImages(root, options);
    cleanupEmptyWechatNodes(root);
  }

  function removeWechatNoise(root) {
    for (const node of Array.from(root.querySelectorAll(WECHAT_REMOVE_SELECTOR))) {
      node.remove();
    }

    for (const node of Array.from(root.querySelectorAll("[style]"))) {
      const style = node.getAttribute("style") || "";
      if (/display\s*:\s*none/i.test(style)) {
        node.remove();
      }
    }
  }

  function replaceWechatEmbeds(root) {
    for (const iframe of Array.from(root.querySelectorAll("iframe"))) {
      const src = iframe.getAttribute("src") || iframe.getAttribute("data-src") || "";
      if (!src) {
        iframe.remove();
        continue;
      }

      const link = document.createElement("a");
      link.href = toAbsoluteUrl(src);
      link.textContent = "视频/音频链接";
      iframe.replaceWith(link);
    }
  }

  async function hydrateWechatImages(root, options) {
    const includeImages = options.includeImages !== false;
    const images = Array.from(root.querySelectorAll("img"));

    for (const image of images) {
      const resolvedUrl = resolveWechatImageUrl(image);

      if (!includeImages || !resolvedUrl) {
        image.remove();
        continue;
      }

      const embeddedUrl = await fetchExtensionAssetAsDataUrl(resolvedUrl);
      image.setAttribute("src", embeddedUrl || resolvedUrl);
      image.setAttribute("alt", buildWechatImageAlt(image));
      image.removeAttribute("data-src");
      image.removeAttribute("data-original");
      image.removeAttribute("data-backsrc");
      image.removeAttribute("data-actualsrc");
      image.removeAttribute("srcset");
      image.className = "";
    }
  }

  function cleanupEmptyWechatNodes(root) {
    const removableSelectors = ["p", "section", "div", "span"];
    let changed = true;

    while (changed) {
      changed = false;
      const nodes = Array.from(root.querySelectorAll(removableSelectors.join(",")));
      for (const node of nodes) {
        const hasMedia = node.querySelector("img, video, audio, iframe, table, pre");
        const text = cleanupInline(node.textContent || "");
        if (!hasMedia && !text && node.children.length === 0) {
          node.remove();
          changed = true;
        }
      }
    }
  }

  function resolveWechatImageUrl(image) {
    const candidates = [
      image.getAttribute("data-src"),
      image.getAttribute("data-original"),
      image.getAttribute("data-backsrc"),
      image.getAttribute("data-actualsrc"),
      image.currentSrc,
      image.getAttribute("src")
    ];

    for (const candidate of candidates) {
      const url = String(candidate || "").trim();
      if (!url || url.startsWith("data:image/svg+xml")) {
        continue;
      }
      return toAbsoluteUrl(url);
    }

    return "";
  }

  function buildWechatImageAlt(image) {
    return cleanupInline(
      image.getAttribute("data-caption")
      || image.getAttribute("data-title")
      || image.getAttribute("alt")
      || "公众号图片"
    ) || "公众号图片";
  }

  async function fetchExtensionAssetAsDataUrl(url) {
    try {
      const response = await sendRuntimeMessage({
        type: MESSAGE_FETCH_ASSET,
        url
      });
      return response?.dataUrl || "";
    } catch (error) {
      return "";
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || "后台请求失败"));
          return;
        }

        resolve(response);
      });
    });
  }

  function normalizeWechatTitle(value) {
    return stripInvisibleText(String(value || ""))
      .replace(/\s+/g, " ")
      .replace(/\s+-\s+微信公众平台$/, "")
      .trim();
  }

  async function convertClientVarsToMarkdown(meta, clientVars, options) {
    const blockMap = clientVars?.data?.block_map || {};
    const root = blockMap[meta.exportToken];
    const rootChildren = root?.data?.children || [];

    if (rootChildren.length === 0) {
      throw new Error("未找到正文块数据");
    }

    const context = {
      blockMap,
      includeImages: options.includeImages !== false,
      imageMap: options.includeImages === false
        ? new Map()
        : options.localImageAssets === true
          ? await buildLocalImageMap(blockMap, meta, options)
          : buildLinkedImageMap(blockMap),
      sheetMap: await buildSheetMarkdownMap(meta, blockMap),
      rootId: meta.exportToken,
      pageTitle: meta.title
    };

    const body = renderBlockSequence(rootChildren, context, 0);
    if (!body.trim()) {
      throw new Error("正文块解析后为空");
    }

    return body;
  }

  function renderBlockSequence(blockIds, context, depth) {
    const parts = [];

    for (let index = 0; index < blockIds.length; index += 1) {
      const blockId = blockIds[index];
      const block = context.blockMap[blockId];
      const type = block?.data?.type;

      if (type === "bullet") {
        const listItems = [];
        while (index < blockIds.length) {
          const currentId = blockIds[index];
          const currentBlock = context.blockMap[currentId];
          if (currentBlock?.data?.type !== "bullet") {
            break;
          }

          const rendered = renderClientVarBlock(currentId, context, depth);
          if (rendered) {
            listItems.push(rendered);
          }
          index += 1;
        }

        index -= 1;
        if (listItems.length > 0) {
          parts.push(listItems.join("\n"));
        }
        continue;
      }

      const rendered = renderClientVarBlock(blockId, context, depth);
      if (rendered) {
        parts.push(rendered);
      }
    }

    return cleanupMarkdown(parts.join("\n\n"));
  }

  function renderClientVarBlock(blockId, context, depth) {
    const block = context.blockMap[blockId];
    if (!block?.data || block.data.hidden) {
      return "";
    }

    const type = block.data.type;
    const text = getBlockText(block);

    switch (type) {
      case "text":
        return text;
      case "heading1":
        return renderHeading(text, 2, context.pageTitle);
      case "heading2":
        return renderHeading(text, 3, context.pageTitle);
      case "heading3":
        return renderHeading(text, 4, context.pageTitle);
      case "bullet":
        return renderBulletBlock(block, context, depth);
      case "image":
        return renderImageBlock(blockId, block, context);
      case "sheet":
        return renderSheetBlock(blockId, context);
      case "callout":
        return renderQuotedChildren(block.data.children || [], context, depth);
      case "quote_container":
        return isCatalogueBlock(block, context) ? "" : renderQuotedChildren(block.data.children || [], context, depth);
      default:
        if (Array.isArray(block.data.children) && block.data.children.length > 0) {
          return renderBlockSequence(block.data.children, context, depth + 1);
        }
        return text;
    }
  }

  function renderHeading(text, level, pageTitle) {
    const cleaned = cleanupMarkdown(text);
    if (!cleaned || cleaned === cleanupMarkdown(pageTitle)) {
      return "";
    }

    return `${"#".repeat(level)} ${cleaned}`;
  }

  function renderBulletBlock(block, context, depth) {
    const head = cleanupMarkdown(getBlockText(block)) || " ";
    const children = Array.isArray(block.data.children) && block.data.children.length > 0
      ? renderBlockSequence(block.data.children, context, depth + 1)
      : "";
    const indent = "  ".repeat(depth);
    const line = `${indent}- ${head}`;
    return children ? `${line}\n${indent}  ${children.replace(/\n/g, `\n${indent}  `)}` : line;
  }

  function renderImageBlock(blockId, block, context) {
    if (!context.includeImages) {
      return "";
    }

    const src = context.imageMap.get(blockId) || buildImageUrl(blockId, block);
    if (!src) {
      return "";
    }

    const alt = normalizeInlineText(block.data.image?.name || "飞书文档图片");
    return `![${alt}](${src})`;
  }

  function renderSheetBlock(blockId, context) {
    return context.sheetMap.get(blockId) || "";
  }

  function renderQuotedChildren(children, context, depth) {
    const content = renderBlockSequence(children, context, depth + 1);
    if (!content) {
      return "";
    }

    return prefixLines(content, "> ");
  }

  function getBlockText(block) {
    const textMap = block?.data?.text?.initialAttributedTexts?.text;
    if (!textMap) {
      return "";
    }

    return cleanupMarkdown(
      Object.keys(textMap)
        .sort((left, right) => Number(left) - Number(right))
        .map((key) => textMap[key] || "")
        .join("")
    );
  }

  function extractImageMapFromDom() {
    const imageMap = new Map();

    for (const img of document.querySelectorAll(".docx-image-block img")) {
      const wrapper = img.closest("[data-record-id]");
      const blockId = wrapper?.getAttribute("data-record-id");
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (blockId && src && !imageMap.has(blockId)) {
        imageMap.set(blockId, src);
      }
    }

    return imageMap;
  }

  async function buildLocalImageMap(blockMap, meta, options = {}) {
    const imageMap = extractImageMapFromDom();
    const linkedMap = new Map();
    const imageBlocks = Object.entries(blockMap).filter(([, block]) => block?.data?.type === "image");
    const assets = Array.isArray(options.assets) ? options.assets : [];
    const assetFolder = buildAssetFolderName(meta.title);
    const fetches = [];

    for (const [index, [blockId, block]] of imageBlocks.entries()) {
      const src = imageMap.get(blockId) || buildImageUrl(blockId, block);
      if (!src) {
        continue;
      }

      fetches.push({
        blockId,
        src,
        promise: fetchImageAsAsset(src, block, assetFolder, assets.length + index + 1, options.imageFetchTimeoutMs)
      });
    }

    const results = await Promise.all(fetches.map(async (entry) => ({
      ...entry,
      asset: await entry.promise
    })));

    for (const { blockId, src, asset } of results) {
      if (asset) {
        assets.push(asset);
        linkedMap.set(blockId, asset.path);
      } else {
        linkedMap.set(blockId, src);
      }
    }

    return linkedMap;
  }

  function buildLinkedImageMap(blockMap) {
    const imageMap = extractImageMapFromDom();
    const linkedMap = new Map();
    const imageBlocks = Object.entries(blockMap).filter(([, block]) => block?.data?.type === "image");

    for (const [blockId, block] of imageBlocks) {
      const src = imageMap.get(blockId) || buildImageUrl(blockId, block);
      if (src) {
        linkedMap.set(blockId, src);
      }
    }

    return linkedMap;
  }

  async function buildSheetMarkdownMap(meta, blockMap) {
    const runtimeMap = buildRuntimeSheetMarkdownMap(blockMap);
    if (runtimeMap.size > 0) {
      return runtimeMap;
    }

    const sheetBlocks = Object.entries(blockMap)
      .filter(([, block]) => block?.data?.type === "sheet" && block?.data?.token)
      .map(([blockId, block]) => ({
        blockId,
        id: blockId,
        type: "sheet",
        version: Number(block.version || 1),
        parent_id: block.data.parent_id || meta.exportToken,
        token: block.data.token
      }));

    if (sheetBlocks.length === 0) {
      return new Map();
    }

    try {
      const response = await fetchWithTimeout("https://internal-api-space.feishu.cn/space/api/ssr/docx/blocks/", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json;charset=UTF-8"
        },
        body: JSON.stringify({
          blockInfos: sheetBlocks.map(({ blockId, ...payload }) => payload),
          token: meta.exportToken,
          options: {
            branch: getFeishuTemplateBranch(),
            biz: meta.pageType === "wiki" ? "wiki" : "docx"
          }
        })
      }, FEISHU_API_TIMEOUT_MS);

      if (!response.ok) {
        return new Map();
      }

      const payload = await response.json();
      if (payload?.code !== 0 || !Array.isArray(payload.data)) {
        return new Map();
      }

      const markdownMap = new Map();
      for (let index = 0; index < sheetBlocks.length; index += 1) {
        const sheetBlock = sheetBlocks[index];
        const ssrData = payload.data[index]?.ssrData;
        const markdown = convertSheetSsrToMarkdown(ssrData);
        if (markdown) {
          markdownMap.set(sheetBlock.blockId, markdown);
        }
      }

      return markdownMap;
    } catch (error) {
      return new Map();
    }
  }

  function buildRuntimeSheetMarkdownMap(blockMap) {
    const markdownMap = new Map();
    const containers = Array.from(document.querySelectorAll('[data-sheet-element="embeddedSheetContainer"]'));

    for (const container of containers) {
      const wrapper = container.closest("[data-record-id]");
      const blockId = wrapper?.getAttribute("data-record-id");
      if (!blockId || !blockMap[blockId] || markdownMap.has(blockId)) {
        continue;
      }

      const dataModel = getEmbeddedSheetDataModel(container);
      const markdown = convertSheetRuntimeToMarkdown(dataModel);
      if (markdown) {
        markdownMap.set(blockId, markdown);
      }
    }

    return markdownMap;
  }

  function getEmbeddedSheetDataModel(container) {
    const fiber = getReactFiberNode(container);
    if (!fiber) {
      return null;
    }

    let current = fiber;
    let hops = 0;
    while (current && hops < 80) {
      const props = current.memoizedProps || current.pendingProps;
      const shell = props?.shell;
      const dataModel = shell?.sheet?._dataModel;
      if (dataModel) {
        return dataModel;
      }
      current = current.return || null;
      hops += 1;
    }

    return null;
  }

  function getReactFiberNode(element) {
    if (!element || typeof element !== "object") {
      return null;
    }

    const key = Object.keys(element).find((name) => {
      return name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$");
    });

    return key ? element[key] : null;
  }

  function convertSheetRuntimeToMarkdown(dataModel) {
    if (!dataModel || typeof dataModel.serialize !== "function") {
      return "";
    }

    try {
      const payload = dataModel.serialize()?.mutation?.setRangeValues;
      if (!payload?.range || !payload?.cells?.cellIds || !payload?.cells?.cells) {
        return "";
      }

      const range = payload.range;
      const startRow = Number(range.startRow || 0);
      const startCol = Number(range.startCol || 0);
      const endRow = Number(range.endRow || 0);
      const endCol = Number(range.endCol || 0);
      const rowCount = endRow - startRow;
      const columnCount = endCol - startCol;

      if (rowCount <= 0 || columnCount <= 0) {
        return "";
      }

      const matrix = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => ""));
      const cellIds = payload.cells.cellIds;
      const cellPool = payload.cells.cells;

      for (let index = 0; index < cellIds.length; index += 1) {
        const rowIndex = Math.floor(index / columnCount);
        const columnIndex = index % columnCount;
        if (rowIndex >= rowCount || columnIndex >= columnCount) {
          break;
        }

        const cellId = cellIds[index];
        const cell = cellPool[cellId];
        matrix[rowIndex][columnIndex] = escapeMarkdownTableCell(
          resolveRuntimeSheetCellValue(
            dataModel,
            payload,
            cell,
            startRow + rowIndex,
            startCol + columnIndex
          )
        );
      }

      const normalized = trimEmptySheetMatrix(matrix);
      if (normalized.length < 2 || normalized[0].length === 0) {
        return "";
      }

      const header = normalized[0];
      const separator = header.map(() => "---");
      const body = normalized.slice(1);

      return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`)
      ].join("\n");
    } catch (error) {
      return "";
    }
  }

  function resolveRuntimeSheetCellValue(dataModel, payload, cell, rowIndex, columnIndex) {
    const runtimeValue = readRuntimeSheetDisplayValue(dataModel, rowIndex, columnIndex);
    if (runtimeValue) {
      return runtimeValue;
    }

    return resolveSerializedSheetCellValue(cell, payload, rowIndex, columnIndex);
  }

  function readRuntimeSheetDisplayValue(dataModel, rowIndex, columnIndex) {
    if (typeof dataModel.getValue !== "function") {
      return "";
    }

    try {
      const rawValue = dataModel.getValue(rowIndex, columnIndex);
      return normalizeRuntimeSheetValue(rawValue);
    } catch (error) {
      return "";
    }
  }

  function normalizeRuntimeSheetValue(value) {
    if (value == null) {
      return "";
    }

    if (typeof value === "string") {
      return cleanupInline(value);
    }

    if (typeof value === "number") {
      return formatSheetNumberValue(value);
    }

    if (Array.isArray(value)) {
      return cleanupInline(value.map((item) => normalizeRuntimeSheetValue(item)).filter(Boolean).join(" "));
    }

    if (typeof value === "object") {
      for (const key of ["displayValue", "formattedValue", "displayText", "text", "value", "v"]) {
        if (value[key] != null) {
          const normalized = normalizeRuntimeSheetValue(value[key]);
          if (normalized) {
            return normalized;
          }
        }
      }
    }

    return "";
  }

  function resolveSerializedSheetCellValue(cell, payload, rowIndex, columnIndex) {
    if (!cell || typeof cell !== "object") {
      return "";
    }

    const strings = payload?.valueRefDelta?.strings || [];
    const numbers = payload?.valueRefDelta?.numbers || [];
    const valueType = Number(cell.valueType || 0);
    const valueId = Number(cell.valueId || 0);

    if (valueType === 3) {
      return cleanupInline(String(strings[valueId] || "").replace(/\n/g, "<br>"));
    }

    if (valueType === 2) {
      const numberValue = Number(numbers[valueId]);
      if (!Number.isFinite(numberValue)) {
        return "";
      }

      return formatSerializedSheetNumber(numberValue, payload, rowIndex, columnIndex);
    }

    return "";
  }

  function formatSerializedSheetNumber(numberValue, payload, rowIndex, columnIndex) {
    const headerValue = payload?.valueRefDelta?.strings?.[columnIndex] || "";
    if (/%|占比/.test(String(headerValue)) || (numberValue > 0 && numberValue < 1)) {
      const percentage = `${stripTrailingZeros((numberValue * 100).toFixed(2))}%`;
      return cleanupInline(percentage);
    }

    return formatSheetNumberValue(numberValue);
  }

  function formatSheetNumberValue(numberValue) {
    if (!Number.isFinite(numberValue)) {
      return "";
    }

    if (Number.isInteger(numberValue)) {
      return String(numberValue);
    }

    return stripTrailingZeros(numberValue.toFixed(4));
  }

  function stripTrailingZeros(value) {
    return String(value)
      .replace(/(\.\d*?[1-9])0+$/u, "$1")
      .replace(/\.0+$/u, "")
      .trim();
  }

  function trimEmptySheetMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
      return [];
    }

    const nonEmptyRows = matrix.filter((row) => row.some((cell) => cleanupInline(cell)));
    if (nonEmptyRows.length === 0) {
      return [];
    }

    let maxColumnCount = 0;
    for (const row of nonEmptyRows) {
      for (let index = row.length - 1; index >= 0; index -= 1) {
        if (cleanupInline(row[index])) {
          maxColumnCount = Math.max(maxColumnCount, index + 1);
          break;
        }
      }
    }

    return nonEmptyRows.map((row) => row.slice(0, maxColumnCount));
  }

  function getFeishuTemplateBranch() {
    const match = document.cookie.match(/(?:^|;\s*)template-branch-list=([^;]+)/);
    return decodeURIComponent(match?.[1] || "release-web-2026.3.3");
  }

  function convertSheetSsrToMarkdown(ssrData) {
    if (!ssrData) {
      return "";
    }

    try {
      const doc = new DOMParser().parseFromString(ssrData, "text/html");
      const allTextNodes = Array.from(doc.querySelectorAll("svg text"))
        .map((node) => {
          const position = getSvgTextPosition(node);
          return {
            text: cleanupMarkdown(node.textContent || ""),
            x: position.x,
            y: position.y,
            className: node.getAttribute("class") || ""
          };
        })
        .filter((item) => item.text);

      if (allTextNodes.length === 0) {
        return "";
      }

      const contentNodes = allTextNodes.filter((item) => !isSheetAxisNode(item));
      const normalizedRows = buildSheetRowsFromTextAnchors(contentNodes);
      if (normalizedRows.length < 2 || normalizedRows[0].every((cell) => !cell)) {
        return "";
      }

      const header = normalizedRows[0];
      const separator = header.map(() => "---");
      const body = normalizedRows.slice(1);

      return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`)
      ].join("\n");
    } catch (error) {
      return "";
    }
  }

  function buildSheetRowsFromTextAnchors(contentNodes) {
    if (!Array.isArray(contentNodes) || contentNodes.length === 0) {
      return [];
    }

    const rowClusters = clusterSheetRows(contentNodes);
    if (rowClusters.length < 2) {
      return [];
    }

    const headerNodes = [...rowClusters[0].nodes].sort((left, right) => left.x - right.x);
    const columnAnchors = headerNodes.map((node) => node.x);
    if (columnAnchors.length < 2) {
      return [];
    }

    return rowClusters.map((cluster) => {
      const columns = Array.from({ length: columnAnchors.length }, () => []);
      for (const node of cluster.nodes) {
        const columnIndex = findColumnIndexFromAnchors(columnAnchors, node.x);
        if (columnIndex === -1) {
          continue;
        }
        columns[columnIndex].push(node);
      }

      return columns.map((cellNodes) => escapeMarkdownTableCell(collapseSheetCellText(cellNodes)));
    });
  }

  function clusterSheetRows(nodes) {
    const sorted = [...nodes].sort((left, right) => {
      if (Math.abs(left.y - right.y) > 1) {
        return left.y - right.y;
      }
      return left.x - right.x;
    });

    const clusters = [];
    for (const node of sorted) {
      const last = clusters[clusters.length - 1];
      if (!last || Math.abs(node.y - last.centerY) > 24) {
        clusters.push({
          centerY: node.y,
          nodes: [node]
        });
        continue;
      }

      last.nodes.push(node);
      last.centerY = last.nodes.reduce((sum, item) => sum + item.y, 0) / last.nodes.length;
    }

    return clusters;
  }

  function findColumnIndexFromAnchors(anchors, x) {
    if (!Array.isArray(anchors) || anchors.length === 0) {
      return -1;
    }

    for (let index = 0; index < anchors.length; index += 1) {
      const leftBoundary = index === 0 ? -Infinity : (anchors[index - 1] + anchors[index]) / 2;
      const rightBoundary = index === anchors.length - 1 ? Infinity : (anchors[index] + anchors[index + 1]) / 2;
      if (x >= leftBoundary && x < rightBoundary) {
        return index;
      }
    }

    return anchors.length - 1;
  }

  function findNearestIndex(values, target) {
    if (!Array.isArray(values) || values.length === 0) {
      return -1;
    }

    let nearestIndex = 0;
    let nearestDistance = Math.abs(values[0] - target);
    for (let index = 1; index < values.length; index += 1) {
      const distance = Math.abs(values[index] - target);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    return nearestIndex;
  }

  function isSheetAxisNode(node) {
    const text = String(node?.text || "").trim();
    if (!text) {
      return false;
    }

    const x = Number(node?.x);
    const y = Number(node?.y);
    const isColumnAxis = /^[A-Z]+$/.test(text) && Number.isFinite(y) && y < 24;
    const isRowAxis = /^\d+$/.test(text) && Number.isFinite(x) && x < 40;

    return isColumnAxis || isRowAxis;
  }

  function isSheetContentNodeWithinGrid(node, columnBoundaries, rowBoundaries) {
    if (!node || isSheetAxisNode(node)) {
      return false;
    }

    const minX = columnBoundaries[0];
    const maxX = columnBoundaries[columnBoundaries.length - 1];
    const minY = rowBoundaries[0];
    const maxY = rowBoundaries[rowBoundaries.length - 1];

    return node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY;
  }

  function findBoundaryIndex(boundaries, target) {
    if (!Array.isArray(boundaries) || boundaries.length < 2) {
      return -1;
    }

    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      if (target >= start && target <= end) {
        return index;
      }
    }

    return -1;
  }

  function getSvgTextPosition(node) {
    const baseX = Number.parseFloat(node.getAttribute("x") || "0");
    const baseY = Number.parseFloat(node.getAttribute("y") || "0");
    let offsetX = 0;
    let offsetY = 0;
    let current = node;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const transform = current.getAttribute?.("transform") || "";
      const offset = parseSvgTransformOffset(transform);
      offsetX += offset.x;
      offsetY += offset.y;
      current = current.parentElement;
    }

    return {
      x: baseX + offsetX,
      y: baseY + offsetY
    };
  }

  function parseSvgTransformOffset(transform) {
    const value = String(transform || "").trim();
    if (!value) {
      return { x: 0, y: 0 };
    }

    const matrixMatch = value.match(/matrix\(\s*[-\d.eE]+\s+[-\d.eE]+\s+[-\d.eE]+\s+[-\d.eE]+\s+([-\d.eE]+)\s+([-\d.eE]+)\s*\)/);
    if (matrixMatch) {
      return {
        x: Number.parseFloat(matrixMatch[1] || "0") || 0,
        y: Number.parseFloat(matrixMatch[2] || "0") || 0
      };
    }

    const translateMatch = value.match(/translate\(\s*([-\d.eE]+)(?:[\s,]+([-\d.eE]+))?\s*\)/);
    if (translateMatch) {
      return {
        x: Number.parseFloat(translateMatch[1] || "0") || 0,
        y: Number.parseFloat(translateMatch[2] || "0") || 0
      };
    }

    return { x: 0, y: 0 };
  }

  function extractSheetGridBoundaries(doc) {
    const verticals = [];
    const horizontals = [];

    for (const line of doc.querySelectorAll("svg line")) {
      const offset = getSvgNodeOffset(line);
      const x1 = Number.parseFloat(line.getAttribute("x1") || "0") + offset.x;
      const y1 = Number.parseFloat(line.getAttribute("y1") || "0") + offset.y;
      const x2 = Number.parseFloat(line.getAttribute("x2") || "0") + offset.x;
      const y2 = Number.parseFloat(line.getAttribute("y2") || "0") + offset.y;

      if (Math.abs(x1 - x2) < 1 && Math.abs(y1 - y2) > 20) {
        verticals.push((x1 + x2) / 2);
      } else if (Math.abs(y1 - y2) < 1 && Math.abs(x1 - x2) > 40) {
        horizontals.push((y1 + y2) / 2);
      }
    }

    for (const path of doc.querySelectorAll("svg path")) {
      const points = parseSvgPathPoints(path.getAttribute("d") || "");
      if (points.length < 2) {
        continue;
      }

      const offset = getSvgNodeOffset(path);
      const xs = points.map((point) => point.x + offset.x);
      const ys = points.map((point) => point.y + offset.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);

      if (maxX - minX < 1 && maxY - minY > 20) {
        verticals.push((minX + maxX) / 2);
      } else if (maxY - minY < 1 && maxX - minX > 40) {
        horizontals.push((minY + maxY) / 2);
      }
    }

    return {
      verticals: dedupeSortedCoordinates(verticals),
      horizontals: dedupeSortedCoordinates(horizontals)
    };
  }

  function parseSvgPathPoints(d) {
    const values = String(d || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const points = [];

    for (let index = 0; index + 1 < values.length; index += 2) {
      points.push({
        x: Number.parseFloat(values[index] || "0") || 0,
        y: Number.parseFloat(values[index + 1] || "0") || 0
      });
    }

    return points;
  }

  function dedupeSortedCoordinates(values) {
    const sorted = [...values]
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);

    const unique = [];
    for (const value of sorted) {
      const previous = unique[unique.length - 1];
      if (typeof previous === "number" && Math.abs(previous - value) < 2) {
        continue;
      }
      unique.push(value);
    }

    return unique;
  }

  function getSvgNodeOffset(node) {
    let offsetX = 0;
    let offsetY = 0;
    let current = node;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const transform = current.getAttribute?.("transform") || "";
      const offset = parseSvgTransformOffset(transform);
      offsetX += offset.x;
      offsetY += offset.y;
      current = current.parentElement;
    }

    return { x: offsetX, y: offsetY };
  }

  function collapseSheetCellText(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return "";
    }

    const sorted = [...nodes].sort((left, right) => {
      if (Math.abs(left.y - right.y) > 1) {
        return left.y - right.y;
      }
      return left.x - right.x;
    });

    const lines = [];
    for (const node of sorted) {
      const currentLine = lines[lines.length - 1];
      if (!currentLine || Math.abs(currentLine.y - node.y) > 6) {
        lines.push({ y: node.y, parts: [node.text] });
        continue;
      }

      currentLine.parts.push(node.text);
    }

    return lines
      .map((line) => cleanupInline(line.parts.join(" ")))
      .filter(Boolean)
      .join("<br>");
  }

  function escapeMarkdownTableCell(value) {
    return String(value || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
  }

  async function fetchImageAsAsset(src, block, assetFolder, assetIndex, timeoutMs = FEISHU_IMAGE_FETCH_TIMEOUT_MS) {
    try {
      const response = await fetchWithTimeout(src, { credentials: "include" }, timeoutMs);
      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      const mimeType = blob.type || guessImageMimeType(block) || "application/octet-stream";
      const extension = getImageExtension(mimeType, block);
      const buffer = await blob.arrayBuffer();
      return {
        path: `${assetFolder}/image-${String(assetIndex).padStart(3, "0")}.${extension}`,
        mimeType,
        contentBase64: arrayBufferToBase64(buffer)
      };
    } catch (error) {
      return null;
    }
  }

  function buildAssetFolderName(title) {
    return "assets";
  }

  function guessImageMimeType(block) {
    const name = String(block?.data?.image?.name || "").toLowerCase();
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (name.endsWith(".webp")) {
      return "image/webp";
    }
    if (name.endsWith(".gif")) {
      return "image/gif";
    }
    if (name.endsWith(".png")) {
      return "image/png";
    }
    return "";
  }

  function getImageExtension(mimeType, block) {
    const name = String(block?.data?.image?.name || "").toLowerCase();
    const extMatch = name.match(/\.([a-z0-9]{2,5})$/);
    if (extMatch) {
      return extMatch[1] === "jpeg" ? "jpg" : extMatch[1];
    }
    if (mimeType === "image/jpeg") {
      return "jpg";
    }
    if (mimeType === "image/webp") {
      return "webp";
    }
    if (mimeType === "image/gif") {
      return "gif";
    }
    if (mimeType === "image/png") {
      return "png";
    }
    return "bin";
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const slice = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...slice);
    }

    return btoa(binary);
  }

  function buildImageUrl(blockId, block) {
    const token = block?.data?.image?.token;
    if (!token) {
      return "";
    }

    return `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/${encodeURIComponent(token)}/?fallback_source=1&mount_node_token=${encodeURIComponent(blockId)}&mount_point=docx_image`;
  }

  function isCatalogueBlock(block, context) {
    const children = Array.isArray(block?.data?.children) ? block.data.children : [];
    if (children.length < 3) {
      return false;
    }

    return children.every((childId) => {
      const child = context.blockMap[childId];
      if (!child?.data || child.data.type !== "bullet") {
        return false;
      }

      const attribPool = child.data.text?.apool?.numToAttrib || {};
      return Object.values(attribPool).some((attrib) => {
        return Array.isArray(attrib)
          && attrib[0] === "link"
          && decodeURIComponent(String(attrib[1] || "")).includes(`${location.pathname}#`);
      });
    });
  }

  function prefixLines(value, prefix) {
    return value
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
  }

  function extractDocumentHtml() {
    return getDocumentNodes().map((page) => serializeNode(page)).join("\n");
  }

  function extractDocumentMarkdown() {
    const markdown = getDocumentNodes()
      .map((node) => convertBlock(node, 0))
      .filter(Boolean)
      .join("\n\n");

    return cleanupMarkdown(markdown);
  }

  function getDocumentNodes() {
    const root = findExportRoot();
    const rootBlock = root?.matches?.(".page-block.root-block") ? root : root?.querySelector?.(".page-block.root-block");
    const scope = rootBlock || root;

    if (!scope) {
      return [document.body];
    }

    const children = Array.from(scope.children).filter((child) => !shouldSkipExportElement(child));
    const bodyChildren = children.filter((child) => {
      if (!(child instanceof Element)) {
        return true;
      }

      return !child.classList.contains("page-block-header");
    });

    return bodyChildren.length > 0 ? bodyChildren : [scope];
  }

  function findExportRoot() {
    const selectors = [
      ".page-main-item.editor .page-block.root-block",
      ".page-main-item.editor .editor-container",
      ".page-main-item.editor",
      ".page-main .page-main-item.editor",
      ".page-main",
      ".page-block.root-block"
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => isVisible(node) && !shouldSkipExportElement(node));
      const best = pickLargestNode(candidates);
      if (best) {
        return best;
      }
    }

    const pages = Array.from(document.querySelectorAll("[data-page-id]"))
      .filter((node) => isVisible(node) && !shouldSkipExportElement(node))
      .slice(0, 200);

    if (pages.length > 0) {
      return pages[0];
    }

    return findBestRoot();
  }

  function findBestRoot() {
    const selectors = [
      "[role='main']",
      "main",
      "[class*='doc-content']",
      "[class*='document-content']",
      "[class*='page-content']",
      "[class*='editor-content']",
      "[class*='wiki-content']"
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => isVisible(node));
      const best = pickLargestNode(candidates);
      if (best) {
        return best;
      }
    }

    return document.body;
  }

  function pickLargestNode(nodes) {
    let best = null;
    let bestScore = 0;

    for (const node of nodes) {
      const textLength = (node.innerText || "").trim().length;
      const childScore = node.children.length * 20;
      const score = textLength + childScore;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }

    return best;
  }

  function serializeNode(node) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return escapeHtml(node.textContent || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const tagName = node.tagName.toLowerCase();
    if (shouldSkipNode(node, tagName) || shouldSkipExportElement(node)) {
      return "";
    }

    if (tagName === "img") {
      return serializeImage(node);
    }

    const computedStyle = window.getComputedStyle(node);
    const inlineStyle = buildInlineStyle(computedStyle);
    const attributes = [];

    for (const name of ATTRIBUTE_WHITELIST) {
      if (!node.hasAttribute(name)) {
        continue;
      }

      let value = node.getAttribute(name) || "";
      if (name === "href") {
        value = toAbsoluteUrl(value);
      } else if (name === "src") {
        value = toAbsoluteUrl(value);
      }

      attributes.push(`${name}="${escapeAttribute(value)}"`);
    }

    if (inlineStyle) {
      attributes.push(`style="${escapeAttribute(inlineStyle)}"`);
    }

    if (tagName === "a") {
      attributes.push('target="_blank"');
      attributes.push('rel="noreferrer noopener"');
    }

    const childHtml = Array.from(node.childNodes).map((child) => serializeNode(child)).join("");
    return `<${tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${childHtml}</${tagName}>`;
  }

  function serializeImage(node) {
    const src = node.currentSrc || node.getAttribute("src") || node.getAttribute("data-src") || "";
    if (!src) {
      return "";
    }

    const computedStyle = window.getComputedStyle(node);
    const inlineStyle = buildInlineStyle(computedStyle);
    const attributes = [
      `src="${escapeAttribute(toAbsoluteUrl(src))}"`,
      `alt="${escapeAttribute(node.getAttribute("alt") || "")}"`
    ];

    if (inlineStyle) {
      attributes.push(`style="${escapeAttribute(inlineStyle)}"`);
    }

    return `<img ${attributes.join(" ")} />`;
  }

  function shouldSkipNode(node, tagName) {
    if (!isVisible(node)) {
      return true;
    }

    return [
      "script",
      "style",
      "noscript",
      "textarea",
      "input",
      "button",
      "canvas",
      "iframe"
    ].includes(tagName);
  }

  function shouldSkipExportElement(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    if (node.matches?.(EXPORT_SKIP_SELECTOR)) {
      return true;
    }

    const identity = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
    if (/catalogue|comment|suggestion|rangecode|toolbar/i.test(identity)) {
      return true;
    }

    const text = stripInvisibleText(node.textContent || "").trim();
    if (text === "评论（0）" || text === "分享") {
      return true;
    }

    return false;
  }

  function isVisible(node) {
    if (!(node instanceof Element)) {
      return true;
    }

    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function buildInlineStyle(style) {
    const declarations = [];

    for (const property of STYLE_WHITELIST) {
      const value = style.getPropertyValue(property);
      if (!value) {
        continue;
      }

      if (shouldSkipStyle(property, value)) {
        continue;
      }

      declarations.push(`${property}:${value}`);
    }

    return declarations.join(";");
  }

  function shouldSkipStyle(property, value) {
    if (value === "none" && !property.startsWith("text-decoration")) {
      return true;
    }

    if (value === "normal" && ["font-style", "font-weight", "letter-spacing"].includes(property)) {
      return true;
    }

    if (value === "rgba(0, 0, 0, 0)" || value === "transparent") {
      return true;
    }

    return false;
  }

  function buildStandaloneHtml(meta, articleHtml) {
    return [
      "<!DOCTYPE html>",
      '<html lang="zh-CN">',
      "<head>",
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${escapeHtml(meta.title)}</title>`,
      "  <style>",
      "    :root { color-scheme: light; }",
      "    body { margin: 0; background: #f4efe6; color: #1f1f1f; font-family: 'PingFang SC', 'Noto Sans SC', sans-serif; }",
      "    .shell { max-width: 1080px; margin: 0 auto; padding: 40px 20px 72px; }",
      "    .card { background: #fffdf9; border: 1px solid rgba(70, 45, 14, 0.08); border-radius: 24px; box-shadow: 0 18px 40px rgba(97, 67, 24, 0.08); overflow: hidden; }",
      "    .head { padding: 28px 32px 18px; background: linear-gradient(180deg, #fff4dd 0%, #fffaf3 100%); border-bottom: 1px solid rgba(70, 45, 14, 0.08); }",
      "    .eyebrow { margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #8d5e1f; }",
      "    h1 { margin: 6px 0 10px; font-size: 30px; line-height: 1.2; }",
      "    .meta { margin: 0; color: #6b6256; font-size: 13px; line-height: 1.6; }",
      "    .content { padding: 28px 32px 40px; overflow-wrap: anywhere; }",
      "    img { max-width: 100%; height: auto; }",
      "    table { border-collapse: collapse; width: 100%; }",
      "    pre { white-space: pre-wrap; overflow-wrap: anywhere; }",
      "    a { color: #0f5ac6; }",
      "  </style>",
      "</head>",
      "<body>",
      '  <div class="shell">',
      '    <article class="card">',
      '      <header class="head">',
      '        <p class="eyebrow">Feishu Export MVP</p>',
      `        <h1>${escapeHtml(meta.title)}</h1>`,
      `        <p class="meta">页面类型: ${escapeHtml(meta.pageType)} | 导出时间: ${escapeHtml(new Date().toLocaleString())}</p>`,
      `        <p class="meta">来源: <a href="${escapeAttribute(location.href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(location.href)}</a></p>`,
      "      </header>",
      `      <section class="content">${articleHtml}</section>`,
      "    </article>",
      "  </div>",
      "</body>",
      "</html>"
    ].join("\n");
  }

  function buildMarkdownDocument(meta, body) {
    const parts = [
      `# ${meta.title}`,
      "",
      `- 页面类型: ${meta.pageType}`,
      `- 来源: ${location.href}`,
      meta.author ? `- 作者: ${meta.author}` : "",
      meta.publishTime ? `- 发布时间: ${meta.publishTime}` : "",
      `- 导出时间: ${new Date().toLocaleString()}`,
      "",
      "---",
      "",
      body || "_未提取到正文内容_"
    ];

    return cleanupMarkdown(parts.join("\n"));
  }

  function buildFilename(title, extension) {
    const safeTitle = sanitizeFilename(title || "local-document");
    return `${safeTitle}.${extension}`;
  }

  function sanitizeFilename(value) {
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    let normalized = value
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120);

    if (!normalized) {
      normalized = "local-document";
    }

    if (reserved.test(normalized)) {
      normalized = `file-${normalized}`;
    }

    return normalized;
  }

  function normalizeTitle(value) {
    return stripInvisibleText(String(value || ""))
      .replace(/\s+-\s+飞书.*/, "")
      .replace(/\s+-\s+Lark.*/, "")
      .trim() || "未命名文档";
  }

  function normalizeGenericTitle(value) {
    return stripInvisibleText(String(value || ""))
      .replace(/\s*[\-|_·•｜|]\s*[^|｜\-_·•]{1,20}$/u, "")
      .trim() || "未命名网页";
  }

  function extractGenericPageTitle() {
    const selector = [
      ".post-detail-content h1",
      ".post-detail-content [class*='title']",
      "[class*='post-detail'] h1",
      "[class*='article'] h1",
      "[class*='entry'] h1",
      ".article-title",
      ".post-title",
      ".entry-title"
    ].join(", ");

    const candidates = Array.from(document.querySelectorAll(selector));
    for (const node of candidates) {
      if (!isVisible(node) || isGenericBodyHeading(node)) {
        continue;
      }

      const text = cleanupInline(node.textContent || "");
      if (text) {
        return text;
      }
    }

    return "";
  }

  function isGenericBodyHeading(node) {
    return Boolean(node.closest?.(".note-content, .feishu-doc-content, .doc-item, .vc-doc-item"));
  }

  function extractVisibleTitle() {
    const selectors = [
      ".page-block-header h1",
      "h1.page-block-content",
      ".page-main-item.editor h1",
      "h1",
      "[role='heading'][aria-level='1']"
    ];

    for (const selector of selectors) {
      const node = Array.from(document.querySelectorAll(selector)).find((element) => {
        const text = stripInvisibleText(element.textContent || "").trim();
        return isVisible(element) && text.length > 0;
      });

      if (node) {
        return normalizeTitle(node.textContent || "");
      }
    }

    return "";
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (error) {
      return url;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttribute(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
  }

  function convertBlock(node, depth) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return normalizeInlineText(node.textContent || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE || !isVisible(node) || shouldSkipExportElement(node)) {
      return "";
    }

    const tagName = node.tagName.toLowerCase();

    if (["script", "style", "noscript", "textarea", "input", "button", "canvas", "iframe"].includes(tagName)) {
      return "";
    }

    if (tagName === "img") {
      return imageToMarkdown(node);
    }

    if (isScysBulletContainer(node)) {
      return scysBulletContainerToMarkdown(node, depth);
    }

    if (isScysOrderedListBlock(node)) {
      return scysOrderedBlockToMarkdown(node, depth);
    }

    if (tagName === "br") {
      return "\n";
    }

    if (tagName === "hr") {
      return "---";
    }

    if (tagName === "pre") {
      return codeBlockToMarkdown(node);
    }

    if (isScysRenderedTableBlock(node)) {
      return scysRenderedTableToMarkdown(node);
    }

    if (tagName === "table") {
      return tableToMarkdown(node);
    }

    if (tagName === "ul" || tagName === "ol") {
      return listToMarkdown(node, depth);
    }

    if (tagName === "blockquote") {
      const content = cleanupMarkdown(Array.from(node.childNodes).map((child) => convertBlock(child, depth + 1)).join("\n"));
      return content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }

    const headingLevel = getHeadingLevel(node);
    if (headingLevel) {
      const content = cleanupMarkdown(convertInlineChildren(node));
      if (!content || content === normalizeTitle(extractVisibleTitle())) {
        return "";
      }
      return `${"#".repeat(headingLevel)} ${content}`;
    }

    if (tagName === "li") {
      return listItemToMarkdown(node, depth, false, 0);
    }

    if (isBlockNode(tagName)) {
      const childBlocks = Array.from(node.childNodes)
        .map((child) => convertBlock(child, depth))
        .filter(Boolean);

      if (childBlocks.length > 0 && hasMeaningfulBlockChildren(node)) {
        return cleanupMarkdown(childBlocks.join("\n\n"));
      }

      const paragraph = cleanupMarkdown(convertInlineChildren(node));
      return paragraph;
    }

    return convertInline(node);
  }

  function convertInline(node) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return normalizeInlineText(node.textContent || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE || !isVisible(node) || shouldSkipExportElement(node)) {
      return "";
    }

    const tagName = node.tagName.toLowerCase();

    if (tagName === "br") {
      return "  \n";
    }

    if (tagName === "img") {
      return imageToMarkdown(node);
    }

    if (tagName === "a") {
      const text = cleanupMarkdown(convertInlineChildren(node)) || normalizeInlineText(node.textContent || "");
      const href = toAbsoluteUrl(node.getAttribute("href") || "");
      return href ? `[${text || href}](${href})` : text;
    }

    if (tagName === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") {
      const content = normalizeInlineText(node.textContent || "");
      return content ? `\`${content}\`` : "";
    }

    const content = convertInlineChildren(node);
    if (!content) {
      return "";
    }

    if (["strong", "b"].includes(tagName)) {
      return `**${content}**`;
    }

    if (["em", "i"].includes(tagName)) {
      return `*${content}*`;
    }

    if (tagName === "s" || tagName === "del") {
      return `~~${content}~~`;
    }

    return content;
  }

  function convertInlineChildren(node) {
    return joinInlineFragments(
      Array.from(node.childNodes).map((child) => convertInline(child))
    );
  }

  function isScysBulletContainer(node) {
    return node instanceof Element && node.classList.contains("bullet_container");
  }

  function isScysOrderedListBlock(node) {
    return node instanceof Element && node.classList.contains("block-order");
  }

  function scysBulletContainerToMarkdown(node, depth) {
    const listNode = node.querySelector(":scope > .row > .list") || node.querySelector(".list");
    const content = cleanupMarkdown(convertInlineChildren(listNode || node));
    if (!content) {
      return "";
    }

    return `${"  ".repeat(depth)}- ${content}`;
  }

  function scysOrderedBlockToMarkdown(node, depth) {
    const markerText = cleanupInline(node.querySelector(":scope > .order-marker")?.textContent || "");
    const normalizedMarker = /^\d+[.)]?$/.test(markerText)
      ? markerText.replace(/\)+$/, ".")
      : "1.";
    const listNode = node.querySelector(":scope > .list") || node.querySelector(".list");
    const content = cleanupMarkdown(convertInlineChildren(listNode || node));
    if (!content) {
      return "";
    }

    return `${"  ".repeat(depth)}${normalizedMarker} ${content}`;
  }

  function isScysRenderedTableBlock(node) {
    return node instanceof Element
      && node.classList.contains("table")
      && getScysRenderedTableColumnCount(node) > 0;
  }

  function getScysRenderedTableColumnCount(node) {
    const className = typeof node.className === "string" ? node.className : "";
    const classMatch = className.match(/\btable_(\d+)\b/);
    if (classMatch) {
      return Number(classMatch[1]) || 0;
    }

    const gridStyle = node.children?.[0]?.getAttribute?.("style") || "";
    const styleMatch = gridStyle.match(/grid-template-columns\s*:\s*([^;]+)/i);
    if (!styleMatch) {
      return 0;
    }

    const repeatMatch = styleMatch[1].match(/repeat\(\s*(\d+)\s*,/i);
    if (repeatMatch) {
      return Number(repeatMatch[1]) || 0;
    }

    return styleMatch[1].split(/\s+/).filter(Boolean).length;
  }

  function scysRenderedTableToMarkdown(tableNode) {
    const columnCount = getScysRenderedTableColumnCount(tableNode);
    const cells = Array.from(tableNode.querySelectorAll(".table_cell"))
      .map((cell) => escapeMarkdownTableCell(convertScysRenderedTableCell(cell)));

    if (columnCount <= 0 || cells.length === 0) {
      return "";
    }

    const rows = [];
    for (let index = 0; index < cells.length; index += columnCount) {
      const row = cells.slice(index, index + columnCount);
      while (row.length < columnCount) {
        row.push("");
      }
      rows.push(row);
    }

    const header = rows[0];
    const separator = new Array(columnCount).fill("---");
    return [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`)
    ].join("\n");
  }

  function convertScysRenderedTableCell(cell) {
    return cleanupMarkdown(
      Array.from(cell.childNodes)
        .map((child) => convertBlock(child, 0))
        .filter(Boolean)
        .join("\n")
    );
  }

  function listToMarkdown(listNode, depth) {
    const ordered = listNode.tagName.toLowerCase() === "ol";
    const items = Array.from(listNode.children).filter((child) => child.tagName?.toLowerCase() === "li");

    return items
      .map((item, index) => listItemToMarkdown(item, depth, ordered, index))
      .join("\n");
  }

  function listItemToMarkdown(item, depth, ordered, index) {
    const indent = "  ".repeat(depth);
    const marker = ordered ? `${index + 1}. ` : "- ";
    const inlineParts = [];
    const nestedLists = [];

    for (const child of Array.from(item.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childTag = child.tagName.toLowerCase();
        if (childTag === "ul" || childTag === "ol") {
          nestedLists.push(child);
          continue;
        }
      }

      inlineParts.push(convertInline(child));
    }

    const head = joinInlineFragments(inlineParts) || " ";
    const tail = nestedLists
      .map((list) => listToMarkdown(list, depth + 1))
      .filter(Boolean)
      .join("\n");

    return `${indent}${marker}${head}${tail ? `\n${tail}` : ""}`;
  }

  function codeBlockToMarkdown(node) {
    const content = (node.textContent || "").replace(/\n+$/, "");
    return `\`\`\`\n${content}\n\`\`\``;
  }

  function imageToMarkdown(node) {
    const src = node.currentSrc || node.getAttribute("src") || node.getAttribute("data-src") || "";
    if (!src) {
      return "";
    }

    const alt = normalizeInlineText(node.getAttribute("alt") || "");
    return `![${alt}](${toAbsoluteUrl(src)})`;
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((row) => Array.from(row.children).map((cell) => cleanupInline(convertInlineChildren(cell))))
      .filter((row) => row.length > 0);

    if (rows.length === 0) {
      return "";
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => {
      const copy = row.slice();
      while (copy.length < columnCount) {
        copy.push("");
      }
      return copy;
    });

    const header = normalizedRows[0];
    const separator = new Array(columnCount).fill("---");
    const body = normalizedRows.slice(1);
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`
    ];

    for (const row of body) {
      lines.push(`| ${row.join(" | ")} |`);
    }

    return lines.join("\n");
  }

  function getHeadingLevel(node) {
    const tagName = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) {
      return Number(tagName[1]);
    }

    const ariaLevel = node.getAttribute("aria-level");
    if (node.getAttribute("role") === "heading" && ariaLevel) {
      return Math.min(Math.max(Number(ariaLevel) || 1, 1), 6);
    }

    const style = window.getComputedStyle(node);
    const fontSize = Number.parseFloat(style.fontSize || "0");
    const fontWeight = Number.parseInt(style.fontWeight || "400", 10);

    if (fontWeight >= 600 && fontSize >= 28) {
      return 1;
    }

    if (fontWeight >= 600 && fontSize >= 22) {
      return 2;
    }

    if (fontWeight >= 600 && fontSize >= 18) {
      return 3;
    }

    return 0;
  }

  function isBlockNode(tagName) {
    return [
      "article",
      "section",
      "main",
      "div",
      "p",
      "header",
      "footer",
      "aside",
      "figure",
      "figcaption"
    ].includes(tagName);
  }

  function hasMeaningfulBlockChildren(node) {
    return Array.from(node.children).some((child) => {
      const tagName = child.tagName.toLowerCase();
      return ["div", "p", "section", "article", "ul", "ol", "table", "pre", "blockquote"].includes(tagName);
    });
  }

  function cleanupInline(value) {
    return stripInvisibleText(value).replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();
  }

  function cleanupMarkdown(value) {
    return stripInvisibleText(value)
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeInlineText(value) {
    return stripInvisibleText(String(value || "").replace(/\s+/g, " "));
  }

  function stripInvisibleText(value) {
    return String(value || "")
      .replace(INVISIBLE_TEXT_RE, "")
      .replace(/\u00A0/g, " ");
  }

  function stripMarkdownImages(value) {
    return cleanupMarkdown(
      String(value || "")
        .replace(/!\[[^\]]*]\([^)]+\)/g, "")
        .replace(/<img\b[^>]*>/gi, "")
    );
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      __test: {
        convertBlock,
        getGenericWebMeta,
        captureWebSnapshot,
        cloneWebCaptureRoot,
        waitForWebCaptureRoot,
        isGoogleDocsPage,
        getGoogleDocsMeta,
        buildGoogleDocsExportUrl,
        exportGoogleDocsDocument,
        parseGoogleDocsExportHtml,
        normalizeGoogleDocsPlainText
      }
    };
  }
})();
