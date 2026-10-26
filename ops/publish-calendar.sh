#!/bin/bash
# Narrow, reversible calendar update on the existing authorized Navigate host.
set -Eeuo pipefail
[[ "$EUID" == 0 ]]
archive=${1:?release archive required}
release=${2:?release name required}
[[ "$archive" == /tmp/navigate-calendar-*.tar.gz && -f "$archive" && ! -L "$archive" ]]
[[ "$release" =~ ^calendar-[a-zA-Z0-9._-]+$ ]]
if [[ "${3:-}" != --locked ]]; then
  [[ ! -L /run/navigate-news ]]
  install -d -o navigate -g navigate -m 0755 /run/navigate-news
  [[ ! -L /run/navigate-news/collector.lock ]]
  if [[ -e /run/navigate-news/collector.lock ]]; then
    [[ -f /run/navigate-news/collector.lock && "$(stat -c %h /run/navigate-news/collector.lock)" == 1 ]]
  fi
  touch /run/navigate-news/collector.lock
  chown navigate:navigate /run/navigate-news/collector.lock
  chmod 0640 /run/navigate-news/collector.lock
  exec /usr/bin/flock -w 5 /run/navigate-news/collector.lock /usr/bin/bash "$0" "$archive" "$release" --locked
fi
current=$(readlink -f /opt/navigate/current)
[[ "$current" == /opt/navigate/releases/* && -f "$current/scripts/content-api/postgres-repository.ts" ]]
for unit in navigate-news-collector.service navigate-horizon-validation.service; do
  state=$(systemctl show "$unit" -p ActiveState --value)
  [[ "$state" == inactive || "$state" == failed ]]
done
api_pid=$(systemctl show navigate-content-api.service -p MainPID --value)
[[ "$api_pid" =~ ^[1-9][0-9]*$ ]]
ss -lntpH 'sport = :5196' | grep -Fq "pid=${api_pid},"
backup="/opt/navigate/backups/$release"
[[ ! -e "$backup" ]]
mkdir -m 0700 "$backup"
mkdir "$backup/new" "$backup/old"
tar -xzf "$archive" -C "$backup/new"
files=(scripts/content-api/postgres-repository.ts scripts/content-api/postgres-repository.test.mts
  database/005-news-calendar-rollups.sql database/verify-calendar-rollups.sql
  database/tests/news-calendar-fixtures.sql database/tests/news-calendar-rollups.sql
  ops/deploy.sh ops/publish-calendar.sh ops/test-calendar-postgres.sh
  ops/verify-calendar-performance.mjs ops/CALENDAR-PERFORMANCE.md)
for file in "${files[@]}"; do
  [[ -f "$backup/new/$file" && ! -L "$backup/new/$file" && ! -L "$current/$file" ]]
  if [[ -e "$current/$file" ]]; then
    [[ -f "$current/$file" ]]
    mkdir -p "$backup/old/$(dirname "$file")"
    cp -a "$current/$file" "$backup/old/$file"
  fi
done
switched=0
restore() {
  status=$?
  trap - EXIT
  if (( status != 0 && switched )); then
    set +e
    for file in "${files[@]}"; do
      if [[ -f "$backup/old/$file" ]]; then cp -a "$backup/old/$file" "$current/$file";
      else rm -f -- "$current/$file"; fi
    done
    systemctl restart navigate-content-api.service
    echo "Calendar publication failed; previous API files restored. Additive rollups retained. Audit: $backup" >&2
  fi
  exit "$status"
}
trap restore EXIT
# No fixture SQL is executed here. Failures leave the previous API running.
timeout 360s docker exec -i agent-build-postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d navigate -v ON_ERROR_STOP=1' < "$backup/new/database/005-news-calendar-rollups.sql" > "$backup/migration.log" 2>&1
timeout 210s docker exec -i agent-build-postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d navigate -v ON_ERROR_STOP=1' < "$backup/new/database/verify-calendar-rollups.sql" > "$backup/oracle.log" 2>&1
switched=1
for file in "${files[@]}"; do
  mkdir -p "$current/$(dirname "$file")"
  install -m 0644 "$backup/new/$file" "$current/$file"
done
systemctl restart navigate-content-api.service
ready=0
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --max-time 2 -fsS -H 'Host: songuu.top' http://127.0.0.1:5196/healthz > /dev/null; then ready=1; break; fi
  sleep 1
done
(( ready )) || { echo 'API did not become healthy after restart' >&2; exit 1; }
cd "$current"
# Health checks do not query PG. These five simultaneous requests are the first calendar reads.
node ops/verify-calendar-performance.mjs http://127.0.0.1:5196 cold-start 2500 > "$backup/cold-start.json"
date +%s > "$backup/cold-start-at"
node ops/verify-live.mjs http://127.0.0.1:5196 > "$backup/api-verification.log" 2>&1
[[ "$(systemctl is-enabled navigate-news-collector.timer)" == enabled ]]
[[ "$(systemctl is-enabled news-collector-daily.timer || true)" == disabled ]]
cat "$backup/cold-start.json" "$backup/api-verification.log"
printf 'Calendar publication passed; current API active. Backup: %s\n' "$backup"
