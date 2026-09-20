import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url)));
const files=manifest.content_scripts.filter(s=>s.world==='MAIN' && s.matches.some(m=>m.includes('bilibili.com'))).flatMap(s=>s.js);
const code=files.map(f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8')).join('\n');
const track=(name,height=0,codecs='avc1.640033')=>({baseUrl:`https://cdn.bilivideo.com/upgcxcode/32/26/41727952632/${name}.m4s`,backupUrl:[`https://backup.bilivideo.com/upgcxcode/32/26/41727952632/${name}.m4s`],height,width:height*16/9,codecs,bandwidth:height*1000});
function setup({audio=true,duration=618}={}) {
 const messages=[],intervals=[],location=new URL('https://www.bilibili.com/video/BV13PYx6GEfY/');
 const video={isConnected:true,currentSrc:'blob:https://www.bilibili.com/current',duration};
 const window={__playinfo__:{code:0,data:{timelength:617770,dash:{duration:618,video:[track('hevc1080',1080,'hvc1'),track('avc1080',1080),track('avc720',720)],audio:audio?[track('audio',0,'mp4a.40.2')]:[]}}},postMessage:m=>messages.push(m)};
 const document={querySelectorAll:selector=>selector==='video'?[video]:[],querySelector:selector=>selector==='h1'?{textContent:'测试视频'}:null,addEventListener(){}};
 vm.runInNewContext(code,{window,document,location,URL,setInterval:fn=>intervals.push(fn),console});
 return {messages,window,location,video,scan(){intervals.forEach(fn=>fn());},rows:()=>messages.flatMap(m=>m.items||[])};
}
test('Bilibili embedded DASH data becomes paired qualities attached to the blob player',()=>{
 const h=setup(),rows=h.rows();assert.equal(rows.length,1);
 assert.equal(rows[0].kind,'paired');assert.equal(rows[0].playerSrc,h.video.currentSrc);
 assert.deepEqual(Array.from(rows[0].variants,v=>v.height),[1080,720]);
 assert.match(rows[0].variants[0].url,/avc1080/);assert.match(rows[0].variants[0].audioUrl,/audio/);
 assert.equal(rows[0].title,'测试视频');assert.equal(rows[0].duration,618);
 assert.ok(rows[0].related.some(u=>u.includes('backup.bilivideo.com')));
});
test('Bilibili never offers silent DASH tracks or associates a short ad',()=>{
 assert.equal(setup({audio:false}).rows().length,0);assert.equal(setup({duration:15}).rows().length,0);
});
test('Bilibili navigation cannot relabel old playinfo as another video or part',()=>{
 for(const suffix of ['/video/BV17gQZBpE11/','/video/BV13PYx6GEfY/?p=2']){
  const h=setup();h.messages.length=0;h.location.href='https://www.bilibili.com'+suffix;h.scan();assert.equal(h.rows().length,0);
 }
});
test('Bilibili rejects non-HTTP tracks',()=>{
 const h=setup();h.messages.length=0;
 h.window.__playinfo__.data.dash.video.forEach(v=>v.baseUrl='file:///secret');
 h.window.__playinfo__.data.dash.video.forEach(v=>v.backupUrl=[]);h.scan();assert.equal(h.rows().length,0);
});
test('Bilibili cannot pair another content ID or an unrelated host with the audio',()=>{
 for(const replacement of ['https://cdn.bilivideo.com/upgcxcode/32/26/999/video.m4s','https://bilivideo.com.evil.test/upgcxcode/32/26/41727952632/video.m4s']) {
  const h=setup();h.messages.length=0;
  h.window.__playinfo__.data.dash.video.forEach(v=>{v.baseUrl=replacement;v.backupUrl=[];});h.scan();assert.equal(h.rows().length,0);
 }
});
test('Bilibili discovers late playback metadata and prefers standard CDN ports',()=>{
 const h=setup({duration:NaN});assert.equal(h.rows().length,0);
 h.window.__playinfo__.data.dash.video.forEach(v=>v.baseUrl=v.baseUrl.replace('cdn.bilivideo.com','peer.bilivideo.cn:8082'));
 h.video.duration=618;h.scan();assert.equal(h.rows().length,1);
 assert.match(h.rows()[0].variants[0].url,/backup\.bilivideo\.com/);
});
