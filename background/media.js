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
// Some sites serve HLS playlists and segments disguised as PNG images: the real bytes sit in a private "roUd" chunk
// whose first byte is a flag (bit 0 = zlib/deflate compressed). This is a container, not encryption.
const PNG_SIGNATURE = [137,80,78,71,13,10,26,10], RO_UD = 0x726f5564, IEND = 0x49454e44;
export function pngChunk(bytes) {
  if (PNG_SIGNATURE.some((b,i) => i < bytes.length && bytes[i] !== b)) return { state:'plain' };
  if (bytes.length < 8) return { state:'need' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 8; i + 8 <= bytes.length;) {
    const size = view.getUint32(i), type = view.getUint32(i + 4), start = i + 8;
    if (type === RO_UD) {
      if (size < 1) return { state:'missing' };
      if (start >= bytes.length) return { state:'need' };
      return { state:'found', deflate:(bytes[start] & 1) === 1, start:start + 1, end:start + size, complete:start + size <= bytes.length };
    }
    if (type === IEND) return { state:'missing' };
    i = start + size + 4;
  }
  return { state:'need' };
}
async function inflate(data, limit) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new Error('解包后的播放列表过大'); }
    chunks.push(value);
  }
  const out = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
export async function unwrapPng(bytes, limit = 16*1024*1024) {
  const chunk = pngChunk(bytes);
  if (chunk.state === 'plain') return { bytes, wrapped:false };
  if (chunk.state !== 'found' || !chunk.complete) throw new Error('PNG 包装的媒体缺少数据块');
  const data = bytes.subarray(chunk.start, chunk.end);
  return { bytes:chunk.deflate ? await inflate(data, limit) : data, wrapped:true };
}
// Reads only as much of a PNG response as needed to tell whether it hides an HLS playlist; segments are
// rejected after their first kilobytes.
export async function wrappedPlaylist(response, limit = 4*1024*1024) {
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) { const next = new Uint8Array(bytes.length + value.length); next.set(bytes); next.set(value, bytes.length); bytes = next; }
      if (bytes.length > limit) return false;
      const chunk = pngChunk(bytes);
      if (['plain','missing'].includes(chunk.state)) return false;
      if (chunk.state === 'found' && !chunk.deflate && bytes.length >= chunk.start + 7)
        return new TextDecoder().decode(bytes.subarray(chunk.start, chunk.start + 7)) === '#EXTM3U';
      if (chunk.state === 'found' && chunk.deflate && chunk.complete)
        return new TextDecoder().decode((await unwrapPng(bytes)).bytes).trimStart().startsWith('#EXTM3U');
      if (done) return false;
    }
  } catch { return false; } finally { reader.cancel().catch(() => {}); }
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
