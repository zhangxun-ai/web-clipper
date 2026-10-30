// Shipped task page in Chromium. Browser storage, tabs, downloads and directory
// permission are fixtures; no real account, file output or external service.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const evidence = path.join(root, 'output/implementation-forest-ui-20261030/batch-evidence');
fs.mkdirSync(evidence, { recursive: true });
const server = http.createServer((req, res) => {
  const relative = new URL(req.url, 'http://local').pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(file);
  res.setHeader('Content-Type', ({ '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' })[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

async function fixture(page, mode) {
  await page.addInitScript(({ mode }) => {
    const job = { title:'公众号内容整理：长期保存与后续研究的完整记录', source:'link-batch', links:['https://example.com/first','https://example.com/second'], outputTarget:'both', zipOutput:true, includeImages:false, createdAt:new Date().toISOString() };
    if (mode.startsWith('course')) Object.assign(job,{type:'course-export',courseTitle:'课程内容与资料整理',courseUrl:'https://example.com/course',chapters:job.links.map((url,index)=>({url,title:`章节 ${index+1}`,order:index+1}))});
    globalThis.batchFixture = { extracts:0, downloads:0, writes:0, allowed:false, tabs:{}, removed:[] };
    const f = globalThis.batchFixture;
    Object.defineProperty(globalThis, 'ObsidianVaultStorage', { configurable:false, writable:false, value:{
      getVaultBinding:async()=>({handle:{name:'研究资料'}, meta:{folderName:'研究资料'}}),
      ensureVaultPermission:async()=>f.allowed?'granted':'prompt', promptVaultPermission:async()=>{f.allowed=true;return 'granted';},
      writeTextFiles:async()=>{f.writes++;}
    }});
    globalThis.chrome = { runtime:{lastError:null}, storage:{local:{get:(keys, cb)=>cb({['batchJob:forest-test']:job}), remove:(keys,cb)=>{f.removed.push(...keys);cb();}}},
      tabs:{ update:(id,options,cb)=>{Object.assign(f.tabs[id],options,{status:'complete'});cb(f.tabs[id]);}, create:(options,cb)=>{const id=Object.keys(f.tabs).length+1;f.tabs[id]={id,url:options.url,status:'complete'};cb(f.tabs[id]);},get:(id,cb)=>cb(f.tabs[id]),remove:(id,cb)=>cb(),onUpdated:{addListener(){},removeListener(){}},sendMessage:(id,msg,cb)=>{f.extracts++; const answer=()=>cb({ok:true,data:{filename:'原文记录.md',mimeType:'text/markdown;charset=utf-8',content:'# 原文记录\n\n这是实际导出管线接收到的测试正文。'}}); if(mode==='stop')setTimeout(answer,600);else answer();}},
      scripting:{executeScript:(options,cb)=>cb([])}, downloads:{download:(options,cb)=>{f.downloads++; if(mode==='course-download-fail'){chrome.runtime.lastError={message:'fixture: download interrupted'};cb();chrome.runtime.lastError=null;}else cb(1);}}
    };
  }, { mode });
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/batch-runner.html?jobId=forest-test`;
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await fixture(page,'complete');await page.goto(url);
    await page.locator('#jobStatus.status-error').waitFor();
    await page.waitForFunction(()=>document.querySelector('#jobStatus').textContent.includes('本地下载成功 2'));
    assert.equal(await page.locator('.delivery-state[data-output="download"][data-state="success"]').count(),2);
    assert.equal(await page.locator('.delivery-state[data-output="obsidian"][data-state="failed"]').count(),2);
    assert.equal(await page.locator('#jobSuccess').textContent(),'0');
    assert.equal(await page.locator('#jobFailure').textContent(),'2');
    assert.match(await page.locator('#contextOutput').textContent(),/研究资料/);
    assert.equal(await page.locator('.delivery-source').first().getAttribute('href'),'https://example.com/first');
    await page.screenshot({path:path.join(evidence,'batch-partial-desktop.png'),fullPage:true});
    const before=await page.evaluate(()=>({extracts:batchFixture.extracts,downloads:batchFixture.downloads}));
    await page.locator('#retryObsidianWrite').click();
    await page.waitForFunction(()=>document.querySelector('#jobSuccess').textContent==='2');
    assert.equal(await page.locator('.delivery-state[data-output="obsidian"][data-state="success"]').count(),2);
    assert.deepEqual(await page.evaluate(()=>({extracts:batchFixture.extracts,downloads:batchFixture.downloads})),before,'supplement never recollects or redownloads');
    for (const width of [800,360,320]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no horizontal overflow at ${width}`);
      await page.screenshot({path:path.join(evidence,`batch-complete-${width}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
    const stopped=await browser.newPage({viewport:{width:360,height:900}});
    await fixture(stopped,'stop');await stopped.goto(url);
    await stopped.locator('#stopTask:not([hidden])').waitFor();
    await stopped.locator('#stopTask').click();
    await stopped.waitForFunction(()=>document.querySelector('#stopTask').textContent==='任务已停止');
    await stopped.waitForFunction(()=>document.querySelectorAll('.delivery-state[data-state="stopped"]').length===4);
    assert.equal(await stopped.locator('.delivery-state[data-state="running"]').count(),0);
    assert.equal(await stopped.evaluate(()=>batchFixture.downloads),0);
    await stopped.screenshot({path:path.join(evidence,'batch-stopped-360.png'),fullPage:true});
    for (const mode of ['course','course-download-fail']) {
      const course=await browser.newPage({viewport:{width:1280,height:900}});
      await fixture(course,mode);await course.goto(url);
      await course.waitForFunction(()=>document.querySelector('#jobStatus').textContent.startsWith('输出未全部完成'));
      await course.waitForFunction(()=>document.querySelector('#workerGrid').textContent.includes('处理已结束'));
      assert.equal(await course.locator('#jobSuccess').textContent(),'0');
      assert.equal(await course.locator('.delivery-state[data-output="obsidian"][data-state="failed"]').count(),2);
      assert.equal(await course.locator(`.delivery-state[data-output="download"][data-state="${mode==='course'?'success':'failed'}"]`).count(),2);
      assert.match(await course.locator('#contextFormat').textContent(),/Markdown \+ HTML/);
      const counts=await course.evaluate(()=>({extracts:batchFixture.extracts,downloads:batchFixture.downloads}));
      await course.locator('#retryObsidianWrite').click();
      await course.waitForFunction(()=>document.querySelector('#obsidianRetryPanel').hidden);
      assert.deepEqual(await course.evaluate(()=>({extracts:batchFixture.extracts,downloads:batchFixture.downloads})),counts);
      assert.equal(await course.locator('#jobSuccess').textContent(),mode==='course'?'2':'0');
      assert.equal(await course.locator('#jobStatus').getAttribute('class'),mode==='course'?'status status-ready':'status status-error');
      assert.equal(await course.locator('.delivery-state[data-state="running"], .delivery-state[data-state="cached"]').count(),0);
      await course.screenshot({path:path.join(evidence,`${mode}-1280.png`),fullPage:true});
      await course.close();
    }
    console.log('PASS batch forest: separate destination receipts, cached Obsidian supplement, original sources, stop states, responsive 1280/800/360/320');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
