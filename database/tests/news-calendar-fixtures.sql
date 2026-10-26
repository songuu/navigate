\set ON_ERROR_STOP on
-- Only the disposable integration database may receive these committed rows.
DO $$
BEGIN
  IF current_database() !~ '^navigate_calendar_test_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Calendar fixtures require a navigate_calendar_test_ database';
  END IF;
  IF EXISTS (SELECT 1 FROM public.news_items) THEN
    RAISE EXCEPTION 'Calendar fixtures require an empty news_items table';
  END IF;
END $$;

INSERT INTO public.news_items
  (external_id, source_key, source_name, source_kind, title, url, ecosystem_layer,
   collected_date, published_date)
VALUES
  ('calendar-test-a', 'shared', '共同来源', 'cn-media', '日历甲', 'https://example.com/calendar/a', 'foundation', '2026-10-24', '2026-10-23'),
  ('calendar-test-b', 'shared', '共同来源', 'cn-media', '日历乙', 'https://example.com/calendar/b', 'foundation', '2026-10-24', '2026-10-23'),
  ('calendar-test-c', 'shared', '共同来源', 'cn-media', '日历丙', 'https://example.com/calendar/c', 'model-platform', '2026-10-25', '2026-10-23'),
  ('calendar-test-d', 'special', 'O''Reilly 🙂', 'cn-media', '日历丁', 'https://example.com/calendar/d', 'model-platform', '2026-10-25', '2026-10-23');
