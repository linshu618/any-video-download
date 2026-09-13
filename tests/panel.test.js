import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const html=await fs.readFile(new URL('../sidepanel/sidepanel.html',import.meta.url),'utf8');
const code=await fs.readFile(new URL('../sidepanel/sidepanel.js',import.meta.url),'utf8');
async function panel(records, videos=[], start=async job=>({job:{...job,id:'created',status:'starting',createdAt:Date.now()}}), players=[], fileAction=async()=>({ok:true}), clearHistory=async()=>({ok:true})) {
  const {document}=parseHTML(html);let listener;
  const chrome={runtime:{sendMessage:async msg=>msg.type==='GET_DOWNLOADS'?{records}:msg.type==='GET_VIDEOS'?{videos,players}:msg.type==='START_DOWNLOAD'?start(msg.job):msg.type==='FILE_ACTION'?fileAction(msg):msg.type==='CLEAR_DOWNLOAD_HISTORY'?clearHistory(): {},onMessage:{addListener(fn){listener=fn;}}},
    tabs:{query:async()=>[{id:1}],sendMessage:async()=>{},onActivated:{addListener(){}}},downloads:{showInFolder(){}}};
  await vm.runInNewContext(`(async()=>{${code}\n})()`,{document,chrome,navigator:{clipboard:{writeText:async()=>{}}},URL,console,setTimeout,clearTimeout,setInterval(){},alert(){}});
  return {document,update(next){records.splice(0,records.length,...next);listener({type:'DOWNLOADS_CHANGED'});}};
}
test('History tab renders persisted progress and a completed save path',async()=>{
  const {document}=await panel([
    {id:'1',title:'进行中的视频',kind:'hls',status:'downloading',duration:100,seconds:40,percent:40,bytes:1048576,speed:2,createdAt:Date.now()},
    {id:'2',title:'完成的视频',kind:'dash',status:'complete',percent:100,path:'C:/Downloads/video.mp4',createdAt:Date.now()}
  ]);
  document.getElementById('historyTab').click();
  const progress=document.querySelector('progress');assert.equal(progress.getAttribute('value'),'40');
  assert.match(document.getElementById('content').textContent,/40%/);
  assert.match(document.getElementById('content').textContent,/C:\/Downloads\/video.mp4/);
  assert.equal(document.querySelectorAll('.cancel-job').length,1);
  assert.equal(document.querySelectorAll('.copy-path').length,1);
});
test('Download click creates a job for the chosen HLS stream',async()=>{
  let submitted;
  const {document}=await panel([],[{id:'v',title:'YouTube example',url:'https://manifest.googlevideo.com/master.m3u8',kind:'hls',duration:367,variants:[{url:'https://manifest.googlevideo.com/1080.m3u8',height:1080}]}],async job=>{submitted=job;return {job:{...job,id:'created',status:'starting',createdAt:Date.now()}};});
  document.querySelector('.download-btn').click();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(submitted?.height,1080);
  assert.equal(submitted?.url,'https://manifest.googlevideo.com/1080.m3u8');
});
test('Missing background response produces a visible error, not silent empty history',async()=>{
  const {document}=await panel([],[{id:'v',title:'Video',url:'https://cdn.test/a.m3u8',kind:'hls'}],async()=>undefined);
  document.querySelector('.download-btn').click();
  await new Promise(r=>setTimeout(r,20));
  assert.match(document.body.textContent,/后台未确认|未响应/);
});
test('Unknown totals display indeterminate progress rather than fabricated percentages',async()=>{
  const {document}=await panel([{id:'1',title:'未知时长',kind:'hls',status:'downloading',percent:null,createdAt:Date.now()}]);
  document.getElementById('historyTab').click();
  assert.equal(document.querySelector('progress').hasAttribute('value'),false);
  assert.match(document.getElementById('content').textContent,/正在获取进度/);
});
test('A 36-minute blob player is shown as unmatched rather than associated with an unrelated ad',async()=>{
  const {document}=await panel([],[{id:'ad',url:'https://cdn.test/ad.mp4',kind:'file',duration:15}],undefined,[{src:'blob:https://site.test/main',duration:2179,visible:true,frameId:0,reportedAt:Date.now()}]);
  assert.match(document.body.textContent,/36:19/);
  assert.match(document.body.textContent,/尚未关联/);
});
test('Exact player source is prioritized over a newly detected unrelated media file',async()=>{
  const {document}=await panel([],[{id:'ad',url:'https://cdn.test/ad.mp4',title:'Ad',kind:'file',timestamp:2},{id:'main',url:'https://cdn.test/main.mp4',title:'Main',kind:'file',timestamp:1,frameId:0}],undefined,[{src:'https://cdn.test/main.mp4#t=2',duration:2179,visible:true,frameId:0,reportedAt:Date.now()}]);
  assert.equal(document.querySelector('.video-item').dataset.id,'main');
  assert.match(document.querySelector('.video-item').textContent,/播放器/);
});

test('A blob-associated pair is prioritized and submits both tracks',async()=>{
  let job;
  const {document}=await panel([],[{id:'other',url:'https://cdn.test/other',kind:'file',timestamp:2},{id:'main',url:'https://cdn.test/video',kind:'paired',playerSrc:'blob:https://site.test/current',duration:333,frameId:0,variants:[{url:'https://cdn.test/video',audioUrl:'https://cdn.test/audio',height:720}]}],async input=>{job=input;return {job:{id:'ok',...input}};},[{src:'blob:https://site.test/current',duration:333,visible:true,frameId:0,reportedAt:Date.now()}]);
  assert.equal(document.querySelector('.video-item').dataset.id,'main');
  assert.match(document.querySelector('.video-item').textContent,/播放器/);
  document.querySelector('.download-btn').click();await new Promise(r=>setTimeout(r,20));
  assert.equal(job.audioUrl,'https://cdn.test/audio');assert.equal(job.kind,'paired');
});

test('Both native and browser history expose folder and video actions with visible errors',async()=>{
  const calls=[];
  const {document}=await panel([{id:'native',kind:'paired',status:'complete',path:'C:/Downloads/a.mp4'},{id:'browser',kind:'file',status:'complete',path:'C:/Downloads/b.mp4',browserId:7}],[],undefined,[],async msg=>{calls.push(msg);return {error:'文件已移动或删除'};});
  document.getElementById('historyTab').click();
  assert.equal(document.querySelectorAll('.show-file').length,2);
  assert.equal(document.querySelectorAll('.open-file').length,2);
  document.querySelector('.show-file').click();await new Promise(r=>setTimeout(r,20));
  assert.equal(calls[0].id,'native');assert.equal(calls[0].action,'reveal');assert.equal(calls[0].path,undefined);
  assert.match(document.getElementById('panelNotice').textContent,/文件已移动或删除/);
});

test('Unacknowledged history clear keeps records and explains how to reload the extension',async()=>{
  const {document}=await panel([{id:'done',kind:'file',status:'complete'}],[],undefined,[],undefined,async()=>undefined);
  document.getElementById('historyTab').click();
  document.getElementById('clearHistoryBtn').click();await new Promise(r=>setTimeout(r,30));
  assert.match(document.getElementById('panelNotice').textContent,/chrome:\/\/extensions/);
  assert.match(document.getElementById('panelNotice').textContent,/重新加载/);
  assert.equal(document.querySelectorAll('.history-item').length,1);
});

test('History clear button removes ended records, keeps current tasks and disables when nothing is clearable',async()=>{
  const rows=[{id:'ended',kind:'file',status:'complete'},{id:'current',kind:'hls',status:'downloading'}];
  const {document}=await panel(rows,[],undefined,[],undefined,async()=>{rows.splice(0,1);return {ok:true,removed:1};});
  const button=document.getElementById('clearHistoryBtn');assert.ok(button);assert.equal(button.hidden,true);
  document.getElementById('historyTab').click();assert.equal(button.hidden,false);assert.equal(button.disabled,false);
  button.click();await new Promise(r=>setTimeout(r,30));
  assert.equal(document.querySelectorAll('.history-item').length,1);
  assert.equal(document.querySelector('.history-item').dataset.job,'current');assert.equal(button.disabled,true);
});
