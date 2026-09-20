// MAIN world: pair the page's embedded DASH tracks, never expose a raw .m4s as a complete video.
(() => {
  if(!/(^|\.)bilibili\.com$/.test(location.hostname))return;
  const pageKey=()=>{
    const id=/^\/video\/(BV[\w]+|av\d+)(?:\/|$)/.exec(location.pathname)?.[1];
    return id?`${id}:${new URL(location.href).searchParams.get('p') || '1'}`:null;
  };
  // Embedded playinfo belongs to this document. A SPA switch must not reuse it.
  const initialPage=pageKey();
  if(!initialPage)return;
  const mediaUrl=value=>{
    try{const u=new URL(value);return /^https?:$/.test(u.protocol) && !u.username && !u.password && /(^|\.)(bilivideo\.com|bilivideo\.cn|bilivideo\.net)$/.test(u.hostname)?u.href:null;}catch{return null;}
  };
  const urls=track=>[track?.baseUrl,track?.base_url,...(track?.backupUrl || track?.backup_url || [])].map(mediaUrl).filter(Boolean);
  const contentId=url=>/\/upgcxcode\/\d+\/\d+\/(\d+)\//.exec(new URL(url).pathname)?.[1];
  function scan() {
    try {
      if(pageKey()!==initialPage)return;
      const info=window.__playinfo__,data=info?.data,dash=data?.dash;
      if(info?.code!==0 || !Array.isArray(dash?.video) || !Array.isArray(dash.audio))return;
      const duration=Number(data.timelength)/1000 || Number(dash.duration);
      const video=[...document.querySelectorAll('video')].find(v=>v.isConnected && v.currentSrc && Number.isFinite(v.duration) && v.duration>0 && Math.abs(v.duration-duration)<2);
      if(!video)return;
      const audio=dash.audio.filter(a=>/^mp4a\./.test(a.codecs || '') && urls(a).length).sort((a,b)=>(b.bandwidth || 0)-(a.bandwidth || 0))[0];
      if(!audio)return;
      // Prefer the standard CDN over peer CDN ports, and AVC for broad MP4 playback support.
      const preferred=track=>urls(track).sort((a,b)=>Number(!!new URL(a).port)-Number(!!new URL(b).port))[0];
      const audioUrl=preferred(audio),id=contentId(audioUrl);
      if(!id)return;
      const variants=[],related=new Set(urls(audio));
      const tracks=dash.video.slice(0,80).sort((a,b)=>Number(!/^avc1\./.test(a.codecs || ''))-Number(!/^avc1\./.test(b.codecs || '')));
      for(const track of tracks) {
        const url=preferred(track),height=Number(track.height);
        if(!url || contentId(url)!==id || !Number.isInteger(height) || height<=0 || height>8640)continue;
        for(const u of urls(track))related.add(u);
        if(variants.some(v=>v.height===height))continue;
        variants.push({url,audioUrl,width:Number(track.width)||null,height,bandwidth:Number(track.bandwidth)||0});
      }
      variants.sort((a,b)=>b.height-a.height);
      if(!variants.length)return;
      window.postMessage({channel:'avd-bilibili-player-v1',items:[{
        siteVideoId:id,url:variants[0].url,kind:'paired',variants,
        related:[...related].filter(u=>u!==variants[0].url),playerSrc:video.currentSrc,duration:video.duration,
        title:String(document.querySelector('h1')?.textContent || 'B站视频').trim().slice(0,300)
      }]},location.origin);
    } catch { /* The document/player may still be initializing. */ }
  }
  setInterval(scan,2000);
  for(const event of ['loadedmetadata','playing','durationchange'])document.addEventListener(event,scan,true);
  scan();
})();
