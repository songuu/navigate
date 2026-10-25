export const STORAGE_KEY = 'songuu-navigation-v1';
export const DEFAULT_STATE = { favorites: [], custom: [], hidden: [], order: [], newTab: true, theme: 'light' };
export function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function loadState(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_STATE, favorites: Array.isArray(value.favorites) ? value.favorites.filter(x => typeof x === 'string') : [], hidden: Array.isArray(value.hidden) ? value.hidden.filter(x => typeof x === 'string') : [], order: Array.isArray(value.order) ? value.order.filter(x => typeof x === 'string') : [], custom: Array.isArray(value.custom) ? value.custom.filter(x => x && typeof x.title === 'string' && safeUrl(x.url)).map(x => ({...x, url:safeUrl(x.url)})) : [], theme: value.theme === 'dark' ? 'dark' : 'light', newTab: value.newTab !== false };
  } catch { return {...DEFAULT_STATE, favorites:[], custom:[], hidden:[], order:[]}; }
}
export function saveState(storage, state) { storage.setItem(STORAGE_KEY, JSON.stringify(state)); }
export function searchLinks(links, query) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return links.filter(link => words.every(word => [link.title,link.url,link.categoryName,link.group,...(link.tags || [])].join(' ').toLocaleLowerCase().includes(word)));
}
export function mergeImported(existing, incoming, categories) {
  const known = new Set(existing.map(x => safeUrl(x.url)));
  const result = [];
  for (const item of incoming) {
    const url = safeUrl(item?.url);
    if (!url || known.has(url)) continue;
    known.add(url);
    result.push({ id:'local-' + crypto.randomUUID(), title: String(item.title || item.name || new URL(url).hostname).slice(0,120), url, domain:new URL(url).hostname, category:categories.includes(item.category) ? item.category : (categories[0] || 'tools'), group:'我的添加', tags:[], local:true });
  }
  return result;
}
export function makeSearchUrl(engine, query) {
  const roots = { google:'https://www.google.com/search?q=', bing:'https://www.bing.com/search?q=', baidu:'https://www.baidu.com/s?wd=', github:'https://github.com/search?q=' };
  return (roots[engine] || roots.google) + encodeURIComponent(query.trim());
}
export function restoreBackupPreferences(state, backup, links) {
  const incoming=[...(Array.isArray(backup.custom)?backup.custom:[]),...(Array.isArray(backup.links)?backup.links:[])];
  const byUrl=new Map(links.map(link=>[safeUrl(link.url),link.id])),known=new Set(links.map(link=>link.id));
  const idMap=new Map(incoming.filter(link=>link&&safeUrl(link.url)).map(link=>[link.id,byUrl.get(safeUrl(link.url))]));
  const remap=ids=>Array.isArray(ids)?ids.map(id=>known.has(id)?id:idMap.get(id)).filter(Boolean):[];
  return {...state,favorites:[...new Set([...state.favorites,...remap(backup.favorites)])],order:remap(backup.order),hidden:remap(backup.hidden),newTab:backup.newTab!==false,theme:backup.theme==='dark'?'dark':'light'};
}
