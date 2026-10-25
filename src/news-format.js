export const NEWS_LAYERS = [
  ['foundation', '基础综述'], ['model-platform', '模型与平台'], ['protocol', '协议与互操作'],
  ['runtime', '编排 Runtime'], ['product-ui', '产品与交互'], ['data-memory', '数据与记忆'],
  ['evaluation', '评测与基准'], ['security-governance', '安全与治理'],
];

export const NEWS_FIELDS = 'external_id,title,title_zh,summary,summary_zh,translation_status,url,content_excerpt,source_name,source_kind,ecosystem_layer,ecosystem_layer_label,collected_date,published_date,published_at,tags';
const DETAIL_FIELDS = `${NEWS_FIELDS},content_text,content_text_zh,content_status`;

export function isNewsDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function buildNewsQuery({date = null, layer = 'all', offset = 0, limit = 20, id = null} = {}) {
  const params = new URLSearchParams({fields: id ? DETAIL_FIELDS : NEWS_FIELDS});
  if (id) params.append('filter', `external_id:eq:${String(id)}`);
  else {
    if (date !== null) {
      if (!isNewsDate(date)) throw new Error('无效的资讯日期');
      params.append('filter', `collected_date:eq:${date}`);
    }
    if (layer !== 'all') {
      if (!NEWS_LAYERS.some(([key]) => key === layer)) throw new Error('无效的资讯分类');
      params.append('filter', `ecosystem_layer:eq:${layer}`);
    }
    for (const sort of ['collected_date:desc', 'published_date:desc', 'external_id:asc']) params.append('sort', sort);
  }
  params.set('limit', String(id ? 1 : Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 20))));
  params.set('offset', String(id ? 0 : Math.min(100000, Math.max(0, Math.trunc(Number(offset)) || 0))));
  params.set('count', 'none');
  return params;
}

export function safeArticleUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const text = value => typeof value === 'string' ? value.trim() : '';

export function normalizeArticle(row) {
  const translated = row.translation_status === 'translated';
  const originalTitle = text(row.title) || '未命名资讯';
  const originalBody = text(row.content_text) || text(row.content_excerpt) || text(row.summary);
  const chineseBody = translated ? text(row.content_text_zh) : '';
  return {
    id: text(row.external_id), title: (translated && text(row.title_zh)) || originalTitle,
    originalTitle, summary: (translated && text(row.summary_zh)) || text(row.summary) || text(row.content_excerpt),
    originalBody, chineseBody, canTranslate: Boolean(chineseBody),
    url: safeArticleUrl(row.url), source: text(row.source_name) || '未知来源',
    layer: text(row.ecosystem_layer), layerLabel: text(row.ecosystem_layer_label) || NEWS_LAYERS.find(([id]) => id === row.ecosystem_layer)?.[1] || '综合资讯',
    date: isNewsDate(row.collected_date) ? row.collected_date : '',
    publishedDate: isNewsDate(row.published_date) ? row.published_date : '', publishedAt: text(row.published_at),
    tags: Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === 'string') : [],
  };
}

export function calendarDates(buckets, layer = 'all') {
  return [...new Set(buckets.filter(bucket => isNewsDate(bucket.date) && bucket.articleCount > 0 && (layer === 'all' || bucket.ecosystemLayer === layer)).map(bucket => bucket.date))].sort().reverse();
}

export function calendarSelectionForLayer(date, month, availableDates, calendarLoaded) {
  if (!date || !calendarLoaded || availableDates.includes(date)) return {date, month};
  const nextDate = availableDates[0] || null;
  return {date: nextDate, month: nextDate ? nextDate.slice(0, 7) : month};
}

/** Read neighboring pages without changing the list snapshot used by Back. */
export async function findNewsNeighbors({id, date = null, layer = 'all', seed, readPage, pageSize = 100, isCurrent = () => true}) {
  const neighbors = {previous: null, next: null};
  let previous = null;
  let found = false;
  const scan = items => {
    for (const item of items) {
      if (item.id === id) {
        if (!found) neighbors.previous = previous;
        found = true;
      } else if (found) {
        neighbors.next = item;
        return true;
      } else previous = item;
    }
    return false;
  };
  if (!isCurrent()) return null;
  if (seed && scan(seed.items)) return neighbors;
  let offset = seed ? seed.nextOffset : 0;
  let hasMore = seed ? seed.hasMore : true;
  const limit = Math.min(1000, Math.max(1, Math.trunc(pageSize) || 100));
  while (hasMore) {
    if (!isCurrent()) return null;
    // Respect the API's offset bound instead of letting query clamping repeat
    // the same page forever when an archive eventually exceeds that contract.
    if (offset > 100000) throw new Error('相邻资讯超出分页读取范围，请返回列表缩小日期筛选');
    const page = await readPage({date, layer, offset, limit});
    if (!isCurrent()) return null;
    if (!page.items.length && page.hasMore) throw new Error('资讯分页未返回数据，无法继续查找相邻文章');
    if (scan(page.items)) return neighbors;
    offset += page.items.length;
    hasMore = Boolean(page.hasMore);
  }
  return found ? neighbors : {previous: null, next: null};
}

export function articleParagraphs(value) {
  return String(value || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}

export function filterLoadedNews(rows, query) {
  const words = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => words.every(word => [row.title, row.originalTitle, row.summary, row.source, ...row.tags].join(' ').toLocaleLowerCase().includes(word)));
}
