(function (scope) {
  "use strict";
  async function capture({ sourceUrl, url }) {
    if (location.href !== sourceUrl || !/^https?:$/.test(location.protocol)) throw new Error("源网页已跳转，请重新选择。");
    return readImage(new URL(url, sourceUrl).href, "same-origin");
  }
  async function readImage(url, credentials) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !["http:", "https:", "data:"].includes(parsed.protocol)
      || parsed.protocol === "data:" && !/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(url)) {
      throw new Error("网页图片地址无效。");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      // Same-origin images may use the page login; cross-origin CDNs generally
      // use public CORS and must not receive this page's credentials.
      const response = await fetch(parsed.href, { credentials, signal: controller.signal });
      if (!response.ok) throw new Error(`网页图片读取失败（HTTP ${response.status}）。`);
      const blob = await response.blob();
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/i.test(blob.type) || !blob.size || blob.size > 20 * 1024 * 1024) {
        throw new Error("网页图片为空、格式暂不支持或超过 20 MiB，未创建缺图文档。");
      }
      const bitmap = await createImageBitmap(blob);
      const pixelWidth = bitmap.width, pixelHeight = bitmap.height;
      bitmap.close();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { mimeType: blob.type, size: bytes.length, pixelWidth, pixelHeight, contentBase64: btoa(binary) };
    } catch (error) {
      if (error.name === "AbortError") throw new Error("网页图片读取超时，请稍后继续；已保存的图片会保留。");
      if (error.name === "TypeError") throw new Error("网站暂不允许读取该图片，请保持原网页打开并稍后重试。");
      throw error;
    } finally { clearTimeout(timer); }
  }
  // Called only by the extension service after checking its existing host grant.
  scope.WebImageCapture = { capture, capturePublic: url => readImage(url, "omit") };
})(globalThis);
