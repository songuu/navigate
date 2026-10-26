-- Run with psql ON_ERROR_STOP as the verified Navigate table owner.
-- Initial backfill and trigger installation commit together; article rows stay intact.
\set ON_ERROR_STOP on
\if :{?reader_role}
\else
  \set reader_role navigate_readonly
\endif
\if :{?writer_role}
\else
  \set writer_role navigate_writer
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';
DO $$
BEGIN
  IF current_database() <> 'navigate'
     AND current_database() !~ '^navigate_calendar_test_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Calendar rollups require the verified Navigate database';
  END IF;
END $$;

-- Block concurrent source writes only for the one-time backfill; normal reads continue.
LOCK TABLE public.news_items IN SHARE ROW EXCLUSIVE MODE;

SELECT (
  to_regclass('public.news_calendar_buckets') IS NOT NULL OR
  to_regclass('public.news_calendar_sources') IS NOT NULL OR
  to_regprocedure('public.maintain_news_calendar_rollups()') IS NOT NULL OR
  to_regprocedure('public.clear_news_calendar_rollups()') IS NOT NULL OR
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.news_items'::regclass
          AND tgname IN ('news_items_calendar_rollups', 'news_items_calendar_rollups_truncate'))
) AS calendar_rollups_present
\gset

\if :calendar_rollups_present
-- A rerun reuses the ready counters. Never silently refill incomplete objects.
DO $$
BEGIN
  IF to_regclass('public.news_calendar_buckets') IS NULL OR
     to_regclass('public.news_calendar_sources') IS NULL OR
     obj_description(to_regclass('public.news_calendar_buckets'), 'pg_class')
       IS DISTINCT FROM 'navigate-calendar-rollups:v1' OR
     obj_description(to_regclass('public.news_calendar_sources'), 'pg_class')
       IS DISTINCT FROM 'navigate-calendar-rollups:v1' OR
     (SELECT count(*) FROM pg_trigger
      WHERE tgrelid='public.news_items'::regclass AND NOT tgisinternal AND tgenabled='O'
        AND ((tgname='news_items_calendar_rollups' AND tgtype=29
              AND tgfoid=to_regprocedure('public.maintain_news_calendar_rollups()'))
          OR (tgname='news_items_calendar_rollups_truncate' AND tgtype=32
              AND tgfoid=to_regprocedure('public.clear_news_calendar_rollups()')))) <> 2 OR
     (SELECT count(*) FROM pg_proc
      WHERE oid IN (to_regprocedure('public.maintain_news_calendar_rollups()'),
                    to_regprocedure('public.clear_news_calendar_rollups()'))
        AND prosecdef AND prorettype='pg_catalog.trigger'::regtype
        AND proconfig @> ARRAY['search_path=pg_catalog']) <> 2 OR
     (SELECT count(*) FROM pg_constraint
      WHERE conrelid IN (to_regclass('public.news_calendar_buckets'), to_regclass('public.news_calendar_sources'))
        AND convalidated AND contype IN ('p','c')) <> 4 THEN
    RAISE EXCEPTION 'Calendar rollups are incomplete; inspect before retrying migration';
  END IF;
END $$;
\else
CREATE TABLE public.news_calendar_buckets (
  collected_date date NOT NULL,
  ecosystem_layer text NOT NULL,
  article_count bigint NOT NULL CHECK (article_count >= 0),
  PRIMARY KEY (collected_date, ecosystem_layer)
);
CREATE TABLE public.news_calendar_sources (
  ecosystem_layer text NOT NULL,
  source_name text NOT NULL,
  article_count bigint NOT NULL CHECK (article_count >= 0),
  PRIMARY KEY (ecosystem_layer, source_name)
);

INSERT INTO public.news_calendar_buckets (collected_date, ecosystem_layer, article_count)
SELECT collected_date, ecosystem_layer, count(*) FROM public.news_items
GROUP BY collected_date, ecosystem_layer;
INSERT INTO public.news_calendar_sources (ecosystem_layer, source_name, article_count)
SELECT ecosystem_layer, source_name, count(*) FROM public.news_items
GROUP BY ecosystem_layer, source_name;

CREATE FUNCTION public.maintain_news_calendar_rollups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  bucket_changed boolean;
  source_changed boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    bucket_changed := ROW(OLD.collected_date, OLD.ecosystem_layer)
                      IS DISTINCT FROM ROW(NEW.collected_date, NEW.ecosystem_layer);
    source_changed := ROW(OLD.ecosystem_layer, OLD.source_name)
                      IS DISTINCT FROM ROW(NEW.ecosystem_layer, NEW.source_name);
    -- Full-text, translation and read-count writes do not touch calendar rows.
    IF NOT bucket_changed AND NOT source_changed THEN RETURN NULL; END IF;
  ELSE
    bucket_changed := true;
    source_changed := true;
  END IF;

  IF bucket_changed THEN
    IF TG_OP IN ('DELETE','UPDATE') THEN
      UPDATE public.news_calendar_buckets SET article_count=article_count-1
      WHERE collected_date=OLD.collected_date AND ecosystem_layer=OLD.ecosystem_layer
        AND article_count>0;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Calendar bucket counter missing or empty for date %, layer %',
          OLD.collected_date, OLD.ecosystem_layer USING ERRCODE='23514';
      END IF;
    END IF;
    IF TG_OP IN ('INSERT','UPDATE') THEN
      INSERT INTO public.news_calendar_buckets AS bucket
        (collected_date, ecosystem_layer, article_count)
      VALUES (NEW.collected_date, NEW.ecosystem_layer, 1)
      ON CONFLICT (collected_date, ecosystem_layer)
      DO UPDATE SET article_count=bucket.article_count+1;
    END IF;
  END IF;

  IF source_changed THEN
    IF TG_OP IN ('DELETE','UPDATE') THEN
      UPDATE public.news_calendar_sources SET article_count=article_count-1
      WHERE ecosystem_layer=OLD.ecosystem_layer AND source_name=OLD.source_name
        AND article_count>0;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Calendar source counter missing or empty for layer %, source %',
          OLD.ecosystem_layer, OLD.source_name USING ERRCODE='23514';
      END IF;
    END IF;
    IF TG_OP IN ('INSERT','UPDATE') THEN
      INSERT INTO public.news_calendar_sources AS source
        (ecosystem_layer, source_name, article_count)
      VALUES (NEW.ecosystem_layer, NEW.source_name, 1)
      ON CONFLICT (ecosystem_layer, source_name)
      DO UPDATE SET article_count=source.article_count+1;
    END IF;
  END IF;
  -- Retain zero rows so concurrent delete/reinsert uses the same locked counter.
  RETURN NULL;
END $$;

CREATE FUNCTION public.clear_news_calendar_rollups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- DELETE avoids taking an exclusive TRUNCATE lock on tables read by the API.
  DELETE FROM public.news_calendar_buckets;
  DELETE FROM public.news_calendar_sources;
  RETURN NULL;
END $$;

CREATE TRIGGER news_items_calendar_rollups
AFTER INSERT OR UPDATE OR DELETE ON public.news_items
FOR EACH ROW EXECUTE FUNCTION public.maintain_news_calendar_rollups();
CREATE TRIGGER news_items_calendar_rollups_truncate
AFTER TRUNCATE ON public.news_items
FOR EACH STATEMENT EXECUTE FUNCTION public.clear_news_calendar_rollups();

COMMENT ON TABLE public.news_calendar_buckets IS 'navigate-calendar-rollups:v1';
COMMENT ON TABLE public.news_calendar_sources IS 'navigate-calendar-rollups:v1';
ANALYZE public.news_calendar_buckets;
ANALYZE public.news_calendar_sources;
\endif

ALTER TABLE public.news_calendar_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_calendar_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.news_calendar_buckets, public.news_calendar_sources
  FROM PUBLIC, :"reader_role", :"writer_role";
GRANT SELECT ON public.news_calendar_buckets, public.news_calendar_sources TO :"reader_role";
DROP POLICY IF EXISTS navigate_calendar_reader ON public.news_calendar_buckets;
CREATE POLICY navigate_calendar_reader ON public.news_calendar_buckets
FOR SELECT TO :"reader_role" USING (true);
DROP POLICY IF EXISTS navigate_calendar_reader ON public.news_calendar_sources;
CREATE POLICY navigate_calendar_reader ON public.news_calendar_sources
FOR SELECT TO :"reader_role" USING (true);
REVOKE ALL ON FUNCTION public.maintain_news_calendar_rollups(), public.clear_news_calendar_rollups()
  FROM PUBLIC, :"reader_role", :"writer_role";

COMMIT;
