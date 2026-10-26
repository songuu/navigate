import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Node does not load CSS; keep the production module intact and supply the
// small browser surface used by these lifecycle and reading-context tests.
const source=(await readFile(new URL('../src/news.js',import.meta.url),'utf8'))
  .replace(/^import '\.\/news.css';\r?\n/,'')
  .replaceAll("'./news-format.js'",JSON.stringify(new URL('../src/news-format.js',import.meta.url).href))
  .replaceAll("'./news-calendar.js'",JSON.stringify(new URL('../src/news-calendar.js',import.meta.url).href));
const {mountNews,mountNewsPreview}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Events {
  listeners=new Map();
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  emit(type,event={}){for(const listener of [...(this.listeners.get(type)||[])])listener(event);}
}
class Element extends Events {
  children=[];parentElement=null;dataset={};className='';hidden=false;_text='';
  constructor(tag,owner){super();this.tagName=tag;this.ownerDocument=owner;this.classList={add:(name)=>{this.className=`${this.className} ${name}`.trim();}};}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set textContent(value){this._text=String(value);this.replaceChildren();}
  setAttribute(name,value){this[name]=value;}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  matches(selector){return selector.startsWith('.')?this.className.split(' ').includes(selector.slice(1)):selector==='[data-language]'?Boolean(this.dataset.language):this.tagName===selector;}
  querySelectorAll(selector){const all=[];for(const child of this.children){if(child.matches(selector))all.push(child);all.push(...child.querySelectorAll(selector));}return all;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  get isConnected(){return this===this.ownerDocument.root||Boolean(this.parentElement?.isConnected);}
  getClientRects(){let node=this;while(node){if(node.hidden)return [];node=node.parentElement;}return this.isConnected?[{}]:[];}
  getBoundingClientRect(){const index=this.ownerDocument.root.querySelectorAll('.news-row').indexOf(this);const top=500+Math.max(0,index)*100-this.ownerDocument.window.scrollY;return {top,bottom:top+100};}
  focus(){this.ownerDocument.activeElement=this;}
}
class Document extends Events {
  visibilityState='visible';activeElement=null;
  createElement(tag){return new Element(tag,this);}
}
const settle=async()=>{for(let turn=0;turn<8;turn++)await new Promise(resolve=>setImmediate(resolve));};
const article=(id,date='2026-10-26',layer='runtime')=>({external_id:id,title:`Article ${id}`,summary:'Summary',source_name:'Source',ecosystem_layer:layer,collected_date:date,content_text:`Body ${id}`,tags:[]});
const articles=count=>Array.from({length:count},(_,index)=>article(`old-${index}`));

async function browser({search='?date=2026-10-26&layer=runtime',preview=false,items=articles(25),initialListItems=null,initialListGate=null}={}) {
  const saved={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
  const document=new Document(),window=new Events(),location=new URL(`https://songuu.top/news/${search}`),timers=new Map(),calls=[];
  let timerId=0,dispose;
  window.location=location;window.scrollY=0;window.scrollTo=({top})=>{window.scrollY=top;};
  window.history={state:null,replaceState:(state,_title,url)=>{window.history.state=state;window.location=new URL(url,window.location);},pushState:(state,_title,url)=>{window.history.state=state;window.location=new URL(url,window.location);}};
  document.window=window;document.root=document.createElement('main');
  const state={items,failCalendar:false,failList:false,listGate:initialListGate,calendarGate:null,initialListItems};
  globalThis.document=document;globalThis.window=window;
  globalThis.setInterval=(callback,delay)=>{assert.equal(delay,30000);timers.set(++timerId,callback);return timerId;};
  globalThis.clearInterval=id=>timers.delete(id);
  globalThis.fetch=async(value,options)=>{
    const url=new URL(value,'https://songuu.top');calls.push({url,options});
    let status=200,payload;
    if(url.pathname==='/data/news-calendar.json') {
      if(state.calendarGate)await state.calendarGate;
      status=state.failCalendar?503:200;
      const buckets=new Map();
      for(const item of state.items){const key=`${item.collected_date}:${item.ecosystem_layer}`;const bucket=buckets.get(key)||{date:item.collected_date,ecosystemLayer:item.ecosystem_layer,articleCount:0};bucket.articleCount++;buckets.set(key,bucket);}
      payload={buckets:[...buckets.values()],sourceCounts:[{ecosystemLayer:'all',sourceCount:1}],snapshotGeneratedAt:'2026-10-26T01:00:00.000Z',snapshotExpiresAt:'2026-10-26T01:02:00.000Z'};
    } else {
      const initialItems=state.initialListItems;state.initialListItems=null;
      if(state.listGate)await state.listGate;
      status=state.failList?503:200;
      let matching=initialItems||state.items;
      for(const filter of url.searchParams.getAll('filter')){
        const [column,,...rest]=filter.split(':'),value=rest.join(':');
        matching=matching.filter(item=>item[column]===value);
      }
      const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
      payload={items:matching.slice(offset,offset+limit),hasMore:offset+limit<matching.length};
    }
    return {ok:status===200,status,headers:new Headers({Date:'Mon, 26 Oct 2026 01:00:00 GMT'}),json:async()=>structuredClone(payload)};
  };
  try {dispose=await (preview?mountNewsPreview:mountNews)(document.root);await settle();}
  catch(error){Object.assign(globalThis,saved);throw error;}
  return {document,window,root:document.root,state,calls,
    async tick(){for(const callback of [...timers.values()])callback();await settle();},
    click(node){assert.ok(node);node.emit('click',{button:0,preventDefault(){}});},
    get listCalls(){return calls.filter(call=>call.url.pathname==='/api/content/v1/news');},
    close(){dispose();assert.equal(timers.size,0);assert.equal(document.listeners.get('visibilitychange')?.size,0);Object.assign(globalThis,saved);},
  };
}

test('live inserts preserve loaded pages, search focus and reading anchor without clearing the list', async()=>{
  const view=await browser();
  try {
    const input=view.root.querySelector('input');input.value='Article';input.emit('input');input.focus();view.window.scrollY=650;
    const previousRows=view.root.querySelectorAll('.news-row');assert.equal(previousRows.length,20);
    let release;view.state.listGate=new Promise(resolve=>{release=resolve;});view.state.items.unshift(article('new'));
    await view.tick();assert.equal(view.root.querySelectorAll('.news-row')[0],previousRows[0]);assert.equal(view.root.querySelector('input'),input);
    view.state.listGate=null;release();await settle();
    assert.equal(view.root.querySelectorAll('.news-row').length,21);assert.equal(view.root.querySelector('input'),input);assert.equal(input.value,'Article');assert.equal(view.document.activeElement,input);assert.equal(view.window.scrollY,750);
    const calls=view.listCalls.length,sidebar=view.root.querySelector('.news-sidebar').children[0];await view.tick();assert.equal(view.listCalls.length,calls);assert.equal(view.root.querySelector('.news-sidebar').children[0],sidebar);
    view.click(view.root.querySelector('.news-load-more'));await settle();assert.equal(view.listCalls.at(-1).url.searchParams.get('offset'),'21');assert.equal(view.root.querySelectorAll('.news-row').length,26);
    view.state.failCalendar=true;await view.tick();assert.equal(view.root.querySelectorAll('.news-row').length,26);assert.match(view.root.querySelector('.news-calendar').textContent,/上次成功/);
    view.state.failCalendar=false;view.state.items.unshift(article('newer'));await view.tick();assert.equal(view.root.querySelectorAll('.news-row').length,27);
  } finally {view.close();}
});

test('polling leaves the reading detail and return snapshot intact, then refreshes after returning', async()=>{
  const view=await browser();
  try {
    view.window.scrollY=650;view.click(view.root.querySelector('.news-row-title'));await settle();
    const detail=view.root.querySelector('.news-detail'),body=view.root.querySelector('.news-detail-body'),calls=view.listCalls.length;
    view.state.items.unshift(article('new'));await view.tick();assert.equal(view.root.querySelector('.news-detail'),detail);assert.equal(view.root.querySelector('.news-detail-body'),body);assert.equal(view.listCalls.length,calls);
    view.click(view.root.querySelector('.news-back'));await settle();assert.equal(view.root.querySelectorAll('.news-row').length,21);assert.equal(view.window.scrollY,750);assert.match(view.window.location.search,/date=2026-10-26/);
  } finally {view.close();}
});

test('new articles remain visible at the top instead of scrolling back to the former first row', async()=>{
  const view=await browser();
  try {
    view.state.items.unshift(article('new'));await view.tick();
    assert.equal(view.window.scrollY,0);assert.match(view.root.querySelector('.news-row-title').textContent,/new/);
  } finally {view.close();}
});

test('a newer first calendar cannot label an older in-flight list response as already refreshed', async()=>{
  const old=articles(25);let release;const gate=new Promise(resolve=>{release=resolve;});
  const view=await browser({items:[article('new'),...old],initialListItems:old,initialListGate:gate});
  try {
    view.state.listGate=null;release();await settle();assert.match(view.root.querySelector('.news-row-title').textContent,/new/);
    const calls=view.listCalls.length;await view.tick();assert.equal(view.listCalls.length,calls);
  } finally {view.close();}
});

test('the home preview also reconciles a newer first calendar with an older initial response', async()=>{
  const old=[article('model-0','2026-10-26','model-platform'),article('model-1','2026-10-26','model-platform'),article('model-2','2026-10-26','model-platform')];
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const view=await browser({preview:true,items:[article('new-model','2026-10-26','model-platform'),...old],initialListItems:old,initialListGate:gate});
  try {view.state.listGate=null;release();await settle();assert.match(view.root.querySelector('.news-row-title').textContent,/new-model/);}
  finally {view.close();}
});

test('default latest follows a new date only while the reader remains at the top', async()=>{
  const view=await browser({search:''});
  try {
    assert.match(view.window.location.search,/date=2026-10-26/);
    view.state.items.unshift(article('tomorrow','2026-10-27'));await view.tick();assert.match(view.window.location.search,/date=2026-10-27/);assert.equal(view.root.querySelectorAll('.news-row').length,1);
    view.window.scrollY=650;view.state.items.unshift(article('later','2026-10-28'));await view.tick();assert.match(view.window.location.search,/date=2026-10-27/);
  } finally {view.close();}
});

test('browser back preserves default latest intent while an explicitly selected date stays fixed', async()=>{
  for(const search of ['', '?date=2026-10-26']) {
    const view=await browser({search});
    try {
      const listUrl=view.window.location.href,listHistory=view.window.history.state;
      view.click(view.root.querySelector('.news-row-title'));await settle();
      view.window.location=new URL(listUrl);view.window.history.state=listHistory;view.window.emit('popstate',{state:listHistory});await settle();
      view.state.items.unshift(article('tomorrow','2026-10-27'));await view.tick();
      assert.equal(view.window.location.search.includes('date=2026-10-27'),search==='');
    } finally {view.close();}
  }
});

test('a calendar request completing after the page becomes hidden cannot start a list request', async()=>{
  const view=await browser({search:''});
  try {
    let release;view.state.calendarGate=new Promise(resolve=>{release=resolve;});view.state.items.unshift(article('tomorrow','2026-10-27'));
    await view.tick();view.document.visibilityState='hidden';view.document.emit('visibilitychange');const calls=view.listCalls.length;
    view.state.calendarGate=null;release();await settle();assert.equal(view.listCalls.length,calls);assert.match(view.window.location.search,/date=2026-10-26/);
    view.document.visibilityState='visible';view.document.emit('visibilitychange');await settle();assert.match(view.window.location.search,/date=2026-10-27/);
  } finally {view.close();}
});

test('a failed list update keeps the loaded rows and automatically retries without another count change', async()=>{
  const view=await browser();
  try {
    const first=view.root.querySelector('.news-row');view.state.items.unshift(article('new'));view.state.failList=true;await view.tick();assert.equal(view.root.querySelector('.news-row')===first,true);assert.match(view.root.querySelector('.news-tail').textContent,/已保留/);
    view.state.failList=false;await view.tick();assert.match(view.root.querySelector('.news-row-title').textContent,/new/);assert.equal(view.root.querySelectorAll('.news-row').length,21);
  } finally {view.close();}
});

test('home preview refreshes only its layer, retains cards on failure and makes no requests while hidden', async()=>{
  const modelItems=[article('model-0','2026-10-26','model-platform'),article('model-1','2026-10-26','model-platform'),article('model-2','2026-10-26','model-platform')];
  const view=await browser({preview:true,items:modelItems});
  try {
    const calls=view.listCalls.length;await view.tick();assert.equal(view.listCalls.length,calls);
    view.state.items.unshift(article('other'));await view.tick();assert.equal(view.listCalls.length,calls);
    const cards=view.root.querySelectorAll('.news-row');view.state.items.unshift(article('new-model','2026-10-26','model-platform'));view.state.failList=true;await view.tick();assert.equal(view.root.querySelectorAll('.news-row')[0],cards[0]);assert.match(view.root.textContent,/已保留/);
    view.state.failList=false;await view.tick();assert.match(view.root.querySelector('.news-row-title').textContent,/new-model/);
    view.root.hidden=true;const allCalls=view.calls.length;await view.tick();assert.equal(view.calls.length,allCalls);
    view.root.hidden=false;await view.tick();assert.equal(view.calls.length,allCalls+1);
  } finally {view.close();}
});
