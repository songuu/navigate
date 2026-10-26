// 收集编排：sources → 抓取(故障隔离) → 归一+分类 → 去重 → 原文正文抽取 → 可选富化 → 出库。
//
// collectOnce 是纯编排，所有副作用（网络、时钟、Supabase）都可由参数注入，便于离线测试：
// - sources 可传 fixtures 派生的假源
// - fetchFeedImpl 可替换为读 fixtures 的实现
// - fetchArticleContentImpl 可替换为固定正文抽取结果
// - now 注入固定时间保证确定性
// - dryRun 跳过出库

import { classify } from "./classify.ts";
import type { ProviderName } from "../../src/shared/llm/index.ts";
import type { RunConfig, SupabaseConfig } from "./config.ts";
import { dedupe } from "./dedupe.ts";
import { enrichItems } from "./enrich.ts";
import { toNewsItem,parsePublishedAt } from "./normalize.ts";
import {editorialSelect,type EditorialOptions,type EditorialStats} from './editorial.ts';
import { fetchArticleContent, type ArticleContentResult } from "./article-content.ts";
import { translateItems, type TranslationClient } from "./translate.ts";
import type { ContentRepository } from "./data/content-repository.ts";
import { openContentRepositoryForWorkers } from "./data/runtime.ts";
import { fetchFeed, type FeedResult } from "./rss.ts";
import { enabledSources } from "./sources.ts";
import {newsItemSchema,type NewsItem,type NewsSource} from "./types.ts";

const ARTICLE_CONTENT_CONCURRENCY = 4;
const DEFAULT_FEED_CONCURRENCY = 4;

export interface SourceOutcome {
  readonly key: string;
  readonly name: string;
  readonly ok: boolean;
  readonly fetched: number;
  readonly attempts: number;
  readonly critical?: boolean;
  readonly error?: string;
  readonly diagnostics?: string;
}

export interface CollectReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly sources: readonly SourceOutcome[];
  readonly totalFetched: number;
  readonly afterDedupe: number;
  readonly contentFetched: number;
  readonly contentEmpty: number;
  readonly contentFailed: number;
  readonly translated: number;
  readonly translationFailed: number;
  readonly translationSkipped: number;
  readonly enriched: number;
  readonly stored: number;
  readonly tableCount: string;
  readonly dryRun: boolean;
  readonly items: readonly NewsItem[];
  readonly collection?:{readonly rawFetched:number;readonly outsideWindow:number;readonly undated:number;readonly rejected:number;readonly existingSkipped:number;readonly afterUrlDedupe:number};
  readonly editorial?:EditorialStats;
}

export type FetchFeedImpl = (
  source: NewsSource,
  opts: { timeoutMs?: number },
) => Promise<FeedResult>;

export type FetchArticleContentImpl = (
  url: string,
  opts: { timeoutMs?: number; now?: Date },
) => Promise<ArticleContentResult>;

export interface CollectOptions {
  readonly sources?: readonly NewsSource[];
  readonly now?: Date;
  readonly dryRun?: boolean;
  readonly supabase?: SupabaseConfig | null;
  /** 首选写入端口；supabase 参数仅用于拒绝旧调用，不能再写入。 */
  readonly contentRepository?: Pick<ContentRepository, "upsertNewsItems"> & Partial<Pick<ContentRepository,'findExistingNewsIds'>>;
  readonly lookbackHours?:number;
  readonly skipExisting?:boolean;
  readonly editorial?:EditorialOptions;
  readonly feedTimeoutMs?: number;
  /** 同时抓取的源数；限制同一供应商的连接突发。 */
  readonly feedConcurrency?: number;
  /** 每源最多保留多少条（按 feed 顺序）；缺省不限。 */
  readonly maxPerSource?: number;
  readonly enrichMax?: number;
  readonly enrichProvider?: ProviderName;
  readonly enrichModel?: string;
  readonly fetchFeedImpl?: FetchFeedImpl;
  readonly translationMaxItems?: number;
  readonly translationProvider?: ProviderName;
  readonly translationModel?: string;
  readonly translationConcurrency?: number;
  readonly translationTimeoutMs?: number;
  readonly translationMaxAttempts?: number;
  readonly translationClient?: TranslationClient;
  readonly articleContentEnabled?: boolean;
  readonly articleContentTimeoutMs?: number;
  readonly articleContentMaxItems?: number;
  readonly fetchArticleContentImpl?: FetchArticleContentImpl;
}

export async function collectOnce(options: CollectOptions = {}): Promise<CollectReport> {
  const start = options.now ?? new Date();
  const sources = options.sources ?? enabledSources();
  const supabase = options.supabase ?? null;
  const contentRepository = options.contentRepository;
  const dryRun = options.dryRun ?? !contentRepository;
  const fetchImpl: FetchFeedImpl = options.fetchFeedImpl ?? fetchFeed;
  const feedConcurrency = options.feedConcurrency ?? DEFAULT_FEED_CONCURRENCY;

  // 有界并发：GitHub Atom 等同域源数量多，Promise.all 会造成连接耗尽和集体超时。
  const feedResults = await fetchFeedsBounded(
    sources,
    Math.max(1, Math.floor(feedConcurrency)),
    fetchImpl,
    options.feedTimeoutMs,
  );

  const collected: NewsItem[] = [];
  const sourceOutcomes: SourceOutcome[] = [];
  const collection={rawFetched:0,outsideWindow:0,undated:0,rejected:0,existingSkipped:0,afterUrlDedupe:0};
  const lookback=options.lookbackHours;
  if(lookback!==undefined&&(!Number.isFinite(lookback)||lookback<1||lookback>720))throw new Error('采集时间窗口需为1–720小时。');
  for (const result of feedResults) {
    if (!result.ok) {
      sourceOutcomes.push({
        key: result.source.key,
        name: result.source.name,
        ok: false,
        fetched: 0,
        attempts: result.attempts,
        critical: result.source.critical,
        error: result.error,
        diagnostics: result.diagnostics,
      });
      continue;
    }
    collection.rawFetched+=result.items.length;
    const recent=lookback===undefined?result.items:result.items.filter(raw=>{
      const published=parsePublishedAt(raw);if(!published){collection.undated++;return true;}
      const time=Date.parse(published);if(time<start.getTime()-lookback*3600000||time>start.getTime()+300000){collection.outsideWindow++;return false;}return true;
    });
    const capped =
      options.maxPerSource !== undefined
        ? recent.slice(0, options.maxPerSource)
        : recent;
    // fetched 报告封顶后实际进入管道的条数，保证与 totalFetched 可对账。
    sourceOutcomes.push({
      key: result.source.key,
      name: result.source.name,
      ok: true,
      fetched: capped.length,
      attempts: result.attempts,
      critical: result.source.critical,
      diagnostics: result.diagnostics,
    });
    for (const rawItem of capped) {
      try{
      const classification = classify(
        {
          title: rawItem.title,
          summary: rawItem.contentSnippet ?? rawItem.content ?? rawItem.summary,
        },
        result.source,
      );
      const normalized=toNewsItem({ source: result.source, rawItem, classification, now: start });
      const parsedUrl=new URL(normalized.url);
      if(!['https:','http:'].includes(parsedUrl.protocol)||parsedUrl.username||parsedUrl.password)throw new Error('Article URL must be a credential-free HTTP(S) URL.');
      newsItemSchema.parse(normalized);collected.push(normalized);
      }catch{collection.rejected++;}
    }
  }

  let items = dedupe(collected);
  collection.afterUrlDedupe=items.length;
  if(options.skipExisting&&contentRepository?.findExistingNewsIds&&items.length){
    const existing=new Set(await contentRepository.findExistingNewsIds(items.map(item=>item.externalId)));
    const before=items.length;items=items.filter(item=>!existing.has(item.externalId));collection.existingSkipped=before-items.length;
  }
  let editorial:EditorialStats|undefined;
  if(options.editorial?.enabled){const selected=await editorialSelect(items,{...options.editorial,now:start});items=selected.items;editorial=selected.stats;}

  const translationMaxItems = options.translationMaxItems ?? 0;
  if (options.articleContentEnabled) {
    items = await attachArticleContent(items, {
      fetchArticleContentImpl: options.fetchArticleContentImpl ?? ((url, opts) => fetchArticleContent(url, opts)),
      timeoutMs: options.articleContentTimeoutMs,
      maxItems: options.articleContentMaxItems,
      now: start,
      preferEnglish: translationMaxItems > 0,
    });
  }

  if (translationMaxItems > 0) {
    items = await translateItems(items, {
      maxItems: translationMaxItems,
      provider: options.translationProvider ?? options.enrichProvider,
      model: options.translationModel,
      concurrency: options.translationConcurrency,
      timeoutMs: options.translationTimeoutMs,
      maxAttempts: options.translationMaxAttempts,
      client: options.translationClient,
      now: start,
    });
  }

  const enrichMax = options.enrichMax ?? 0;
  if (enrichMax > 0) {
    items = await enrichItems(items, {
      maxItems: enrichMax,
      provider: options.enrichProvider,
      model: options.enrichModel,
    });
  }

  const enrichedCount = items.filter((item) => item.enriched).length;
  const contentFetched = items.filter((item) => item.contentStatus === "fetched").length;
  const contentEmpty = items.filter((item) => item.contentStatus === "empty").length;
  const contentFailed = items.filter((item) => item.contentStatus === "failed").length;

  let stored = 0;
  let tableCount = "n/a";
  const translated = items.filter((item) => item.translationStatus === "translated").length;
  const translationFailed = items.filter((item) => item.translationStatus === "failed").length;
  const translationSkipped = items.filter((item) => item.translationStatus === "skipped").length;
  if (!dryRun && contentRepository) {
    if(items.length){const result = await contentRepository.upsertNewsItems(items);stored = result.pushed;tableCount = result.tableCount;}
    else tableCount='unchanged';
  } else if (!dryRun && supabase) {
    throw new Error("Supabase/PostgREST data uploads are disabled for news collection; configure the server PostgreSQL content repository.");
  } else if (!dryRun) {
    throw new Error("A content repository is required when NEWS_DRY_RUN is disabled.");
  }

  const finish = new Date();
  return {
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
    durationMs: Math.max(0, finish.getTime() - start.getTime()),
    sources: sourceOutcomes,
    totalFetched: collected.length,
    afterDedupe: items.length,
    contentFetched,
    contentEmpty,
    contentFailed,
    enriched: enrichedCount,
    stored,
    tableCount,
    dryRun,
    translated,
    translationFailed,
    translationSkipped,
    items,
    collection,
    ...(editorial?{editorial}:{}),
  };
}

async function fetchFeedsBounded(
  sources: readonly NewsSource[],
  concurrency: number,
  fetchImpl: FetchFeedImpl,
  timeoutMs: number | undefined,
): Promise<FeedResult[]> {
  const results = new Array<FeedResult>(sources.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const source = sources[index];
      if (!source) return;
      try{results[index] = await fetchImpl(source, { timeoutMs });}
      catch(error){results[index]={source,ok:false,items:[],attempts:1,error:`source adapter failed (${error instanceof Error?error.name:'unknown error'})`};}
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, sources.length) }, () => worker()),
  );
  return results;
}

interface AttachArticleContentOptions {
  readonly fetchArticleContentImpl: FetchArticleContentImpl;
  readonly timeoutMs?: number;
  readonly maxItems?: number;
  readonly preferEnglish?: boolean;
  readonly now: Date;
}

async function attachArticleContent(
  items: readonly NewsItem[],
  options: AttachArticleContentOptions,
): Promise<NewsItem[]> {
  const maxItems = options.maxItems ?? items.length;
  const next = [...items];
  const indexes = next.map((_, index) => index).filter(index=>next[index]?.contentStatus!=='fetched');
  const prioritizedIndexes = options.preferEnglish
    ? [
        ...indexes.filter((index) => next[index]?.lang === "en"),
        ...indexes.filter((index) => next[index]?.lang !== "en"),
      ]
    : indexes;
  const selectedIndexes = prioritizedIndexes.slice(0, maxItems);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = selectedIndexes[cursor++];
      if (index === undefined) return;
      const item = next[index];
      if (!item) return;
      let result:ArticleContentResult;
      try{result = await options.fetchArticleContentImpl(item.url, {
        timeoutMs: options.timeoutMs,
        now: options.now,
      });}catch(error){result={text:'',excerpt:'',status:'failed',fetchedAt:options.now.toISOString(),error:`article adapter failed (${error instanceof Error?error.name:'unknown error'})`};}
      next[index] = mergeArticleContent(item, result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ARTICLE_CONTENT_CONCURRENCY, selectedIndexes.length) }, () => worker()),
  );
  return next;
}

function mergeArticleContent(item: NewsItem, result: ArticleContentResult): NewsItem {
  const contentText = result.text || item.contentText;
  const contentExcerpt = result.excerpt || item.contentExcerpt || item.summary;
  return {
    ...item,
    contentText,
    contentExcerpt,
    contentStatus: result.status,
    contentFetchedAt: result.fetchedAt,
    metadata: {
      ...item.metadata,
      articleContent: {
        status: result.status,
        fetchedAt: result.fetchedAt,
        error: result.error ?? null,
      },
    },
  };
}

/** 用 RunConfig 跑一次收集；cli 与 cron 共用此入口。 */
export async function collectFromConfig(
  config: RunConfig,
  overrides: Partial<CollectOptions> = {},
): Promise<CollectReport> {
  const dryRun = overrides.dryRun ?? config.dryRun;
  const repositoryHandle =
    !dryRun && !overrides.contentRepository
      ? await openContentRepositoryForWorkers({
          config: config.contentRepository,
          supabase: config.supabase,
        })
      : null;

  try {
    return await collectOnce({
      dryRun,
      supabase: config.supabase,
      contentRepository: repositoryHandle?.repository,
      feedTimeoutMs: config.feedTimeoutMs,
      feedConcurrency: config.feedConcurrency,
      maxPerSource: config.maxPerSource,
      lookbackHours:config.lookbackHours,
      skipExisting:config.skipExisting,
      editorial:config.editorial,
      enrichMax: config.enrichMax,
      enrichProvider: config.enrichProvider,
      enrichModel: config.enrichModel,
      translationMaxItems: config.translationMaxItems,
      translationProvider: config.enrichProvider,
      translationModel: config.translationModel,
      translationConcurrency: config.translationConcurrency,
      translationTimeoutMs: config.translationTimeoutMs,
      translationMaxAttempts: config.translationMaxAttempts,
      articleContentEnabled: config.articleContentEnabled,
      articleContentTimeoutMs: config.articleContentTimeoutMs,
      articleContentMaxItems: config.articleContentMaxItems,
      ...overrides,
    });
  } finally {
    await repositoryHandle?.close();
  }
}
