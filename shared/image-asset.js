(function (scope) {
  "use strict";
  function mimeFromBytes(bytes) {
    const starts = signature => signature.every((value, index) => bytes[index] === value);
    if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
    if (starts([255, 216, 255])) return "image/jpeg";
    if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97])) return "image/gif";
    if (starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return "image/webp";
    if (starts([66, 77])) return "image/bmp";
    return null;
  }

  async function read(blob) {
    if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error("图片为空、格式无效或超过 20 MiB，已停止保存以免遗漏图片。");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // CDN Content-Type is advisory: the same PNG can be labelled image/jpeg.
    // Keep the original bytes, and require both a supported signature and decoding.
    const mimeType = mimeFromBytes(bytes);
    if (!mimeType) throw new Error("图片格式无效或暂不支持，已停止保存以免遗漏图片。");
    let bitmap;
    try { bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType })); }
    catch (_) { throw new Error("图片文件无法完整解码，已停止保存以免遗漏图片。"); }
    const pixelWidth = bitmap.width, pixelHeight = bitmap.height;
    bitmap.close();
    if (![pixelWidth, pixelHeight].every(value => Number.isInteger(value) && value > 0 && value <= 100000)) {
      throw new Error("图片像素尺寸无效，已停止保存以免遗漏图片。");
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { mimeType, size: bytes.length, pixelWidth, pixelHeight, contentBase64: btoa(binary) };
  }
  scope.ImageAsset = { read, mimeFromBytes };
})(globalThis);
