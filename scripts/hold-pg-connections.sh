#!/bin/sh
# Hold <count> idle Postgres connections for <seconds> to cause a controlled,
# demo-only threshold crossing of postgresql connection usage.
#
# Usage: scripts/hold-pg-connections.sh <count> <seconds> [--dry-run]
# Env:   PG_CONTAINER (required); PGUSER, PGDATABASE, PGPASSWORD are passed into
#        the container by name only, so their values never appear in argv or output.
#
# Every session sets application_name=hold-pg-connections. On exit, Ctrl-C or
# TERM the script kills its docker exec clients and also terminates those
# sessions server-side, because killing `docker exec` does not end psql in the
# container. Cleanup matches by application_name, so it also ends the sessions of
# a concurrent run of this script: run one at a time.
#
# The script refuses to go past max_connections - superuser_reserved_connections,
# so it never locks out superuser access.
#
# Planned crossing numbers (2026-11-07, not yet run live; needs blocker B2).
# Dash0 read-only check: current ~= 8 client backends (astronomy_db 5 + postgres 3),
# usage ratio ~= 0.08, so max_connections ~= 100 (default; reserved 3 -> limit 97).
# The demo check is avg over 15m with degraded > 0.8 and failed > 0.9:
#   count=75 -> (8 + 75) / 100 = 0.83  degraded
#   count=85 -> (8 + 85) / 100 = 0.93  failed
# The script's "current" counts only client backends (backend_type 'client
# backend'), excluding its own psql, so it matches the 8 above. Background workers
# (autovacuum, walwriter, ...) don't use max_connections slots. With current 8 the
# refusal limit is 97, so count=85 (8 + 85 = 93 < 97) is allowed.
# Hold for at least 1800 s so the 15-minute average crosses. Re-measure with
# --dry-run first (it prints max_connections and current) and record the live
# values in docs/DEMO.md.
set -u

APP=hold-pg-connections

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

is_pos_int() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 0 ]
}

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  die "usage: $0 <count> <seconds> [--dry-run]"
fi
count=$1
seconds=$2
dry_run=0
if [ $# -eq 3 ]; then
  [ "$3" = "--dry-run" ] || die "unknown option: $3"
  dry_run=1
fi
is_pos_int "$count" || die "count must be a positive integer"
is_pos_int "$seconds" || die "seconds must be a positive integer"
[ -n "${PG_CONTAINER:-}" ] || die "missing env: PG_CONTAINER"

query() {
  docker exec -e PGUSER -e PGDATABASE -e PGPASSWORD "$PG_CONTAINER" psql -tAc "$1"
}

# Capture psql's output before trimming it, so a psql failure is reported as one
# instead of being masked by the pipeline.
strip() { printf '%s' "$1" | tr -d '[:space:]'; }
raw=$(query "show max_connections") || die "could not read max_connections (psql failed)"
max=$(strip "$raw")
raw=$(query "show superuser_reserved_connections") || die "could not read superuser_reserved_connections (psql failed)"
reserved=$(strip "$raw")
raw=$(query "select count(*) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()") || die "could not read the current connection count (psql failed)"
current=$(strip "$raw")
is_pos_int "$max" || die "unexpected max_connections value"
case "$reserved" in '' | *[!0-9]*) die "unexpected superuser_reserved_connections value" ;; esac
case "$current" in '' | *[!0-9]*) die "unexpected connection count value" ;; esac

limit=$((max - reserved))
if [ $((current + count)) -ge "$limit" ]; then
  die "refusing: would exceed max_connections minus superuser_reserved_connections (current $current + $count >= $max - $reserved)"
fi

printf 'max_connections=%s current=%s holding=%s for %ss (usage about %s%%)\n' \
  "$max" "$current" "$count" "$seconds" "$(((current + count) * 100 / max))"

session_cmd="docker exec -e PGUSER -e PGDATABASE -e PGPASSWORD -e PGAPPNAME=$APP $PG_CONTAINER psql -c \"select pg_sleep($seconds)\""

if [ "$dry_run" -eq 1 ]; then
  i=0
  while [ "$i" -lt "$count" ]; do
    printf 'DRY-RUN %s\n' "$session_cmd"
    i=$((i + 1))
  done
  exit 0
fi

pids=""
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null
    query "select pg_terminate_backend(pid) from pg_stat_activity where application_name = '$APP' and pid <> pg_backend_pid()" >/dev/null 2>&1
    wait 2>/dev/null
    pids=""
  fi
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

i=0
while [ "$i" -lt "$count" ]; do
  docker exec -e PGUSER -e PGDATABASE -e PGPASSWORD -e PGAPPNAME="$APP" "$PG_CONTAINER" \
    psql -c "select pg_sleep($seconds)" >/dev/null 2>&1 &
  pids="$pids $!"
  i=$((i + 1))
done

# Check that the sessions are really open (bad credentials make every psql exit
# at once). Poll for up to 10 s.
active=0
tries=0
while [ "$tries" -lt 10 ]; do
  raw=$(query "select count(*) from pg_stat_activity where application_name = '$APP'") || raw=0
  active=$(strip "$raw")
  [ "$active" = "$count" ] && break
  tries=$((tries + 1))
  # Background sleep + wait, so an INT/TERM aimed at this script's PID runs the
  # trap at once instead of being held until a foreground sleep finishes.
  sleep 1 &
  wait $!
done
if [ "$active" != "$count" ]; then
  printf 'error: only %s of %s sessions are open (check PGUSER, PGDATABASE, PGPASSWORD)\n' "$active" "$count" >&2
  exit 1
fi
printf 'holding %s sessions\n' "$active"

wait
pids=""
printf 'released %s connections\n' "$count"
