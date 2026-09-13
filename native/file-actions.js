import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

function launch(script) {
  return new Promise((resolve,reject)=>{
    const executable=path.join(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child=spawn(executable,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('打开文件超时，请重试。'));},10000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('无法启动系统文件操作。'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('系统无法打开此文件，请检查默认播放器或文件关联。'));});
  });
}
export async function fileAction(input,run=launch) {
  if(!['open','reveal'].includes(input.action))throw new Error('不支持的文件操作');
  const value=input.path;
  const valid=p=>typeof p==='string' && /^[a-z]:[\\/]/i.test(p) && !/[\x00-\x1f"<>|?*]/.test(p) && !p.slice(2).includes(':') && /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(p);
  if(!valid(value))throw new Error('只支持本地视频文件');
  let target;
  try {target=await fs.realpath(value);if(!(await fs.stat(target)).isFile())throw new Error();}
  catch {throw new Error('文件不存在，可能已被移动或删除。');}
  if(!valid(target))throw new Error('文件指向的目标不是本地视频');
  // File names are data, never executable PowerShell text (including quotes, $, and &).
  const encoded=Buffer.from(target,'utf8').toString('base64');
  const command=input.action==='reveal'
    ? `Start-Process -FilePath explorer.exe -ArgumentList ('/select,"{0}"' -f $target)`
    : 'Start-Process -FilePath $target';
  await run(`$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ${command}`);
  return {ok:true};
}
