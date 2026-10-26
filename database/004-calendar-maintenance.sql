-- Run with ON_ERROR_STOP against Navigate, outside a transaction, while its
-- collector is idle. Reuse the calendar indexes already defined in 001.
SET lock_timeout = '5s';
SET statement_timeout = '5min';
SET maintenance_work_mem = '32MB';

DO $$
BEGIN
  IF (SELECT count(*) <> 3 OR NOT bool_and(indisvalid AND indisready)
      FROM pg_index
      WHERE indrelid = 'public.news_items'::regclass
        AND indexrelid IN ('public.news_items_calendar_bucket_idx'::regclass,
                          'public.news_items_calendar_layer_source_idx'::regclass,
                          'public.news_items_calendar_source_idx'::regclass)) THEN
    RAISE EXCEPTION 'Navigate calendar indexes must be present, valid and ready';
  END IF;
END $$;

-- Ordinary online vacuum restores visibility information and removes dead
-- tuple versions. Disabling tail truncation avoids its exclusive table lock.
VACUUM (ANALYZE, TRUNCATE FALSE) public.news_items;
