import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOL_CATEGORIES,REFERENCE_TOOLS,buildToolCatalogue,filterTools} from '../src/tools-catalogue.js';

test('reference catalogue has 87 unique tools in supported categories and fixed safe original URLs',()=>{
  assert.equal(REFERENCE_TOOLS.length,87);
  assert.equal(new Set(REFERENCE_TOOLS.map(tool=>tool.id)).size,87);
  const categories=new Set(TOOL_CATEGORIES.map(category=>category.id));
  assert.deepEqual([...categories].sort(),['audio','convert','develop','education','file','fun','image','life']);
  for(const tool of REFERENCE_TOOLS){
    assert.ok(tool.title&&tool.description&&tool.icon&&tool.keywords.length>0);
    assert.ok(categories.has(tool.category),tool.id+' must use a known category');
    const url=new URL(tool.url);
    assert.equal(url.origin,'https://kaka770.cn');
    assert.equal(url.username+url.password+url.search+url.hash,'');
    assert.equal(url.pathname,tool.id==='fun-avatar'?'/fun-avatar':'/tools/'+tool.id);
  }
});

test('real local implementations replace mapped reference entries and preserve runnable descriptors',()=>{
  const run=()=> 'formatted';
  const local=[{id:'json',title:'JSON 格式化',category:'convert',description:'查看 JSON',keywords:['结构化'],run},{id:'uuid',title:'UUID',category:'develop',description:'生成标识',keywords:['uuid']}];
  const before=local.map(item=>({...item}));
  const catalogue=buildToolCatalogue(local);
  assert.equal(catalogue.length,88);
  assert.equal(catalogue.find(tool=>tool.id==='json').run,run);
  assert.equal(catalogue.some(tool=>tool.id==='json-viewer'),false);
  assert.equal(catalogue.find(tool=>tool.id==='json').source,'local');
  assert.equal(catalogue.find(tool=>tool.id==='json').url,'/tools/?tool=json');
  assert.deepEqual(local,before);
});

test('unimplemented mappings remain reachable external entries instead of broken local tools',()=>{
  const catalogue=buildToolCatalogue([]);
  assert.equal(catalogue.length,87);
  for(const id of ['json-viewer','img-converter','markdown-to-doc']){
    assert.equal(catalogue.find(tool=>tool.id===id).source,'external');
    assert.equal(catalogue.find(tool=>tool.id===id).url,'https://kaka770.cn/tools/'+id);
  }
});

test('one local implementation is not duplicated and descriptor URLs cannot change its destination',()=>{
  const catalogue=buildToolCatalogue([{id:'base64',title:'Base64',category:'convert',description:'编码',url:'javascript:alert(1)'},{id:'base64',title:'duplicate'}]);
  assert.equal(catalogue.filter(tool=>tool.id==='base64').length,1);
  assert.equal(catalogue.find(tool=>tool.id==='base64').url,'/tools/?tool=base64');
  assert.equal(catalogue.find(tool=>tool.id==='base64').source,'local');
  const sameId=buildToolCatalogue([{id:'ip-query',title:'IP 查询',category:'develop',description:'查询网络信息'}]);
  assert.equal(sameId.filter(tool=>tool.id==='ip-query').length,1);
  assert.equal(sameId.find(tool=>tool.id==='ip-query').source,'local');
});

test('search matches every word across title description and keywords without mutating catalogue',()=>{
  const items=[{id:'a',title:'JSON 工具',description:'格式化数据',keywords:['pretty','开发'],category:'develop',source:'local'},{id:'b',title:'Other',description:'pretty',keywords:[],category:'life',source:'external'}];
  assert.deepEqual(filterTools(items,{query:' JSON   pretty 开发 '}).map(tool=>tool.id),['a']);
  assert.deepEqual(filterTools(items,{query:'PRETTY'}).map(tool=>tool.id),['a','b']);
  assert.deepEqual(filterTools(items,{query:'missing'}),[]);
  assert.equal(items.length,2);
});

test('category and source filters compose, and favorites only include selected visible entries',()=>{
  const items=[{id:'a',title:'Alpha',description:'',keywords:[],category:'develop',source:'local'},{id:'b',title:'Beta',description:'',keywords:[],category:'develop',source:'external'},{id:'c',title:'Gamma',description:'',keywords:[],category:'life',source:'local'}];
  assert.deepEqual(filterTools(items,{category:'develop',source:'external'}).map(tool=>tool.id),['b']);
  assert.deepEqual(filterTools(items,{category:'develop',source:'favorites',favorites:['b','c','unknown']}).map(tool=>tool.id),['b']);
  assert.deepEqual(filterTools(items,{source:'favorites'}),[]);
  assert.deepEqual(filterTools(items,{source:'favorites',favorites:['a'],query:'beta'}),[]);
  assert.deepEqual(filterTools(items).map(tool=>tool.id),['a','b','c']);
});
