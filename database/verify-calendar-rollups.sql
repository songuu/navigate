-- Read-only production oracle: compare both directions, including missing groups.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='5s';
DO $$
BEGIN
  IF current_database()<>'navigate' AND current_database() !~ '^navigate_calendar_test_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Calendar verification requires the verified Navigate database';
  END IF;
  IF EXISTS (
    WITH original AS MATERIALIZED (
      SELECT collected_date, ecosystem_layer, count(*)::bigint AS article_count
      FROM public.news_items GROUP BY collected_date,ecosystem_layer
    )
    (SELECT * FROM original EXCEPT
     SELECT collected_date,ecosystem_layer,article_count FROM public.news_calendar_buckets WHERE article_count>0)
    UNION ALL
    (SELECT collected_date,ecosystem_layer,article_count FROM public.news_calendar_buckets WHERE article_count>0
     EXCEPT SELECT * FROM original)
  ) THEN RAISE EXCEPTION 'Calendar bucket rollups differ from article records'; END IF;
  IF EXISTS (
    WITH original AS MATERIALIZED (
      SELECT ecosystem_layer,source_name,count(*)::bigint AS article_count
      FROM public.news_items GROUP BY ecosystem_layer,source_name
    )
    (SELECT * FROM original EXCEPT
     SELECT ecosystem_layer,source_name,article_count FROM public.news_calendar_sources WHERE article_count>0)
    UNION ALL
    (SELECT ecosystem_layer,source_name,article_count FROM public.news_calendar_sources WHERE article_count>0
     EXCEPT SELECT * FROM original)
  ) THEN RAISE EXCEPTION 'Calendar source rollups differ from article records'; END IF;
END $$;
SELECT sum(article_count) AS total_articles,count(*) AS date_layer_buckets FROM public.news_calendar_buckets WHERE article_count>0;
SELECT count(DISTINCT source_name) AS distinct_sources FROM public.news_calendar_sources WHERE article_count>0;
COMMIT;
