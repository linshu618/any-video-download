import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const native = fs.existsSync(new URL('../native/download.js',import.meta.url)) ? await import('../native/download.js') : {};
test('HLS separate audio is explicitly mapped; URLs never go through a shell', () => {
  const args = native.buildArgs?.({url:'https://cdn.test/v.m3u8?x=1&y=2',audioUrl:'https://cdn.test/a.m3u8',pageUrl:'https://page.test/',kind:'hls'},'C:/Downloads/movie.mp4');
  assert.ok(args?.includes('1:a:0'));
  assert.ok(args.includes('https://cdn.test/v.m3u8?x=1&y=2'));
  assert.ok(args.includes('copy'));
});
test('Reject local-file inputs and newline header injection', () => {
  assert.equal(typeof native.buildArgs,'function');
  assert.throws(() => native.buildArgs({url:'file:///C:/secret',kind:'hls'},'out.mp4'));
  assert.throws(() => native.buildArgs({url:'https://cdn.test/a',pageUrl:'https://x/\r\nCookie: bad'},'out.mp4'));
});
test('Output name cannot escape download directory or use Windows device names', () => {
  assert.equal(typeof native.safeName,'function');
  assert.equal(native.safeName('../../CON'), '_CON');
  assert.equal(native.safeName('demo.mp4'), 'demo');
});
test('DASH selects the requested resolution rather than always the first stream', () => {
  assert.equal(native.chooseVideo?.([{index:0,codec_type:'audio'},{index:1,codec_type:'video',height:360},{index:2,codec_type:'video',height:1080}],1080),2);
});
