import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {startDownload} from '../native/download.js';
let config;
try {config = JSON.parse((await fs.readFile(new URL('../native/config.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));} catch {}
await fs.mkdir('test-output',{recursive:true});
test('Real HLS split video/audio becomes a playable MP4 with both tracks', {timeout:45000,skip:!config}, async () => {
  const folder = await fs.mkdtemp(path.resolve('test-output/hls-'));
  const video = spawnSync(config.ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','2','-c:v','libx264','-an','-f','hls','-hls_time','1','-hls_list_size','0',path.join(folder,'video.m3u8')],{windowsHide:true});
  assert.equal(video.status,0,video.stderr.toString());
  const audio = spawnSync(config.ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-c:a','aac','-vn','-f','hls','-hls_time','1','-hls_list_size','0',path.join(folder,'audio.m3u8')],{windowsHide:true});
  assert.equal(audio.status,0,audio.stderr.toString());
  const server = http.createServer(async(req,res) => {
    try {res.end(await fs.readFile(path.join(folder,path.basename(new URL(req.url,'http://localhost').pathname))));} catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let stop;const updates=[];
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const done = new Promise((resolve,reject) => {
      startDownload({...config,downloadDir:folder},{url:`${base}/video.m3u8`,audioUrl:`${base}/audio.m3u8`,kind:'hls',title:'fixture'},msg => {
        updates.push(msg);
        if(msg.type === 'done') resolve(msg.path); if(msg.type === 'error') reject(new Error(msg.error));
      }).then(cancel => stop=cancel,reject);
    });
    const output=await done;
    assert.ok(updates.some(m=>m.type==='progress' && m.seconds>0 && m.bytes>0));
    assert.ok(updates.find(m=>m.type==='done').bytes>0);
    const probe=spawnSync(path.join(path.dirname(config.ffmpeg),'ffprobe.exe'),['-v','error','-show_streams','-of','json',output],{windowsHide:true});
    assert.equal(probe.status,0,probe.stderr.toString());
    const streams=JSON.parse(probe.stdout).streams;
    assert.ok(streams.some(s => s.codec_type === 'video' && s.width === 160));
    assert.ok(streams.some(s => s.codec_type === 'audio'));
    assert.ok(Number(streams[0].duration) >= 1.9);
  } finally {stop?.();server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
});
test('Native messaging handshake handles fragmented framed input',{timeout:10000,skip:!config}, async () => {
  const host=spawn(process.execPath,['native/host.js',config.allowedOrigins[0]],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const body=Buffer.from(JSON.stringify({type:'ping'})), header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  const response = new Promise((resolve,reject) => {let bytes=Buffer.alloc(0);host.stdout.on('data',chunk => {bytes=Buffer.concat([bytes,chunk]);if(bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0)+4) resolve(JSON.parse(bytes.subarray(4,4+bytes.readUInt32LE(0))));});host.on('error',reject);host.on('exit',code => {if(code) reject(new Error(`Native host exit ${code}`));});});
  host.stdin.write(header.subarray(0,2));host.stdin.write(Buffer.concat([header.subarray(2),body]));
  try {assert.deepEqual(await response,{type:'ready'});} finally {host.stdin.end();}
});
test('Native host rejects another extension origin',{skip:!config}, () => {
  const result=spawnSync(process.execPath,['native/host.js','chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],{windowsHide:true});
  assert.equal(result.status,1);
});

test('Native file action returns a framed missing-file error even when stdin closes',{skip:!config},()=>{
  const body=Buffer.from(JSON.stringify({type:'file_action',action:'reveal',path:path.resolve('test-output/does-not-exist.mp4')}));
  const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  const result=spawnSync(process.execPath,['native/host.js',config.allowedOrigins[0]],{input:Buffer.concat([header,body]),windowsHide:true,timeout:10000});
  assert.equal(result.status,0);assert.ok(result.stdout.length>4);
  const reply=JSON.parse(result.stdout.subarray(4,4+result.stdout.readUInt32LE(0)));
  assert.equal(reply.ok,false);assert.match(reply.error,/不存在|移动|删除/);
});
test('Real DASH download honors selected resolution and retains audio',{timeout:45000,skip:!config},async()=>{
  const folder=await fs.mkdtemp(path.resolve('test-output/dash-'));
  const generated=spawnSync(config.ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-f','lavfi','-i','color=c=red:s=320x180:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-map','0:v','-map','1:v','-map','2:a','-c:v','libx264','-c:a','aac','-f','dash','movie.mpd'],{windowsHide:true,cwd:folder});
  assert.equal(generated.status,0,generated.stderr.toString());
  const server=http.createServer(async(req,res)=>{try{res.end(await fs.readFile(path.join(folder,path.basename(new URL(req.url,'http://localhost').pathname))));}catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let stop;
  try{
    const output=await new Promise((resolve,reject)=>{
      startDownload({...config,downloadDir:folder},{url:`http://127.0.0.1:${server.address().port}/movie.mpd`,kind:'dash',height:180,title:'dash-fixture'},msg=>{if(msg.type==='done')resolve(msg.path);if(msg.type==='error')reject(new Error(msg.error));}).then(cancel=>stop=cancel,reject);
    });
    const probe=spawnSync(path.join(path.dirname(config.ffmpeg),'ffprobe.exe'),['-v','error','-show_streams','-of','json',output],{windowsHide:true});
    assert.equal(probe.status,0);
    const streams=JSON.parse(probe.stdout).streams;
    assert.ok(streams.some(s=>s.codec_type==='video'&&s.height===180));
    assert.ok(streams.some(s=>s.codec_type==='audio'));
  }finally{stop?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('An HTTP 403 media segment reaches the user as HTTP 403, not a merge guess',{timeout:15000,skip:!config},async()=>{
  const folder=await fs.mkdtemp(path.resolve('test-output/http403-'));
  const server=http.createServer((req,res)=>{
    if(req.url==='/index.m3u8'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nblocked.ts\n#EXT-X-ENDLIST');}
    else res.writeHead(403).end('Forbidden');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let stop;
  try{
    const error=await new Promise((resolve,reject)=>{
      startDownload({...config,downloadDir:folder},{url:`http://127.0.0.1:${server.address().port}/index.m3u8`,kind:'hls',title:'rejected-segment'},msg=>{
        if(msg.type==='error')resolve(msg.error);if(msg.type==='done')reject(new Error('Unexpected successful download'));
      }).then(cancel=>stop=cancel,reject);
    });
    assert.match(error,/HTTP 403/);assert.match(error,/分片/);assert.doesNotMatch(error,/可能|127\.0\.0\.1|http:\/\//);
  }finally{stop?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
