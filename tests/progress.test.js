import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const mod=fs.existsSync(new URL('../native/progress.js',import.meta.url)) ? await import('../native/progress.js') : {};
test('FFmpeg progress decodes split chunks, CRLF, size and speed at block boundaries',()=>{
  assert.equal(typeof mod.progressReader,'function');
  const messages=[],feed=mod.progressReader(m=>messages.push(m));
  feed('total_size=1048576\r\nout_time_');feed('us=12500000\r\nspeed=2.5x\r\nprogress=continue\r\n');
  assert.deepEqual(messages,[{type:'progress',seconds:12.5,bytes:1048576,speed:2.5}]);
});
test('Older FFmpeg time format works without an out_time_us field',()=>{
  assert.equal(typeof mod.progressReader,'function');
  const messages=[],feed=mod.progressReader(m=>messages.push(m));
  feed('out_time=00:01:02.500000\nspeed=N/A\nprogress=end\n');
  assert.equal(messages[0].seconds,62.5);assert.equal(messages[0].speed,null);
});
