import test from 'node:test';import assert from 'node:assert/strict';import {youtubePage,youtubeArgs,youtubeProgress} from '../native/youtube-download.js';
test('YouTube downloads resolve the page again rather than reusing a stale HLS URL',()=>{
 const args=youtubeArgs({ffmpeg:'C:/ffmpeg/bin/ffmpeg.exe'},{pageUrl:'https://www.youtube.com/watch?v=6l7ble9P74o&list=ignored',url:'https://stale.test/token',height:1080},'C:/Downloads/视频 %work');
 assert.equal(args.at(-1),'https://www.youtube.com/watch?v=6l7ble9P74o');assert.ok(args.includes('--ignore-config'));assert.ok(args.includes('--no-playlist'));
 assert.match(args[args.indexOf('-f')+1],/height=1080/);assert.ok(!args.some(x=>x.includes('stale.test')));assert.ok(args.some(x=>x.includes('%%work')));
});
test('YouTube routing rejects other hosts and malformed quality settings',()=>{
 for(const u of ['https://www.youtube.com.evil.test/watch?v=6l7ble9P74o','file:///C:/secret','http://www.youtube.com/watch?v=6l7ble9P74o'])assert.equal(youtubePage(u),null);
 assert.throws(()=>youtubeArgs({ffmpeg:'f'},{pageUrl:'https://www.youtube.com/watch?v=6l7ble9P74o',height:'1080;bad'},'out'));
});
test('YouTube progress combines tracks without pretending the video is complete before merging',()=>{
 const messages=[];const read=youtubeProgress(x=>messages.push(x));read(Buffer.from('avd:616:100\navd:140:2'));read(Buffer.from('0\navd:616:90\n'));
 assert.equal(messages.at(-1).bytes,120);assert.equal(messages.at(-1).indeterminate,true);assert.ok(messages.every(x=>x.type==='progress'&&x.seconds===0));
});

import {youtubeInfo} from '../native/youtube-download.js';
import {EventEmitter} from 'node:events';
function fakeInfo(value){return ()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify(value)));child.emit('close',0);});return child;};}
test('Metadata exposes only usable unique qualities and never signed media URLs',async()=>{
 const info=await youtubeInfo({ytDlp:'fake.exe'},'https://www.youtube.com/watch?v=6l7ble9P74o',String,fakeInfo({id:'6l7ble9P74o',title:'Sample',duration:58,formats:[{ext:'mp4',vcodec:'vp9',acodec:'none',height:1080,url:'https://secret.test/token'},{ext:'mp4',vcodec:'avc1',acodec:'none',height:1080},{ext:'mp4',vcodec:'avc1',acodec:'aac',height:720},{ext:'mp4',vcodec:'avc1',acodec:'aac',height:2160,has_drm:true},{ext:'m4a',vcodec:'none',acodec:'aac'}]}));
 assert.deepEqual(info.heights,[1080,720]);assert.equal(info.videoId,'6l7ble9P74o');assert.equal(JSON.stringify(info).includes('secret'),false);
});
test('Metadata rejects a different video and no usable MP4 tracks',async()=>{
 await assert.rejects(youtubeInfo({ytDlp:'fake.exe'},'https://www.youtube.com/watch?v=6l7ble9P74o',String,fakeInfo({id:'other'})),/不一致/);
 await assert.rejects(youtubeInfo({ytDlp:'fake.exe'},'https://www.youtube.com/watch?v=6l7ble9P74o',String,fakeInfo({id:'6l7ble9P74o',formats:[]})),/没有.*可下载/);
});
