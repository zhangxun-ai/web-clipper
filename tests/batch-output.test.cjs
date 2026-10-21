const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const outputModels = require('../shared/export-ui-models.js');
const obsidianExport = require('../shared/obsidian-export.js');
const vaultStorage = require('../shared/obsidian-vault-storage.js');

const runnerSource = fs.readFileSync(require.resolve('../batch-runner.js'), 'utf8');
function section(start, end) {
  const from = runnerSource.indexOf(start);
  const to = end ? runnerSource.indexOf(end, from) : runnerSource.length;
  assert.ok(from >= 0 && to > from, `production section missing: ${start}`);
  return runnerSource.slice(from, to);
}

// Exercise production orchestration, permission checks, Markdown writer, retry,
// status/stat rendering and ZIP bytes. Only source/network/download transport and
// directory handles are fixtures; no user's vault or remote API is accessed.
function createRunner({ permission = 'granted', sourceFailures = [], writeFailures = [], zipFails = false, missingWriter = false } = {}) {
  const state = { permission, sourceFailures: new Set(sourceFailures), writeFailures: new Set(writeFailures),
    sourceCalls: [], writes: [], written: new Map(), downloads: [], permissionRequests: 0, zipFails };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', hidden: true, disabled: false, children: [],
      prepend(child) { this.children.unshift(child); } });
    return elements.get(id);
  };
  const directory = prefix => ({
    async queryPermission() { return state.permission; },
    async requestPermission() { state.permissionRequests += 1; return state.permission; },
    async getDirectoryHandle(name) { return directory(`${prefix}${name}/`); },
    async getFileHandle(name) {
      const path = `${prefix}${name}`;
      return { async createWritable() { return {
        async write(content) {
          state.writes.push({ path, content });
          if (state.writeFailures.has(name)) throw new Error('fixture: disk full');
          state.written.set(path, content);
        },
        async close() {}
      }; } };
    }
  });
  const handle = directory('');
  const blobs = new Map();
  const storage = { ...vaultStorage, getVaultBinding: async () => ({ handle }) };
  if (missingWriter) delete storage.writeTextFiles;
  const context = {
    Blob, TextEncoder, Uint8Array, Uint32Array, DataView,
    document: { createElement: () => ({ textContent: '', className: '' }) },
    statusEl: element('status'), progressEl: element('progress'), successEl: element('success'), failureEl: element('failure'),
    obsidianRetryPanelEl: element('retryPanel'), obsidianRetryCopyEl: element('retryCopy'), retryObsidianWriteButton: element('retryButton'),
    resultSummaryEl: element('results'), resultListEl: element('resultList'), logEl: element('logs'), resultEntryCache: new Set(),
    INTER_TASK_DELAY_MS: 0, sleep: async () => {}, setStopTaskActive() {},
    normalizeOutputTarget: outputModels.normalizeOutputTarget, getOutputTargetState: outputModels.getOutputTargetState,
    obsidianVaultStorage: storage, buildObsidianNoteFile: obsidianExport.buildObsidianNoteFile,
    buildObsidianCourseBundle: obsidianExport.buildObsidianCourseBundle,
    maybeStripWechatUiNoiseFromMarkdown: text => String(text).trim(),
    URL: { createObjectURL(blob) { const url = `blob:fixture-${blobs.size}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); } },
    setTimeout(callback) { callback(); },
    exportLinkWithRetry: async (url, options) => {
      state.sourceCalls.push({ url, options });
      if (state.sourceFailures.has(url)) throw new Error('fixture: source unavailable');
      return article(url);
    },
    downloadFile: async request => {
      const blob = blobs.get(request.url);
      state.downloads.push({ ...request, blob });
      if (state.zipFails && request.filename.endsWith('.zip')) throw new Error('fixture: download interrupted');
    }
  };
  context.downloadWithFallback = (url, filename) => context.downloadFile({ url, filename });
  vm.createContext(context);
  vm.runInContext([
    'let pendingObsidianRetry = null; let cachedObsidianBinding = fixtureBinding; let cachedObsidianBindingPromise = null; let stopRequested = false;',
    section('async function runLinkBatchJob(', 'async function runCourseExportJob('),
    section('function getJobTotal(', 'async function exportLinkWithRetry('),
    section('async function downloadExportResult(', 'function sendMessageToTab('),
    section('async function writeSingleNoteToObsidian(', 'function normalizeDownloadFilename('),
    section('function buildZipFilename(', 'function loadJob('),
    section('function setPendingObsidianRetry(', 'function setWorkerState('),
    section('function updateStats(', 'async function fetchAssetAsDataUrlFromBackground('),
    section('function setStatus('),
    'this.api = { run: runLinkBatchJob, retry: handleRetryObsidianWrite, pending: () => pendingObsidianRetry };'
  ].join('\n'), Object.assign(context, { fixtureBinding: { handle } }));
  return { ...context.api, state, element,
    stats: () => [Number(element('success').textContent), Number(element('failure').textContent)],
    status: () => ({ text: element('status').textContent, className: element('status').className }),
    logs: () => element('logs').children.map(entry => entry.textContent).join('\n') };
}

function article(url) {
  const id = new URL(url).pathname.split('/').at(-1);
  return { filename: `${id}.md`, mimeType: 'text/markdown;charset=utf-8',
    content: `# 原文 ${id}\n\n完整正文 ${id}\n\n![原图](data:image/png;base64,aW1hZ2U=)\n` };
}

function job(outputTarget, { links = ['https://scys.com/article/a'], zipOutput = false } = {}) {
  return { title: '输出回归', source: 'fixture', outputTarget, links, zipOutput, includeImages: true };
}

async function zipEntries(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    entries.set(name, bytes.subarray(start, start + size).toString('utf8'));
    offset = start + size;
  }
  return entries;
}

test('Obsidian-only denied write is a failed article with retained content and an error status', async () => {
  const runner = createRunner({ permission: 'denied' });
  await runner.run(job('obsidian'));
  assert.deepEqual(runner.stats(), [0, 1]);
  assert.equal(runner.status().className, 'status status-error');
  assert.match(runner.status().text, /Obsidian.*成功 0 篇，失败 1 篇/);
  assert.doesNotMatch(runner.status().text, /已写入|已同步/);
  assert.equal(runner.state.downloads.length, 0);
  assert.equal(runner.state.written.size, 0);
  assert.equal(runner.pending().entries.length, 1);
  assert.equal(runner.pending().entries[0].result.content, article('https://scys.com/article/a').content.trim());
  assert.equal(runner.element('retryPanel').hidden, false);
  assert.match(runner.element('retryCopy').textContent, /关闭本页后需要重新开始/);
});

test('both still downloads an actual ZIP when every Obsidian write fails and reports each destination', async () => {
  const runner = createRunner({ permission: 'denied' });
  const links = ['https://scys.com/article/a', 'https://scys.com/article/b'];
  await runner.run(job('both', { links, zipOutput: true }));
  assert.deepEqual(runner.stats(), [0, 2]);
  assert.equal(runner.status().className, 'status status-error');
  assert.match(runner.status().text, /本地下载成功 2 篇；Obsidian 写入成功 0 篇、失败 2 篇/);
  assert.doesNotMatch(runner.status().text, /已同步/);
  assert.equal(runner.state.downloads.length, 1);
  const entries = await zipEntries(runner.state.downloads[0].blob);
  for (const link of links) assert.equal(entries.get(article(link).filename), article(link).content.trim());
  const manifest = JSON.parse(entries.get('manifest.json'));
  assert.deepEqual([manifest.successCount, manifest.failureCount, manifest.localSuccessCount, manifest.obsidianSuccessCount, manifest.obsidianFailureCount], [0, 2, 2, 0, 2]);
  assert.equal(manifest.outputTarget, 'both');
  assert.equal(manifest.failedEntries.length, 2);
  assert.equal(manifest.exportedEntries.length, 2);
  assert.match(entries.get('failed.txt'), /Obsidian 写入失败/);
  assert.match(entries.get('articles.txt'), /a\.md.*https:\/\/scys\.com\/article\/a/);
});

test('both counts a disk write failure once, preserves local files and retries only the failed note', async () => {
  const runner = createRunner({ writeFailures: ['b.md'] });
  const links = ['https://scys.com/article/a', 'https://scys.com/article/b'];
  await runner.run(job('both', { links }));
  assert.deepEqual(runner.stats(), [1, 1]);
  assert.equal(runner.state.downloads.length, 2);
  assert.match(runner.status().text, /本地下载成功 2 篇；Obsidian 写入成功 1 篇、失败 1 篇/);
  assert.equal(runner.pending().entries[0].url, links[1]);
  runner.state.writeFailures.clear();
  await runner.retry();
  assert.deepEqual(runner.stats(), [2, 0]);
  assert.equal(runner.status().className, 'status status-ready');
  assert.equal(runner.pending(), null);
  assert.equal(runner.state.sourceCalls.length, 2);
  assert.equal(runner.state.downloads.length, 2);
  assert.deepEqual(runner.state.writes.map(entry => entry.path.split('/').at(-1)), ['a.md', 'b.md', 'b.md']);
  assert.match(runner.state.writes.at(-1).content, /完整正文 b/);
  assert.match(runner.state.writes.at(-1).content, /data:image\/png;base64,aW1hZ2U=/);
});

test('denied and partial retries retain original payloads, skip already written notes and update failure counts', async () => {
  const runner = createRunner({ permission: 'denied', writeFailures: ['b.md'] });
  const links = ['https://scys.com/article/a', 'https://scys.com/article/b'];
  await runner.run(job('obsidian', { links }));
  const originalPayload = runner.pending().entries[1].result;
  await runner.retry();
  assert.deepEqual(runner.stats(), [0, 2]);
  assert.equal(runner.pending().entries[1].result, originalPayload);
  runner.state.permission = 'granted';
  await runner.retry();
  assert.deepEqual(runner.stats(), [1, 1]);
  assert.equal(runner.status().className, 'status status-error');
  assert.equal(runner.pending().entries.length, 1);
  assert.equal(runner.pending().entries[0].result, originalPayload);
  runner.state.writeFailures.clear();
  await runner.retry();
  assert.deepEqual(runner.stats(), [2, 0]);
  assert.equal(runner.status().className, 'status status-ready');
  assert.equal(runner.pending(), null);
  assert.equal(runner.state.sourceCalls.length, 2);
  assert.equal(runner.state.downloads.length, 0);
  assert.deepEqual(runner.state.writes.map(entry => entry.path.split('/').at(-1)), ['a.md', 'b.md', 'b.md']);
});

test('Obsidian recovery cannot turn a failed local ZIP download into a green completion', async () => {
  const runner = createRunner({ permission: 'denied', zipFails: true });
  await runner.run(job('both', { zipOutput: true }));
  assert.deepEqual(runner.stats(), [0, 1]);
  assert.match(runner.status().text, /本地下载成功 0 篇/);
  runner.state.permission = 'granted';
  await runner.retry();
  assert.equal(runner.pending(), null);
  assert.deepEqual(runner.stats(), [0, 1]);
  assert.equal(runner.status().className, 'status status-error');
  assert.match(runner.status().text, /本地下载成功 0 篇；Obsidian 写入成功 1 篇、失败 0 篇/);
  assert.equal(runner.state.downloads.length, 1);
  assert.equal(runner.state.sourceCalls.length, 1);
  assert.doesNotMatch(runner.logs(), /ZIP 已生成/);
});

test('source failures remain failed after other Obsidian notes recover and never create empty retry payloads', async () => {
  const links = ['https://scys.com/article/a', 'https://scys.com/article/b'];
  const runner = createRunner({ permission: 'denied', sourceFailures: [links[1]] });
  await runner.run(job('obsidian', { links }));
  assert.deepEqual(runner.stats(), [0, 2]);
  assert.equal(runner.pending().entries.length, 1);
  runner.state.permission = 'granted';
  await runner.retry();
  assert.deepEqual(runner.stats(), [1, 1]);
  assert.equal(runner.status().className, 'status status-error');
  assert.equal(runner.pending(), null);
  assert.equal(runner.state.sourceCalls.length, 2);
  assert.equal(runner.state.written.size, 1);
});

test('download-only succeeds without attempting an Obsidian write or showing an Obsidian retry', async () => {
  const runner = createRunner({ permission: 'denied' });
  await runner.run(job('download', { zipOutput: true }));
  assert.deepEqual(runner.stats(), [1, 0]);
  assert.equal(runner.status().className, 'status status-ready');
  assert.equal(runner.pending(), null);
  assert.equal(runner.state.permissionRequests, 0);
  assert.equal(runner.state.writes.length, 0);
  const entries = await zipEntries(runner.state.downloads[0].blob);
  assert.match(entries.get('a.md'), /完整正文 a/);
  const manifest = JSON.parse(entries.get('manifest.json'));
  assert.deepEqual([manifest.successCount, manifest.failureCount, manifest.localSuccessCount], [1, 0, 1]);
});

test('a missing Obsidian writer cannot silently claim that a note was written', async () => {
  const runner = createRunner({ missingWriter: true });
  await runner.run(job('obsidian'));
  assert.deepEqual(runner.stats(), [0, 1]);
  assert.equal(runner.status().className, 'status status-error');
  assert.match(runner.logs(), /Obsidian 写入模块未加载/);
  assert.doesNotMatch(runner.logs(), /已写入 Obsidian/);
});
