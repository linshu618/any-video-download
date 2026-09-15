export function youtubeId(value) {
  try {const u=new URL(value);if(u.protocol!=='https:' || !['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname))return null;
    const id=u.pathname==='/watch'?u.searchParams.get('v'):/^\/(shorts|embed)\/([^/]+)\/?$/.exec(u.pathname)?.[2];
    return /^[A-Za-z0-9_-]{11}$/.test(id || '')?id:null;
  }catch{return null;}
}
export function createYoutubeResolver(api) {
  return async pageUrl=>{
    const id=youtubeId(pageUrl);if(!id)throw new Error('不是有效的 YouTube 视频地址。');
    const url=`https://www.youtube.com/watch?v=${id}`;
    let timer,reply;
    try {reply=await Promise.race([api.runtime.sendNativeMessage('com.any_video_download.helper',{type:'youtube_info',url}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('本地助手未在 50 秒内返回视频信息，请检查助手版本。')),50000);})]);}
    catch(error){throw new Error('YouTube 本地解析失败：'+error.message);}
    finally{clearTimeout(timer);}
    if(!reply?.ok)throw new Error(reply?.error || '本地助手未返回视频信息，请更新本地助手。');
    const media=reply.media;if(media?.videoId!==id || !Array.isArray(media.heights))throw new Error('本地助手返回的视频信息不匹配。');
    const heights=[...new Set(media.heights.filter(h=>Number.isInteger(h)&&h>0&&h<=8640))].sort((a,b)=>b-a);
    if(!heights.length)throw new Error('当前视频没有可下载的 MP4 清晰度。');
    return {url,pageUrl:url,kind:'youtube',siteVideoId:id,title:String(media.title || 'YouTube 视频').slice(0,300),duration:Number(media.duration)>0?Number(media.duration):null,
      variants:heights.map(height=>({url,height})),related:[],segments:[],parsed:true,error:null};
  };
}
