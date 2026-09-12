let currentTabId = null;
let latest = [];
let playback = [];
let records = [], view = 'media', refreshing = false;
const jobs = new Map(), choices = new Map();
const submitting = new Set();
const content = document.getElementById('content');
const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notice(message) {
  const node=document.getElementById('panelNotice');node.textContent=message || '';node.hidden=!message;
}
async function request(message) {
  let timer;
  try {
    return await Promise.race([chrome.runtime.sendMessage(message),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('后台未响应，请重新加载扩展并重新打开侧栏。')),15000);
    })]);
  } finally {clearTimeout(timer);}
}
function duration(seconds) {return seconds > 0 ? `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}` : '';}
function size(bytes) {return bytes > 0 ? bytes > 1048576 ? `${(bytes/1048576).toFixed(1)} MB` : `${Math.round(bytes/1024)} KB` : '';}
function name(video) {return (video.title || 'video').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,150);}
function directName(video) {
  const path = new URL(video.url).pathname;
  const ext = /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.exec(path)?.[1] || (video.type?.includes('webm') ? 'webm' : 'mp4');
  return `${name(video)}.${ext}`;
}
function sourceKey(value) {
  try {const u=new URL(value);if(!/^https?:$/.test(u.protocol))return null;u.hash='';return u.href;}catch{return null;}
}
function playerFor(video) {
  const urls=[video.url,...(video.related || [])].map(sourceKey).filter(Boolean);
  return playback.find(p=>p.visible && Date.now()-p.reportedAt<15000 && (p.frameId || 0)===(video.frameId || 0) && sourceKey(p.src) && urls.includes(sourceKey(p.src)));
}
function renderPlayers() {
  const node=document.getElementById('playerStatus');
  const current=playback.filter(p=>p.visible && p.duration && Date.now()-p.reportedAt<15000);
  node.hidden=view!=='media' || !current.length;
  node.innerHTML=current.map(p=>{
    const matched=latest.some(v=>playerFor(v)===p);
    return `<div><strong>页面播放器 ${escape(duration(p.duration))}</strong> · ${matched?'已关联下载条目':p.src?.startsWith('blob:')?'流式播放，尚未关联下载地址':'尚未关联下载地址'}</div>`;
  }).join('');
}
const isActive = job => ['starting','downloading','finalizing','cancelling'].includes(job.status);
const statusText = job => ({starting:'正在连接并准备下载…',downloading:'正在下载',finalizing:'正在完成文件封装…',cancelling:'正在取消…',complete:'下载完成',failed:'下载失败',cancelled:'已取消',interrupted:'下载中断'}[job.status] || job.status);
function progressHTML(job) {
  if(!job)return '';
  const percent=job.percent;
  const details=[percent!=null ? `${percent}%` : isActive(job) ? '正在获取进度' : '',
    job.seconds>0 ? `${duration(job.seconds)}${job.duration ? ` / ${duration(job.duration)}` : ''}` : '',
    job.bytes>0 ? `${job.kind==='file'?'已下载':'已写入'} ${size(job.bytes)}` : '',
    job.speed>0 && isActive(job) ? `处理速度 ${job.speed.toFixed(1)}×` : ''].filter(Boolean).join(' · ');
  return `<div class="job-progress"><div class="progress-caption"><strong>${escape(statusText(job))}</strong><span>${escape(job.quality)}</span></div>
    ${isActive(job) || job.status==='complete' ? `<progress max="100" ${percent!=null?`value="${percent}"`:''} aria-label="下载进度"></progress>` : ''}
    <div class="progress-details">${escape(details)}</div>${job.error?`<div class="job-error">${escape(job.error)}</div>`:''}</div>`;
}
function switchView(next) {
  view=next;
  for(const [id,value] of [['mediaTab','media'],['historyTab','history']]) {
    const button=document.getElementById(id);button.classList.toggle('selected',view===value);button.setAttribute('aria-pressed',String(view===value));
  }
  document.getElementById('clearBtn').hidden=view==='history';render();
  document.getElementById('rescanBtn').hidden=view==='history';
}
function renderHistory() {
  content.innerHTML=records.length ? records.map(job=>`<article class="history-item" data-job="${escape(job.id)}">
    <div class="video-name" title="${escape(job.title)}">${escape(job.title)}</div>
    <div class="history-date">${escape(new Date(job.createdAt).toLocaleString())} · ${escape(job.kind.toUpperCase())}</div>
    ${progressHTML(job)}${job.path?`<div class="file-path">${escape(job.path)}</div>`:''}
    <div class="history-actions">${isActive(job)?'<button class="cancel-job">取消下载</button>':''}${job.path?'<button class="copy-path">复制保存路径</button>':''}${job.browserId!=null && job.status==='complete'?'<button class="show-file">在文件夹中显示</button>':''}</div>
    </article>`).join('') : '<div class="empty-state"><p>还没有下载记录</p><p>新下载的进度和结果会保存在这里。</p></div>';
  for(const card of content.querySelectorAll('[data-job]')) {
    const job=records.find(r=>r.id===card.dataset.job);
    card.querySelector('.cancel-job')?.addEventListener('click',()=>cancelJob(job.id));
    card.querySelector('.copy-path')?.addEventListener('click',async e=>{try{await navigator.clipboard.writeText(job.path);e.target.textContent='已复制';}catch{e.target.textContent='复制失败';}});
    card.querySelector('.show-file')?.addEventListener('click',()=>chrome.downloads.showInFolder(job.browserId));
  }
}
async function cancelJob(id) {
  try {const result=await request({type:'CANCEL_DOWNLOAD',id});if(!result?.ok)throw new Error(result?.error || '后台未确认取消操作');await refreshRecords();}
  catch(error){notice(error.message);}
}
async function refreshRecords() {
  if(refreshing)return;refreshing=true;
  try {
    const result=await request({type:'GET_DOWNLOADS'});
    if(!Array.isArray(result?.records))throw new Error(result?.error || '后台未确认下载记录请求，请重新加载扩展。');
    const changed=JSON.stringify(records)!==JSON.stringify(result.records);
    records=result.records || [];jobs.clear();
    for(const job of records) if(job.mediaId && !jobs.has(job.mediaId))jobs.set(job.mediaId,{...job,active:isActive(job)});
    const count=records.filter(isActive).length;
    document.getElementById('downloadCount').textContent=count ? `${count} 个进行中` : String(records.length);
    if(changed && !document.activeElement?.matches('select'))render();
  } catch(error) {notice(error.message);} finally {refreshing=false;}
}
function render() {
  renderPlayers();
  if(view==='history'){renderHistory();return;}
  if(!latest.length) {content.innerHTML = '<div class="empty-state"><p>播放网页视频后，会在这里显示。</p><button id="scan">重新扫描</button></div>'; document.getElementById('scan').onclick=rescan; return;}
  content.innerHTML = [...latest].sort((a,b)=>Number(!!playerFor(b))-Number(!!playerFor(a)) || (b.timestamp || 0)-(a.timestamp || 0)).map(v => {
    const job = jobs.get(v.id), variants = v.variants || [], selected = choices.get(v.id) || '0';
    const player=playerFor(v);
    const options = variants.map((variant,index) => `<option value="${index}" ${String(index) === selected ? 'selected' : ''}>${escape(variant.height ? `${variant.height}p` : variant.bandwidth ? `${Math.round(variant.bandwidth/1000)} kbps` : `画质 ${index+1}`)}</option>`).join('');
    return `<div class="video-item" data-id="${escape(v.id)}">
      ${v.poster ? `<img class="poster" src="${escape(v.poster)}" alt="视频封面" referrerpolicy="no-referrer">` : ''}
      <div class="video-info"><div class="video-name" title="${escape(v.title)}">${escape(v.title)}</div>
        <div class="video-meta"><span class="badge">${escape(v.kind === 'file' ? '视频' : v.kind.toUpperCase())}</span>
        ${variants.length ? `<select class="quality" aria-label="清晰度" ${job?.active ? 'disabled' : ''}>${options}</select>` : ''}
        ${player?'<span class="badge">播放器</span>':''}
        <span class="size">${escape([duration(player?.duration || v.duration),v.kind === 'file' ? size(v.size) : '',v.live ? '直播' : ''].filter(Boolean).join(' · '))}</span></div>
        <div class="status" role="status">${escape(v.protected ? '检测到受保护的媒体，无法下载' : v.live ? '直播暂不支持下载' : v.error || '')}</div>
        ${progressHTML(job)}
        <div class="source">${escape(new URL(v.url).hostname)}</div>
      </div><div class="actions"><button class="download-btn" ${v.protected || v.live || job?.active || submitting.has(v.id) ? 'disabled' : ''}>${submitting.has(v.id) ? '正在提交…' : job?.active ? '下载中' : v.live ? '录制' : '下载'}</button>
      ${job?.active ? '<button class="cancel">取消</button>' : ''}<button class="copy">复制链接</button></div></div>`;
  }).join('');
  for(const row of content.querySelectorAll('.video-item')) {
    const video = latest.find(v => v.id === row.dataset.id);
    row.querySelector('.quality')?.addEventListener('change',e => choices.set(video.id,e.target.value));
    row.querySelector('.download-btn').onclick=() => download(video);
    row.querySelector('.cancel')?.addEventListener('click',() => cancelJob(jobs.get(video.id).id));
    row.querySelector('.copy').onclick=async () => {
      try {await navigator.clipboard.writeText(video.url);row.querySelector('.copy').textContent='已复制';} catch {row.querySelector('.copy').textContent='复制失败';}
    };
  }
}
async function download(video) {
  if(submitting.has(video.id))return;
  submitting.add(video.id);notice('');render();
  const variant = video.variants?.[Number(choices.get(video.id) || 0)];
  try {
    const result=await request({type:'START_DOWNLOAD',job:{mediaId:video.id,kind:video.kind,url:variant?.url || video.url,audioUrl:variant?.audioUrl,
      height:variant?.height,title:name(video),filename:directName(video),duration:playerFor(video)?.duration || video.duration,pageUrl:video.pageUrl,userAgent:navigator.userAgent}});
    if(!result?.job?.id) throw new Error(result?.error || '后台未确认下载任务，请重新加载扩展后重试。');
    // Show the acknowledged task immediately, even if a concurrent history refresh is pending.
    if(!records.some(r=>r.id===result.job.id))records.unshift(result.job);
    switchView('history');await refreshRecords();
  }catch(error){notice(`无法开始下载：${error.message}`);}
  finally{submitting.delete(video.id);render();}
}
async function load() {
  const requested = currentTabId; if(requested == null) return;
  try {const result=await chrome.runtime.sendMessage({type:'GET_VIDEOS',tabId:requested}); if(currentTabId === requested){latest=result?.videos || [];playback=result?.players || [];render();}}
  catch {content.textContent='扩展已更新，请关闭并重新打开侧栏。';}
}
function rescan() {if(currentTabId != null) chrome.tabs.sendMessage(currentTabId,{type:'RESCAN'}).catch(() => notice('当前网页尚未加载扫描脚本，请刷新视频网页后重试。'));}
chrome.runtime.onMessage.addListener(msg => {
  if(msg.type === 'VIDEO_FOUND' && msg.tabId === currentTabId){latest=msg.videos;playback=msg.players || [];if(view==='media')render();}
  if(msg.type === 'DOWNLOADS_CHANGED')refreshRecords();
});
chrome.tabs.onActivated.addListener(async info => {currentTabId=info.tabId;latest=[];playback=[];render();await load();rescan();});
document.getElementById('clearBtn').onclick=async () => {await chrome.runtime.sendMessage({type:'CLEAR_VIDEOS',tabId:currentTabId}); await load();};
const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
document.getElementById('mediaTab').onclick=()=>switchView('media');
document.getElementById('rescanBtn').onclick=()=>{notice('');rescan();};
document.getElementById('historyTab').onclick=()=>{switchView('history');refreshRecords();};
currentTabId=tab?.id; await load(); await refreshRecords();rescan();
setInterval(refreshRecords,1000);
