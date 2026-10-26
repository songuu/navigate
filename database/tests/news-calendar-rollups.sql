\set ON_ERROR_STOP on
\if :{?reader_role}
\else
  \set reader_role navigate_readonly
\endif
\if :{?writer_role}
\else
  \set writer_role navigate_writer
\endif

-- Runner: 001 -> 002 -> fixtures -> 005 -> 005 -> this file, in a fresh DB.
DO $$
BEGIN
  IF current_database() !~ '^navigate_calendar_test_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Calendar integration tests require a navigate_calendar_test_ database';
  END IF;
END $$;

BEGIN;
SET LOCAL statement_timeout = '90s';
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.assert_calendar_rollups(context text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    (SELECT collected_date, ecosystem_layer, count(*)::bigint AS article_count
     FROM public.news_items GROUP BY collected_date, ecosystem_layer
     EXCEPT
     SELECT collected_date, ecosystem_layer, article_count
     FROM public.news_calendar_buckets WHERE article_count > 0)
    UNION ALL
    (SELECT collected_date, ecosystem_layer, article_count
     FROM public.news_calendar_buckets WHERE article_count > 0
     EXCEPT
     SELECT collected_date, ecosystem_layer, count(*)::bigint
     FROM public.news_items GROUP BY collected_date, ecosystem_layer)
  ) THEN
    RAISE EXCEPTION 'Calendar bucket mismatch: %', context;
  END IF;
  IF EXISTS (
    (SELECT ecosystem_layer, source_name, count(*)::bigint AS article_count
     FROM public.news_items GROUP BY ecosystem_layer, source_name
     EXCEPT
     SELECT ecosystem_layer, source_name, article_count
     FROM public.news_calendar_sources WHERE article_count > 0)
    UNION ALL
    (SELECT ecosystem_layer, source_name, article_count
     FROM public.news_calendar_sources WHERE article_count > 0
     EXCEPT
     SELECT ecosystem_layer, source_name, count(*)::bigint
     FROM public.news_items GROUP BY ecosystem_layer, source_name)
  ) THEN
    RAISE EXCEPTION 'Calendar source mismatch: %', context;
  END IF;
END $$;

SELECT pg_temp.assert_calendar_rollups('nonempty backfill and repeated migration');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.news_items) <> 4 OR
     (SELECT sum(article_count) FROM public.news_calendar_buckets) <> 4 OR
     (SELECT count(DISTINCT source_name) FROM public.news_calendar_sources WHERE article_count > 0) <> 2 THEN
    RAISE EXCEPTION 'Backfill fixtures were not retained exactly';
  END IF;
END $$;

-- A content/translation/read-count update must not rewrite the counters.
CREATE TEMP TABLE original_bucket_versions AS
  SELECT collected_date, ecosystem_layer, ctid::text AS row_version
  FROM public.news_calendar_buckets;
CREATE TEMP TABLE original_source_versions AS
  SELECT ecosystem_layer, source_name, ctid::text AS row_version
  FROM public.news_calendar_sources;
INSERT INTO public.news_items
  (external_id, source_key, source_name, source_kind, title, url, ecosystem_layer,
   collected_date, published_date, content_text)
VALUES ('calendar-test-a', 'shared', '共同来源', 'cn-media', '正文更新',
        'https://example.com/calendar/a', 'foundation', '2026-10-24', '2026-10-23', '新的正文')
ON CONFLICT (external_id) DO UPDATE SET content_text = EXCLUDED.content_text;
UPDATE public.news_items SET read_count = read_count + 1, title_zh = '译文',
  collected_date = collected_date, ecosystem_layer = ecosystem_layer, source_name = source_name;
SELECT pg_temp.assert_calendar_rollups('content-only UPSERT and no-op dimensions');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.news_calendar_buckets b JOIN original_bucket_versions v
      USING (collected_date, ecosystem_layer) WHERE b.ctid::text <> v.row_version) OR
     EXISTS (SELECT 1 FROM public.news_calendar_sources s JOIN original_source_versions v
      USING (ecosystem_layer, source_name) WHERE s.ctid::text <> v.row_version) THEN
    RAISE EXCEPTION 'Content-only updates rewrote calendar counters';
  END IF;
END $$;

UPDATE public.news_items SET collected_date='2026-10-26', ecosystem_layer='security-governance',
  source_name='新来源' WHERE external_id='calendar-test-a';
SELECT pg_temp.assert_calendar_rollups('date, layer and source move');

CREATE TEMP TABLE before_source_only_change AS
  SELECT collected_date, ecosystem_layer, ctid::text AS row_version FROM public.news_calendar_buckets;
UPDATE public.news_items SET source_name='仅改来源' WHERE external_id='calendar-test-b';
SELECT pg_temp.assert_calendar_rollups('source-only move');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.news_calendar_buckets b JOIN before_source_only_change v
      USING (collected_date, ecosystem_layer) WHERE b.ctid::text <> v.row_version) THEN
    RAISE EXCEPTION 'Source-only update rewrote date buckets';
  END IF;
END $$;

CREATE TEMP TABLE before_date_only_change AS
  SELECT ecosystem_layer, source_name, ctid::text AS row_version FROM public.news_calendar_sources;
UPDATE public.news_items SET collected_date='2026-10-26' WHERE external_id='calendar-test-b';
SELECT pg_temp.assert_calendar_rollups('date-only move');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.news_calendar_sources s JOIN before_date_only_change v
      USING (ecosystem_layer, source_name) WHERE s.ctid::text <> v.row_version) THEN
    RAISE EXCEPTION 'Date-only update rewrote source counts';
  END IF;
END $$;

DELETE FROM public.news_items WHERE external_id='calendar-test-b';
DELETE FROM public.news_items WHERE external_id='calendar-test-c';
SELECT pg_temp.assert_calendar_rollups('delete last source reference and last bucket article');
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.news_calendar_sources
                 WHERE source_name='共同来源' AND article_count=0) OR
     NOT EXISTS (SELECT 1 FROM public.news_calendar_buckets
                 WHERE collected_date='2026-10-24' AND ecosystem_layer='foundation' AND article_count=0) THEN
    RAISE EXCEPTION 'Zero counters should remain available for concurrent re-insertion';
  END IF;
END $$;

INSERT INTO public.news_items
  (external_id, source_key, source_name, source_kind, title, url, ecosystem_layer, collected_date, published_date)
VALUES ('calendar-test-reinsert', 'shared', '共同来源', 'cn-media', '恢复零计数',
        'https://example.com/calendar/reinsert', 'foundation', '2026-10-24', '2026-10-23');
SELECT pg_temp.assert_calendar_rollups('reinsert into retained zero counters');
DELETE FROM public.news_items WHERE external_id='calendar-test-reinsert';
SELECT pg_temp.assert_calendar_rollups('delete after zero-counter reinsert');

SAVEPOINT calendar_truncate;
TRUNCATE public.news_items;
SELECT pg_temp.assert_calendar_rollups('truncate');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.news_calendar_buckets) OR EXISTS (SELECT 1 FROM public.news_calendar_sources) THEN
    RAISE EXCEPTION 'Truncate did not reset calendar counters';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT calendar_truncate;
SELECT pg_temp.assert_calendar_rollups('truncate rollback');

-- Corrupting an aggregate must fail the source write, rather than hide drift.
SAVEPOINT calendar_missing_counter;
DELETE FROM public.news_calendar_buckets WHERE ecosystem_layer='security-governance';
DO $$
BEGIN
  BEGIN
    DELETE FROM public.news_items WHERE external_id='calendar-test-a';
    RAISE EXCEPTION 'Expected missing-counter rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.news_items WHERE external_id='calendar-test-a') THEN
    RAISE EXCEPTION 'Counter failure did not roll back the source write';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT calendar_missing_counter;
SELECT pg_temp.assert_calendar_rollups('counter failure rollback');

SAVEPOINT calendar_missing_source;
DELETE FROM public.news_calendar_sources WHERE ecosystem_layer='security-governance';
DO $$
BEGIN
  BEGIN
    DELETE FROM public.news_items WHERE external_id='calendar-test-a';
    RAISE EXCEPTION 'Expected missing-source-counter rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.news_items WHERE external_id='calendar-test-a') OR
     (SELECT article_count FROM public.news_calendar_buckets
      WHERE collected_date='2026-10-26' AND ecosystem_layer='security-governance') <> 1 THEN
    RAISE EXCEPTION 'Source-counter failure did not roll back preceding bucket changes';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT calendar_missing_source;
SELECT pg_temp.assert_calendar_rollups('source-counter failure rollback');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) permission
    WHERE p.oid IN ('public.maintain_news_calendar_rollups()'::regprocedure,
                    'public.clear_news_calendar_rollups()'::regprocedure)
      AND permission.grantee=0 AND permission.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC unexpectedly has SECURITY DEFINER execute privilege';
  END IF;
END $$;

SET LOCAL ROLE :"reader_role";
SELECT count(*) FROM public.news_calendar_buckets;
SELECT count(*) FROM public.news_calendar_sources;
DO $$
BEGIN
  IF has_function_privilege(current_user, 'public.maintain_news_calendar_rollups()', 'EXECUTE') OR
     has_function_privilege(current_user, 'public.clear_news_calendar_rollups()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Reader unexpectedly has SECURITY DEFINER execute privilege';
  END IF;
  BEGIN
    UPDATE public.news_calendar_buckets SET article_count=999;
    RAISE EXCEPTION 'Reader unexpectedly changed rollups';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SET LOCAL ROLE :"writer_role";
INSERT INTO public.news_items
  (external_id, source_key, source_name, source_kind, title, url, ecosystem_layer, collected_date, published_date)
VALUES ('calendar-test-writer', 'writer', '权限写入', 'cn-media', 'Writer insert',
        'https://example.com/calendar/writer', 'foundation', '2026-10-26', '2026-10-25');
DO $$
BEGIN
  IF has_function_privilege(current_user, 'public.maintain_news_calendar_rollups()', 'EXECUTE') OR
     has_function_privilege(current_user, 'public.clear_news_calendar_rollups()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Writer unexpectedly has SECURITY DEFINER execute privilege';
  END IF;
  BEGIN
    INSERT INTO public.news_calendar_buckets VALUES ('2026-10-27','foundation',999);
    RAISE EXCEPTION 'Writer unexpectedly inserted direct rollups';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.news_calendar_sources SET article_count=999;
    RAISE EXCEPTION 'Writer unexpectedly updated direct rollups';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.news_calendar_buckets;
    RAISE EXCEPTION 'Writer unexpectedly deleted direct rollups';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    TRUNCATE public.news_calendar_sources;
    RAISE EXCEPTION 'Writer unexpectedly truncated direct rollups';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT pg_temp.assert_calendar_rollups('least-privilege writer trigger');

ROLLBACK;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.news_items) <> 4 OR
     (SELECT sum(article_count) FROM public.news_calendar_buckets) <> 4 THEN
    RAISE EXCEPTION 'Integration transaction did not restore committed fixtures';
  END IF;
END $$;
\echo Calendar rollup integration tests passed; behavioral writes rolled back.
