(() => {
  const sent=new Set(), resources=new Map(), players=new WeakMap(), playerIds=new WeakMap();let pending=null,force=false,nextPlayerId=0,lastReport=0,bridged=[],bridgeAt=0,bridgeSent='';
  function allVideos(root=document,seen=new Set()) {
    if(seen.has(root))return [];seen.add(root);
    const found=[...root.querySelectorAll('video')];
    for(const node of root.querySelectorAll('*'))if(node.shadowRoot)found.push(...allVideos(node.shadowRoot,seen));
    return found;
  }
  function collect(entries) {
    for(const e of entries) if(/\.(m3u8|mpd|mp4|webm)(?:\?|$)/i.test(e.name)) resources.set(e.name,{url:e.name,observedAt:e.startTime || 0});
  }
  function scan() {
    pending=null;
    const items=[],playback=[];let changed=force;const forced=force;force=false;
    for(const video of allVideos()) {
      const src=video.currentSrc || video.src || '',duration=Number.isFinite(video.duration)?video.duration:null;
      const old=players.get(video);
      if(!old || old.src!==src || (old.duration==null)!==(duration==null) || Math.abs((old.duration || 0)-(duration || 0))>Math.max(2,(old.duration || 0)*0.05)) {
        changed=true;players.set(video,{src,duration});
      }
      if(!playerIds.has(video))playerIds.set(video,String(++nextPlayerId));
      const rect=video.getBoundingClientRect?.();
      playback.push({id:playerIds.get(video),src,duration,width:video.videoWidth,height:video.videoHeight,visible:rect?rect.width>0 && rect.height>0:true,paused:video.paused});
      if(/^https?:/.test(src))items.push({url:src,type:video.querySelector('source')?.type || 'video/unknown',
        title:video.getAttribute('title') || video.getAttribute('aria-label') || undefined,
        poster:video.poster,duration:duration ?? undefined,width:video.videoWidth,height:video.videoHeight});
      // Alternative/previous <source> elements are candidates, not evidence for the playing video's duration.
      for(const source of video.querySelectorAll('source'))if(source.src!==src && /^https?:/.test(source.src))items.push({url:source.src,type:source.type || 'video/unknown'});
    }
    if(changed || Date.now()-lastReport>5000){lastReport=Date.now();chrome.runtime.sendMessage({type:'PLAYER_STATE',players:playback}).catch(()=>{});}
    if(changed)chrome.runtime.sendMessage({type:'PLAYER_CHANGED'}).catch(()=>{});
    const matched=Date.now()-bridgeAt<10000?bridged.filter(item=>playback.some(p=>p.src===item.playerSrc && Math.abs(p.duration-item.duration)<2)):[];
    const bridgeKey=JSON.stringify(matched);
    if(matched.length && (forced || bridgeKey!==bridgeSent)) {
      bridgeSent=bridgeKey;
      chrome.runtime.sendMessage({type:'PLAYER_MEDIA',items:matched}).catch(()=>{bridgeSent='';});
    }
    items.push(...resources.values());resources.clear();
    const fresh=items.filter(item=>{const key=JSON.stringify(item);if(sent.has(key))return false;sent.add(key);return true;});
    if(sent.size>5000)sent.clear();
    // Receiver accepts 100 items per message. Never mark the remaining tail as sent and discard it.
    for(let i=0;i<fresh.length;i+=100){
      const batch=fresh.slice(i,i+100);
      chrome.runtime.sendMessage({type:'MEDIA_SCAN',items:batch}).catch(()=>{for(const item of batch)sent.delete(JSON.stringify(item));});
    }
  }
  // Throttle rather than debounce: continuous media requests must not starve the scan.
  function schedule(){if(pending===null)pending=setTimeout(scan,300);}
  if(typeof window!=='undefined')window.addEventListener('message',event=>{
    if(event.source!==window)return;
    const allowed=event.data?.channel==='avd-douyin-player-v1' && /(^|\.)douyin\.com$/.test(location.hostname)
      || event.data?.channel==='avd-bilibili-player-v1' && /(^|\.)bilibili\.com$/.test(location.hostname);
    if(!allowed)return;
    bridged=(Array.isArray(event.data.items)?event.data.items:[]).slice(0,5);bridgeAt=Date.now();schedule();
  });
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','poster']});
  for(const event of ['loadstart','emptied','loadedmetadata','durationchange','playing','play','ended'])document.addEventListener(event,schedule,true);
  collect(performance.getEntriesByType('resource'));
  try{new PerformanceObserver(list=>{collect(list.getEntries());schedule();}).observe({type:'resource',buffered:true});}catch{}
  chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='RESCAN'){sent.clear();force=true;collect(performance.getEntriesByType('resource'));schedule();}});
  // Some players reuse a blob URL and update metadata without changing DOM attributes.
  setInterval(schedule,2000);
  scan();
})();
