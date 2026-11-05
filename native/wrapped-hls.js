import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import {progressReader} from './progress.js';

// Some sites disguise HLS playlists and MPEG-TS segments as PNG images: the real bytes sit in a private "roUd"
// chunk whose first byte is a flag (bit 0 = zlib/deflate). FFmpeg cannot read that, so segments are fetched here,
// unwrapped and piped to FFmpeg in order.
const SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const PREFETCH=4, ATTEMPTS=3;
export function pngPayload(buffer) {
  if(buffer.length<8 || !buffer.subarray(0,8).equals(SIGNATURE))return buffer;
  for(let i=8;i+8<=buffer.length;) {
    const size=buffer.readUInt32BE(i),type=buffer.toString('latin1',i+4,i+8),start=i+8;
    if(start+size>buffer.length)break;
    if(type==='roUd' && size>0) {
      const data=buffer.subarray(start+1,start+size);
      return buffer[start]&1 ? zlib.inflateSync(data,{maxOutputLength:64*1024*1024}) : data;
    }
    if(type==='IEND')break;
    i=start+size+4;
  }
  throw new Error('PNG 包装的媒体缺少数据块，网站格式可能已变化。');
}
function httpHref(value,base) {
  const url=new URL(value,base);
  if(!['http:','https:'].includes(url.protocol))throw new Error('只允许 HTTP/HTTPS 媒体地址');
  return url.href;
}
export function readPlaylist(text,base) {
  if(!text.trimStart().startsWith('#EXTM3U'))throw new Error('返回内容不是 HLS 播放列表');
  const variants=[],segments=[];let pending=null,duration=0,ended=false;
  for(const line of text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)) {
    if(line.startsWith('#EXT-X-STREAM-INF:')){pending=line;continue;}
    if(line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE\b/.test(line))
      throw new Error('该视频的分片使用了加密或 fMP4 格式，暂不支持下载。');
    if(line.startsWith('#EXTINF:'))duration+=Number.parseFloat(line.slice(8)) || 0;
    if(line==='#EXT-X-ENDLIST')ended=true;
    if(line.startsWith('#'))continue;
    const url=httpHref(line,base);
    if(pending) {
      variants.push({url,height:Number(/RESOLUTION=\d+x(\d+)/.exec(pending)?.[1]) || 0,bandwidth:Number(/BANDWIDTH=(\d+)/.exec(pending)?.[1]) || 0});
      pending=null;
    } else segments.push(url);
  }
  return {variants,segments,duration,live:!variants.length && !ended};
}
export function chooseVariant(variants,height) {
  const sorted=[...variants].sort((a,b)=>b.height-a.height || b.bandwidth-a.bandwidth);
  return (height && sorted.find(v=>v.height===height)) || sorted[0];
}
class HttpError extends Error {
  constructor(status,segment){super(`${segment?'媒体分片':'播放列表'}请求失败：服务器返回 HTTP ${status}。`);this.status=status;}
}
async function fetchBuffer(url,headers,signal,limit,segment) {
  let last;
  for(let attempt=0;attempt<ATTEMPTS;attempt++) {
    try {
      const response=await fetch(url,{headers,redirect:'follow',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
      if(!response.ok)throw new HttpError(response.status,segment);
      const chunks=[];let length=0;
      for await(const chunk of response.body) {
        length+=chunk.length;
        if(length>limit)throw new Error(segment?'媒体分片超过大小上限。':'播放列表超过大小上限。');
        chunks.push(chunk);
      }
      return {buffer:Buffer.concat(chunks),url:response.url || url};
    } catch(error) {
      if(signal.aborted)throw error;
      last=error;
      if(error instanceof HttpError && error.status<500 && error.status!==429)break;
    }
  }
  if(last?.name==='TimeoutError')throw new Error('网络读写超时。');
  if(last instanceof HttpError || /上限/.test(last?.message))throw last;
  throw new Error(`${segment?'媒体分片':'播放列表'}下载失败：${last?.cause?.code || last?.message || '网络错误'}`);
}
async function loadPlaylist(job,headers,signal) {
  let {buffer,url}=await fetchBuffer(httpHref(job.url),headers,signal,8*1024*1024,false);
  let list=readPlaylist(pngPayload(buffer).toString('utf8'),url);
  if(list.variants.length) {
    ({buffer,url}=await fetchBuffer(chooseVariant(list.variants,job.height).url,headers,signal,8*1024*1024,false));
    list=readPlaylist(pngPayload(buffer).toString('utf8'),url);
    if(list.variants.length)throw new Error('播放列表嵌套层级不受支持。');
  }
  if(list.live)throw new Error('直播流暂不支持下载。');
  if(!list.segments.length)throw new Error('播放列表中没有视频分片。');
  return list;
}
async function segment(url,headers,signal) {
  const data=pngPayload((await fetchBuffer(url,headers,signal,64*1024*1024,true)).buffer);
  if(data[0]!==0x47)throw new Error('解包后的分片不是 MPEG-TS 格式，暂不支持下载。');
  return data;
}
export function startWrappedHls(config,job,output,notify,failure) {
  if(job.audioUrl)throw new Error('PNG 包装的视频暂不支持单独音轨。');
  const controller=new AbortController(), headers={'user-agent':String(job.userAgent || 'Mozilla/5.0').slice(0,1000)};
  if(job.pageUrl)headers.referer=httpHref(job.pageUrl);
  let child=null,finished=false,exited=null,errorText='';
  const fail=async message=>{
    if(finished)return;finished=true;
    controller.abort();child?.kill();
    // Windows keeps the output locked until FFmpeg exits.
    if(child && child.exitCode===null)await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]).catch(()=>{});
    await fs.rm(output,{force:true}).catch(()=>{});
    notify({type:'error',error:message});
  };
  const run=async()=>{
    const list=await loadPlaylist(job,headers,controller.signal);
    if(finished)return;
    child=spawn(config.ffmpeg,['-hide_banner','-loglevel','warning','-n','-f','mpegts','-i','pipe:0','-map','0:v:0?','-map','0:a:0?',
      '-c','copy','-movflags','+faststart','-progress','pipe:1',output],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    exited=once(child,'close');
    child.stdin.on('error',()=>{});
    child.stderr.on('data',chunk=>{errorText=(errorText+chunk).slice(-65536);});
    child.stdout.on('data',progressReader(notify));
    child.once('error',()=>fail('无法启动 FFmpeg，请重新安装本地下载助手。'));
    child.once('close',async code=>{
      if(finished)return;
      if(code===0){finished=true;const stat=await fs.stat(output);notify({type:'done',path:output,bytes:stat.size});}
      else await fail(failure(errorText,code));
    });
    const pending=[];let next=0;
    const fill=()=>{
      while(pending.length<PREFETCH && next<list.segments.length) {
        const task=segment(list.segments[next++],headers,controller.signal);task.catch(()=>{});pending.push(task);
      }
    };
    while(next<list.segments.length || pending.length) {
      fill();
      const data=await pending.shift();
      if(finished || child.exitCode!==null)return;
      if(!child.stdin.write(data))await Promise.race([once(child.stdin,'drain'),exited]);
    }
    child.stdin.end();
  };
  notify({type:'started'});
  run().catch(error=>fail(controller.signal.aborted && !finished ? '下载已取消' : error.message));
  // Cancel reports through fail(): the extension already marks a cancelling job as cancelled.
  return ()=>{if(!finished){controller.abort();child?.kill();}};
}
