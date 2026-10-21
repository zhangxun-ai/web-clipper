const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const username = 'gh_test', biz = 'MzE5ODg1MTY4Mw==';
const timestamp = Date.parse('2026-09-07T12:00:00+08:00') / 1000;
const url = mid => `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${mid}&idx=1&sn=${String(mid).padStart(32,'0')}`;
const meta = mid => ({ username, biz, mid: String(mid), idx: '1', sn: String(mid).padStart(32,'0'), publishTimestamp: timestamp, title: `Article ${mid}` });
const article = (mid, extra={}) => ({ title: `Article ${mid}`, url: url(mid), publishTimestamp: timestamp, publicationSource: 'article', ...extra });
const page = (articles, isEnd, nextOffset='') => ({ account: { username, fakeid: biz }, articles, isEnd, nextOffset });
function harness(pages) {
  const storage = {}, calls = [], opened = [], tabs = new Map(); let listener, id = 0;
  const chrome = {
    runtime: { id:'fixture', getURL: value => `chrome-extension://fixture/${value}`, onMessage:{addListener:fn => { listener=fn; }},
      sendNativeMessage: (_host, request, callback) => {
        calls.push(request);
        if (request.action === 'tikhub_status') return callback({ok:true,data:{configured:true}});
        const next = pages.shift();
        if (typeof next === 'function') next(callback);
        else callback(next?.error ? {ok:false,...next} : {ok:true,data:next});
      } },
    storage:{local:{get:async keys => keys === null ? structuredClone(storage) : Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(storage[key])])),
      set:async values => {Object.assign(storage,structuredClone(values));}}},
    tabs: {create:async ({url: value}) => {const tab={id:++id,url:value,status:'complete'};tabs.set(id,tab);opened.push(value);return tab;},
      get:async id=>tabs.get(id),remove:async id=>{tabs.delete(id);},query:async()=>[...tabs.values()],update:async()=>{},
      sendMessage:async id=>({ok:true,data:meta(new URL(tabs.get(id).url).searchParams.get('mid'))})}, scripting:{executeScript:async()=>{}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../shared/wechat-history-service.js'),'utf8'),{chrome,crypto:webcrypto,TextEncoder,URL,Intl,Date,Map,Set,structuredClone,setTimeout,clearTimeout});
  const send = (action, params) => new Promise(resolve => listener({type:'wechat-history',action,params},{id:'fixture',url:chrome.runtime.getURL('popup.html')},resolve));
  const input = {seedUrl:url(1),startDate:'2026-09-07',endDate:'2026-09-07'};
  const selected = (listId, urls) => send('download-selected',{listId,articleUrls:urls,options:{outputTarget:'download',includeImages:false,zipOutput:true}});
  return {storage,calls,opened,send,input,selected};
}

test('partial pages stay downloadable on error; resume preserves opaque cursor and skips original tabs',async()=>{
  const h=harness([page([article(1),article(2)],false,'opaque+/='),{error:'upstream failed',code:'TIKHUB_NETWORK',details:{httpStatus:503}},page([article(3)],true)]);
  const first=await h.send('list',h.input);
  assert.equal(first.ok,false);assert.equal(first.details.httpStatus,503);
  const view=h.storage.wechatHistoryView;
  assert.equal(view.state,'error');assert.equal(view.complete,false);assert.equal(view.articles.length,2);
  assert.deepEqual(h.opened,[url(1)]);
  const downloaded=await h.selected(view.listId,[url(2)]);
  assert.equal(downloaded.ok,true);assert.equal(downloaded.data.complete,false);
  const resumed=await h.send('list',h.input);
  assert.equal(resumed.ok,true);assert.equal(resumed.data.complete,true);assert.equal(resumed.data.articles.length,3);
  assert.deepEqual(h.calls.filter(call=>call.action==='tikhub_article_page').map(call=>call.params.offset),[undefined,'opaque+/=','opaque+/=']);
  assert.equal(h.opened.filter(value=>value===url(1)).length,1);
});

test('complete account cache is reused across date ranges and a failed refresh preserves last complete snapshot',async()=>{
  const h=harness([page([article(1),article(2)],true),{error:'unavailable',code:'TIKHUB_NETWORK'}]);
  const first=await h.send('list',h.input);assert.equal(first.ok,true);
  const cached=await h.send('list',{...h.input,startDate:'2026-09-06'});
  assert.equal(cached.data.cached,true);assert.equal(cached.data.lastCompleteAt,first.data.queriedAt);
  assert.equal(h.calls.filter(call=>call.action==='tikhub_article_page').length,1);
  await h.send('list',{...h.input,refresh:true});
  const failed=h.storage.wechatHistoryView;
  assert.equal(failed.state,'error');assert.equal(failed.complete,false);assert.equal(failed.articles.length,2);
  assert.equal((await h.selected(failed.listId,[url(2)])).ok,true);
  assert.equal((await h.send('list',h.input)).data.cached,true);
});

test('unknown dates remain candidates and original date range rejects selection without purchasing another page',async()=>{
  const h=harness([page([article(2,{publishTimestamp:null,publicationSource:null})],true)]);
  const queried=await h.send('list',{...h.input,startDate:'2026-09-08',endDate:'2026-09-08'});
  assert.equal(queried.data.articles[0].publishDate,null);assert.equal(queried.data.articles[0].needsVerification,true);
  const result=await h.selected(queried.data.listId,[url(2)]);
  assert.equal(result.code,'WECHAT_SELECTION_DATE_MISMATCH');
  assert.equal(Object.keys(h.storage).some(key=>key.startsWith('batchJob:')),false);
  assert.equal(h.calls.filter(call=>call.action==='tikhub_article_page').length,1);
});

test('selected downloads run while next page is pending and keep current selection',async()=>{
  let release;
  const h=harness([page([article(2)],false,'next'),callback=>{release=()=>callback({ok:true,data:page([article(3)],true)});}]);
  const listing=h.send('list',h.input);
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  const partial=h.storage.wechatHistoryView;
  assert.equal(partial.state,'loading');assert.equal(partial.articles.length,1);
  h.storage.wechatHistorySelection={listId:partial.listId,urls:[url(2)]};
  assert.equal((await h.selected(partial.listId,[url(2)])).ok,true);
  release();await listing;
  assert.deepEqual(h.storage.wechatHistoryView.selectedUrls,[url(2)]);
  assert.equal(h.storage.wechatHistoryView.articles.length,2);
});

test('20-page limit keeps partial results and resume never restarts or treats dates as an end marker',async()=>{
  const pages=Array.from({length:20},(_,index)=>page([article(index+2)],false,`cursor-${index+1}`));
  pages.push(page([article(99)],true));
  const h=harness(pages);
  const result=await h.send('list',h.input);
  assert.equal(result.code,'WECHAT_HISTORY_PAGE_LIMIT');assert.equal(h.storage.wechatHistoryView.articles.length,20);
  assert.equal(h.calls.filter(call=>call.action==='tikhub_article_page').length,20);
  assert.equal((await h.send('list',h.input)).data.articles.length,21);
  assert.equal(h.calls.at(-1).params.offset,'cursor-20');
});

test('validated original metadata is reused for selections in a different date-range query',async()=>{
  const h=harness([page([article(2)],true)]);
  const first=await h.send('list',h.input);
  assert.equal((await h.selected(first.data.listId,[url(2)])).ok,true);
  const second=await h.send('list',{...h.input,startDate:'2026-09-06'});
  assert.equal((await h.selected(second.data.listId,[url(2)])).ok,true);
  assert.equal(h.opened.filter(value=>value===url(2)).length,1);
  assert.equal(h.calls.filter(call=>call.action==='tikhub_article_page').length,1);
});

test('wrong account article is rejected before it becomes selectable',async()=>{
  const h=harness([page([article(2,{url:url(2).replace(encodeURIComponent(biz),'MzWrongAccount')})],true)]);
  const result=await h.send('list',h.input);
  assert.equal(result.code,'TIKHUB_ACCOUNT_MISMATCH');assert.equal(h.storage.wechatHistoryView.articles.length,0);
  assert.equal(h.storage.wechatHistoryView.complete,false);
});


function legacyJob(overrides={}) {
  return { account:{ username, fakeid:biz }, startDate:'2026-09-07',endDate:'2026-09-07',
    pageCount:2, articles:[{...article(2),publishDate:'2026-09-07'}], offset:'opaque-legacy+/=',
    seenOffsets:['','first-page'],pending:null,complete:true,updatedAt:Date.parse('2026-09-07T16:00:00Z'),...overrides };
}

test('legacy complete history migrates across date ranges without purchasing any list page',async()=>{
  const h=harness([]), key='wechatHistory:'+ 'a'.repeat(64);
  const old=legacyJob();h.storage[key]=structuredClone(old);
  const result=await h.send('list',{...h.input,startDate:'2026-09-06'});
  assert.equal(result.ok,true);assert.equal(result.data.cached,true);assert.equal(result.data.complete,true);
  assert.equal(result.data.queriedAt,new Date(old.updatedAt).toISOString());
  assert.equal(result.data.articles.length,1);assert.equal(result.data.articles[0].candidateDate,true);
  assert.equal(h.calls.length,0);assert.deepEqual(h.storage[key],old);
});

test('legacy partial resumes opaque checkpoint and retains already collected articles',async()=>{
  const h=harness([page([article(3)],true)]),key='wechatHistory:'+'b'.repeat(64);
  const old=legacyJob({complete:false});h.storage[key]=structuredClone(old);
  const result=await h.send('list',h.input);
  assert.equal(result.ok,true);assert.equal(result.data.articles.length,2);
  const calls=h.calls.filter(call=>call.action==='tikhub_article_page');
  assert.equal(calls.length,1);assert.equal(calls[0].params.offset,'opaque-legacy+/=');
  assert.deepEqual(h.storage[key],old);
});

test('legacy damaged checkpoint does not silently buy a new first page',async()=>{
  const h=harness([]);h.storage['wechatHistory:'+'c'.repeat(64)]=legacyJob({complete:false,offset:undefined});
  const result=await h.send('list',h.input);
  assert.equal(result.code,'WECHAT_HISTORY_CHECKPOINT_INVALID');assert.equal(h.calls.length,0);
});


test('refresh merges new pages with previous snapshot for download and keeps both after failure',async()=>{
  let rejectPage;
  const h=harness([page([article(1),article(2)],true),
    page([article(2,{title:'Updated provider title'}),article(3)],false,'refresh-next'),
    callback=>{rejectPage=()=>callback({ok:false,code:'TIKHUB_HTTP_400',error:'bad page',details:{httpStatus:400}});}]);
  const initial=await h.send('list',h.input);
  const indexKey=Object.keys(h.storage).find(key=>key.startsWith('wechatAccountIndex:'));
  const snapshot=structuredClone(h.storage[indexKey].snapshot);
  const refresh=h.send('list',{...h.input,refresh:true});
  while (!rejectPage) await new Promise(resolve=>setImmediate(resolve));
  const partial=h.storage.wechatHistoryView;
  assert.equal(partial.state,'loading');assert.equal(partial.complete,false);assert.equal(partial.refreshing,true);
  assert.equal(partial.lastCompleteAt,initial.data.queriedAt);
  assert.deepEqual(new Set(partial.articles.map(article=>article.url)),new Set([url(1),url(2),url(3)]));
  assert.equal(partial.articles.find(article=>article.url===url(2)).title,'Updated provider title');
  assert.equal(h.storage[partial.listId].articles.length,3,'the downloadable list stores the same merged identities');
  const download=await h.selected(partial.listId,[url(1),url(3)]);
  assert.equal(download.ok,true);assert.equal(download.data.complete,false);
  rejectPage();assert.equal((await refresh).ok,false);
  const failed=h.storage.wechatHistoryView;
  assert.equal(failed.articles.length,3);assert.equal(failed.complete,false);assert.equal(failed.lastCompleteAt,snapshot.collectedAt);
  assert.equal((await h.selected(failed.listId,[url(3)])).ok,true,'new first-page article remains downloadable after refresh fails');
  assert.deepEqual(h.storage[indexKey].snapshot,snapshot,'failed refresh never overwrites the last complete snapshot');
  const cached=await h.send('list',h.input);
  assert.equal(cached.data.cached,true);assert.equal(cached.data.complete,true);assert.equal(cached.data.articles.length,2);
});
