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

test('FFmpeg failures report evidence instead of speculative causes',()=>{
  assert.equal(typeof native.ffmpegFailure,'function');
  assert.match(native.ffmpegFailure('HTTP error 403 Forbidden',1),/HTTP 403/);
  assert.match(native.ffmpegFailure('Connection timed out',1),/超时/);
  assert.match(native.ffmpegFailure("Protocol 'httpproxy' not on whitelist 'http,https'",1),/httpproxy/);
  const text=native.ffmpegFailure("Error when loading first segment 'https://cdn.test/secret?token=abc'\nError opening input: Invalid data found when processing input",1);
  assert.match(text,/第一个.*分片/);assert.doesNotMatch(text,/可能|secret|token=|https:\/\//);
  assert.match(native.ffmpegFailure('Unrecognized option strange_flag',7),/strange_flag/);
  assert.match(native.ffmpegFailure('',7),/退出码 7/);
});
