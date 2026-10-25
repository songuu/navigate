-- Run with psql, as the table owner. Provision LOGIN roles and passwords
-- separately; these identifiers can also name the existing deployment roles.
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
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'reader_role', :'writer_role')
\gexec
GRANT USAGE ON SCHEMA public TO :"reader_role", :"writer_role";
GRANT SELECT ON public.news_items TO :"reader_role";
GRANT SELECT, INSERT, UPDATE ON public.news_items TO :"writer_role";
DROP POLICY IF EXISTS navigate_news_writer ON public.news_items;
CREATE POLICY navigate_news_writer ON public.news_items FOR ALL TO :"writer_role" USING (true) WITH CHECK (true);
COMMIT;

