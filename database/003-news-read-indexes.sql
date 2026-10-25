-- Match src/news-format.js exactly: dates descending, stable identity ascending.
-- Keep this migration outside BEGIN: online builds must not block the collector.
-- Run psql with ON_ERROR_STOP against the verified Navigate database only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS news_items_public_list_order_idx
  ON public.news_items (collected_date DESC, published_date DESC, external_id ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS news_items_public_layer_list_order_idx
  ON public.news_items (ecosystem_layer, collected_date DESC, published_date DESC, external_id ASC);
