import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const code=await fs.readFile(new URL('../background/service-worker.js',import.meta.url),'utf8');
function event() {let callback; return {addListener(fn){callback=fn;},emit(...args){return callback?.(...args);}};}
function harness(fetcher=fetch, initialStorage={}) {
  const storage=structuredClone(initialStorage), messages=[];
  const chrome={sidePanel:{setPanelBehavior:async()=>{}},storage:{session:{get:async key=>structuredClone({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
    action:{setBadgeText:async()=>{}},tabs:{get:async()=>({title:'Page',url:'https://page.test'}),onUpdated:event(),onRemoved:event()},
    runtime:{id:'test',onMessage:event(),sendMessage:async msg=>{messages.push(msg);}},webRequest:{onResponseStarted:event()}};
  chrome.storage.local=chrome.storage.session;
  chrome.downloads={onChanged:event(),search:async()=>[]};
  vm.runInNewContext(code,{chrome,fetch:fetcher,URL,AbortSignal,TextDecoder,Uint8Array,structuredClone,crypto,console,setTimeout,clearTimeout});
  return {chrome,messages,rows:()=>storage.media_v2_1?.videos || [],request(url,type='video/mp4'){chrome.webRequest.onResponseStarted.emit({tabId:1,url,statusCode:200,responseHeaders:[{name:'content-type',value:type}]});}};
}
async function until(check) {for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for worker state');}

test('Built worker acknowledges clear history, persists it and rejects content-script requests',async()=>{
  const h=harness(fetch,{download_history_v1:[{id:'done',kind:'file',status:'complete',path:'C:/Downloads/video.mp4'}]});
  const sender={id:'test',url:'chrome-extension://test/sidepanel/sidepanel.html'};
  const send=async(type,from=sender)=>{
    let response;
    h.chrome.runtime.onMessage.emit({type},from,value=>{response=value;});
    await until(()=>response!==undefined);return response;
  };
  assert.equal((await send('GET_DOWNLOADS')).records.length,1);
  assert.ok((await send('CLEAR_DOWNLOAD_HISTORY',{id:'test',url:'https://page.test',tab:{id:1}})).error);
  assert.equal((await send('GET_DOWNLOADS')).records.length,1);
  const result=await send('CLEAR_DOWNLOAD_HISTORY');
  assert.equal(result.ok,true);assert.equal(result.removed,1);
  assert.equal((await send('GET_DOWNLOADS')).records.length,0);
  const saved=await h.chrome.storage.local.get('download_history_v1');
  assert.equal(saved.download_history_v1.length,0);
});
test('Concurrent discoveries retain all distinct files in one tab',async()=>{
  const h=harness();for(let i=0;i<20;i++)h.request(`https://cdn.test/${i}.mp4`);
  await until(()=>h.rows().length===20);
  assert.equal(new Set(h.rows().map(v=>v.url)).size,20);
});
test('Clear during a playlist fetch prevents stale results from restoring the list',async()=>{
  let release;
  const h=harness(()=>new Promise(resolve=>{release=()=>resolve(new Response('#EXTM3U\n#EXTINF:2,\nhttps://cdn.test/s.ts\n#EXT-X-ENDLIST'));}));
  h.request('https://cdn.test/a.m3u8','application/vnd.apple.mpegurl');
  await until(()=>!!release);
  await new Promise(resolve=>h.chrome.runtime.onMessage.emit({type:'CLEAR_VIDEOS',tabId:1},{id:'test'},resolve));
  release();await new Promise(r=>setTimeout(r,50));
  assert.equal(h.rows().length,0);
});
test('HLS parent and child network discoveries collapse into one quality selector',async()=>{
  const h=harness(async url=>({ok:true,url,body:new Response(url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nchild.m3u8' : '#EXTM3U\n#EXTINF:2,\npart.mp4\n#EXT-X-ENDLIST').body}));
  h.request('https://cdn.test/part.mp4');h.request('https://cdn.test/child.m3u8');h.request('https://cdn.test/master.m3u8');
  await until(()=>h.rows().length===1 && h.rows()[0].parsed);
  assert.equal(h.rows()[0].url,'https://cdn.test/master.m3u8');
  assert.equal(h.rows()[0].variants[0].height,360);
  assert.equal(h.rows()[0].duration,2);
});
test('Ad to main transition reparses a reused manifest instead of retaining the ad',async()=>{
  let duration=15;
  const h=harness(async url=>({ok:true,url,body:new Response(`#EXTM3U\n#EXTINF:${duration},\nsegment-${duration}.ts\n#EXT-X-ENDLIST`).body}));
  h.request('https://cdn.test/current.m3u8');
  await until(()=>h.rows()[0]?.parsed);
  assert.equal(h.rows()[0].duration,15);duration=600;
  h.chrome.runtime.onMessage.emit({type:'PLAYER_CHANGED',src:'blob:https://page.test/main',duration:600},{id:'test',tab:{id:1},frameId:0},()=>{});
  await until(()=>h.rows()[0]?.duration===600);
  assert.equal(h.rows().length,1);
});
test('A player switch during an in-flight ad parse queues a fresh main-content parse',async()=>{
  let release,first=true;
  const response=(url,duration)=>({ok:true,url,body:new Response(`#EXTM3U\n#EXTINF:${duration},\npart.ts\n#EXT-X-ENDLIST`).body});
  const h=harness(url=>{if(first){first=false;return new Promise(resolve=>release=()=>resolve(response(url,15)));}return Promise.resolve(response(url,900));});
  h.request('https://cdn.test/reused.m3u8');await until(()=>!!release);
  h.chrome.runtime.onMessage.emit({type:'PLAYER_CHANGED'},{id:'test',tab:{id:1},frameId:0},()=>{});
  await new Promise(r=>setTimeout(r,10));release();
  await until(()=>h.rows()[0]?.duration===900);
  assert.equal(h.rows().length,1);
});
test('Concurrent network capture does not discard the player duration',async()=>{
  const h=harness(),url='https://cdn.test/main.mp4';h.request(url);
  h.chrome.runtime.onMessage.emit({type:'MEDIA_SCAN',items:[{url,type:'video/unknown',duration:2179,width:1280,height:720}]},{id:'test',tab:{id:1},frameId:0},()=>{});
  await until(()=>h.rows()[0]?.duration===2179);
  assert.equal(h.rows()[0].height,720);
});
test('A resource-only rescan cannot erase already known player metadata',async()=>{
  const h=harness(),url='https://cdn.test/main.mp4';
  const scan=items=>h.chrome.runtime.onMessage.emit({type:'MEDIA_SCAN',items},{id:'test',tab:{id:1},frameId:0},()=>{});
  scan([{url,type:'video/unknown',duration:2179}]);await until(()=>h.rows()[0]?.duration===2179);
  scan([{url}]);await new Promise(r=>setTimeout(r,30));
  assert.equal(h.rows()[0].duration,2179);
});

test('Player evidence groups raw video/audio requests and survives later track responses',async()=>{
  const h=harness();const sender={id:'test',tab:{id:1,url:'https://www.douyin.com/jingxuan?modal_id=123'},url:'https://www.douyin.com/',frameId:0};
  const src='blob:https://www.douyin.com/current';
  h.request('https://cdn.test/video');h.request('https://cdn.test/audio');await until(()=>h.rows().length===2);
  h.chrome.runtime.onMessage.emit({type:'PLAYER_STATE',players:[{id:'p',src,duration:333,visible:true}]},sender,()=>{});
  h.chrome.runtime.onMessage.emit({type:'PLAYER_MEDIA',items:[{siteVideoId:'123',url:'https://cdn.test/video',kind:'paired',duration:333,playerSrc:src,title:'Current',variants:[{url:'https://cdn.test/video',audioUrl:'https://cdn.test/audio',height:720}]}]},sender,()=>{});
  await until(()=>h.rows().length===1 && h.rows()[0].kind==='paired');
  assert.equal(h.rows()[0].title,'Current');
  h.request('https://cdn.test/video');h.request('https://cdn.test/audio');await new Promise(r=>setTimeout(r,40));
  assert.equal(h.rows().length,1);assert.equal(h.rows()[0].kind,'paired');assert.equal(h.rows()[0].variants[0].audioUrl,'https://cdn.test/audio');
});

const youtubeId='YzI6-emjbMA',youtubeUrl='https://www.youtube.com/watch?v='+youtubeId;
test('Bilibili paired tracks reach the downloadable list without a playlist fetch',async()=>{
 const h=harness(()=>{throw Error('No playlist needed');});
 const sender={id:'test',tab:{id:1,url:'https://www.bilibili.com/video/BV13PYx6GEfY/'},url:'https://www.bilibili.com/video/BV13PYx6GEfY/',frameId:0};
 const src='blob:https://www.bilibili.com/current';
 h.chrome.runtime.onMessage.emit({type:'PLAYER_STATE',players:[{id:'p',src,duration:618,visible:true}]},sender,()=>{});
 h.chrome.runtime.onMessage.emit({type:'PLAYER_MEDIA',items:[{siteVideoId:'41727952632',url:'https://cdn.bilivideo.com/video.m4s',kind:'paired',duration:618,playerSrc:src,title:'B站视频',variants:[{url:'https://cdn.bilivideo.com/video.m4s',audioUrl:'https://cdn.bilivideo.com/audio.m4s',height:1080}]}]},sender,()=>{});
 await until(()=>h.rows().length===1);assert.equal(h.rows()[0].variants[0].height,1080);assert.equal(h.rows()[0].pageUrl,sender.tab.url);
});
const youtubeReply=height=>({ok:true,media:{videoId:youtubeId,title:'Current video',duration:120,heights:[height]}});
test('YouTube discovery lists real qualities without observing any HLS request',async()=>{
 let requests=0;const h=harness(()=>{throw Error('No browser HLS fetch expected');});h.chrome.tabs.get=async()=>({url:youtubeUrl});
 h.chrome.runtime.sendNativeMessage=async()=>{requests++;return youtubeReply(720);};
 h.chrome.runtime.onMessage.emit({type:'GET_VIDEOS',tabId:1},{id:'test'},()=>{});await until(()=>h.rows()[0]?.parsed);
 assert.equal(h.rows()[0].kind,'youtube');assert.equal(h.rows()[0].variants[0].height,720);assert.equal(requests,1);
 h.request('https://manifest.googlevideo.com/old.m3u8','application/vnd.apple.mpegurl');await new Promise(r=>setTimeout(r,30));assert.equal(h.rows().length,1);
});
test('Manual YouTube rescan refreshes cached qualities',async()=>{
 const h=harness();h.chrome.tabs.get=async()=>({url:youtubeUrl});let height=720;h.chrome.runtime.sendNativeMessage=async()=>youtubeReply(height);
 h.chrome.runtime.onMessage.emit({type:'GET_VIDEOS',tabId:1},{id:'test'},()=>{});await until(()=>h.rows()[0]?.parsed);await new Promise(r=>setTimeout(r,20));height=1080;
 h.chrome.runtime.onMessage.emit({type:'RESOLVE_YOUTUBE',tabId:1},{id:'test',url:'chrome-extension://test/sidepanel/sidepanel.html'},()=>{});await until(()=>h.rows()[0]?.variants[0].height===1080);
});
test('Navigation discards a native metadata response for the previous video',async()=>{
 let release;const h=harness();h.chrome.tabs.get=async()=>({url:youtubeUrl});h.chrome.runtime.sendNativeMessage=()=>new Promise(resolve=>release=()=>resolve(youtubeReply(1080)));
 h.chrome.runtime.onMessage.emit({type:'GET_VIDEOS',tabId:1},{id:'test'},()=>{});await until(()=>!!release);
 h.chrome.tabs.get=async()=>({url:'https://www.youtube.com/watch?v=abcdefghijk'});h.chrome.tabs.onUpdated.emit(1,{url:'https://www.youtube.com/watch?v=abcdefghijk'});await new Promise(r=>setTimeout(r,10));release();await new Promise(r=>setTimeout(r,30));assert.equal(h.rows().length,0);
});
test('Missing native helper is shown as a specific discovery error',async()=>{
 const h=harness();h.chrome.tabs.get=async()=>({url:youtubeUrl});h.chrome.runtime.sendNativeMessage=async()=>{throw Error('Native host not found');};
 h.chrome.runtime.onMessage.emit({type:'GET_VIDEOS',tabId:1},{id:'test'},()=>{});await until(()=>h.messages.some(m=>/未找到本地助手/.test(m.mediaNotice||'')));assert.equal(h.rows().length,0);
});
