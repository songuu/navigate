import './style.css';
import {loadState, saveState, safeUrl, searchLinks, mergeImported, makeSearchUrl, restoreBackupPreferences} from './model.js';
import {mountNews, mountNewsPreview} from './news.js';

const $ = (selector, scope=document) => scope.querySelector(selector);
let state=loadState(localStorage), data, catalogPromise, active='all', query='', toastTimer;
async function ensureCatalog(){
  if(data)return data;
  if(!catalogPromise)catalogPromise=fetch('/data/bookmarks.json').then(async response=>{if(!response.ok)throw new Error('书签目录 HTTP '+response.status);data=await response.json();return data;}).catch(error=>{catalogPromise=undefined;throw error;});
  return catalogPromise;
}
document.documentElement.dataset.theme=state.theme;
$('#year').textContent=new Date().getFullYear();
const icons={ai:'✦',dev:'⌘',community:'◉',tools:'⚒',news:'▤',reading:'▥',learning:'◇',travel:'↗',shopping:'♧',fun:'♫',private:'⌑'};
function categories(){return [...(data?.categories||[]),{id:'private',name:'本机私藏'}];}
const apps=[
  ['Pipeline','工作流编排与运行控制台','/pipeline/','P','blue'],
  ['Agent Build','从零到一，构建你的 AI Agent','/agent-build/','A','amber'],
  ['AICrew Studio','多 Agent 创作与协作空间','/aicrew/','C','green'],
  ['Tech Persistence','让工程经验成为长期记忆','/tech-persistence/','T','purple'],
  ['折页','把散落的经验，整理成知识','/essay/','折','amber'],
  ['RAG System','检索增强与智能问答工作台','/rag-system/','R','blue'],
  ['Better Agent','Agent 开发与运行的工作空间','/better-agent/','B','purple'],
  ['途伴 Roam','规划旅途，记录沿途的风景','/travel/','途','green']
];
function el(tag, cls, text){const item=document.createElement(tag); if(cls)item.className=cls; if(text!==undefined)item.textContent=text; return item;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,2600);}
function persist(){try{saveState(localStorage,state);}catch{toast('浏览器存储空间不足，请先导出备份。');}}
function updateTheme(){document.documentElement.dataset.theme=state.theme;$('#theme-toggle').setAttribute('aria-label',state.theme==='dark'?'切换浅色主题':'切换深色主题');}
$('#theme-toggle').onclick=()=>{state.theme=state.theme==='dark'?'light':'dark';persist();updateTheme();};updateTheme();
$('#settings-open').onclick=()=>{$('#open-new-tab').checked=state.newTab;$('#settings-dialog').showModal();};
$('#open-new-tab').onchange=e=>{state.newTab=e.target.checked;persist();document.querySelectorAll('.bookmark-link').forEach(a=>a.target=state.newTab?'_blank':'_self');};
$('#homepage-help').onclick=()=>$('#homepage-instructions').hidden=!$('#homepage-instructions').hidden;
function download(name, content){const blob=new Blob([content],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#export-local').onclick=async()=>{try{await ensureCatalog();download('songuu-bookmarks-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify({type:'songuu-navigation-backup',version:1,exportedAt:new Date().toISOString(),...state,links:allLinks().filter(x=>state.favorites.includes(x.id))},null,2));}catch(error){$('#settings-message').textContent='导出失败：'+error.message;}};
$('#import-bookmarks').onchange=async e=>{
  try{
    const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw new Error('文件需小于 5 MB。');
    await ensureCatalog();const text=await file.text();let incoming,backup;
    if(/\.html?$/i.test(file.name)){
      // Template contents stay inert: bookmark HTML must not load images or
      // frames before we extract its links. Never attach this fragment.
      const template=document.createElement('template');template.innerHTML=text;
      incoming=Array.from(template.content.querySelectorAll('a[href]')).map(a=>({title:a.textContent,url:a.getAttribute('href')}));
    }
    else{const parsed=JSON.parse(text);if(parsed.type==='songuu-navigation-backup'&&parsed.version===1)backup=parsed;incoming=Array.isArray(parsed)?parsed:[...(Array.isArray(parsed.custom)?parsed.custom:[]),...(Array.isArray(parsed.links)?parsed.links:[])];}
    if(!Array.isArray(incoming))throw new Error('没有找到可导入的书签。');
    const added=mergeImported(allLinks(),incoming,categories().map(c=>c.id));state.custom.push(...added);
    if(backup){
      state=restoreBackupPreferences(state,backup,allLinks());updateTheme();$('#open-new-tab').checked=state.newTab;
    }
    persist();renderLinks();$('#settings-message').textContent=`已导入 ${added.length} 条新书签${backup?'并恢复收藏与偏好':''}，重复与无效网址已跳过。`;
  }catch(error){$('#settings-message').textContent='导入失败：'+error.message;}finally{e.target.value='';}
};
$('#bookmark-cancel').onclick=()=>$('#bookmark-dialog').close();
$('#bookmark-form').onsubmit=e=>{
  e.preventDefault();const form=new FormData(e.target),url=safeUrl(form.get('url'));
  if(!url){$('#bookmark-message').textContent='请输入有效的 http 或 https 网址。';return;}
  const added=mergeImported(allLinks(),[{title:form.get('title'),url,category:form.get('category')}],categories().map(c=>c.id));
  if(!added.length){$('#bookmark-message').textContent='这个网址已在导航中。';return;}
  state.custom.push(...added);state.favorites.push(added[0].id);persist();e.target.reset();$('#bookmark-dialog').close();renderLinks();toast('已添加到本机书签和我的收藏');
};
function allLinks(){return [...(data?.links||[]),...state.custom].map(link=>({...link,categoryName:categories().find(c=>c.id===link.category)?.name||'我的添加'}));}

async function boot(){
  const main=$('#main');
  if(location.pathname.startsWith('/news')){document.title='AI 资讯 · Songuu 导航';$('[data-page="news"]').classList.add('active');main.className='news-page';await mountNews(main);return;}
  if(location.pathname.startsWith('/tools')){document.title='在线工具 · Songuu 导航';$('[data-page="tools"]').classList.add('active');renderTools(main);return;}
  $('[data-page="home"]').classList.add('active');
  main.innerHTML=`<section class="hero"><div class="hero-note"><span class="live-dot"></span> 你的日常，从这里开始</div><div class="clock" aria-label="当前时间"><span id="clock-hours">--</span><span class="clock-colon">:</span><span id="clock-minutes">--</span></div><p class="hero-date" id="clock-date"></p><form id="search-form" class="search-box" role="search"><label class="sr-only" for="search-engine">搜索范围</label><select id="search-engine"><option value="local">⌕ 站内书签</option><option value="google">Google</option><option value="bing">Bing</option><option value="baidu">百度</option><option value="github">GitHub</option></select><input id="search-input" aria-label="搜索书签或输入关键词" placeholder="搜索你的网站，或切换引擎探索更多" autocomplete="off" /><kbd>/</kbd><button aria-label="搜索" title="搜索">⌕</button></form><p class="search-hint">少一点寻找，多一点专注。<a href="/news/">看看今天的 AI 新鲜事 <span>↗</span></a></p></section><div class="home-content"><section id="apps" class="apps-section"><div class="section-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h2>我的应用<span class="heading-dot">.</span></h2></div><span class="section-note">熟悉的工作空间，一步直达</span></div><div class="apps-grid" id="apps-grid"></div></section><section class="bookmark-board" aria-label="分类书签导航"><div class="board-toolbar"><div id="category-tabs" class="category-tabs" role="tablist" aria-label="书签分类"></div><button id="add-bookmark" class="add-button" title="添加本机书签">＋ <span>添加</span></button></div><div class="board-caption"><p id="result-count" aria-live="polite"></p><div class="view-options"><button id="view-grid" aria-label="网格视图" title="网格视图" class="selected">▦</button><button id="view-list" aria-label="列表视图" title="列表视图">☷</button></div></div><div id="bookmark-content" class="bookmark-content"><p class="empty-state">正在整理你的书签…</p></div></section><section class="latest-section"><div class="section-heading"><div><span class="eyebrow">STAY CURIOUS</span><h2>AI 今日见闻<span class="heading-dot">.</span></h2></div><a class="text-link" href="/news/">全部资讯 ↗</a></div><div id="latest-news"></div></section></div>`;
  const tick=()=>{const now=new Date();$('#clock-hours').textContent=String(now.getHours()).padStart(2,'0');$('#clock-minutes').textContent=String(now.getMinutes()).padStart(2,'0');$('#clock-date').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(now);};tick();setInterval(tick,15000);
  const appGrid=$('#apps-grid');for(const [name,desc,path,icon,color]of apps){const a=el('a','app-card');a.href=path;a.append(el('span','app-symbol '+color,icon));const label=el('div','app-label');label.append(el('strong','',name),el('span','',desc));a.append(label,el('span','app-arrow','↗'));appGrid.append(a);}
  $('#search-form').onsubmit=e=>{e.preventDefault();const input=$('#search-input').value.trim(),engine=$('#search-engine').value;if(engine==='local'){query=input;renderLinks();$('#bookmark-content').scrollIntoView({behavior:'smooth',block:'start'});}else if(input){window.open(makeSearchUrl(engine,input),state.newTab?'_blank':'_self','noopener,noreferrer');}};
  $('#search-input').oninput=e=>{if($('#search-engine').value==='local'){query=e.target.value;renderLinks();}};
  $('#search-engine').onchange=()=>{query='';renderLinks();$('#search-input').focus();};
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();$('#search-input').focus();}if(e.key==='Escape'&&document.activeElement===$('#search-input')){$('#search-input').value='';query='';renderLinks();$('#search-input').blur();}});
  $('#add-bookmark').onclick=()=>{$('#bookmark-message').textContent='';$('#bookmark-dialog').showModal();};
  $('#view-grid').onclick=()=>setView(false);$('#view-list').onclick=()=>setView(true);
  try{await ensureCatalog();renderCategories();renderLinks();$('#bookmark-category').replaceChildren(...categories().map(c=>{const option=el('option','',c.name);option.value=c.id;return option;}));}
  catch(error){$('#bookmark-content').replaceChildren(el('p','empty-state','书签暂时未能加载。请刷新重试。'));console.error('Bookmark data load failed:',error);}
  mountNewsPreview($('#latest-news')).catch(error=>console.error('News preview failed:',error));
}
function setView(list){$('#bookmark-content').classList.toggle('list-view',list);$('#view-list').classList.toggle('selected',list);$('#view-grid').classList.toggle('selected',!list);}
function renderCategories(){if(!data)return;const tabs=$('#category-tabs');tabs.replaceChildren();for(const c of [{id:'all',name:'全部'},{id:'favorites',name:'★ 我的收藏'},...categories()]){const button=el('button',active===c.id?'active':'',c.name);button.setAttribute('role','tab');button.setAttribute('aria-selected',String(active===c.id));button.onclick=()=>{active=c.id;renderCategories();renderLinks();};tabs.append(button);}}
function renderLinks(){
  if(!data||!$('#bookmark-content'))return;
  let links=allLinks().filter(x=>!state.hidden.includes(x.id)&&safeUrl(x.url));
  if(active==='favorites')links=links.filter(x=>state.favorites.includes(x.id));else if(active!=='all')links=links.filter(x=>x.category===active);
  links=searchLinks(links,query);const order=new Map(state.order.map((id,i)=>[id,i]));links.sort((a,b)=>(order.get(a.id)??1e6)-(order.get(b.id)??1e6));
  $('#result-count').textContent=query?`“${query}” · 找到 ${links.length} 个网站`:`${active==='favorites'?'我的收藏':categories().find(c=>c.id===active)?.name||'全部网站'} · ${links.length} 个好去处`;
  const content=$('#bookmark-content');content.replaceChildren();if(!links.length){const empty=el('div','empty-state');empty.append(el('span','empty-icon','✧'),el('h3','',active==='favorites'?'把喜欢的网站留在这里':'还没有找到这个网站'),el('p','',active==='favorites'?'点击书签旁的星标，建立自己的常用清单。':'换个关键词，或添加一个本机书签。'));content.append(empty);return;}
  const groups=active==='favorites'?[{id:'favorites',name:'我的收藏'}]:categories().filter(c=>active==='all'||active===c.id);
  for(const c of groups){const rows=active==='favorites'?links:links.filter(x=>x.category===c.id);if(!rows.length)continue;const section=el('section','bookmark-group');const heading=el('div','group-heading');heading.append(el('span','category-icon',icons[c.id]||'★'),el('h3','',c.name),el('span','group-count',String(rows.length)));const grid=el('div','links-grid');for(const link of rows)grid.append(renderBookmark(link));section.append(heading,grid);content.append(section);}
}
function renderBookmark(link){
  const card=el('div','bookmark-card');card.draggable=true;card.dataset.id=link.id;
  card.ondragstart=e=>{e.dataTransfer.setData('text/plain',link.id);e.dataTransfer.effectAllowed='move';card.classList.add('dragging');};card.ondragend=()=>card.classList.remove('dragging');card.ondragover=e=>e.preventDefault();card.ondrop=e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');const ids=allLinks().map(x=>x.id);const ordered=[...new Set([...state.order,...ids])].filter(x=>x!==id);ordered.splice(ordered.indexOf(link.id),0,id);state.order=ordered;persist();renderLinks();};
  const a=el('a','bookmark-link');a.href=link.url;a.target=state.newTab?'_blank':'_self';a.rel='noopener noreferrer';a.title=link.title+'\n'+link.url;const initial=el('span','site-icon',link.domain.replace(/^www\./,'').slice(0,1).toUpperCase());initial.style.setProperty('--icon-hue',String([...link.domain].reduce((a,c)=>a+c.charCodeAt(0),0)%280));
  const label=el('span','bookmark-label');label.append(el('strong','',link.title),el('small','',link.domain.replace(/^www\./,'')));a.append(initial,label);
  const star=el('button','favorite-button',state.favorites.includes(link.id)?'★':'☆');star.setAttribute('aria-label',(state.favorites.includes(link.id)?'取消收藏 ':'收藏 ')+link.title);star.title=state.favorites.includes(link.id)?'取消收藏':'加入收藏';star.classList.toggle('is-favorite',state.favorites.includes(link.id));star.onclick=()=>{state.favorites=state.favorites.includes(link.id)?state.favorites.filter(x=>x!==link.id):[...state.favorites,link.id];persist();renderLinks();};card.append(a,star);
  if(link.local){const remove=el('button','remove-bookmark','×');remove.title='删除本机书签';remove.setAttribute('aria-label','删除 '+link.title);remove.onclick=()=>{const removed=state.custom.find(x=>x.id===link.id);state.custom=state.custom.filter(x=>x.id!==link.id);persist();renderLinks();const notice=$('#toast');notice.replaceChildren(document.createTextNode('书签已移除 '));const undo=el('button','','撤销');undo.onclick=()=>{state.custom.push(removed);persist();renderLinks();notice.hidden=true;};notice.append(undo);notice.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>notice.hidden=true,12000);};card.append(remove);}
  return card;
}
function renderTools(main){
  main.className='tools-page';main.innerHTML=`<div class="page-intro"><p class="eyebrow">SMALL TOOLS, BIG DIFFERENCE</p><h1>顺手的小工具<span class="heading-dot">.</span></h1><p>在浏览器里完成，不上传你的内容。</p></div><div class="tools-layout"><div class="tool-picker" role="tablist"><button data-tool="json" class="active" role="tab">{ } JSON 格式化</button><button data-tool="encode" role="tab">↔ 编码转换</button><button data-tool="time" role="tab">◷ 时间戳转换</button><button data-tool="count" role="tab">¶ 文本统计</button><button data-tool="uuid" role="tab">⌘ UUID 生成</button></div><section class="tool-workspace"><h2 id="tool-title">JSON 格式化</h2><label for="tool-input" id="tool-label">输入 JSON</label><textarea id="tool-input" placeholder='{"hello": "Songuu"}' spellcheck="false"></textarea><div class="tool-actions"><button class="primary-button" id="tool-run">格式化</button><button class="secondary-button" id="tool-secondary">压缩</button><button class="secondary-button" id="tool-copy">复制结果</button></div><pre id="tool-output" aria-live="polite">在上方输入内容，结果会显示在这里。</pre></section></div>`;
  let tool='json';const modes={json:['JSON 格式化','输入 JSON','格式化','压缩'],encode:['编码转换','输入文本','URL 编码','URL 解码'],time:['时间戳转换','输入秒 / 毫秒时间戳或日期','转换时间','当前时间'],count:['文本统计','输入或粘贴文本','统计','清空'],uuid:['UUID 生成','输入数量（1–100）','生成 UUID','生成一个']};
  document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>{tool=button.dataset.tool;document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b===button));const [title,label,primary,secondary]=modes[tool];$('#tool-title').textContent=title;$('#tool-label').textContent=label;$('#tool-run').textContent=primary;$('#tool-secondary').textContent=secondary;$('#tool-input').value='';$('#tool-input').placeholder=tool==='uuid'?'1':'';$('#tool-output').textContent='';});
  function run(secondary=false){const value=$('#tool-input').value;let output;try{if(tool==='json')output=JSON.stringify(JSON.parse(value),null,secondary?0:2);if(tool==='encode')output=secondary?decodeURIComponent(value):encodeURIComponent(value);if(tool==='time'){const date=secondary?new Date():new Date(/^\d+$/.test(value.trim())?Number(value)*(value.trim().length<=10?1000:1):value);if(!Number.isFinite(date.getTime()))throw new Error('请输入有效时间戳或日期。');output=`本地时间：${date.toLocaleString('zh-CN')}\nUTC：${date.toISOString()}\n秒：${Math.floor(date.getTime()/1000)}\n毫秒：${date.getTime()}`;}if(tool==='count'){if(secondary){$('#tool-input').value='';output='';}else output=`字符数：${[...value].length}\n不含空白：${[...value.replace(/\s/g,'')].length}\n中文字符：${(value.match(/[\u4e00-\u9fff]/g)||[]).length}\n英文单词：${(value.match(/[a-zA-Z]+(?:['’-][a-zA-Z]+)*/g)||[]).length}\n行数：${value?value.split(/\r?\n/).length:0}`;}if(tool==='uuid'){const count=secondary?1:Number(value||1);if(!Number.isInteger(count)||count<1||count>100)throw new Error('数量应为 1 到 100 的整数。');output=Array.from({length:count},()=>crypto.randomUUID()).join('\n');}$('#tool-output').textContent=output;}catch(error){$('#tool-output').textContent='无法处理：'+error.message;}}
  $('#tool-run').onclick=()=>run();$('#tool-secondary').onclick=()=>run(true);$('#tool-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('#tool-output').textContent);toast('结果已复制');}catch{toast('复制失败，请手动选择结果复制。');}};
}
boot().catch(error=>{$('#main').replaceChildren(el('p','empty-state','页面加载遇到问题，请刷新重试。'));console.error(error);});
