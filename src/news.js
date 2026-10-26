import './news.css';
import { NEWS_LAYERS, buildNewsQuery, isNewsDate, normalizeArticle, calendarDates, articleParagraphs, filterLoadedNews, findNewsNeighbors, calendarSelectionForLayer } from './news-format.js';
import { readNewsCalendar } from './news-calendar.js';

const mounted = new WeakMap();
const PAGE_SIZE = 20;

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function button(label, action, className = 'news-button') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function contextFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const layer = params.get('layer');
  const date = params.get('date');
  return {id: params.get('id'), layer: NEWS_LAYERS.some(([key]) => key === layer) ? layer : 'all', date: isNewsDate(date) ? date : null, explicitDate: params.has('date')};
}

function articleLink(article, context = {}) {
  const params = new URLSearchParams();
  params.set('id', article.id);
  if (context.date || article.date) params.set('date', context.date || article.date);
  if (context.layer && context.layer !== 'all') params.set('layer', context.layer);
  return `/news/?${params}`;
}

async function requestJson(url, lifetimeSignal, {withResponse = false, allowNotFound = false} = {}) {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timedOut = false;
  const abort = () => controller.abort();
  if (lifetimeSignal.aborted) abort();
  else lifetimeSignal.addEventListener('abort', abort, {once: true});
  // An uncached read on the shared host can exceed 12 seconds; keep the
  // request cancellable without turning a valid slow response into an error.
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  try {
    const response = await fetch(url, {signal: controller.signal, cache: 'no-store', headers: {Accept: 'application/json'}});
    if (response.status === 404 && allowNotFound) return {status: response.status};
    if (!response.ok) throw new Error(`资讯服务暂不可用（HTTP ${response.status}）`);
    const payload = await response.json();
    return withResponse ? {status: response.status, payload, responseDate: response.headers.get('Date'), elapsedMs: performance.now() - startedAt} : payload;
  } catch (error) {
    if (lifetimeSignal.aborted) throw error;
    if (timedOut) throw new Error('资讯读取超时，请重试');
    if (error instanceof Error && error.message.startsWith('资讯服务')) throw error;
    throw new Error('无法读取资讯，请检查网络后重试');
  } finally {
    clearTimeout(timeout);
    lifetimeSignal.removeEventListener('abort', abort);
  }
}

async function requestPage(apiBase, options, signal) {
  const payload = await requestJson(`${apiBase}/news?${buildNewsQuery(options)}`, signal);
  if (!payload || !Array.isArray(payload.items)) throw new Error('资讯数据格式异常，请稍后重试');
  return {...payload, items: payload.items.map(normalizeArticle).filter(row => row.id)};
}

function status(message, retry, error = false) {
  const box = el('div', `news-status${error ? ' news-status-error' : ''}`);
  box.setAttribute('role', error ? 'alert' : 'status');
  box.append(el('p', '', message));
  if (retry) box.append(button('重新加载', retry));
  return box;
}

function metadata(article) {
  const meta = el('div', 'news-meta');
  meta.append(el('span', 'news-layer-tag', article.layerLabel), el('span', '', article.source));
  const date = article.publishedDate || article.date;
  if (date) meta.append(el('time', '', date));
  return meta;
}

function newsRow(article, context, openArticle) {
  const row = el('article', 'news-row');
  const copy = el('div', 'news-row-copy');
  copy.append(metadata(article));
  const title = el('a', 'news-row-title', article.title);
  title.href = articleLink(article, context);
  if (openArticle) title.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); openArticle(article);
  });
  copy.append(title, el('p', 'news-row-summary', article.summary || '查看这条资讯的完整内容与来源。'));
  if (article.tags.length) {
    const tags = el('div', 'news-tags');
    article.tags.slice(0, 3).forEach(tag => tags.append(el('span', '', tag)));
    copy.append(tags);
  }
  const arrow = el('span', 'news-row-arrow', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  row.append(copy, arrow);
  return row;
}

/** Owns all requests and listeners; call the returned disposer before replacing the view. */
export async function mountNews(container, {apiBase = '/api/content/v1'} = {}) {
  mounted.get(container)?.();
  const lifetime = new AbortController();
  let generation = 0;
  let state = contextFromUrl();
  let rows = [];
  let hasMore = false;
  let offset = 0;
  let loading = false;
  let calendar = {buckets: [], sourceCounts: []};
  let calendarLoaded = false;
  let calendarError = '';
  let calendarGeneration = 0;
  let month = (state.date || new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())).slice(0, 7);
  let query = '';
  let listScroll = 0;
  let listState = null;

  container.classList.add('news-root');
  const shell = el('div', 'news-layout');
  const sidebar = el('aside', 'news-sidebar');
  const content = el('section', 'news-content');
  content.setAttribute('aria-label', 'AI 资讯内容');
  shell.append(sidebar, content);
  container.replaceChildren(shell);

  function replaceUrl(id = null, push = false) {
    const params = new URLSearchParams();
    if (id) params.set('id', id);
    if (state.date) params.set('date', state.date);
    else if (state.explicitDate) params.set('date', 'all');
    if (state.layer !== 'all') params.set('layer', state.layer);
    const url = `${window.location.pathname}${params.size ? `?${params}` : ''}`;
    window.history[push ? 'pushState' : 'replaceState']({news: true}, '', url);
  }

  function renderSidebar() {
    sidebar.replaceChildren();
    const intro = el('div', 'news-sidebar-intro');
    intro.append(el('p', 'news-eyebrow', 'AI DAILY'), el('h2', '', '资讯目录'), el('p', 'news-muted', '每天一站，掌握 AI 新进展。'));
    const nav = el('nav', 'news-layer-nav');
    nav.setAttribute('aria-label', '资讯分类');
    for (const [key, label] of [['all', '全部资讯'], ...NEWS_LAYERS]) {
      const count = calendar.buckets.filter(bucket => key === 'all' || bucket.ecosystemLayer === key).reduce((sum, bucket) => sum + bucket.articleCount, 0);
      const item = button(label, () => {
        state.layer = key; state.id = null;
        const dates = calendarDates(calendar.buckets, key);
        const selection = calendarSelectionForLayer(state.date, month, dates, calendarLoaded);
        state.date = selection.date; month = selection.month;
        replaceUrl(); renderSidebar(); void loadList();
      }, `news-layer-button${state.layer === key ? ' is-active' : ''}`);
      item.setAttribute('aria-pressed', String(state.layer === key));
      if (calendarLoaded) item.append(el('span', 'news-count', count.toLocaleString('zh-CN')));
      nav.append(item);
    }
    sidebar.append(intro, nav, renderCalendar());
    const sourceCount = calendar.sourceCounts.find(value => value.ecosystemLayer === state.layer)?.sourceCount;
    const footnote = el('p', 'news-sidebar-note', sourceCount ? `来自 ${sourceCount} 个资讯来源 · 每日自动采集` : '按采集日期归档 · 每日自动采集');
    sidebar.append(footnote);
  }

  function renderCalendar() {
    const box = el('section', 'news-calendar');
    box.setAttribute('aria-label', '按采集日期筛选');
    const head = el('div', 'news-calendar-head');
    const shift = delta => {
      const [year, number] = month.split('-').map(Number);
      const next = new Date(Date.UTC(year, number - 1 + delta, 1));
      month = next.toISOString().slice(0, 7); renderSidebar();
    };
    const previous = button('‹', () => shift(-1), 'news-icon-button'); previous.setAttribute('aria-label', '上一个月');
    const next = button('›', () => shift(1), 'news-icon-button'); next.setAttribute('aria-label', '下一个月');
    head.append(previous, el('strong', '', `${month.slice(0,4)} 年 ${Number(month.slice(5))} 月`), next);
    const grid = el('div', 'news-calendar-grid');
    for (const day of ['一','二','三','四','五','六','日']) grid.append(el('span', 'news-calendar-weekday', day));
    const [year, number] = month.split('-').map(Number);
    const start = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
    for (let i = 0; i < start; i++) grid.append(el('span'));
    const available = new Set(calendarDates(calendar.buckets, state.layer));
    const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2,'0')}`;
      const item = button(day, () => {
        state.date = date; state.explicitDate = true; state.id = null;
        replaceUrl(); renderSidebar(); void loadList();
      }, `news-calendar-day${date === state.date ? ' is-active' : ''}`);
      item.setAttribute('aria-label', `${date}${available.has(date) ? ' 有资讯' : ' 无资讯'}`);
      if (date === state.date) item.setAttribute('aria-current', 'date');
      item.disabled = calendarLoaded && !available.has(date);
      grid.append(item);
    }
    box.append(head, grid, button('查看全部日期', () => {
      state.date = null; state.explicitDate = true; state.id = null; replaceUrl(); renderSidebar(); void loadList();
    }, `news-calendar-all${!state.date ? ' is-active' : ''}`));
    if (calendarError) box.append(status(calendarError, () => {void loadCalendar();}, true));
    return box;
  }

  function renderList() {
    if (state.id || lifetime.signal.aborted) return;
    content.replaceChildren();
    const header = el('header', 'news-heading');
    const title = el('div');
    title.append(el('p', 'news-eyebrow', 'DISCOVER WHAT’S NEXT'), el('h1', '', 'AI 资讯'), el('p', 'news-muted', '模型发布、开源进展与工具更新，持续收录。'));
    const date = el('div', 'news-heading-date', state.date || '全部日期');
    header.append(title, date);
    const tools = el('div', 'news-toolbar');
    const label = el('label', 'news-search');
    label.append(el('span', 'news-visually-hidden', '搜索已加载资讯'));
    const input = el('input'); input.type='search'; input.placeholder='搜索已加载资讯 / 来源'; input.value=query;
    input.addEventListener('input', () => {query=input.value; renderItems();});
    label.append(input);
    tools.append(label, el('span', 'news-result-count'));
    const list = el('div', 'news-list'); list.setAttribute('aria-live', 'polite');
    const tail = el('div', 'news-tail');
    content.append(header, tools, list, tail);
    function renderItems() {
      const visible = filterLoadedNews(rows, query);
      list.replaceChildren();
      visible.forEach(row => list.append(newsRow(row, state, openArticle)));
      tools.querySelector('.news-result-count').textContent = query ? `${visible.length} 条匹配 · 已加载 ${rows.length} 条` : `已加载 ${rows.length} 条资讯`;
      if (!visible.length && !loading) list.append(status(query ? '已加载资讯中没有匹配项，试试其他关键词或加载更多。' : '这一天还没有资讯，试试其他日期或查看全部。'));
      tail.replaceChildren();
      if (loading) tail.append(status('正在加载资讯…'));
      else if (hasMore) tail.append(button('加载更多资讯 ↓', () => {void loadList(true);}, 'news-load-more'));
      else if (rows.length) tail.append(el('p', 'news-muted', '已显示当前筛选下的全部资讯'));
    }
    renderItems();
  }

  async function loadList(append = false) {
    const current = ++generation;
    if (!append) {rows=[]; offset=0; hasMore=false;}
    loading=true; renderList();
    try {
      const page = await requestPage(apiBase, {date:state.date,layer:state.layer,offset,limit:PAGE_SIZE}, lifetime.signal);
      if (current !== generation || lifetime.signal.aborted) return;
      rows = [...new Map([...rows,...page.items].map(row => [row.id,row])).values()];
      offset += page.items.length; hasMore=Boolean(page.hasMore); loading=false;
      renderList();
    } catch (error) {
      if (current !== generation || lifetime.signal.aborted) return;
      loading=false; renderList();
      if (!rows.length) content.querySelector('.news-list').replaceChildren();
      content.querySelector('.news-tail').replaceChildren(status(error.message, () => {void loadList(append);}, true));
    }
  }

  async function loadCalendar() {
    const current = ++calendarGeneration;
    calendarError='';
    try {
      const payload = await readNewsCalendar({readJson:requestJson,apiBase,signal:lifetime.signal,isDevelopment:import.meta.env?.DEV === true,hostname:window.location.hostname});
      if (current !== calendarGeneration || lifetime.signal.aborted) return;
      calendar=payload; calendarLoaded=true;
      const dates=calendarDates(calendar.buckets,state.layer);
      if (!state.explicitDate && !state.id && !state.date && dates[0]) {
        state.date=dates[0]; month=state.date.slice(0,7); replaceUrl(); void loadList();
      }
    } catch (error) {
      if (current !== calendarGeneration || lifetime.signal.aborted) return;
      calendar={buckets:[],sourceCounts:[]}; calendarLoaded=false;
      calendarError=error.message;
    }
    renderSidebar();
  }

  function openArticle(article) {
    listScroll=window.scrollY;
    listState={rows:[...rows],offset,hasMore,date:state.date,layer:state.layer};
    state.id=article.id;
    replaceUrl(article.id,true);
    void loadDetail(); window.scrollTo({top:0,behavior:'instant'});
  }

  function backToList() {
    state.id=null; replaceUrl(null,true);
    if (listState && listState.date===state.date && listState.layer===state.layer) {
      generation++; rows=listState.rows; offset=listState.offset; hasMore=listState.hasMore; loading=false; renderList();
      window.scrollTo({top:listScroll,behavior:'instant'});
    } else void loadList();
  }

  async function loadDetail() {
    const current=++generation;
    const id=state.id;
    content.replaceChildren(status('正在加载文章正文…'));
    try {
      const page=await requestPage(apiBase,{id},lifetime.signal);
      if(current!==generation || lifetime.signal.aborted) return;
      const article=page.items[0];
      if(!article) {
        content.replaceChildren(button('← 返回资讯',backToList),status('未找到这篇资讯，可能尚未同步或已下线。')); return;
      }
      renderDetail(article,current);
      const snapshot = listState && listState.date === state.date && listState.layer === state.layer ? listState : null;
      const neighbors = await findNewsNeighbors({
        id,
        date: snapshot ? state.date : (state.date || (state.explicitDate ? null : article.date || null)),
        layer: state.layer,
        seed: snapshot ? {items: snapshot.rows, nextOffset: snapshot.offset, hasMore: snapshot.hasMore} : undefined,
        readPage: options => requestPage(apiBase, options, lifetime.signal),
        isCurrent: () => current === generation && !lifetime.signal.aborted,
      });
      if(current!==generation || lifetime.signal.aborted) return;
      const navigation=content.querySelector('.news-detail-navigation');
      if(!neighbors || !navigation) return;
      for(const [neighbor,label] of [[neighbors.previous,'← 上一篇'],[neighbors.next,'下一篇 →']]) {
        if(!neighbor) continue;
        const item=button(label,()=> {state.id=neighbor.id; replaceUrl(neighbor.id,true);void loadDetail();window.scrollTo({top:0,behavior:'instant'});},'news-neighbor');
        item.append(el('span','',neighbor.title)); navigation.append(item);
      }
    } catch(error) {
      if(current!==generation || lifetime.signal.aborted) return;
      // Neighbor lookup is optional and must never hide an already readable article.
      if(content.querySelector('.news-detail')) return;
      content.replaceChildren(button('← 返回资讯',backToList),status(error.message,()=>{void loadDetail();},true));
    }
  }

  function renderDetail(article) {
    content.replaceChildren();
    const back=button('← 返回资讯',backToList,'news-back');
    const card=el('article','news-detail');
    const title=el('h1','news-detail-title',article.title);
    card.append(metadata(article),title);
    if(article.date) card.append(el('p','news-muted',`采集日期 ${article.date}${article.publishedDate ? ` · 原文发布 ${article.publishedDate}` : ''}`));
    const controls=el('div','news-detail-controls');
    const body=el('div','news-detail-body');
    function renderLanguage(zh) {
      title.textContent=zh ? article.title : article.originalTitle;
      body.replaceChildren();
      const text=zh ? article.chineseBody : article.originalBody;
      if(!text) body.append(el('p','news-muted','该来源暂未提供可读取正文，请通过原文链接阅读。'));
      for(const paragraph of articleParagraphs(text)) body.append(el('p','',paragraph));
      controls.querySelectorAll('[data-language]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.language===(zh?'zh':'original'))));
    }
    if(article.canTranslate) {
      const zh=button('中文',()=>renderLanguage(true),'news-language');zh.dataset.language='zh';
      const original=button('原文',()=>renderLanguage(false),'news-language');original.dataset.language='original';
      controls.append(zh,original);
    }
    if(article.url) {
      const original=el('a','news-original-link','阅读来源原文 ↗');original.href=article.url;original.target='_blank';original.rel='noopener noreferrer'; controls.append(original);
    }
    card.append(controls,body);
    const navigation=el('nav','news-detail-navigation');navigation.setAttribute('aria-label','相邻资讯');
    content.append(back,card,navigation);
    renderLanguage(article.canTranslate);
  }

  const onPopState=()=> {
    state=contextFromUrl(); if(state.date) month=state.date.slice(0,7); renderSidebar();
    if(state.id) {void loadDetail(); return;}
    if(listState && listState.date===state.date && listState.layer===state.layer) {
      generation++; rows=listState.rows; offset=listState.offset; hasMore=listState.hasMore; loading=false; renderList();
      window.scrollTo({top:listScroll,behavior:'instant'});
    } else void loadList();
  };
  const onVisibilityChange=()=> {if(document.visibilityState === 'visible') void loadCalendar();};
  window.addEventListener('popstate',onPopState);
  document.addEventListener('visibilitychange',onVisibilityChange);
  const dispose=()=> {lifetime.abort();generation++;calendarGeneration++;window.removeEventListener('popstate',onPopState);document.removeEventListener('visibilitychange',onVisibilityChange);mounted.delete(container);};
  mounted.set(container,dispose);
  renderSidebar();
  if(state.id)void loadDetail();else void loadList();
  void loadCalendar();
  return dispose;
}

export async function mountNewsPreview(container,{apiBase='/api/content/v1'}={}) {
  mounted.get(container)?.();
  const lifetime=new AbortController();
  const dispose=()=> {lifetime.abort();mounted.delete(container);};
  mounted.set(container,dispose);
  container.classList.add('news-preview');
  async function load() {
    container.replaceChildren(status('正在读取最新 AI 资讯…'));
    try {
      const page=await requestPage(apiBase,{layer:'model-platform',limit:3},lifetime.signal);
      if(lifetime.signal.aborted)return;
      container.replaceChildren();
      page.items.forEach(article=>container.append(newsRow(article,{})));
      if(!page.items.length)container.append(status('资讯正在准备中，稍后再来看看。'));
    }catch(error){if(!lifetime.signal.aborted)container.replaceChildren(status(error.message,()=>{void load();},true));}
  }
  void load();
  return dispose;
}
