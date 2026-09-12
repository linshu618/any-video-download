import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {progressReader} from './progress.js';
export function safeName(value = 'video') {
  let name = String(value).split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/\.(mp4|mkv|webm)$/i,'').replace(/[. ]+$/g,'').slice(0,120) || 'video';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
function remote(value) {
  if (typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new Error('无效的下载地址');
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol)) throw new Error('只允许 HTTP/HTTPS 媒体地址');
  return value;
}
export function buildArgs(job,output) {
  const args = ['-hide_banner','-loglevel','error','-nostdin','-n'];
  const addInput = url => {
    args.push('-protocol_whitelist','http,https,tcp,tls,crypto','-rw_timeout','20000000');
    if(job.pageUrl) args.push('-referer',remote(job.pageUrl));
    if(job.userAgent && !/[\r\n\x00]/.test(job.userAgent)) args.push('-user_agent',job.userAgent.slice(0,1000));
    args.push('-i',remote(url));
  };
  addInput(job.url);
  if(job.audioUrl) addInput(job.audioUrl);
  args.push('-map', Number.isInteger(job.videoIndex) ? `0:${job.videoIndex}` : '0:v:0?', '-map', job.audioUrl ? '1:a:0' : '0:a:0?',
    '-c','copy','-movflags','+faststart','-progress','pipe:1',output);
  return args;
}
export function chooseVideo(streams,height) {
  const videos = streams.filter(s => s.codec_type === 'video');
  const selected = height ? videos.find(s => s.height === height) : videos.sort((a,b) => (b.height || 0)-(a.height || 0))[0];
  if(!selected) throw new Error('清单中未找到所选画质');
  return selected.index;
}
async function dashIndex(config,job) {
  const args = ['-v','error','-protocol_whitelist','http,https,tcp,tls,crypto','-rw_timeout','15000000'];
  if(job.pageUrl) args.push('-referer',remote(job.pageUrl));
  if(job.userAgent && !/[\r\n\x00]/.test(job.userAgent)) args.push('-user_agent',job.userAgent.slice(0,1000));
  args.push('-show_streams','-of','json',remote(job.url));
  return new Promise((resolve,reject) => {
    const probe = spawn(path.join(path.dirname(config.ffmpeg),'ffprobe.exe'),args,{windowsHide:true,stdio:['ignore','pipe','ignore']});
    let text=''; const timer=setTimeout(() => {probe.kill();reject(new Error('DASH 画质探测超时'));},25000);
    probe.stdout.on('data',chunk => {text += chunk; if(text.length > 2*1024*1024) probe.kill();});
    probe.once('error',error => {clearTimeout(timer);reject(error);});
    probe.once('close',code => {clearTimeout(timer);try {if(code !== 0) throw new Error('无法探测 DASH 媒体');resolve(chooseVideo(JSON.parse(text).streams,job.height));}catch(error){reject(error);}});
  });
}
export async function startDownload(config,job,notify) {
  if(job.kind === 'dash') job = {...job,videoIndex:await dashIndex(config,job)};
  await fs.mkdir(config.downloadDir,{recursive:true});
  const output = path.join(config.downloadDir,`${safeName(job.title)}_${randomUUID().slice(0,8)}.mp4`);
  const args = buildArgs(job,output);
  const child = spawn(config.ffmpeg,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let finished = false;
  let errorText = '';
  child.stderr.on('data',chunk => {errorText = (errorText + chunk).slice(-3000);});
  child.stdout.on('data',progressReader(notify));
  const fail = async message => {
    if(finished) return; finished = true;
    await fs.rm(output,{force:true}).catch(() => {});
    // FFmpeg diagnostics can include signed URLs; do not expose them in the panel.
    notify({type:'error',error:message});
  };
  child.once('error',() => fail('无法启动 FFmpeg，请重新安装本地下载助手。'));
  child.once('close',async code => {
    if(finished) return;
    if(code === 0) { finished = true; const stat=await fs.stat(output);notify({type:'done',path:output,bytes:stat.size}); }
    else await fail(/403|401/.test(errorText) ? '媒体服务器拒绝访问（可能需要登录凭据或链接已过期）。' : '流媒体合并失败：可能是受保护内容、格式不兼容或网络中断。');
  });
  notify({type:'started'});
  return () => {if(!finished) child.kill();};
}
