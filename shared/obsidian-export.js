(function (globalScope) {
  function namespaceObsidianAssets(markdown, assets, namespace) {
    const files = Array.isArray(assets) ? assets : [];
    let content = String(markdown || "");
    if (files.length && !/^[a-zA-Z0-9-]{1,80}$/.test(String(namespace || ""))) {
      throw new Error("Obsidian 图片目录无效");
    }
    const mapped = files.map(asset => {
      const path = String(asset?.path || "");
      if (!path || path.split("/").some(part => !part || part === "." || part === "..")
        || /[\\\u0000-\u001f:]/.test(path) || !asset.contentBase64) {
        throw new Error("Obsidian 图片文件无效，未写入不完整笔记");
      }
      const mappedPath = `assets/${namespace}/${path.replace(/^assets\//, "")}`;
      content = content.split(`(${path})`).join(`(${mappedPath})`);
      return { ...asset, path: mappedPath };
    });
    return { markdown: content, assets: mapped };
  }

  function buildObsidianNoteFile(payload) {
    const title = cleanupTitle(payload?.title, "未命名文档");
    const exportedAt = normalizeIsoTimestamp(payload?.exportedAt);
    const dateFolder = exportedAt.slice(0, 10);
    const sourceUrl = String(payload?.sourceUrl || "").trim();
    const markdown = String(payload?.markdown || "").trim();
    const path = [
      "文档本地导出",
      "单篇文档",
      dateFolder,
      `${sanitizePathSegment(title)}.md`
    ].join("/");

    return {
      path,
      content: [
        "---",
        `title: ${escapeFrontmatterString(title)}`,
        sourceUrl ? `source: ${escapeFrontmatterString(sourceUrl)}` : "",
        `exported_at: "${exportedAt}"`,
        'tags: ["local-export"]',
        "---",
        "",
        `# ${title}`,
        "",
        markdown,
        ""
      ].filter(Boolean).join("\n")
    };
  }

  function buildObsidianCourseBundle(payload) {
    const title = cleanupTitle(payload?.title, "未命名专栏");
    const sourceUrl = String(payload?.sourceUrl || "").trim();
    const exportedAt = normalizeIsoTimestamp(payload?.exportedAt);
    const chapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
    const failedChapters = Array.isArray(payload?.failedChapters) ? payload.failedChapters : [];
    const folderPath = ["文档本地导出", "课程专栏", sanitizePathSegment(title)].join("/");
    const chapterFiles = chapters.map((chapter) => buildCourseChapterFile(folderPath, title, exportedAt, chapter));
    const indexPath = `${folderPath}/index.md`;
    const groupedChapters = groupChapters(chapters);
    const indexContent = [
      "---",
      `title: ${escapeFrontmatterString(title)}`,
      sourceUrl ? `source: ${escapeFrontmatterString(sourceUrl)}` : "",
      `exported_at: "${exportedAt}"`,
      `chapter_count: ${chapters.length}`,
      `failed_count: ${failedChapters.length}`,
      'tags: ["local-export", "scys-course"]',
      "---",
      "",
      `# ${title}`,
      "",
      sourceUrl ? `来源：${sourceUrl}` : "",
      `导出时间：${exportedAt}`,
      `成功：${chapters.length} 章`,
      `失败：${failedChapters.length} 章`,
      "",
      "## 目录",
      "",
      ...buildIndexLines(groupedChapters, chapterFiles),
      failedChapters.length > 0 ? "\n## 失败章节\n" : "",
      ...failedChapters.map((chapter) => `- ${cleanupTitle(chapter?.title, "未命名章节")} | ${String(chapter?.message || "未知错误").trim() || "未知错误"}`),
      ""
    ].filter(Boolean).join("\n");

    return {
      folderPath,
      indexPath,
      files: [{ path: indexPath, content: indexContent }, ...chapterFiles]
    };
  }

  function buildCourseChapterFile(folderPath, courseTitle, exportedAt, chapter) {
    const order = Number(chapter?.order) || 0;
    const chapterTitle = cleanupTitle(chapter?.title, `章节 ${order || 0}`);
    const sectionTitle = cleanupTitle(chapter?.sectionTitle, "");
    const sourceUrl = String(chapter?.url || "").trim();
    const chapterId = String(chapter?.chapterId || "").trim();
    const safeFilename = `${String(order).padStart(3, "0")}-${sanitizePathSegment(chapterTitle)}.md`;
    const path = `${folderPath}/chapters/${safeFilename}`;
    const content = [
      "---",
      `title: ${escapeFrontmatterString(chapterTitle)}`,
      `course: ${escapeFrontmatterString(courseTitle)}`,
      sectionTitle ? `section: ${escapeFrontmatterString(sectionTitle)}` : "",
      `order: ${order}`,
      chapterId ? `chapter_id: "${chapterId}"` : "",
      sourceUrl ? `source: ${escapeFrontmatterString(sourceUrl)}` : "",
      `exported_at: "${exportedAt}"`,
      'tags: ["local-export", "scys-course"]',
      "---",
      "",
      `# ${chapterTitle}`,
      "",
      String(chapter?.markdown || "").trim(),
      ""
    ].filter(Boolean).join("\n");

    return {
      path,
      title: chapterTitle,
      sectionTitle,
      content
    };
  }

  function buildIndexLines(groups, chapterFiles) {
    const pathByKey = new Map(chapterFiles.map((file) => [buildChapterKey(file.title, file.sectionTitle), file]));
    const lines = [];

    for (const group of groups) {
      if (group.sectionTitle) {
        lines.push(`- ${group.sectionTitle}`);
      }

      for (const chapter of group.chapters) {
        const file = pathByKey.get(buildChapterKey(chapter.title, chapter.sectionTitle));
        const prefix = group.sectionTitle ? "  " : "";
        const linkPath = file?.path.split("/").slice(-2).join("/").replace(/\.md$/i, "") || `chapters/${sanitizePathSegment(chapter.title)}`;
        lines.push(`${prefix}- [[${linkPath}|${chapter.title}]]`);
      }
    }

    return lines;
  }

  function groupChapters(chapters) {
    const groups = [];
    let currentGroup = null;

    for (const chapter of chapters) {
      const sectionTitle = cleanupTitle(chapter?.sectionTitle, "");
      if (!currentGroup || currentGroup.sectionTitle !== sectionTitle) {
        currentGroup = {
          sectionTitle,
          chapters: []
        };
        groups.push(currentGroup);
      }
      currentGroup.chapters.push({
        title: cleanupTitle(chapter?.title, "未命名章节"),
        sectionTitle
      });
    }

    return groups;
  }

  function buildChapterKey(title, sectionTitle) {
    return `${sectionTitle}::${title}`;
  }

  function cleanupTitle(value, fallback) {
    const cleaned = String(value || "").replace(/\s+/g, " ").trim();
    return cleaned || fallback;
  }

  function sanitizePathSegment(value) {
    const cleaned = cleanupTitle(value, "untitled")
      .replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 80);
    return cleaned || "untitled";
  }

  function normalizeIsoTimestamp(value) {
    const raw = String(value || "").trim();
    if (raw && !Number.isNaN(Date.parse(raw))) {
      return new Date(raw).toISOString();
    }
    return new Date().toISOString();
  }

  function escapeFrontmatterString(value) {
    const text = String(value || "").replace(/\r?\n/g, " ").trim();
    if (/^[\w\u4E00-\u9FFF\s\-./:?=&()]+$/u.test(text)) {
      return text;
    }
    return JSON.stringify(text);
  }

  const api = {
    namespaceObsidianAssets,
    buildObsidianNoteFile,
    buildObsidianCourseBundle
  };

  globalScope.ObsidianExport = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
