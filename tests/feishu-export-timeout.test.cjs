const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadExporterForTest(fetchImpl, { width = 3264, height = 2448 } = {}) {
  const sourcePath = path.join(__dirname, "../content-scripts/feishu-exporter.js");
  const source = fs.readFileSync(sourcePath, "utf8").replace(
    "convertBlock,\n        getGenericWebMeta",
    "convertBlock,\n        getGenericWebMeta,\n        convertClientVarsToMarkdown"
  );
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    Blob,
    Uint8Array,
    AbortController,
    createImageBitmap: async () => ({ width, height, close() {} }),
    FileReader: class {
      readAsDataURL() {}
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    Element: class {},
    window: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    },
    location: {
      href: "https://example.feishu.cn/wiki/wikiToken",
      hostname: "example.feishu.cn",
      pathname: "/wiki/wikiToken",
      protocol: "https:",
      origin: "https://example.feishu.cn"
    },
    document: {
      scripts: [],
      title: "测试文档",
      querySelector: () => null,
      querySelectorAll: () => []
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} }
      }
    },
    fetch: fetchImpl,
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/image-asset.js"), "utf8"), sandbox);
  vm.runInNewContext(source, sandbox, { filename: sourcePath });
  return { ...sandbox.module.exports.__test, sandbox };
}

function buildClientVarsWithImage(count = 1) {
  const blockMap = {
    docToken: {
      data: {
        children: Array.from({ length: count }, (_, index) => `imageBlock${index + 1}`)
      }
    }
  };

  for (let index = 1; index <= count; index += 1) {
    blockMap[`imageBlock${index}`] = {
      data: {
        type: "image",
        image: {
          token: `imageToken${index}`,
          name: count === 1 ? "配图" : `配图${index}`
        }
      }
    };
  }

  return {
    data: {
      block_map: blockMap
    }
  };
}

async function assertSettlesWithin(promise, timeoutMs) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
  const result = await Promise.race([promise, timeout]);
  assert.notEqual(result, "timeout");
  return result;
}

(async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438HwHwAGmAKHfbWTmQAAAABJRU5ErkJggg==", "base64");
  let fetchCalls = 0;
  const exporter = loadExporterForTest(async (url, options) => {
    assert.match(url, /\/download\/preview\/imageToken1\/\?preview_type=16$/);
    assert.equal(options.credentials, "include");
    fetchCalls += 1;
    return {
      ok: true,
      blob: async () => new Blob([bytes], { type: "image/jpeg" })
    };
  });
  const assets = [];

  const markdown = await assertSettlesWithin(
    exporter.convertClientVarsToMarkdown(
      {
        exportToken: "docToken",
        pageTitle: "测试文档",
        title: "测试文档"
      },
      buildClientVarsWithImage(),
      {
        includeImages: true,
        localImageAssets: true,
        imageFetchTimeoutMs: 20,
        assets
      }
    ),
    100
  );

  assert.equal(fetchCalls, 1);
  assert.doesNotMatch(markdown, /data:image\//);
  assert.doesNotMatch(markdown, /internal-api-drive-stream\.feishu\.cn/);
  assert.match(markdown, /!\[配图]\(assets\/image-001\.png\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(assets)), [
    {
      path: "assets/image-001.png",
      mimeType: "image/png",
      contentBase64: bytes.toString("base64")
    }
  ]);

  {
    let linkedFetchCalls = 0;
    const linkedExporter = loadExporterForTest(async () => {
      linkedFetchCalls += 1;
      return new Promise(() => {});
    });

    const linkedMarkdown = await assertSettlesWithin(
      linkedExporter.convertClientVarsToMarkdown(
        {
          exportToken: "docToken",
          pageTitle: "测试文档",
          title: "测试文档"
        },
        buildClientVarsWithImage(3),
        {
          includeImages: true,
          localImageAssets: false,
          assets: []
        }
      ),
      20
    );

    assert.equal(linkedFetchCalls, 0);
    assert.match(linkedMarkdown, /!\[配图1]\(https:\/\/internal-api-drive-stream\.feishu\.cn/);
    assert.match(linkedMarkdown, /!\[配图2]\(https:\/\/internal-api-drive-stream\.feishu\.cn/);
    assert.match(linkedMarkdown, /!\[配图3]\(https:\/\/internal-api-drive-stream\.feishu\.cn/);
  }

  {
    let hangingFetchCalls = 0;
    const hangingExporter = loadExporterForTest(async () => {
      hangingFetchCalls += 1;
      return new Promise(() => {});
    });
    const hangingAssets = [];

    await assert.rejects(assertSettlesWithin(
      hangingExporter.convertClientVarsToMarkdown(
        { exportToken: "docToken", title: "测试文档" }, buildClientVarsWithImage(3),
        { includeImages: true, localImageAssets: true, imageFetchTimeoutMs: 20, assets: hangingAssets }
      ), 100
    ), /原图读取超时/);
    assert.equal(hangingFetchCalls, 3);
    assert.deepEqual(hangingAssets, []);

  }

  for (const [name, fetchImpl, expected] of [
    ["HTTP error", async () => ({ ok: false, status: 403 }), /HTTP 403/],
    ["login page", async () => ({ ok: true, blob: async () => new Blob(["<html>login</html>"], { type: "image/jpeg" }) }), /格式无效/],
    ["hanging body", async () => ({ ok: true, blob: async () => new Promise(() => {}) }), /原图读取超时/]
  ]) {
    const failed = loadExporterForTest(fetchImpl), failedAssets = [];
    await assert.rejects(assertSettlesWithin(failed.convertClientVarsToMarkdown(
      { exportToken: "docToken", title: name }, buildClientVarsWithImage(),
      { includeImages: true, localImageAssets: true, imageFetchTimeoutMs: 20, assets: failedAssets }
    ), 100), expected);
    assert.deepEqual(failedAssets, []);
  }

  {
    const thumbnail = loadExporterForTest(async () => ({ ok: true, blob: async () => new Blob([bytes]) }), { width: 1280, height: 710 });
    const original = buildClientVarsWithImage();
    original.data.block_map.imageBlock1.data.image.width = 1940;
    original.data.block_map.imageBlock1.data.image.height = 1076;
    await assert.rejects(thumbnail.convertClientVarsToMarkdown({ exportToken: "docToken", title: "Original" }, original,
      { includeImages: true, localImageAssets: true, assets: [] }), /像素小于原图/);
  }

  {
    const navigation = loadExporterForTest(async () => {
      navigation.sandbox.location.href = "https://example.feishu.cn/wiki/other";
      return { ok: true, blob: async () => new Blob([bytes], { type: "image/png" }) };
    });
    const navigationAssets = [];
    await assert.rejects(navigation.convertClientVarsToMarkdown({ exportToken: "docToken", title: "Original" }, buildClientVarsWithImage(),
      { includeImages: true, localImageAssets: true, assets: navigationAssets }), /源文档已跳转/);
    assert.deepEqual(navigationAssets, []);
  }

  {
    let calls = 0;
    const noImage = loadExporterForTest(async () => { calls++; throw new Error("No fetch expected"); });
    // An image-only document becomes empty in text-only mode; importantly it
    // still never downloads the image before reporting the existing empty-body error.
    await assert.rejects(noImage.convertClientVarsToMarkdown({ exportToken: "docToken", title: "Original" }, buildClientVarsWithImage(),
      { includeImages: false, localImageAssets: true, assets: [] }), /正文块解析后为空/);
    assert.equal(calls, 0);
    const bad = buildClientVarsWithImage(); delete bad.data.block_map.imageBlock1.data.image.token;
    await assert.rejects(noImage.convertClientVarsToMarkdown({ exportToken: "docToken", title: "Original" }, bad,
      { includeImages: true, localImageAssets: true, assets: [] }), /缺少原图标识/);
    const laterBad = buildClientVarsWithImage(2); delete laterBad.data.block_map.imageBlock2.data.image.token;
    await assert.rejects(noImage.convertClientVarsToMarkdown({ exportToken: "docToken", title: "Original" }, laterBad,
      { includeImages: true, localImageAssets: true, assets: [] }), /第 2 张图片缺少原图标识/);
    assert.equal(calls, 0, "validate the whole source list before starting any image request");
  }
})();
