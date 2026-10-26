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
  scripts/content-api/server.ts scripts/content-api/server.test.mts scripts/content-api/start-production.ts
  scripts/content-api/calendar-snapshot.ts scripts/content-api/calendar-snapshot.test.mts
  src/news.js src/news-calendar.js tests/news-calendar.test.mjs
  database/005-news-calendar-rollups.sql database/verify-calendar-rollups.sql
  database/tests/news-calendar-fixtures.sql database/tests/news-calendar-rollups.sql
  ops/deploy.sh ops/publish-calendar.sh ops/test-calendar-postgres.sh
  ops/verify-calendar-performance.mjs ops/verify-calendar-snapshot.mjs ops/content-api.env.example
  ops/navigate-content-api.service ops/navigate.location.conf ops/CALENDAR-PERFORMANCE.md)
for file in "${files[@]}"; do
  [[ -f "$backup/new/$file" && ! -L "$backup/new/$file" && ! -L "$current/$file" ]]
  if [[ -e "$current/$file" ]]; then
    [[ -f "$current/$file" ]]
    mkdir -p "$backup/old/$(dirname "$file")"
    cp -a "$current/$file" "$backup/old/$file"
  fi
done
[[ -s "$backup/new/dist/index.html" && -d "$backup/new/dist/assets" && -f "$current/dist/index.html" && ! -L "$current/dist/index.html" ]]
[[ -d "$current/dist/assets" && ! -L "$current/dist" && ! -L "$current/dist/assets" ]]
unit=/etc/systemd/system/navigate-content-api.service
fragment=/etc/nginx/snippets/navigate.location.conf
[[ -f "$unit" && ! -L "$unit" && -f "$fragment" && ! -L "$fragment" ]]
cp -a "$unit" "$backup/previous-api.service"
cp -a "$fragment" "$backup/previous-navigate.location.conf"
cp -a "$current/dist/index.html" "$backup/previous-index.html"
systemd-analyze verify "$backup/new/ops/navigate-content-api.service"
install_index() {
  local next_index
  next_index=$(mktemp "$current/dist/.calendar-index.XXXXXX")
  install -m 0644 "$1" "$next_index"
  mv -T "$next_index" "$current/dist/index.html"
}
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
    cp -a "$backup/previous-api.service" "$unit"
    cp -a "$backup/previous-navigate.location.conf" "$fragment"
    install_index "$backup/previous-index.html"
    systemctl daemon-reload
    systemctl restart navigate-content-api.service
    nginx -t && systemctl reload nginx
    echo "Calendar publication failed; prior API, unit, route and index restored. Additive rollups and new immutable assets retained. Audit: $backup" >&2
  fi
  exit "$status"
}
trap restore EXIT
# No fixture SQL is executed here. Failures leave the previous API running.
timeout 360s docker exec -i agent-build-postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d navigate -v ON_ERROR_STOP=1' < "$backup/new/database/005-news-calendar-rollups.sql" > "$backup/migration.log" 2>&1
timeout 210s docker exec -i agent-build-postgres sh -c 'exec psql -X -A -t -U "$POSTGRES_USER" -d navigate -v ON_ERROR_STOP=1' < "$backup/new/database/verify-calendar-rollups.sql" > "$backup/oracle.log" 2>&1
expected_total=$(awk -F '|' '/^[0-9]+\|[0-9]+$/ {print $1}' "$backup/oracle.log")
[[ "$expected_total" =~ ^[1-9][0-9]*$ ]]
switched=1
for file in "${files[@]}"; do
  mkdir -p "$current/$(dirname "$file")"
  install -m 0644 "$backup/new/$file" "$current/$file"
done
install -m 0644 "$current/ops/navigate-content-api.service" "$unit"
systemctl daemon-reload
systemctl restart navigate-content-api.service
ready=0
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --max-time 2 -fsS -H 'Host: songuu.top' http://127.0.0.1:5196/healthz > /dev/null; then ready=1; break; fi
  sleep 1
done
(( ready )) || { echo 'API did not become healthy after restart' >&2; exit 1; }
cd "$current"
[[ -s /var/lib/navigate-content-api/calendar.json && ! -L /var/lib/navigate-content-api/calendar.json ]]
install -m 0644 "$current/ops/navigate.location.conf" "$fragment"
nginx -t
systemctl reload nginx
# Route reload is asynchronous. Validate the asset before exposing its new UI.
route_ready=0
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --max-time 2.5 -fsS --resolve songuu.top:443:127.0.0.1 \
    -D "$backup/snapshot.headers" -o "$backup/snapshot.json" -w '%{time_total}\n' \
    https://songuu.top/data/news-calendar.json > "$backup/snapshot-seconds.txt" 2> "$backup/snapshot-http.log" \
    && node ops/verify-calendar-snapshot.mjs "$backup/snapshot.json" "$backup/snapshot.headers" "$expected_total" "$(cat "$backup/snapshot-seconds.txt")" > "$backup/snapshot-verification.json" 2>> "$backup/snapshot-http.log"; then route_ready=1; break; fi
  sleep 1
done
(( route_ready )) || { echo 'Snapshot route did not become readable within 2.5s' >&2; exit 1; }
node ops/verify-live.mjs http://127.0.0.1:5196 > "$backup/api-verification.log" 2>&1
# New hashed assets are additive, so old pages and rollback keep their resources.
while IFS= read -r -d '' asset; do
  relative=${asset#"$backup/new/dist/"}
  [[ "$relative" =~ ^assets/[A-Za-z0-9._-]+\.(js|css)$ && ! -L "$asset" && ! -L "$current/dist/$relative" ]]
  install -m 0644 "$asset" "$current/dist/$relative"
done < <(find "$backup/new/dist/assets" -maxdepth 1 -type f -print0)
install_index "$backup/new/dist/index.html"
[[ "$(systemctl is-enabled navigate-news-collector.timer)" == enabled ]]
[[ "$(systemctl is-enabled news-collector-daily.timer || true)" == disabled ]]
cat "$backup/snapshot-verification.json" "$backup/snapshot-seconds.txt" "$backup/api-verification.log"
printf 'Calendar publication passed; current API active. Backup: %s\n' "$backup"
