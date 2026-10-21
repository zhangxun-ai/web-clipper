// Run from the repository root: node icon/render-brand.cjs
// Uses the project's existing Playwright Chromium; no additional dependency.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'brand.svg'), 'utf8');
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const size of [16, 32, 48, 96, 128]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
      await page.screenshot({ path: path.join(__dirname, `${size}.png`), omitBackground: true });
      console.log(`Rendered icon/${size}.png (${size} × ${size})`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
