import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const media = fs.existsSync(new URL('../background/media.js', import.meta.url))
  ? await import('../background/media.js') : {};
test('MIME-only playlists are detected; transport segments are excluded', () => {
  assert.equal(media.classify?.('https://cdn.test/play?id=1', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(media.classify?.('https://cdn.test/a.m4s', 'video/mp4'), null);
  assert.equal(media.classify?.('https://cdn.test/a.ts', 'application/octet-stream'), null);
  assert.equal(media.classify?.('https://cdn.test/a', 'application/dash+xml'), 'dash');
});
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English, stereo",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="aud",CODECS="avc1.640028,mp4a.40.2"\nhi.m3u8?token=keep\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="aud"\nlo.m3u8';
test('HLS resolves signed variants and associates separate audio', () => {
  const p = media.parseHls?.(master, 'https://cdn.test/movie/master.m3u8');
  assert.equal(p?.variants?.length, 2);
  assert.equal(p.variants[0].url, 'https://cdn.test/movie/hi.m3u8?token=keep');
  assert.equal(p.variants[0].height, 1080);
  assert.equal(p.variants[0].audioUrl, 'https://cdn.test/movie/audio.m3u8');
});
test('HLS media playlist yields duration and segment membership, not manifest size', () => {
  const p = media.parseHls?.('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.5,\ns1.mp4\n#EXTINF:4,\ns2.mp4\n#EXT-X-ENDLIST', 'https://cdn.test/a/index.m3u8');
  assert.equal(p?.duration, 7.5);
  assert.equal(p.live, false);
  assert.deepEqual(p.segments, ['https://cdn.test/a/init.mp4', 'https://cdn.test/a/s1.mp4', 'https://cdn.test/a/s2.mp4']);
});
test('Master arriving after child removes duplicate children and MP4 segments', () => {
  let rows = [{id:'child', url:'https://cdn.test/movie/hi.m3u8?token=keep', kind:'hls', variants:[], related:[], segments:['https://cdn.test/s.mp4'], duration:12}, {id:'seg',url:'https://cdn.test/s.mp4',kind:'file'}];
  const parsed = media.parseHls?.(master, 'https://cdn.test/movie/master.m3u8');
  rows = media.mergeMedia?.(rows, {id:'master', url:'https://cdn.test/movie/master.m3u8',kind:'hls', ...parsed});
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].duration, 12);
});
test('Unrelated videos with identical titles remain distinct; signatures preserved', () => {
  const rows = media.mergeMedia?.([{id:'1',url:'https://cdn.test/a.mp4?token=1',kind:'file',title:'Page'}], {id:'2',url:'https://cdn.test/b.mp4?token=2',kind:'file',title:'Page'});
  assert.equal(rows?.length, 2);
  assert.equal(rows[1].url, 'https://cdn.test/b.mp4?token=2');
});
test('DASH extracts representations, duration and DRM without treating segments as videos', () => {
  const p = media.parseDash?.('<MPD mediaPresentationDuration="PT1M2.5S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:abc"/><Representation id="v1" width="1920" height="1080" bandwidth="4000000"/><Representation id="v2" width="1280" height="720"/></AdaptationSet></Period></MPD>', 'https://cdn.test/movie.mpd');
  assert.equal(p?.duration, 62.5);
  assert.equal(p.variants.length, 2);
  assert.equal(p.protected, true);
});
test('Invalid HLS responses fail visibly instead of masquerading as a video', () => {
  assert.equal(typeof media.parseHls, 'function');
  assert.throws(() => media.parseHls('<html>login</html>', 'https://cdn.test/a.m3u8'));
});
