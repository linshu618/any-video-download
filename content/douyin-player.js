// Runs in the page's MAIN world; exports only the current player's media fields.
(() => {
  if(!/(^|\.)douyin\.com$/.test(location.hostname))return;
  const http=value=>{try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
  const urls=value=>(Array.isArray(value)?value:[value]).map(v=>http(typeof v==='string'?v:v?.src || v?.url)).filter(Boolean);
  function scan() {
    try {
      const p=window.player,video=p?.video,config=p?.config;
      if(!video?.isConnected || !config || !video.currentSrc || !Number.isFinite(video.duration) || video.duration<=0)return;
      const info=config.awemeInfo || {},id=String(info.awemeId || p.curDefinition?.vid || '');
      const requested=new URL(location.href).searchParams.get('modal_id') || /^\/video\/(\d+)/.exec(location.pathname)?.[1];
      if(!/^\d+$/.test(id) || requested && requested!==id)return;
      const current=p.curDefinition;
      const definitions=[current,...(config.definition?.list || [])].filter(Boolean);
      const variants=[],related=new Set();
      for(const d of definitions.slice(0,20)) {
        if(d.vid && String(d.vid)!==id)continue;
        const first=Array.isArray(d.url)?d.url[0]:d.url;
        const url=http(d.main_url || (typeof first==='string'?first:first?.src || first?.url));
        const audio=urls(d.audioDefinition?.url || d.audioDefinition?.main_url);
        const split=d.vtype==='DASH' || d.format==='dash' || d.mediaType==='video' || !!d.audioDefinition;
        if(!url || split && !audio.length || variants.some(v=>v.url===url))continue;
        if(d.duration && Math.abs(Number(d.duration)-video.duration)>2)continue;
        variants.push({url,audioUrl:audio[0] || null,width:Number(d.width)||null,height:Number(d.height)||null,bandwidth:Number(d.bitrate)||0});
        for(const value of [...urls(d.url),...audio])related.add(value);
      }
      if(!variants.length)return;
      const paired=!!variants[0].audioUrl;
      const choices=variants.filter(v=>!!v.audioUrl===paired);
      window.postMessage({channel:'avd-douyin-player-v1',items:[{
        siteVideoId:id,url:choices[0].url,kind:paired?'paired':'file',variants:choices,
        related:[...related].filter(u=>u!==choices[0].url),playerSrc:video.currentSrc,
        duration:video.duration,title:String(info.desc || info.itemTitle || '抖音视频').slice(0,300),poster:http(config.poster)
      }]},location.origin);
    } catch { /* A player can be replaced during SPA navigation. */ }
  }
  setInterval(scan,2000);
  for(const event of ['loadedmetadata','playing','durationchange'])document.addEventListener(event,scan,true);
  scan();
})();
