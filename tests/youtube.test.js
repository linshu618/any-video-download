import test from 'node:test';import assert from 'node:assert/strict';import {youtubeId,createYoutubeResolver} from '../background/youtube.js';
const id='YzI6-emjbMA',url='https://www.youtube.com/watch?v='+id;
test('YouTube URLs require exact HTTPS hosts and valid video IDs',()=>{assert.equal(youtubeId(url),id);assert.equal(youtubeId('https://www.youtube.com/shorts/'+id),id);for(const bad of ['http://www.youtube.com/watch?v='+id,'https://youtube.com.evil.test/watch?v='+id,'https://www.youtube.com/watch?v=bad'])assert.equal(youtubeId(bad),null);});
test('Discovery uses the configured native parser and returns canonical page URLs with real qualities',async()=>{
 let message;const resolve=createYoutubeResolver({runtime:{sendNativeMessage:async(host,msg)=>{assert.equal(host,'com.any_video_download.helper');message=msg;return {ok:true,media:{videoId:id,title:'Sample',duration:120,heights:[720,1080,720]}};}}});
 const result=await resolve(url);assert.equal(message.type,'youtube_info');assert.equal(result.kind,'youtube');assert.deepEqual(result.variants.map(v=>v.height),[1080,720]);assert.ok(result.variants.every(v=>v.url===url));
});
test('Native errors remain specific instead of falling back to empty HLS discovery',async()=>{
 await assert.rejects(createYoutubeResolver({runtime:{sendNativeMessage:async()=>{throw Error('Specified native messaging host not found.');}}})(url),/未找到本地助手.*GUIDE\.md.*重新运行安装脚本/);
 await assert.rejects(createYoutubeResolver({runtime:{sendNativeMessage:async()=>{throw Error('Native host has exited.');}}})(url),/YouTube 本地解析失败：Native host has exited\./);
 await assert.rejects(createYoutubeResolver({runtime:{sendNativeMessage:async()=>({ok:false,error:'HTTP 403'})}})(url),/HTTP 403/);
});
test('Discovery rejects mismatched metadata and invalid quality arrays',async()=>{
 await assert.rejects(createYoutubeResolver({runtime:{sendNativeMessage:async()=>({ok:true,media:{videoId:'other',heights:[1080]}})}})(url),/不匹配/);
 await assert.rejects(createYoutubeResolver({runtime:{sendNativeMessage:async()=>({ok:true,media:{videoId:id,heights:['1080',0,-1]}})}})(url),/没有可下载/);
});
