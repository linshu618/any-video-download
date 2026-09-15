import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
export function youtubePage(value) {
  try {const u=new URL(value);if(u.protocol!=='https:' || !['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname))return null;
    const id=u.pathname==='/watch'?u.searchParams.get('v'):/^\/(shorts|embed)\/([^/]+)\/?$/.exec(u.pathname)?.[2];
    return /^[\w-]{11}$/.test(id || '')?`https://www.youtube.com/watch?v=${id}`:null;
  }catch{return null;}
}
export function youtubeArgs(config,job,workDir) {
  const url=youtubePage(job.pageUrl);if(!url)throw new Error('无效的 YouTube 视频地址。');
  const height=Number(job.height);if(job.height!=null && (!Number.isInteger(height)||height<1||height>8640))throw new Error('无效的视频清晰度。');
  const filter=height?`[height=${height}]`:'';
  return ['--ignore-config','--no-playlist','--no-simulate','--no-overwrites','--no-colors','--encoding','utf-8','--newline','--progress','--progress-delta','0.5',
    '--socket-timeout','20','--retries','2','--fragment-retries','2',
    '--js-runtimes',`node:${process.execPath}`,'--ffmpeg-location',path.dirname(config.ffmpeg),
    '--progress-template','download:avd:%(info.format_id)s:%(progress.downloaded_bytes)s',
    '-f',`bv${filter}[ext=mp4]+ba[ext=m4a]/b${filter}[ext=mp4]`,
    '--merge-output-format','mp4','--remux-video','mp4','-o',path.join(workDir,'video.%(ext)s').replaceAll('%(ext)s','__AVD_EXT__').replaceAll('%','%%').replace('__AVD_EXT__','%(ext)s'),url];
}
export function youtubeProgress(notify) {
  let buffer='';const tracks=new Map();
  return chunk=>{buffer+=chunk.toString('utf8');const lines=buffer.split(/\r?\n/);buffer=lines.pop().slice(-65536);
    for(const line of lines){const m=/^avd:([^:]{1,128}):(\d+)$/.exec(line.trim());if(!m)continue;tracks.set(m[1],Math.max(tracks.get(m[1])||0,Number(m[2])));
      notify({type:'progress',seconds:0,bytes:[...tracks.values()].reduce((a,b)=>a+b,0),speed:null,indeterminate:true});}
  };
}
export async function startYoutubeDownload(config,job,output,notify,formatError,launch=spawn) {
  if(!config.ytDlp)throw new Error('YouTube 下载器尚未配置，请重新运行本地助手安装脚本。');
  await fs.access(config.ytDlp);
  const base=await fs.realpath(config.downloadDir),work=await fs.mkdtemp(path.join(base,'.avd-youtube-'));
  const cleanup=async()=>{if(path.dirname(work)!==base || !path.basename(work).startsWith('.avd-youtube-'))throw new Error('Invalid download workspace');await fs.rm(work,{recursive:true,force:true}).catch(()=>{});};
  let child;
  try{child=launch(config.ytDlp,youtubeArgs(config,job,work),{windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){await cleanup();throw error;}
  let settled=false,cancelled=false,stderr='';
  child.stdout.on('data',youtubeProgress(notify));
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-65536);});
  const finish=async(code,error)=>{
    if(settled)return;settled=true;
    let message;
    try{
      if(error || code!==0 || cancelled){message={type:'error',error:cancelled?'下载已取消。':formatError(error?.message || stderr,code,'YouTube 下载器')};}
      else {
      const result=path.join(work,'video.mp4');const stat=await fs.stat(result);if(!stat.isFile()||!stat.size)throw new Error('下载器没有生成完整视频文件。');
      await fs.copyFile(result,output,1);
      message={type:'done',path:output,bytes:stat.size};
      }
    }catch(error){message={type:'error',error:formatError(error.message,error.code,'保存视频')};}
    finally{await cleanup();}
    notify(message);
  };
  child.once('error',error=>{void finish(null,error);});child.once('close',code=>{void finish(code);});
  notify({type:'started'});
  return ()=>{
    if(settled||cancelled)return;cancelled=true;
    if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}
    else child.kill();
  };
}

export async function youtubeInfo(config,pageUrl,formatError,launch=spawn) {
  const url=youtubePage(pageUrl);if(!url)throw new Error('无效的 YouTube 视频地址。');
  if(!config.ytDlp)throw new Error('YouTube 下载器尚未配置，请更新本地助手。');
  const args=['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-progress','--no-colors','--encoding','utf-8','--socket-timeout','15','--retries','1','--js-runtimes',`node:${process.execPath}`,url];
  return new Promise((resolve,reject)=>{
    const child=launch(config.ytDlp,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;
    child.stdout.setEncoding?.('utf8');child.stderr.setEncoding?.('utf8');
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('YouTube 视频解析超时（45 秒）。'));},45000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16*1024*1024){child.kill();finish(new Error('YouTube 视频信息超过大小限制。'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
    child.once('error',error=>finish(new Error(formatError(error.message,error.code,'YouTube 解析器'))));
    child.once('close',code=>{
      if(settled)return;
      if(code!==0){finish(new Error(formatError(stderr,code,'YouTube 解析器')));return;}
      try{
        const data=JSON.parse(stdout);if(data.id!==new URL(url).searchParams.get('v'))throw new Error('解析结果与当前视频不一致。');
        if(data.is_live || data.live_status==='is_upcoming')throw new Error('YouTube 直播或尚未开始的视频暂不支持下载。');
        const formats=Array.isArray(data.formats)?data.formats:[];
        const hasAudio=formats.some(f=>!f.has_drm && f.ext==='m4a' && f.acodec && f.acodec!=='none');
        const heights=[...new Set(formats.filter(f=>!f.has_drm && f.ext==='mp4' && f.vcodec && f.vcodec!=='none' && (hasAudio || f.acodec && f.acodec!=='none')).map(f=>Number(f.height)).filter(h=>Number.isInteger(h)&&h>0&&h<=8640))].sort((a,b)=>b-a);
        if(!heights.length)throw new Error('解析器没有返回带音轨的可下载 MP4 清晰度。');
        finish(null,{videoId:data.id,title:String(data.title || 'YouTube 视频').slice(0,300),duration:Number(data.duration)>0?Number(data.duration):null,heights});
      }catch(error){finish(new Error(error instanceof SyntaxError?'YouTube 解析器返回了无效 JSON。':error.message));}
    });
  });
}
