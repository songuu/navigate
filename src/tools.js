import './tools.css';
import {TEXT_TOOLS} from './tools-core.js';
import {MEDIA_TOOLS,mountMediaTool} from './tools-media.js';
import {BROWSER_TOOLS,mountBrowserTool,downloadText} from './tools-browser.js';
import {TOOL_CATEGORIES,REFERENCE_TOOLS,buildToolCatalogue,filterTools} from './tools-catalogue.js';

const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const localTools=[...TEXT_TOOLS,...MEDIA_TOOLS,...BROWSER_TOOLS];
const catalogue=buildToolCatalogue(localTools),byId=new Map(localTools.map(tool=>[tool.id,tool]));
const preferenceKey='songuu-tools-v1';
const isPlainClick=event=>event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey;
function preferences(){try{const data=JSON.parse(localStorage.getItem(preferenceKey)||'{}');return {favorites:Array.isArray(data.favorites)?data.favorites.filter(x=>typeof x==='string'):[],recent:Array.isArray(data.recent)?data.recent.filter(x=>byId.has(x)).slice(0,6):[]};}catch{return {favorites:[],recent:[]};}}

export function mountTools(main,{toast=()=>{}}={}){
  const prefs=preferences();let category='all',source='all',query='',generation=0,disposeTool;
  main.className='tools-page toolbox-page';
  const header=el('header','toolbox-intro'),intro=el('div');intro.append(el('p','eyebrow','THE EVERYDAY TOOLBOX'));
  const title=el('h1','','每个小问题，'),line=el('span','','都有顺手的工具。');title.append(line);intro.append(title,el('p','toolbox-subtitle','打开即用的小工具，把重复工作交给浏览器。'));
  const stats=el('div','toolbox-stats');stats.append(el('strong','',String(localTools.length)),el('span','','个站内工具'),el('strong','',String(catalogue.length)),el('span','','个精选入口'));header.append(intro,stats);
  const directory=el('section','tool-directory'),searchbar=el('div','tool-searchbar'),searchLabel=el('label','tool-search-label'),search=el('input');search.type='search';search.placeholder='搜索工具、功能或关键词…';search.setAttribute('aria-label','搜索工具');searchLabel.append(el('span','','⌕'),search);
  const sources=el('div','tool-source-tabs');for(const [id,label] of [['all','全部工具'],['local','站内工具'],['external','精选外链'],['favorites','我的收藏']]){const b=el('button','',label);b.type='button';b.dataset.source=id;b.onclick=()=>{source=id;renderCards();};sources.append(b);}searchbar.append(searchLabel,sources);
  const layout=el('div','tool-directory-layout'),sidebar=el('aside','tool-categories');sidebar.setAttribute('aria-label','工具分类');
  for(const c of [{id:'all',title:'全部分类',icon:'▦'},...TOOL_CATEGORIES]){const b=el('button');b.type='button';b.dataset.category=c.id;b.append(el('span','',c.icon),el('span','',c.title));b.onclick=()=>{category=c.id;renderCards();};sidebar.append(b);}
  const results=el('div','tool-results'),count=el('p','tool-count'),grid=el('div','tool-card-grid');count.setAttribute('aria-live','polite');results.append(count,grid);layout.append(sidebar,results);
  const recent=el('div','tool-recent');directory.append(searchbar,recent,layout);
  const workspace=el('section','tool-workspace-panel');workspace.hidden=true;
  const footer=el('p','toolbox-footnote');footer.append(document.createTextNode('站内工具在浏览器中处理；文字朗读使用系统语音。外部工具会打开原网站。目录灵感来自 '));const credit=el('a','','卡卡轻导航 ↗');credit.href='https://kaka770.cn/tools';credit.target='_blank';credit.rel='noopener noreferrer';footer.append(credit);
  main.replaceChildren(header,directory,workspace,footer);
  function persist(){try{localStorage.setItem(preferenceKey,JSON.stringify(prefs));}catch{toast('工具偏好未能保存，请检查浏览器存储空间。');}}
  function renderRecent(){recent.replaceChildren();if(!prefs.recent.length)return;recent.append(el('span','','最近使用'));for(const id of prefs.recent){const tool=byId.get(id);if(!tool)continue;const a=el('a','',tool.title);a.href='/tools/?tool='+encodeURIComponent(id);a.onclick=e=>{if(!isPlainClick(e))return;e.preventDefault();void openTool(id);};recent.append(a);}}
  function renderCards(){
    const rows=filterTools(catalogue,{query,category,source,favorites:prefs.favorites});
    count.textContent=`${rows.length} 个工具${query?' · 搜索“'+query+'”':''}`;
    for(const b of sources.querySelectorAll('button')){const active=b.dataset.source===source;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
    for(const b of sidebar.querySelectorAll('button')){const active=b.dataset.category===category;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
    grid.replaceChildren();if(!rows.length){const empty=el('div','tool-empty');empty.append(el('strong','','还没有找到匹配的工具'),el('p','','试试其他关键词，或切换分类。'));grid.append(empty);return;}
    for(const tool of rows){
      const card=el('article','tool-card'),a=el('a','tool-card-link'),top=el('div','tool-card-top'),icon=el('span','tool-card-icon',tool.icon||'⌘'),badge=el('span','tool-badge '+(tool.source==='local'?'is-local':''),tool.source==='local'?'站内':'外部 ↗');
      card.dataset.category=tool.category;a.href=tool.url;if(tool.source==='external'){a.target='_blank';a.rel='noopener noreferrer';}else a.onclick=e=>{if(!isPlainClick(e))return;e.preventDefault();void openTool(tool.id);};
      top.append(icon,badge);a.append(top,el('h2','',tool.title),el('p','',tool.description));const bottom=el('div','tool-card-bottom');bottom.append(el('span','',(TOOL_CATEGORIES.find(x=>x.id===tool.category)?.title||'实用工具')));
      const favorite=el('button','tool-favorite',prefs.favorites.includes(tool.id)?'★':'☆');favorite.type='button';favorite.setAttribute('aria-label',(prefs.favorites.includes(tool.id)?'取消收藏 ':'收藏 ')+tool.title);favorite.setAttribute('aria-pressed',String(prefs.favorites.includes(tool.id)));favorite.onclick=()=>{prefs.favorites=prefs.favorites.includes(tool.id)?prefs.favorites.filter(x=>x!==tool.id):[...prefs.favorites,tool.id];persist();renderCards();};bottom.append(favorite);card.append(a,bottom);grid.append(card);
    }
  }
  function showDirectory(push=true){generation++;disposeTool?.();disposeTool=undefined;workspace.replaceChildren();workspace.hidden=true;directory.hidden=false;header.hidden=false;document.title='在线工具 · Songuu 导航';if(push)history.pushState({},'','/tools/');renderRecent();renderCards();}
  async function openTool(id,push=true){
    const tool=byId.get(id);if(!tool){showDirectory(false);toast('未找到这个站内工具，已返回工具目录。');return;}
    const current=++generation;disposeTool?.();disposeTool=undefined;workspace.replaceChildren();workspace.hidden=false;directory.hidden=true;header.hidden=true;
    document.title=tool.title+' · Songuu 工具';if(push)history.pushState({},'','/tools/?tool='+encodeURIComponent(id));prefs.recent=[id,...prefs.recent.filter(x=>x!==id)].slice(0,6);persist();
    const toolbar=el('div','tool-workspace-nav'),back=el('button','secondary-button','← 工具目录'),share=el('button','secondary-button','复制工具链接');back.onclick=()=>showDirectory();share.onclick=async()=>{try{await navigator.clipboard.writeText(location.href);toast('工具链接已复制');}catch{toast('复制失败，请复制浏览器地址栏。');}};toolbar.append(back,share);
    const reference=REFERENCE_TOOLS.find(item=>(item.localId||item.id)===id);if(reference){const original=el('a','secondary-button','原站工具 ↗');original.href=reference.url;original.target='_blank';original.rel='noopener noreferrer';toolbar.insertBefore(original,share);}
    const heading=el('header','tool-workspace-heading');heading.append(el('span','tool-card-icon',tool.icon||'⌘'),el('div'));heading.lastChild.append(el('p','eyebrow','SONGUU TOOLBOX'),el('h1','',tool.title),el('p','',tool.description));
    const body=el('div','tool-workspace');body.setAttribute('aria-label',tool.title+'工作台');workspace.append(toolbar,heading,body);workspace.scrollIntoView({block:'start'});
    try{
      if(TEXT_TOOLS.some(x=>x.id===id)){mountTextTool(body,tool);}
      else{const cleanup=await (MEDIA_TOOLS.some(x=>x.id===id)?mountMediaTool:mountBrowserTool)(body,id,{notify:toast});if(current!==generation)cleanup?.();else disposeTool=cleanup;}
    }catch(error){if(current===generation){const message=el('p','tool-feedback is-error','工具加载失败：'+error.message);message.setAttribute('role','alert');body.append(message);}}
  }
  function mountTextTool(body,tool){
    const fields=el('div','tool-fields'),inputs=new Map();
    for(const field of tool.fields||[]){const label=el('label','field',field.label),input=el(field.multiline?'textarea':field.type==='select'?'select':'input');
      if(field.type==='select'){for(const option of field.options||[]){const o=el('option','',typeof option==='string'?option:option.label);o.value=typeof option==='string'?option:option.value;input.append(o);}}
      else if(!field.multiline)input.type=field.type||'text';if(field.type==='checkbox')input.checked=!!field.value;else input.value=String(field.value??'');if(field.min!==undefined)input.min=String(field.min);if(field.max!==undefined)input.max=String(field.max);label.append(input);fields.append(label);inputs.set(field.name,input);
    }
    const label=el('label','field',tool.inputLabel||'输入内容'),input=el('textarea');input.placeholder=tool.placeholder||'';input.spellcheck=false;input.maxLength=1000000;label.append(input);
    const actions=el('div','tool-actions'),feedback=el('p','tool-feedback'),output=el('pre','tool-output');feedback.setAttribute('role','status');output.setAttribute('aria-live','polite');output.id='tool-output';output.tabIndex=0;
    let runNumber=0;
    for(const [index,action] of (tool.actions||[{id:'run',label:'运行'}]).entries()){
      const b=el('button',index===0?'primary-button':'secondary-button',action.label);b.type='button';b.onclick=async()=>{
        const run=++runNumber;feedback.textContent='';feedback.classList.remove('is-error');b.disabled=true;
        try{const options={action:action.id};for(const [key,control] of inputs)options[key]=control.type==='checkbox'?control.checked:control.value;const value=await tool.run(input.value,options);if(run===runNumber&&body.isConnected){output.textContent=String(value);output.dataset.success='true';}}
        catch(error){if(run===runNumber&&body.isConnected){output.textContent='';output.dataset.success='false';feedback.textContent='无法处理：'+error.message;feedback.classList.add('is-error');}}
        finally{b.disabled=false;}
      };actions.append(b);
    }
    const copy=el('button','secondary-button','复制结果');copy.onclick=async()=>{try{if(output.dataset.success!=='true')throw new Error('请先生成结果。');await navigator.clipboard.writeText(output.textContent);toast('结果已复制');}catch(error){feedback.textContent=error.message||'复制失败，请手动复制。';}};
    const download=el('button','secondary-button','下载结果');download.onclick=()=>{if(output.dataset.success!=='true'){feedback.textContent='请先生成结果。';return;}downloadText('songuu-'+tool.id+'.txt',output.textContent);};actions.append(copy,download);body.append(fields,label,actions,feedback,output);
  }
  search.oninput=()=>{query=search.value;renderCards();};
  const onHistory=()=>{const id=new URLSearchParams(location.search).get('tool');if(id)void openTool(id,false);else showDirectory(false);};
  window.addEventListener('popstate',onHistory);
  // A page restored from the back/forward cache keeps its listeners, but any
  // media resources and intervals released on pagehide must be mounted again.
  window.addEventListener('pagehide',()=>{generation++;disposeTool?.();disposeTool=undefined;});
  window.addEventListener('pageshow',event=>{if(event.persisted)onHistory();});
  renderRecent();renderCards();const initial=new URLSearchParams(location.search).get('tool');if(initial)void openTool(initial,false);
}
