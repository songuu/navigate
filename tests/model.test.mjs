import test from 'node:test';
import assert from 'node:assert/strict';
import {safeUrl,loadState,mergeImported,searchLinks,makeSearchUrl,restoreBackupPreferences} from '../src/model.js';
test('imports reject executable URLs and embedded credentials', () => {
  for (const url of ['javascript:alert(1)','data:text/html,x','file:///secret','https://u:p@host.com']) assert.equal(safeUrl(url),null);
  assert.equal(mergeImported([], [{title:'x',url:'javascript:x'},{title:'ok',url:'https://example.com'}], ['tools']).length,1);
});
test('imports deduplicate normalized URLs and constrain categories', () => {
  const items=mergeImported([{url:'https://example.com/'}],[{url:'https://example.com'},{url:'https://other.com',category:'unknown'}],['tools']);
  assert.equal(items.length,1); assert.equal(items[0].category,'tools');
});
test('corrupt browser state does not prevent navigation', () => {
  assert.deepEqual(loadState({getItem:()=>'{broken'}).favorites,[]);
  assert.deepEqual(loadState({getItem:()=>'{"custom":[{"url":"javascript:x","title":"x"}],"favorites":false}'}).custom,[]);
});
test('search matches all words across title, category and URL', () => {
  const links=[{title:'Claude',url:'https://claude.ai',categoryName:'AI 工具'}];
  assert.equal(searchLinks(links,'ai claude').length,1); assert.equal(searchLinks(links,'missing').length,0);
});
test('external search encodes user input as a query', () => assert.equal(makeSearchUrl('google','a&b'), 'https://www.google.com/search?q=a%26b'));
test('cross-device backup restores public and remapped private favorites and preferences',()=>{
  const backup={custom:[{id:'old-private',url:'https://personal.example/'}],links:[{id:'public',url:'https://example.com/'}],favorites:['old-private','public','missing'],order:['old-private','public'],newTab:false,theme:'dark'};
  const state=restoreBackupPreferences({favorites:[],custom:[]},backup,[{id:'new-private',url:'https://personal.example/'},{id:'public',url:'https://example.com/'}]);
  assert.deepEqual(state.favorites,['new-private','public']);assert.deepEqual(state.order,['new-private','public']);assert.equal(state.newTab,false);assert.equal(state.theme,'dark');
});
