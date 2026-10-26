#!/bin/bash
# Run against an existing PG container; only the newly created test DB is changed.
set -Eeuo pipefail
container=${1:-agent-build-postgres}
mode=${2:-full}
[[ "$container" =~ ^[a-zA-Z0-9._-]+$ && "$mode" =~ ^(full|red)$ ]]
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_db="navigate_calendar_test_$(date +%Y%m%d%H%M%S)_$$"
[[ "$test_db" =~ ^navigate_calendar_test_[a-z0-9_]+$ ]]
work_dir=$(mktemp -d /tmp/navigate-calendar-test.XXXXXX)
created=0
cleanup() {
  status=$?
  trap - EXIT
  if (( created )); then
    if ! docker exec "$container" sh -c 'exec dropdb --force -U "$POSTGRES_USER" "$1"' sh "$test_db"; then
      printf 'Could not remove owned temporary DB: %s\n' "$test_db" >&2
      status=1
    fi
  fi
  [[ "$work_dir" == /tmp/navigate-calendar-test.* && -d "$work_dir" && ! -L "$work_dir" ]] && rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
for file in database/001-news-items.sql database/002-news-access.sql database/tests/news-calendar-fixtures.sql database/tests/news-calendar-rollups.sql; do
  [[ -f "$repo/$file" ]]
done
docker exec "$container" sh -c 'exec createdb -U "$POSTGRES_USER" "$1"' sh "$test_db"
created=1
pg_file() {
  local sql_file=$1
  shift
  docker exec -i "$container" sh -c 'database=$1; shift; exec psql -X -U "$POSTGRES_USER" -d "$database" -v ON_ERROR_STOP=1 "$@"' sh "$test_db" "$@" < "$sql_file"
}
# Roles belong to the cluster: reuse them and never create/alter production roles.
cat > "$work_dir/roles.sql" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='navigate_readonly') OR
     NOT EXISTS (SELECT FROM pg_roles WHERE rolname='navigate_writer') THEN
    RAISE EXCEPTION 'Test requires existing navigate_readonly and navigate_writer roles';
  END IF;
END $$;
SQL
cat "$work_dir/roles.sql" "$repo/database/001-news-items.sql" "$repo/database/002-news-access.sql" "$repo/database/tests/news-calendar-fixtures.sql" > "$work_dir/setup.sql"
pg_file "$work_dir/setup.sql"
if [[ "$mode" == red ]]; then
  if pg_file "$repo/database/tests/news-calendar-rollups.sql" > "$work_dir/red.log" 2>&1; then
    echo 'Expected pre-migration integration failure but tests passed' >&2
    exit 1
  fi
  grep -Fq 'relation "public.news_calendar_buckets" does not exist' "$work_dir/red.log"
  echo 'RED verified: behavioral integration test rejects the missing calendar migration.'
  exit 0
fi
# A contending source writer must make the first migration fail atomically.
cat > "$work_dir/blocker.sql" <<'SQL'
SET application_name='navigate-calendar-locktest';
BEGIN;
LOCK TABLE public.news_items IN SHARE ROW EXCLUSIVE MODE;
SELECT pg_sleep(120);
COMMIT;
SQL
cat > "$work_dir/lock-ready.sql" <<'SQL'
SELECT CASE WHEN EXISTS (
  SELECT FROM pg_locks WHERE relation='public.news_items'::regclass
    AND mode='ShareRowExclusiveLock' AND granted
) THEN 'ready' ELSE 'waiting' END;
SQL
pg_file "$work_dir/blocker.sql" > "$work_dir/blocker.log" 2>&1 &
blocker_pid=$!
ready=0
for attempt in $(seq 1 10); do
  if [[ "$(pg_file "$work_dir/lock-ready.sql" -At)" == ready ]]; then ready=1; break; fi
  sleep 1
done
(( ready )) || { echo 'Lock-test session did not become ready' >&2; exit 1; }
if pg_file "$repo/database/005-news-calendar-rollups.sql" > "$work_dir/lock-failure.log" 2>&1; then
  echo 'Expected lock timeout but migration succeeded' >&2; exit 1
fi
grep -Fq 'canceling statement due to lock timeout' "$work_dir/lock-failure.log"
cat > "$work_dir/cancel-blocker.sql" <<'SQL'
SELECT pg_cancel_backend(pid) FROM pg_stat_activity
WHERE datname=current_database() AND application_name='navigate-calendar-locktest'
  AND pid<>pg_backend_pid();
DO $$ BEGIN
  IF to_regclass('public.news_calendar_buckets') IS NOT NULL OR
     to_regclass('public.news_calendar_sources') IS NOT NULL OR
     (SELECT count(*) FROM public.news_items)<>4 THEN
    RAISE EXCEPTION 'Lock failure left partial migration or changed articles';
  END IF;
END $$;
SQL
pg_file "$work_dir/cancel-blocker.sql"
wait "$blocker_pid" || true

cat > "$work_dir/before-rerun.sql" <<'SQL'
CREATE TEMP TABLE calendar_versions AS
SELECT 'bucket' AS kind, collected_date::text AS first_key, ecosystem_layer AS second_key,
       ctid::text AS tuple_id, xmin::text AS tuple_tx, article_count
FROM public.news_calendar_buckets
UNION ALL
SELECT 'source', ecosystem_layer, source_name, ctid::text, xmin::text, article_count
FROM public.news_calendar_sources;
SQL
cat > "$work_dir/after-rerun.sql" <<'SQL'
DO $$ BEGIN
  IF EXISTS (
    SELECT * FROM calendar_versions EXCEPT
    (SELECT 'bucket', collected_date::text, ecosystem_layer, ctid::text, xmin::text, article_count FROM public.news_calendar_buckets
     UNION ALL
     SELECT 'source', ecosystem_layer, source_name, ctid::text, xmin::text, article_count FROM public.news_calendar_sources)
  ) OR (SELECT count(*) FROM calendar_versions) <>
       (SELECT (SELECT count(*) FROM public.news_calendar_buckets)+(SELECT count(*) FROM public.news_calendar_sources)) THEN
    RAISE EXCEPTION 'Ready migration rerun rebuilt or changed the counters';
  END IF;
END $$;
SQL
cat "$repo/database/005-news-calendar-rollups.sql" "$work_dir/before-rerun.sql" "$repo/database/005-news-calendar-rollups.sql" "$work_dir/after-rerun.sql" "$repo/database/tests/news-calendar-rollups.sql" > "$work_dir/behavior.sql"
pg_file "$work_dir/behavior.sql"

# Two independent writer transactions contend for the same counters.
cat > "$work_dir/concurrent.sql" <<'SQL'
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='15s';
SET LOCAL ROLE navigate_writer;
INSERT INTO public.news_items
  (external_id,source_key,source_name,source_kind,title,url,ecosystem_layer,collected_date,published_date)
SELECT :'prefix' || n, 'parallel', 'Concurrent source', 'cn-media', 'Concurrent calendar test',
       'https://example.com/' || :'prefix' || n, 'foundation', '2026-10-26', '2026-10-26'
FROM generate_series(1,20) AS n;
SELECT pg_sleep(0.25);
COMMIT;
SQL
pg_file "$work_dir/concurrent.sql" -v prefix=calendar-parallel-a- > "$work_dir/parallel-a.log" 2>&1 &
first_pid=$!
pg_file "$work_dir/concurrent.sql" -v prefix=calendar-parallel-b- > "$work_dir/parallel-b.log" 2>&1 &
second_pid=$!
first_ok=0; second_ok=0
wait "$first_pid" && first_ok=1
wait "$second_pid" && second_ok=1
if (( !first_ok || !second_ok )); then cat "$work_dir/parallel-a.log" "$work_dir/parallel-b.log"; exit 1; fi
cat > "$work_dir/assert-concurrent.sql" <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM public.news_items) <> 44 OR
     (SELECT sum(article_count) FROM public.news_calendar_buckets) <> 44 OR
     (SELECT sum(article_count) FROM public.news_calendar_sources) <> 44 OR
     (SELECT article_count FROM public.news_calendar_sources WHERE ecosystem_layer='foundation' AND source_name='Concurrent source') <> 40 THEN
    RAISE EXCEPTION 'Concurrent writer increments lost or duplicated articles';
  END IF;
END $$;
SQL
pg_file "$work_dir/assert-concurrent.sql"
printf 'PASS: historical backfill, idempotence, changes, rollback, permissions, lock timeout and concurrent writers (%s).\n' "$test_db"
