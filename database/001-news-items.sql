-- Standalone PostgreSQL schema. It does not depend on a hosted API or auth roles.
-- Import existing rows with their external_id and collection dates unchanged.
BEGIN;

CREATE TABLE IF NOT EXISTS public.news_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  source_key text NOT NULL,
  source_name text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('cn-media','en-media','paper','community','vendor-blog','release')),
  title text NOT NULL,
  url text NOT NULL,
  summary text NOT NULL DEFAULT '',
  content_text text NOT NULL DEFAULT '',
  content_excerpt text NOT NULL DEFAULT '',
  content_status text NOT NULL DEFAULT 'not_fetched' CHECK (content_status IN ('not_fetched','fetched','empty','failed')),
  content_fetched_at timestamptz,
  title_zh text NOT NULL DEFAULT '',
  summary_zh text NOT NULL DEFAULT '',
  content_text_zh text NOT NULL DEFAULT '',
  translation_status text NOT NULL DEFAULT 'not_requested' CHECK (translation_status IN ('not_requested','translated','skipped','failed')),
  translated_at timestamptz,
  ecosystem_layer text NOT NULL DEFAULT 'foundation' CHECK (ecosystem_layer IN ('foundation','model-platform','protocol','runtime','product-ui','data-memory','evaluation','security-governance')),
  ecosystem_layer_label text NOT NULL DEFAULT '基础综述',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  lang text NOT NULL DEFAULT 'en' CHECK (lang IN ('zh','en')),
  published_at timestamptz,
  published_date date NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  collected_date date NOT NULL,
  enriched boolean NOT NULL DEFAULT false,
  read_count integer NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_text tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(title_zh,'') || ' ' || coalesce(source_name,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(summary_zh,'') || ' ' || coalesce(content_excerpt,'') || ' ' || coalesce(content_text,'') || ' ' || coalesce(content_text_zh,''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_items_external_id_key UNIQUE (external_id)
);

CREATE INDEX IF NOT EXISTS news_items_published_date_idx ON public.news_items (published_date DESC, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS news_items_collected_date_idx ON public.news_items (collected_date DESC, collected_at DESC);
CREATE INDEX IF NOT EXISTS news_items_layer_idx ON public.news_items (ecosystem_layer, published_date DESC, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS news_items_source_idx ON public.news_items (source_key, published_date DESC, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS news_items_url_idx ON public.news_items (url);
CREATE INDEX IF NOT EXISTS news_items_tags_idx ON public.news_items USING gin (tags);
CREATE INDEX IF NOT EXISTS news_items_search_idx ON public.news_items USING gin (search_text);
CREATE INDEX IF NOT EXISTS news_items_calendar_bucket_idx ON public.news_items (collected_date DESC, ecosystem_layer);
CREATE INDEX IF NOT EXISTS news_items_calendar_layer_source_idx ON public.news_items (ecosystem_layer, source_name);
CREATE INDEX IF NOT EXISTS news_items_calendar_source_idx ON public.news_items (source_name);

CREATE OR REPLACE FUNCTION public.set_news_items_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS news_items_set_updated_at ON public.news_items;
CREATE TRIGGER news_items_set_updated_at BEFORE UPDATE ON public.news_items
FOR EACH ROW EXECUTE FUNCTION public.set_news_items_updated_at();

ALTER TABLE public.news_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read news items" ON public.news_items;
CREATE POLICY "Public read news items" ON public.news_items FOR SELECT USING (true);

COMMENT ON COLUMN public.news_items.external_id IS 'Stable canonical URL identity; retain during migration.';
COMMENT ON COLUMN public.news_items.collected_date IS 'First collection date in Asia/Shanghai; public calendar and list filtering use this date.';
COMMENT ON COLUMN public.news_items.published_date IS 'Source publication date; separate from collection date.';
COMMIT;
