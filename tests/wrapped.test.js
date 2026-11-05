import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {wrap} from './png-fixture.js';
import {pngChunk,unwrapPng,wrappedPlaylist,parseHls} from '../background/media.js';
import {pngPayload,readPlaylist,chooseVariant} from '../native/wrapped-hls.js';
import {startDownload} from '../native/download.js';

const playlist='#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:8.28,\nhttps://v3.cdn.test/hls/a/C-000.png?auth=x\n#EXTINF:10,\nhttps://v4.cdn.test/hls/a/C-001.png?auth=y\n#EXT-X-ENDLIST\n';
const bytes=buffer=>new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.length);
const responseOf=buffer=>new Response(new Blob([buffer]));

test('Background unwraps a deflated PNG-disguised playlist and keeps plain playlists unchanged',async()=>{
  const wrapped=await unwrapPng(bytes(wrap(playlist,true)));
  assert.equal(wrapped.wrapped,true);
  const parsed=parseHls(new TextDecoder().decode(wrapped.bytes),'https://cdn.test/index.png');
  assert.equal(parsed.duration,18.28);assert.equal(parsed.segments.length,2);assert.equal(parsed.live,false);
  const plain=await unwrapPng(new TextEncoder().encode(playlist));
  assert.equal(plain.wrapped,false);
  await assert.rejects(unwrapPng(bytes(wrap(playlist).subarray(0,60))),/缺少数据块/);
});
test('PNG probe accepts a disguised playlist and rejects disguised segments and real images',async()=>{
  assert.equal(await wrappedPlaylist(responseOf(wrap(playlist,true))),true);
  assert.equal(await wrappedPlaylist(responseOf(wrap(playlist,false))),true);
  assert.equal(await wrappedPlaylist(responseOf(wrap(Buffer.alloc(4000,0x47)))),false);
  const image=wrap(Buffer.alloc(0));image.write('IDAT',image.indexOf('roUd'),'latin1');
  assert.equal(await wrappedPlaylist(responseOf(image)),false);
  assert.equal(pngChunk(new TextEncoder().encode('#EXTM3U')).state,'plain');
});
test('Native parser unwraps segments, rejects encrypted or live playlists and picks the requested quality',()=>{
  assert.deepEqual([...pngPayload(wrap(Buffer.from([0x47,1,2])))],[0x47,1,2]);
  assert.equal(pngPayload(wrap(playlist,true)).toString(),playlist);
  assert.deepEqual([...pngPayload(Buffer.from([0x47,9]))],[0x47,9]);
  const list=readPlaylist(playlist,'https://cdn.test/index.png');
  assert.equal(list.segments[1],'https://v4.cdn.test/hls/a/C-001.png?auth=y');assert.equal(list.duration,18.28);
  assert.throws(()=>readPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST','https://cdn.test/'),/加密/);
  assert.equal(readPlaylist('#EXTM3U\n#EXTINF:1,\na.ts','https://cdn.test/').live,true);
  assert.throws(()=>readPlaylist('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST','https://cdn.test/'),/HTTP/);
  const master=readPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlo.png\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1280x720\nhi.png','https://cdn.test/m/index.png');
  assert.equal(chooseVariant(master.variants).url,'https://cdn.test/m/hi.png');
  assert.equal(chooseVariant(master.variants,360).url,'https://cdn.test/m/lo.png');
});

let config;
try {config=JSON.parse((await fs.readFile(new URL('../native/config.json',import.meta.url),'utf8')).replace(/^﻿/,''));} catch {}
test('PNG-disguised HLS downloads to a playable MP4 through FFmpeg',{timeout:45000,skip:!config},async()=>{
  await fs.mkdir('test-output',{recursive:true});
  const folder=await fs.mkdtemp(path.resolve('test-output/wrapped-'));
  const made=spawnSync(config.ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','3',
    '-c:v','libx264','-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0','-hls_segment_filename',path.join(folder,'C-%03d.ts'),path.join(folder,'plain.m3u8')],{windowsHide:true});
  assert.equal(made.status,0,made.stderr.toString());
  const text=(await fs.readFile(path.join(folder,'plain.m3u8'),'utf8')).replace(/C-(\d+)\.ts/g,'C-$1.png');
  const referers=new Set();
  const server=http.createServer(async(req,res)=>{
    referers.add(req.headers.referer);
    const name=path.basename(new URL(req.url,'http://localhost').pathname);
    if(name==='hls'){res.writeHead(302,{location:'/index.png?auth=1'}).end();return;}
    try{
      const body=name==='index.png'?wrap(text,true):wrap(await fs.readFile(path.join(folder,name.replace(/\.png$/,'.ts'))));
      res.writeHead(200,{'content-type':'image/png'}).end(body);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let stop;const updates=[];
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const output=await new Promise((resolve,reject)=>{
      startDownload({...config,downloadDir:folder},{url:`${base}/api/hls`,kind:'hls',wrapped:'png',title:'wrapped-fixture',pageUrl:`${base}/v/1`},msg=>{
        updates.push(msg);if(msg.type==='done')resolve(msg.path);if(msg.type==='error')reject(new Error(msg.error));
      }).then(cancel=>stop=cancel,reject);
    });
    assert.ok(updates.some(m=>m.type==='progress' && m.seconds>0));
    assert.deepEqual([...referers],[`${base}/v/1`]);
    const probe=spawnSync(path.join(path.dirname(config.ffmpeg),'ffprobe.exe'),['-v','error','-show_streams','-of','json',output],{windowsHide:true});
    assert.equal(probe.status,0,probe.stderr.toString());
    const streams=JSON.parse(probe.stdout).streams;
    assert.ok(streams.some(s=>s.codec_type==='video' && s.width===160));
    assert.ok(streams.some(s=>s.codec_type==='audio'));
    assert.ok(Number(streams[0].duration)>=2.9);
  }finally{stop?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('A blocked PNG segment fails with HTTP status and leaves no partial file',{timeout:20000,skip:!config},async()=>{
  await fs.mkdir('test-output',{recursive:true});
  const folder=await fs.mkdtemp(path.resolve('test-output/wrapped403-'));
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/index.png'))res.writeHead(200,{'content-type':'image/png'}).end(wrap('#EXTM3U\n#EXTINF:2,\nC-000.png\n#EXT-X-ENDLIST',true));
    else res.writeHead(403).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let stop;
  try{
    const error=await new Promise((resolve,reject)=>{
      startDownload({...config,downloadDir:folder},{url:`http://127.0.0.1:${server.address().port}/index.png`,kind:'hls',wrapped:'png',title:'blocked'},msg=>{
        if(msg.type==='error')resolve(msg.error);if(msg.type==='done')reject(new Error('Unexpected success'));
      }).then(cancel=>stop=cancel,reject);
    });
    assert.match(error,/分片.*HTTP 403/);assert.doesNotMatch(error,/127\.0\.0\.1/);
    assert.deepEqual((await fs.readdir(folder)).filter(f=>f.endsWith('.mp4')),[]);
  }finally{stop?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
