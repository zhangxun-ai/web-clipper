(function (scope) {
  "use strict";
  if (scope.FeishuImageCapture?.version === 2) return;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

  async function capture({ sourceUrl, blockId, token, width, height }) {
    const expected = new URL(sourceUrl);
    if (expected.origin !== location.origin || expected.pathname.replace(/\/$/, "") !== location.pathname.replace(/\/$/, "")
      || !/(^|\.)(feishu\.cn|larkoffice\.com)$/.test(location.hostname)
      || !/^\/(docx|wiki)\/[A-Za-z0-9]+\/?$/.test(location.pathname)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(token) || !/^[A-Za-z0-9_-]{1,128}$/.test(blockId)) {
      throw new Error("源页面已改变，请回到要剪存的文档后重试。");
    }
    // The document image viewer uses preview_type=16 for full-resolution images.
    // The existing exporter's cover endpoint silently caps large images at 1280px.
    const url = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/${encodeURIComponent(token)}/?preview_type=16`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}），请确认源页面仍可正常显示图片。`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/") || !blob.size || blob.size > MAX_IMAGE_BYTES) {
        throw new Error("图片为空、格式无效或超过 20 MiB，已停止剪存以免遗漏图片。");
      }
      const bitmap = await createImageBitmap(blob);
      const pixelWidth = bitmap.width, pixelHeight = bitmap.height;
      bitmap.close();
      if ((Number.isFinite(width) && pixelWidth < width) || (Number.isFinite(height) && pixelHeight < height)) {
        throw new Error("图片服务返回的像素小于原图，已停止创建文档；请稍后继续读取原图。");
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return { mimeType: blob.type, size: bytes.length, pixelWidth, pixelHeight, contentBase64: btoa(binary) };
    } catch (error) {
      if (error.name === "AbortError") throw new Error("图片读取超时，请稍后继续；已下载的图片会保留。");
      throw error;
    } finally { clearTimeout(timer); }
  }

  scope.FeishuImageCapture = { capture, version: 2 };
})(globalThis);
