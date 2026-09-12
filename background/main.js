import { classify, httpUrl, parseHls, parseDash, mergeMedia } from './media.js';
import { DownloadManager } from './downloads.js';
import { isExtensionPage } from './sender.js';
const downloads = new DownloadManager(chrome);
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
const queues = new Map(), inFlight = new Map();
const key = id => `media_v2_${id}`;
async function state(id) { return (await chrome.storage.session.get(key(id)))[key(id)] || {epoch:0, videos:[]}; }
function serial(id, task) {
  const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(id, next);
  next.finally(() => {if (queues.get(id) === next) queues.delete(id);}).catch(() => {});
  return next;
}
async function publish(id, value) {
  await chrome.storage.session.set({[key(id)]:value});
  await chrome.action.setBadgeText({tabId:id,text:value.videos.length ? String(value.videos.length) : ''}).catch(() => {});
  chrome.runtime.sendMessage({type:'VIDEO_FOUND',tabId:id,videos:value.videos,players:value.players || []}).catch(() => {});
}
async function reset(id, pageUrl) {
  return serial(id, async () => { const s = await state(id); await publish(id,{epoch:s.epoch+1,pageUrl,videos:[]}); });
}
async function playlist(url, kind) {
  const response = await fetch(url, {credentials:'include', signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`播放列表请求失败（HTTP ${response.status}）`);
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  while (true) {
    const {done,value} = await reader.read(); if(done) break;
    length += value.length;
    if (length > 4*1024*1024) {await reader.cancel(); throw new Error('播放列表超过 4 MB，已停止解析');}
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk,offset); offset += chunk.length;}
  return (kind === 'hls' ? parseHls : parseDash)(new TextDecoder().decode(bytes),response.url);
}
async function discover(tabId, candidate) {
  candidate=Object.fromEntries(Object.entries(candidate).filter(([,value])=>value!==undefined));
  if (tabId < 0 || !httpUrl(candidate.url)) return;
  let kind = candidate.kind || classify(candidate.url,candidate.type);
  if (!kind) return;
  const token = `${tabId}:${candidate.url}`;
  if (inFlight.has(token)) {const flight=inFlight.get(token);flight.queued={...flight.queued,...candidate};return;}
  const flight={queued:null,epoch:null};inFlight.set(token,flight);
  try {
    const tab = await chrome.tabs.get(tabId);
    let epoch, needsParse = false;
    await serial(tabId, async () => {
      const s = await state(tabId); epoch = s.epoch;flight.epoch=epoch;
      const old = s.videos.find(v => v.url === candidate.url);
      if(old?.kind && candidate.type==='video/unknown'){kind=old.kind;candidate.type=old.type;}
      if (s.videos.some(v => v.segments?.includes(candidate.url))) return;
      const refresh=kind!=='file' && (candidate.forceRefresh || !old?.parsed || Date.now()-(old.parsedAt || 0)>10000);
      if (old?.parsed && !refresh && !candidate.title && !candidate.poster && !candidate.duration && !candidate.width) return;
      const item = {...old, ...candidate, id:old?.id || crypto.randomUUID(),kind,
        title:candidate.title || old?.title || tab.title || '视频', pageUrl:tab.url,
        size:kind === 'file' ? candidate.size || old?.size || null : null,
        timestamp:old?.timestamp || Date.now()};
      needsParse = refresh;
      s.videos = mergeMedia(s.videos,item).slice(-200); s.pageUrl = tab.url;
      await publish(tabId,s);
    });
    if (!needsParse) return;
    let parsed;
    try {
      parsed = await playlist(candidate.url,kind);
      // One child supplies duration and segment membership even before the player chooses a quality.
      if (kind === 'hls' && parsed.variants.length) {
        try {
          const child = await playlist(parsed.variants[0].url,'hls');
          parsed.duration = child.duration; parsed.live = child.live;
          parsed.segments = child.segments; parsed.protected ||= child.protected;
        } catch { /* The master is still usable by the downloader. */ }
      }
      parsed.parsed = true;parsed.parsedAt=Date.now();parsed.error=null;
    } catch (error) { parsed = {error:error.message,parsed:false}; }
    await serial(tabId,async () => {
      const s = await state(tabId); if(s.epoch !== epoch) return;
      const item = s.videos.find(v => v.url === candidate.url);
      const parent = s.videos.find(v => v.related?.includes(candidate.url));
      if(!item && !parent) return;
      s.videos = mergeMedia(s.videos,{...(item || candidate), ...parsed,kind,url:candidate.url});
      await publish(tabId,s);
    });
  } catch { /* A tab may close while requests finish. */ }
  finally {
    inFlight.delete(token);
    if(flight.queued && (await state(tabId)).epoch===flight.epoch)discover(tabId,flight.queued);
  }
}
async function refreshPlayer(tabId,frameId) {
  const s=await state(tabId);
  for(const row of s.videos.filter(v=>v.kind!=='file' && (v.frameId || 0)===frameId).slice(-20)) {
    discover(tabId,{url:row.url,kind:row.kind,frameId,forceRefresh:true});
  }
}
chrome.webRequest.onResponseStarted.addListener(details => {
  if (details.tabId < 0 || details.statusCode >= 400) return;
  const header = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value;
  const type = header('content-type') || '';
  const kind = classify(details.url,type); if(!kind) return;
  const total = /\/(\d+)$/.exec(header('content-range') || '')?.[1];
  const size = total || (details.statusCode === 206 ? null : header('content-length'));
  discover(details.tabId,{url:details.url,type,kind,frameId:details.frameId || 0,size:size ? Number(size) : null});
},{urls:['<all_urls>']},['responseHeaders']);
chrome.runtime.onMessage.addListener((msg,sender,reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if(['GET_DOWNLOADS','START_DOWNLOAD','CANCEL_DOWNLOAD'].includes(msg.type)) {
    if(!isExtensionPage(sender,chrome.runtime.id)) {reply({error:'下载请求来源校验失败，请从扩展侧栏重试。'});return;}
    const operation=msg.type==='GET_DOWNLOADS' ? downloads.list().then(records=>({records}))
      : msg.type==='START_DOWNLOAD' ? downloads.start(msg.job).then(job=>({job}))
      : downloads.cancel(msg.id).then(()=>({ok:true}));
    operation.then(reply,error=>reply({error:error.message}));return true;
  }
  if(msg.type === 'GET_VIDEOS') {state(msg.tabId).then(s => reply({videos:s.videos,players:s.players || []})); return true;}
  if(msg.type === 'CLEAR_VIDEOS') {reset(msg.tabId).then(() => reply({ok:true})); return true;}
  if(msg.type === 'PLAYER_CHANGED' && sender.tab) {
    refreshPlayer(sender.tab.id,sender.frameId || 0).catch(console.error);return;
  }
  if(msg.type==='PLAYER_STATE' && sender.tab) {
    serial(sender.tab.id,async()=>{
      const s=await state(sender.tab.id),frameId=sender.frameId || 0,now=Date.now();
      const incoming=(Array.isArray(msg.players)?msg.players:[]).slice(0,20).map(p=>({
        id:String(p.id).slice(0,80),frameId,src:typeof p.src==='string'?p.src.slice(0,16000):'',duration:Number(p.duration)>0?Number(p.duration):null,
        visible:p.visible===true,paused:p.paused===true,reportedAt:now
      }));
      s.players=[...(s.players || []).filter(p=>p.frameId!==frameId && now-p.reportedAt<15000),...incoming];
      await publish(sender.tab.id,s);
    }).catch(console.error);return;
  }
  if(msg.type === 'MEDIA_SCAN' && sender.tab) {
    for(const item of (msg.items || []).slice(0,100)) {
      if(!httpUrl(item.url)) continue;
      discover(sender.tab.id,{url:item.url,frameId:sender.frameId || 0, type:String(item.type || '').slice(0,100),
        title:typeof item.title === 'string' ? item.title.slice(0,300) : undefined,
        poster:httpUrl(item.poster) || undefined,duration:Number(item.duration) || undefined,
        width:Number(item.width) || undefined,height:Number(item.height) || undefined});
    }
  }
});
chrome.tabs.onUpdated.addListener((id,change) => {if(change.url) reset(id,change.url);});
chrome.tabs.onRemoved.addListener(id => serial(id,() => chrome.storage.session.remove(key(id))));
