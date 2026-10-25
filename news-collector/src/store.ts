// Retain the legacy entry point so old callers fail explicitly instead of
// silently writing into the retired database. PostgreSQL writes use src/data/.
import type { SupabaseConfig } from "./config.ts";
import { rejectSupabaseDataWrite } from "./data/supabase-write-policy.ts";
import type { NewsItem } from "./types.ts";

export interface UpsertResult {
  readonly attempted: number;
  readonly invalid: number;
  readonly pushed: number;
  readonly tableCount: string;
}

export async function upsertNewsItems(
  _items: readonly NewsItem[],
  _config: SupabaseConfig,
  _fetchImpl: typeof fetch = fetch,
): Promise<UpsertResult> {
  return rejectSupabaseDataWrite("news_items legacy Supabase upsert");
}
