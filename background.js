importScripts("shared/feishu-wiki-clip.js", "shared/web-image-capture.js", "shared/feishu-clip-service.js");

const MESSAGE_FETCH_ASSET = "exporter:fetch-asset";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_FETCH_ASSET) {
    return false;
  }

  fetchAssetAsDataUrl(message.url)
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "资源获取失败" }));

  return true;
});

async function fetchAssetAsDataUrl(url) {
  if (!url) {
    throw new Error("资源地址为空");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`资源获取失败: ${response.status}`);
  }

  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const mimeType = blob.type || guessMimeType(url) || "application/octet-stream";
  return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;
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

function guessMimeType(url) {
  const lower = String(url || "").toLowerCase();
  if (lower.includes("wx_fmt=png") || lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.includes("wx_fmt=gif") || lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.includes("wx_fmt=webp") || lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.includes("wx_fmt=jpeg") || lower.includes("wx_fmt=jpg") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  return "";
}
