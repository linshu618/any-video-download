import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const path=new URL('../content/douyin-player.js',import.meta.url);
const code=fs.existsSync(path)?fs.readFileSync(path,'utf8'):'';
function extract({audio=true,id='123',url='https://cdn.test/video',duration=333.067}={}) {
  const messages=[];
  const definition={vid:id,url:[{src:url},{src:'https://backup.test/video'}],height:720,width:1290,vtype:'DASH',duration,
    audioDefinition:audio?{url:[{src:'https://cdn.test/audio'},{src:'https://backup.test/audio'}]}:undefined};
  const video={currentSrc:'blob:https://www.douyin.com/current',duration,isConnected:true};
  const window={player:{video,curDefinition:definition,config:{awemeInfo:{awemeId:id,desc:'Example title',authenticationToken:'DO_NOT_EXPORT'},definition:{list:[definition]}}},postMessage:m=>messages.push(m)};
  vm.runInNewContext(code,{window,location:new URL('https://www.douyin.com/jingxuan?modal_id=123'),URL,document:{addEventListener(){}},setInterval(){},setTimeout(){},console});
  return messages.flatMap(m=>m.items||[]);
}
test('Douyin DASH player produces one video/audio pair with exact blob association',()=>{
  const rows=extract();assert.equal(rows.length,1);
  assert.equal(rows[0].kind,'paired');assert.equal(rows[0].duration,333.067);
  assert.equal(rows[0].title,'Example title');assert.equal(rows[0].playerSrc,'blob:https://www.douyin.com/current');
  assert.equal(rows[0].variants[0].audioUrl,'https://cdn.test/audio');
  assert.ok(rows[0].related.includes('https://backup.test/audio'));
  assert.equal(JSON.stringify(rows).includes('DO_NOT_EXPORT'),false);
});
test('A preloaded next video is not labeled as the requested Douyin video',()=>assert.equal(extract({id:'456'}).length,0));
test('DASH video without an audio definition is not offered as a complete download',()=>assert.equal(extract({audio:false}).length,0));
test('Non-HTTP source configurations are not exported',()=>assert.equal(extract({url:'file:///secret'}).length,0));
