#!/bin/bash
# Usage: bash ops/recover-verified-copy.sh /opt/navigate/backups/OLD_RELEASE /opt/navigate/backups/NEW_RECOVERY
# Read-only database verification for an owned, already copied news database.
# This script never imports data, changes credentials, or switches web routes.
set -Eeuo pipefail
umask 077

fail() { printf 'Recovery refused: %s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'run as root on the existing deployment host.'
[[ $# == 2 ]] || fail 'provide the original backup directory and a new recovery directory.'

base=/opt/navigate
backup_root=$(realpath -e -- "$base/backups")
[[ "$backup_root" == /opt/navigate/backups && -d "$backup_root" && ! -L "$base/backups" ]] || fail 'backup root must be the real /opt/navigate/backups directory.'
backup=$(realpath -e -- "$1")
[[ "$backup" == "$backup_root/"* && -d "$backup" && ! -L "$1" ]] || fail 'original backup must be a real directory below /opt/navigate/backups.'
work_parent=$(realpath -e -- "$(dirname -- "$2")")
work_name=$(basename -- "$2")
[[ "$work_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$ ]] || fail 'invalid recovery directory name.'
work="$work_parent/$work_name"
[[ "$work" == "$backup_root/"* && ! -e "$work" && ! -L "$work" ]] || fail 'recovery directory must be new and below /opt/navigate/backups.'

shared="$base/shared"
owned="$shared/news-database-owned"
migrated="$shared/news-migrated"
[[ -d "$shared" && ! -L "$shared" && ! -e "$migrated" && ! -L "$migrated" ]] || fail 'shared directory must be real and news-migrated must not already exist.'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
verify_sql="$repo/database/verify-news.sql"
[[ -f "$verify_sql" && ! -L "$verify_sql" ]] || fail 'current database/verify-news.sql is missing or is a symlink.'

validate() {
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const kind = process.argv[2], path = process.argv[3];
const info = fs.lstatSync(path);
if (!(kind === 'directory' ? info.isDirectory() : info.isFile()) || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) {
  throw new Error(`${path}: expected a root-owned ${kind === 'directory' ? 'directory' : 'regular file'} without group/world write permission`);
}
if (kind === 'directory') process.exit(0);
const text = fs.readFileSync(path, 'utf8');
if (kind === 'ownership') {
  const proof = JSON.parse(text);
  if (proof.database !== 'navigate' || proof.container !== 'agent-build-postgres' ||
      typeof proof.createdAt !== 'string' || !Number.isFinite(Date.parse(proof.createdAt))) {
    throw new Error(`${path}: database ownership proof does not identify this migration`);
  }
} else {
  const lines = text.trimEnd().split(/\r?\n/);
  const header = lines[0]?.split('|');
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const integer = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
  if (lines.length < 3 || header.length !== 6 ||
      ![header[0], header[1], header[4], header[5]].every(integer) ||
      Number(header[0]) < 1 || header[0] !== header[1] ||
      !day.test(header[2]) || !day.test(header[3]) ||
      Number(header[4]) > Number(header[0]) || Number(header[5]) > Number(header[0]) ||
      !/^[0-9a-f]{32}$/.test(lines.at(-1))) {
    throw new Error(`${path}: incomplete count/date/body/translation/checksum report`);
  }
  let sum = 0;
  const dates = [];
  for (const line of lines.slice(1, -1)) {
    const fields = line.split('|');
    if (fields.length !== 3 || !day.test(fields[0]) ||
        !/^(foundation|model-platform|protocol|runtime|product-ui|data-memory|evaluation|security-governance)$/.test(fields[1]) ||
        !integer(fields[2]) || Number(fields[2]) < 1) {
      throw new Error(`${path}: incomplete or invalid calendar bucket`);
    }
    dates.push(fields[0]);
    sum += Number(fields[2]);
  }
  dates.sort();
  if (sum !== Number(header[0]) || dates[0] !== header[2] || dates.at(-1) !== header[3]) {
    throw new Error(`${path}: bucket totals/date range do not match the summary`);
  }
}
NODE
}

validate directory "$backup_root"
validate directory "$backup"
validate directory "$work_parent"
validate directory "$shared"
validate ownership "$owned"
# A read-only descriptor to the validated private marker provides the lock;
# never create a root-writable lock target in the world-writable /run/lock.
exec 9<"$owned"
flock -n 9 || fail 'another news recovery is running.'
validate report "$backup/source-verify.txt"
validate report "$backup/target-verify.txt"
cmp -- "$backup/source-verify.txt" "$backup/target-verify.txt" || fail "original complete reports differ: $backup"

old_unit=news-collector-daily.timer
old_enabled=$(systemctl is-enabled "$old_unit" 2>/dev/null || true)
old_active=$(systemctl show "$old_unit" -p ActiveState --value)
case "$old_enabled" in enabled|enabled-runtime|disabled) ;; *) fail "unsupported original timer enable state: $old_enabled" ;; esac
case "$old_active" in active|inactive|failed) ;; *) fail "unsupported original timer activity: $old_active" ;; esac
new_enabled=$(systemctl is-enabled navigate-news-collector.timer 2>/dev/null || true)
[[ "$new_enabled" != enabled && "$new_enabled" != enabled-runtime ]] || fail 'new collector timer must remain disabled during recovery.'
new_active=$(systemctl show navigate-news-collector.timer -p ActiveState --value)
[[ "$new_active" == inactive || "$new_active" == failed ]] || fail "new collector timer is $new_active; it must not be scheduled during recovery."

mkdir -m 700 -- "$work"
printf '%s\n' "$backup" > "$work/original-backup"
printf '%s\n' "$old_enabled" > "$work/old-timer-enabled"
printf '%s\n' "$old_active" > "$work/old-timer-active"
cp -- "$verify_sql" "$work/verify-news.sql"
sha256sum "$work/verify-news.sql" > "$work/verify-news.sha256"
temporary_marker=''
committed=0
timer_touched=0
restore() {
  status=$?
  trap - EXIT
  set +e
  if (( committed == 0 )); then
    if [[ -n "$temporary_marker" && -f "$temporary_marker" && "$migrated" -ef "$temporary_marker" ]]; then rm -f -- "$migrated"; fi
    if (( timer_touched == 1 )); then
      restore_failed=0
      case "$old_enabled" in
        enabled) systemctl enable "$old_unit" || restore_failed=1 ;;
        enabled-runtime) systemctl enable --runtime "$old_unit" || restore_failed=1 ;;
        disabled) systemctl disable "$old_unit" || restore_failed=1 ;;
      esac
      if [[ "$old_active" == active ]]; then systemctl start "$old_unit" || restore_failed=1; fi
      if (( restore_failed == 1 )); then printf 'CRITICAL: failed to restore previous timer state; inspect %s\n' "$work" >&2; status=1; fi
    fi
    printf 'Recovery failed; no database data or credentials changed. Audit: %s\n' "$work" >&2
    (( status != 0 )) || status=1
  fi
  [[ -z "$temporary_marker" ]] || rm -f -- "$temporary_marker"
  exit "$status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

timer_touched=1
systemctl disable --now "$old_unit"
[[ $(systemctl is-enabled "$old_unit" 2>/dev/null || true) == disabled ]] || fail 'old timer did not become disabled.'
[[ $(systemctl show "$old_unit" -p ActiveState --value) == inactive ]] || fail 'old timer did not stop.'
for unit in news-collector-daily.service navigate-news-collector.service; do
  state=$(systemctl show "$unit" -p ActiveState --value)
  [[ "$state" == inactive || "$state" == failed ]] || fail "$unit is $state; wait for the writer to finish before recovery."
done

# Every database session is read-only, has the same timestamp/date rendering,
# and reads one repeatable snapshot. No dumps, DDL, DML or .env reads occur.
verify_database() {
  database=$1
  [[ "$database" == agent_build || "$database" == navigate ]] || fail 'unexpected verification database.'
  {
    printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
    cat -- "$work/verify-news.sql"
    printf '\nCOMMIT;\n'
  } | docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on -c timezone=UTC -c datestyle=ISO,YMD' \
      agent-build-postgres sh -c 'exec psql -X -q -A -t -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1' sh "$database"
}
verify_database agent_build > "$work/source-verify.txt" 2> "$work/source-query.log"
verify_database navigate > "$work/target-verify.txt" 2> "$work/target-query.log"
validate report "$work/source-verify.txt"
validate report "$work/target-verify.txt"
cmp -- "$work/source-verify.txt" "$work/target-verify.txt" || fail "fresh source/target reports differ; do not reuse the copy. Audit: $work"

temporary_marker=$(mktemp "$shared/.news-migrated.recovery.XXXXXXXX")
printf 'Verified existing copy without reimport\nrecovered_at=%s\noriginal_backup=%s\nrecovery_audit=%s\nchecksum=%s\n' \
  "$(date -u +%FT%TZ)" "$backup" "$work" "$(tail -n 1 "$work/target-verify.txt")" > "$temporary_marker"
chmod 640 "$temporary_marker"
# Hard-link creation is atomic and refuses to overwrite an existing marker.
ln -T -- "$temporary_marker" "$migrated"
committed=1
printf 'Existing news copy reverified; news-migrated created. Old timer remains disabled. Audit: %s\n' "$work"
