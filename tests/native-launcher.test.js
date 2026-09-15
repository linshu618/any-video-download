import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
let config;try{config=JSON.parse(fs.readFileSync(path.join(root,'native/config.json'),'utf8'));}catch{}
test('Windows registered CMD launcher preserves Unicode paths and binary native messages', {skip:process.platform!=='win32'||!config},()=>{
 const launcher=path.join(root,'native/launch.cmd');
 const body=Buffer.from(JSON.stringify({type:'ping'}));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
 const command=`""${launcher}" "${config.allowedOrigins[0]}""`;
 const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{input:Buffer.concat([header,body]),windowsHide:true,windowsVerbatimArguments:true,timeout:10000});
 assert.equal(result.status,0,result.stderr?.toString());
 assert.ok(result.stdout.length>=4,'No native message frame from launcher');
 const size=result.stdout.readUInt32LE(0);
 assert.equal(result.stdout.length,size+4,'Launcher polluted the binary protocol');
 assert.deepEqual(JSON.parse(result.stdout.subarray(4).toString()),{type:'ready'});
});
