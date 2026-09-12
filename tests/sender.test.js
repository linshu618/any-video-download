import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const mod=fs.existsSync(new URL('../background/sender.js',import.meta.url))?await import('../background/sender.js'):{};
test('Extension page messages are accepted when Chrome supplies origin without url',()=>{
  assert.equal(mod.isExtensionPage?.({id:'own',origin:'chrome-extension://own'},'own'),true);
});
test('Content scripts and other extensions cannot start local downloads',()=>{
  assert.equal(typeof mod.isExtensionPage,'function');
  for(const sender of [{id:'other',url:'chrome-extension://own/sidepanel.html'},{id:'own',url:'https://youtube.com/',tab:{id:1}},{id:'own',tab:{id:1}},{id:'own',origin:'https://example.com'}])assert.equal(mod.isExtensionPage(sender,'own'),false);
});
