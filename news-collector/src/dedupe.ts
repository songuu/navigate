// 批内去重。
//
// 收集身份是 externalId（canonical URL 的 sha256），但不同源也可能给出同一 url 的不同形态，
// 故同时用 externalId 与 url 双重判定，保留首次出现顺序（稳定、可测）。
// 另外补一条“同源 + 同发布日期 + 同标题归一化”规则，挡住媒体源偶发的同文双链接。
// 该规则故意不跨 source 生效，避免误伤不同项目恰好同名的 release/公告。

import type { NewsItem } from "./types.ts";

function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function dedupe(items: readonly NewsItem[]): NewsItem[] {
  const seenIds = new Map<string,number>();
  const seenUrls = new Map<string,number>();
  const seenSourceTitleDays = new Map<string,number>();
  const result: NewsItem[] = [];

  for (const item of items) {
    const sourceTitleDayKey = [
      item.sourceKey,
      item.publishedDate,
      normalizeTitle(item.title),
    ].join("::");
    const existing=seenIds.get(item.externalId)??seenUrls.get(item.url)??seenSourceTitleDays.get(sourceTitleDayKey);
    const index=existing??result.length;
    if(existing===undefined)result.push(item);
    else result[index]=mergeDuplicate(result[index]!,item);
    seenIds.set(item.externalId,index);seenUrls.set(item.url,index);seenSourceTitleDays.set(sourceTitleDayKey,index);
  }

  return result;
}

function mergeDuplicate(first:NewsItem,incoming:NewsItem):NewsItem{
  const richer=(incoming.contentStatus==='fetched'&&first.contentStatus!=='fetched')||(incoming.contentText.length>first.contentText.length&&!(first.contentStatus==='fetched'&&incoming.contentStatus!=='fetched'))?incoming:first;
  const evidence=new Map<string,{sourceKey:string;sourceName:string;url:string}>();
  for(const item of [first,incoming]){
    const prior=Array.isArray(item.metadata.mergedSources)?item.metadata.mergedSources:[];
    for(const source of [...prior,{sourceKey:item.sourceKey,sourceName:item.sourceName,url:item.url}]){
      if(source&&typeof source==='object'&&typeof source.sourceKey==='string'&&typeof source.sourceName==='string'&&typeof source.url==='string')evidence.set(source.sourceKey+'\n'+source.url,{sourceKey:source.sourceKey,sourceName:source.sourceName,url:source.url});
    }
  }
  return {...first,contentText:richer.contentText,contentExcerpt:richer.contentExcerpt,contentStatus:richer.contentStatus,contentFetchedAt:richer.contentFetchedAt,
    metadata:{...first.metadata,...(richer.metadata.articleContent?{articleContent:richer.metadata.articleContent}:{}),mergedSources:[...evidence.values()]}};
}
