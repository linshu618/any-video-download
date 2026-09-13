import {httpUrl} from './media.js';
export function playerMedia(item,frameId) {
  if(!item || !/^\d{1,30}$/.test(String(item.siteVideoId)) || !['paired','file'].includes(item.kind))return null;
  const url=httpUrl(item.url),playerSrc=typeof item.playerSrc==='string'?item.playerSrc.slice(0,16000):'';
  if(!url || !/^(blob:https?:|https?:)/.test(playerSrc) || !Number.isFinite(item.duration) || item.duration<=0)return null;
  const variants=(Array.isArray(item.variants)?item.variants:[]).slice(0,20).map(v=>({url:httpUrl(v?.url),audioUrl:httpUrl(v?.audioUrl),
    width:Number(v?.width)||null,height:Number(v?.height)||null,bandwidth:Number(v?.bandwidth)||0})).filter(v=>v.url && (item.kind!=='paired' || v.audioUrl));
  if(!variants.length || !variants.some(v=>v.url===url))return null;
  const related=[...new Set([...(Array.isArray(item.related)?item.related:[]).slice(0,100),...variants.flatMap(v=>[v.url,v.audioUrl])].map(v=>httpUrl(v)).filter(v=>v && v!==url))];
  return {url,kind:item.kind,variants,related,playerSrc,frameId,siteVideoId:String(item.siteVideoId),duration:item.duration,
    title:String(item.title || '抖音视频').slice(0,300),poster:httpUrl(item.poster),type:'video/mp4',parsed:true,size:null};
}
