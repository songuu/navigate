import { NEWS_LAYERS, isNewsDate } from './news-format.js';

const layerKeys = new Set(NEWS_LAYERS.map(([key]) => key));
const MAX_SNAPSHOT_LIFETIME_MS = 120000;
const DATE_HEADER_PRECISION_MS = 1000;

function calendarShape(payload) {
  const buckets = payload?.buckets;
  const sourceCounts = payload?.sourceCounts;
  if (!Array.isArray(buckets) || !Array.isArray(sourceCounts)
    || buckets.some(bucket => !bucket || !isNewsDate(bucket.date) || !layerKeys.has(bucket.ecosystemLayer)
      || !Number.isSafeInteger(bucket.articleCount) || bucket.articleCount <= 0)
    || sourceCounts.some(source => !source || (source.ecosystemLayer !== 'all' && !layerKeys.has(source.ecosystemLayer))
      || !Number.isSafeInteger(source.sourceCount) || source.sourceCount < 0)
    || sourceCounts.filter(source => source.ecosystemLayer === 'all').length !== 1) {
    throw new Error('资讯日历数据格式异常，请稍后重试');
  }
  return {buckets, sourceCounts};
}

function isoTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : NaN;
}

/** Use the server clock: an incorrect workstation clock must not admit expired archives. */
export function validateNewsCalendarSnapshot(payload, {responseDate, elapsedMs = 0} = {}) {
  const serverDate = typeof responseDate === 'string' ? Date.parse(responseDate) : NaN;
  if (!Number.isFinite(serverDate) || new Date(serverDate).toUTCString() !== responseDate
    || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error('资讯日历缺少有效的服务器时间，请重试');
  }
  const generatedAt = isoTimestamp(payload?.snapshotGeneratedAt);
  const expiresAt = isoTimestamp(payload?.snapshotExpiresAt);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || expiresAt <= generatedAt
    || expiresAt - generatedAt > MAX_SNAPSHOT_LIFETIME_MS) {
    throw new Error('资讯日历快照有效期异常，请稍后重试');
  }
  if (generatedAt > serverDate + DATE_HEADER_PRECISION_MS) {
    throw new Error('资讯日历快照生成时间在未来，请稍后重试');
  }
  // Date headers omit milliseconds; include that precision and the entire read
  // duration so a near-expiry response is rejected conservatively.
  if (serverDate + DATE_HEADER_PRECISION_MS + elapsedMs >= expiresAt) {
    throw new Error('资讯日历快照已过期，请重新加载');
  }
  return calendarShape(payload);
}

export async function readNewsCalendar({readJson, apiBase = '/api/content/v1', signal, isDevelopment = false, hostname = ''}) {
  const allowNotFound = isDevelopment === true && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  const response = await readJson('/data/news-calendar.json', signal, {withResponse: true, allowNotFound});
  // Vite does not produce the server's snapshot. Only that explicit local 404
  // can use the legacy API; outages and stale production data must fail fast.
  if (response.status === 404 && allowNotFound) {
    return calendarShape(await readJson(`${apiBase}/news/calendar`, signal));
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`资讯服务暂不可用（HTTP ${response.status}）`);
  }
  return validateNewsCalendarSnapshot(response.payload, response);
}
