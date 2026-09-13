import fs from 'node:fs';
import {startDownload} from './download.js';
import {fileAction} from './file-actions.js';
const config = JSON.parse(fs.readFileSync(new URL('./config.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
if (!config.allowedOrigins.includes(process.argv[2])) process.exit(1);
function send(message) {
  const body = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); process.stdout.write(Buffer.concat([header,body]));
}
let buffered = Buffer.alloc(0), cancel = null, busy = false, closing = false, cancelled = false;
process.stdin.on('data',chunk => {
  buffered = Buffer.concat([buffered,chunk]);
  while(buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if(length > 256*1024) process.exit(1);
    if(buffered.length < 4+length) break;
    const payload = buffered.subarray(4,4+length); buffered = buffered.subarray(4+length);
    let msg; try {msg = JSON.parse(payload);} catch {send({type:'error',error:'无效请求'}); continue;}
    if(msg.type === 'ping') {send({type:'ready'}); continue;}
    if(msg.type==='file_action' && !busy) {
      busy=true;
      fileAction(msg).then(send,error=>send({ok:false,error:error.message})).finally(()=>{busy=false;if(closing)process.exit(0);});
      continue;
    }
    if(msg.type === 'cancel') {cancelled=true;cancel?.(); continue;}
    if(msg.type !== 'download' || busy) continue;
    busy = true; cancelled=false;
    startDownload(config,msg,reply => {send(reply); if(['done','error'].includes(reply.type)) busy=false;})
      .then(stop => {cancel=stop; if(closing || cancelled) cancel();})
      .catch(() => {busy=false; send({type:'error',error:'无法开始下载，请检查地址及本地助手配置。'});});
  }
});
process.stdin.on('end',() => {closing=true; cancel?.(); if(!busy) process.exit(0);});
process.stdout.on('error',() => {cancel?.(); process.exit(0);});
