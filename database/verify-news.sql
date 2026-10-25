\set ON_ERROR_STOP on
-- Run against source and destination while collectors are stopped. Compare all
-- three output blocks before enabling the new writer. No private config appears.
SELECT count(*) AS total, count(DISTINCT external_id) AS distinct_identities,
       min(collected_date) AS first_collection, max(collected_date) AS latest_collection,
       count(*) FILTER (WHERE content_status = 'fetched') AS bodies,
       count(*) FILTER (WHERE translation_status = 'translated') AS translations
FROM public.news_items;

SELECT collected_date, ecosystem_layer, count(*) AS articles
FROM public.news_items GROUP BY collected_date, ecosystem_layer
ORDER BY collected_date, ecosystem_layer;

-- Include all portable payload columns; ignore generated/internal columns.
SELECT md5(coalesce(string_agg(md5((to_jsonb(n) - ARRAY['id','search_text','created_at','updated_at'])::text), '' ORDER BY external_id), '')) AS portable_payload_checksum
FROM public.news_items n;
