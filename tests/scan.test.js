import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const code=await fs.readFile(new URL('../content/media-scan.js',import.meta.url),'utf8');
function setup(initial=[]) {
  const messages=[],timers=new Map(),events={},observers={};let index=0;
  const video={currentSrc:'',src:'',duration:15,poster:'',videoWidth:640,videoHeight:360,querySelector:()=>null,querySelectorAll:()=>[],getAttribute:()=>null};
  const chrome={runtime:{sendMessage:async m=>messages.push(m),onMessage:{addListener(fn){events.message=fn;}}}};
  const window={addEventListener:(name,fn)=>events['window:'+name]=fn};
  vm.runInNewContext(code,{chrome,window,location:new URL('https://www.douyin.com/'),document:{documentElement:{},querySelectorAll:()=>[video],addEventListener:(name,fn)=>events[name]=fn},
    performance:{getEntriesByType:()=>initial},MutationObserver:class{constructor(fn){observers.mutation=fn;}observe(){}},
    PerformanceObserver:class{constructor(fn){observers.performance=fn;}observe(){}},
    setTimeout(fn){timers.set(++index,fn);return index;},clearTimeout(id){timers.delete(id);},setInterval(){},URL,console});
  return {messages,events,observers,video,timers,window,flush(){const tasks=[...timers.values()];timers.clear();tasks.forEach(fn=>fn());}};
}
test('Resource observer discovers post-ad media even when performance buffer is full',()=>{
  const h=setup();
  h.observers.performance({getEntries:()=>[{name:'https://cdn.test/main.m3u8'}]});h.flush();
  assert.ok(h.messages.some(m=>m.items?.some(i=>i.url==='https://cdn.test/main.m3u8')));
});
test('More than 100 early resources do not hide the main video in an initial scan',()=>{
  const h=setup(Array.from({length:230},(_,i)=>({name:`https://cdn.test/${i}.mp4`})));
  const urls=h.messages.filter(m=>m.type==='MEDIA_SCAN').flatMap(m=>m.items.slice(0,100).map(i=>i.url));
  assert.ok(urls.includes('https://cdn.test/229.mp4'));
});
test('A steady stream of network activity does not keep resetting the scheduled scan',()=>{
  const h=setup();
  h.observers.performance({getEntries:()=>[]});const first=[...h.timers.keys()][0];
  for(let i=0;i<20;i++)h.observers.performance({getEntries:()=>[]});
  assert.ok(h.timers.has(first));
});
test('Same-player ad to main duration/source transition notifies the background',()=>{
  const h=setup();h.messages.length=0;
  h.video.currentSrc='blob:https://site.test/main';h.video.duration=600;
  h.events.loadedmetadata();h.flush();
  assert.ok(h.messages.some(m=>m.type==='PLAYER_CHANGED'));
});
test('Blob player duration is reported even without a directly downloadable URL',()=>{
  const h=setup();h.video.currentSrc='blob:https://site.test/main';h.video.duration=2179;
  h.events.loadedmetadata();h.flush();
  assert.ok(h.messages.some(m=>m.type==='PLAYER_STATE' && m.players?.some(p=>p.duration===2179 && p.src==='blob:https://site.test/main')));
});
test('Unused source elements do not inherit the current main-video duration',()=>{
  const h=setup();h.messages.length=0;
  h.video.currentSrc='https://cdn.test/main.mp4';h.video.duration=2179;
  h.video.querySelectorAll=()=>[{src:'https://cdn.test/old-ad.mp4'}];
  h.events.loadedmetadata();h.flush();
  const ad=h.messages.filter(m=>m.type==='MEDIA_SCAN').flatMap(m=>m.items).find(i=>i.url==='https://cdn.test/old-ad.mp4');
  assert.equal(ad?.duration,undefined);
});

test('Page bridge forwards only evidence matching an actual current player',()=>{
  const h=setup();h.video.currentSrc='blob:https://www.douyin.com/current';h.video.duration=333;
  const receive=playerSrc=>h.events['window:message']({source:h.window,data:{channel:'avd-douyin-player-v1',items:[{playerSrc,duration:333,siteVideoId:'123'}]}});
  receive('blob:https://www.douyin.com/next');h.flush();assert.equal(h.messages.some(m=>m.type==='PLAYER_MEDIA'),false);
  receive(h.video.currentSrc);h.flush();assert.equal(h.messages.find(m=>m.type==='PLAYER_MEDIA').items[0].siteVideoId,'123');
});
