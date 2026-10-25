#!/bin/bash
# Usage: bash ops/deploy.sh /tmp/navigate-RELEASE.tar.gz RELEASE
# Runs on the authorized existing host, with all prior data and routes retained.
set -Eeuo pipefail
archive=${1:?release archive required}
release=${2:?release name required}
[[ "$release" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'Invalid release name' >&2; exit 1; }
base=/opt/navigate
target="$base/releases/$release"
backup="$base/backups/$release"
mkdir -p "$base/releases" "$base/shared" "$backup"
chmod 700 "$base/backups" "$backup"
id navigate >/dev/null 2>&1 || useradd --system --home-dir /var/lib/navigate --shell /sbin/nologin navigate
mkdir -p "$target"
tar -xzf "$archive" -C "$target"
cd "$target"
npm ci --omit=dev --no-audit --no-fund > "$backup/npm-install.log" 2>&1
test -s dist/index.html
collector_state=$(systemctl show news-collector-daily.service -p ActiveState --value)
if [[ "$collector_state" != inactive && "$collector_state" != failed ]]; then
  echo 'Old collector is running; wait for completion before migration.' >&2; exit 1
fi
previous=$(readlink "$base/current" || true)
old_timer=$(systemctl is-enabled news-collector-daily.timer || true)
new_timer=$(systemctl is-enabled navigate-news-collector.timer 2>/dev/null || true)
cp -a /etc/nginx/conf.d/default.conf "$backup/nginx-default.conf"
cp -a /opt/songuu-home/index.html "$backup/previous-home.html"
guard=/opt/agent-build/host-guard/agent-build-stack-guard.sh
if [[ -f "$guard" ]]; then cp -a "$guard" "$backup/previous-host-guard.sh"; fi
if [[ -f /etc/nginx/snippets/navigate.location.conf ]]; then cp -a /etc/nginx/snippets/navigate.location.conf "$backup/navigate.location.conf"; fi
for unit in navigate-content-api.service navigate-news-collector.service navigate-news-collector.timer; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then cp -a "/etc/systemd/system/$unit" "$backup/$unit"; fi
done
printf '%s\n' "$previous" > "$backup/previous-release"
printf '%s\n' "$old_timer" > "$backup/old-timer-state"
switched=0
rollback() {
  status=$?
  if (( status != 0 )); then
    set +e
    echo "Deployment failed; restoring previous route and collector owner. Backup: $backup" >&2
    cp -a "$backup/nginx-default.conf" /etc/nginx/conf.d/default.conf
    if [[ -f "$backup/previous-host-guard.sh" ]]; then cp -a "$backup/previous-host-guard.sh" "$guard"; fi
    if [[ -f "$backup/navigate.location.conf" ]]; then cp -a "$backup/navigate.location.conf" /etc/nginx/snippets/navigate.location.conf; fi
    if [[ -n "$previous" ]]; then ln -sfn "$previous" "$base/current"; fi
    nginx -t && systemctl reload nginx || true
    systemctl stop navigate-news-collector.timer navigate-news-collector.service navigate-content-api.service
    for unit in navigate-content-api.service navigate-news-collector.service navigate-news-collector.timer; do
      if [[ -f "$backup/$unit" ]]; then cp -a "$backup/$unit" "/etc/systemd/system/$unit"; fi
    done
    systemctl daemon-reload
    if [[ -n "$previous" ]]; then systemctl restart navigate-content-api.service; fi
    if [[ "$new_timer" == enabled ]]; then systemctl enable --now navigate-news-collector.timer; fi
    if [[ "$old_timer" == enabled ]]; then systemctl enable --now news-collector-daily.timer; fi
  fi
  exit "$status"
}
trap rollback EXIT
systemctl disable --now news-collector-daily.timer
collector_state=$(systemctl show news-collector-daily.service -p ActiveState --value)
[[ "$collector_state" == inactive || "$collector_state" == failed ]]
if [[ ! -f "$base/shared/news-migrated" ]]; then
  node ops/provision-news.mjs
  test -f "$base/shared/news-database-owned"
  docker exec agent-build-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t public.news_items --no-owner --no-acl' > "$backup/news-items-full.sql"
  docker exec agent-build-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t public.news_items --data-only --no-owner --no-acl' > "$backup/news-items-data.sql"
  docker exec -i agent-build-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d navigate -v ON_ERROR_STOP=1' < database/001-news-items.sql > "$backup/schema.log"
  # The target belongs only to this migration until its success marker exists.
  # Preserve an interrupted target before replacing it; restore is one transaction.
  docker exec agent-build-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d navigate -t public.news_items --no-owner --no-acl' > "$backup/target-before-import.sql"
  { printf 'TRUNCATE public.news_items;\n'; cat "$backup/news-items-data.sql"; } | docker exec -i agent-build-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d navigate --single-transaction -v ON_ERROR_STOP=1' > "$backup/import.log"
  docker exec -i agent-build-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d navigate -v ON_ERROR_STOP=1' < database/002-news-access.sql > "$backup/access.log"
  docker exec -i agent-build-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1' < database/verify-news.sql > "$backup/source-verify.txt"
  docker exec -i agent-build-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d navigate -At -v ON_ERROR_STOP=1' < database/verify-news.sql > "$backup/target-verify.txt"
  cmp "$backup/source-verify.txt" "$backup/target-verify.txt"
  echo 'Source/destination news row counts, date buckets and payload checksums match.'
fi
chown -R root:navigate "$base/shared"
chmod 750 "$base/shared"
chmod 640 "$base/shared/"*.env
ln -sfn "$target" "$base/current"
cp ops/navigate-content-api.service ops/navigate-news-collector.service ops/navigate-news-collector.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable navigate-content-api.service
systemctl restart navigate-content-api.service
for attempt in $(seq 1 15); do
  if curl -fsS -H 'Host: songuu.top' http://127.0.0.1:5190/healthz > /dev/null; then break; fi
  sleep 1
done
curl -fsS -H 'Host: songuu.top' 'http://127.0.0.1:5190/api/content/v1/news?fields=external_id,title,collected_date&limit=1' > "$backup/api-sample.json"
curl -fsS -H 'Host: songuu.top' 'http://127.0.0.1:5190/api/content/v1/news/calendar' > "$backup/api-calendar.json"
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1]));if(!p.items?.length)throw new Error("No migrated article readable");console.log("Migrated article read verified")' "$backup/api-sample.json"
cp ops/navigate.location.conf /etc/nginx/snippets/navigate.location.conf
python3 - "$backup/nginx-default.conf" <<'PY'
import sys,re
from pathlib import Path
path=Path('/etc/nginx/conf.d/default.conf')
text=path.read_text()
if 'include /etc/nginx/snippets/navigate.location.conf;' not in text:
    pattern=r'    location = / \{[^{}]*\n    \}'
    updated,count=re.subn(pattern,'    include /etc/nginx/snippets/navigate.location.conf;',text,count=1)
    if count!=1: raise RuntimeError('Expected exactly one original homepage location')
    path.write_text(updated)
PY
nginx -t
systemctl reload nginx
# The old host guard must no longer attempt to restart the retired PM2 news
# scheduler. CLI collection now has a single systemd/flock owner.
if [[ -f "$guard" ]]; then
  python3 - "$guard" <<'PY'
import sys
from pathlib import Path
path=Path(sys.argv[1])
text=path.read_text()
path.write_text(text.replace('  news-collector\n','  # News collection is owned by navigate-news-collector.timer.\n'))
PY
fi
curl -fsS --resolve songuu.top:443:127.0.0.1 https://songuu.top/ | grep -q 'Songuu'
curl -fsS --resolve songuu.top:443:127.0.0.1 'https://songuu.top/api/content/v1/news?fields=external_id,title,collected_date&limit=1' > /dev/null
date -Is > "$base/shared/news-migrated"
echo 'Run systemctl start navigate-news-collector.service and verify the report before enabling navigate-news-collector.timer.'
echo "Navigation release $release active; backup $backup"
