import { XMLParser } from 'fast-xml-parser';

export function httpUrl(value, base) {
  try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}
export function classify(url, type = '') {
  if (!httpUrl(url)) return null;
  const path = new URL(url).pathname;
  if (/\.(ts|m4s|cmfv|cmfa|aac|key)$/i.test(path) || /mp2t/i.test(type)) return null;
  if (/mpegurl/i.test(type) || /\.m3u8$/i.test(path)) return 'hls';
  if (/dash\+xml/i.test(type) || /\.mpd$/i.test(path)) return 'dash';
  if (/vnd.yt-ump/i.test(type)) return null; // A multiplexed transport response is not a downloadable MP4.
  if (/^video\//i.test(type) || /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(path)) return 'file';
  return null;
}
function attrs(line) {
  const result = {};
  for (const m of line.slice(line.indexOf(':') + 1).matchAll(/([\w-]+)=(?:"([^"]*)"|([^,]*))/g)) result[m[1]] = m[2] ?? m[3];
  return result;
}
export function parseHls(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('返回内容不是 HLS 播放列表');
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const audio = lines.filter(s => s.startsWith('#EXT-X-MEDIA:')).map(attrs).filter(a => a.TYPE === 'AUDIO');
  const variants = [], segments = [];
  let duration = 0, pending = null, protectedMedia = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) { pending = attrs(line); continue; }
    if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0;
    if (line.startsWith('#EXT-X-MAP:')) { const u = httpUrl(attrs(line).URI, url); if (u) segments.push(u); }
    if (/^#EXT-X-(KEY|SESSION-KEY):/.test(line)) {
      const a = attrs(line);
      if ((a.KEYFORMAT && a.KEYFORMAT !== 'identity') || (a.METHOD && !['NONE', 'AES-128'].includes(a.METHOD))) protectedMedia = true;
    }
    if (line.startsWith('#')) continue;
    const resolved = httpUrl(line, url);
    if (!resolved) continue;
    if (pending) {
      const [width, height] = (pending.RESOLUTION || '').split('x').map(Number);
      const group = audio.filter(a => a['GROUP-ID'] === pending.AUDIO);
      const track = group.find(a => a.DEFAULT === 'YES') || group[0];
      variants.push({ url: resolved, width: width || null, height: height || null, bandwidth: Number(pending.BANDWIDTH) || 0,
        codecs: pending.CODECS || '', audioUrl: track?.URI ? httpUrl(track.URI, url) : null });
      pending = null;
    } else segments.push(resolved);
  }
  const related = [...variants.map(v => v.url), ...audio.map(a => httpUrl(a.URI, url)).filter(Boolean)];
  return { variants: variants.sort((a,b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth), related, segments,
    duration: duration || null, live: variants.length ? null : !lines.includes('#EXT-X-ENDLIST'), protected: protectedMedia, size: null };
}
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
function seconds(value = '') {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  return m ? Number(m[1] || 0)*86400 + Number(m[2] || 0)*3600 + Number(m[3] || 0)*60 + Number(m[4] || 0) : null;
}
export function parseDash(text, url) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持带外部实体的 DASH 清单');
  const mpd = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'', removeNSPrefix:true, processEntities:false }).parse(text).MPD;
  if (!mpd) throw new Error('返回内容不是 DASH 清单');
  let protectedMedia = false;
  const variants = [];
  for (const period of array(mpd.Period)) for (const set of array(period.AdaptationSet)) {
    if (set.ContentProtection !== undefined) protectedMedia = true;
    for (const rep of array(set.Representation)) {
      if (rep.ContentProtection !== undefined) protectedMedia = true;
      if (!(rep.height || set.height || /video/.test(rep.mimeType || set.mimeType || set.contentType || ''))) continue;
      variants.push({url, representationId:String(rep.id ?? ''), height:Number(rep.height || set.height) || null,
        width:Number(rep.width || set.width) || null, bandwidth:Number(rep.bandwidth) || 0});
    }
  }
  return { variants:variants.sort((a,b) => (b.height || 0)-(a.height || 0)), duration:seconds(mpd.mediaPresentationDuration),
    live:mpd.type === 'dynamic', protected:protectedMedia, related:[], segments:[], size:null };
}
export function mergeMedia(rows, incoming) {
  const item = structuredClone(incoming);
  const parent = rows.find(r => r.url !== item.url && r.related?.includes(item.url));
  if (parent) {
    return rows.filter(r => r.id === parent.id || !item.segments?.includes(r.url)).map(r => r.id === parent.id ? {
      ...r, duration:item.parsed && item.duration ? item.duration : r.duration || item.duration, live:item.live ?? r.live,
      segments:[...new Set([...(r.segments || []), ...(item.segments || [])])], protected:r.protected || item.protected
    } : r);
  }
  if (rows.some(r => r.segments?.includes(item.url))) return rows;
  const children = rows.filter(r => item.related?.includes(r.url));
  item.segments = [...new Set([...(item.segments || []), ...children.flatMap(r => r.segments || [])])];
  item.duration ||= children.find(r => r.duration)?.duration || null;
  const old = rows.find(r => r.url === item.url);
  const combined = {...old, ...item, id:old?.id || item.id};
  const result = rows.filter(r => r.url !== item.url && !item.related?.includes(r.url) && !item.segments.includes(r.url));
  result.push(combined);
  return result;
}
