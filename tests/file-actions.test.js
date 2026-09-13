import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const source=new URL('../native/file-actions.js',import.meta.url);
const mod=fs.existsSync(source)?await import(source):{};
test('File operations validate local existing media and safely encode special characters',async()=>{
  assert.equal(typeof mod.fileAction,'function');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'avd-file-action-'));
  const target=path.join(folder,"sample ' & $() 视频.mp4");fs.writeFileSync(target,'fixture');
  try {
    let script;
    await mod.fileAction({action:'reveal',path:target},async value=>{script=value;});
    assert.ok(script.includes(Buffer.from(target,'utf8').toString('base64')));
    assert.equal(script.includes(target),false);
    await assert.rejects(()=>mod.fileAction({action:'open',path:path.join(folder,'missing.mp4')}),/移动|删除|不存在/);
    await assert.rejects(()=>mod.fileAction({action:'open',path:'C:/Windows/notepad.exe'}));
    await assert.rejects(()=>mod.fileAction({action:'open',path:'https://example.test/file.mp4'}));
    await assert.rejects(()=>mod.fileAction({action:'execute',path:target}));
  } finally {fs.unlinkSync(target);fs.rmdirSync(folder);}
});
