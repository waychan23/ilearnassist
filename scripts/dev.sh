#!/usr/bin/env bash
#
# Restart `pnpm dev` from a clean slate.
#
#   scripts/dev.sh            stop anything still running, then start
#   scripts/dev.sh --stop     stop, and start nothing
#   scripts/dev.sh --status   report what is running and which ports are held, change nothing
#
# Why this exists. `pnpm dev` is `pnpm --parallel` over two watch processes, and aborting it does
# not reliably take the children with it. What is left behind is worse than nothing:
#
#   * An orphaned `tsx watch` keeps the backend port, so the next `pnpm dev` cannot bind it —
#     and because it is still watching the tree, it reloads through whatever edits happen next.
#     That is not hypothetical: a half-applied change once reached a real database this way,
#     serving a UI that belonged to neither state.
#   * An orphaned vite does *not* fail loudly. It takes the next free port instead, so each
#     abandoned run leaves a server one port further along, still serving that day's code — and
#     the port you have open in a tab starts answering from a build nobody is editing any more.
#
# So this does two things, and the second matters as much as the first:
#
#   1. before starting, stop every dev server of *this repo* that is still running;
#   2. run `pnpm dev` in a **process group of its own**, and stop that group on the way out —
#      including when this script is killed, which is the case the old arrangement got wrong.
#      `pnpm --parallel` sits between the terminal and the two watchers, and signalling only
#      that middle process is exactly how the grandchildren end up reparented to init.
#
# Nothing is killed without checking whose it is: a process is a candidate only if its working
# directory is this repo's `apps/server` or `apps/web`. Another project's vite on the same port,
# or an editor's tooling, does not match and is left alone.
#
# bash 3.2 compatible on purpose — that is what macOS ships, and a script that only works with
# a homebrew bash is a script that fails on the machine it was written for.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# The web port vite starts on and climbs from when it is taken. The whole range is swept,
# because the climb is what makes the leftovers invisible.
WEB_PORTS="5173 5174 5175 5176 5177 5178 5179 5180 5181 5182"
FALLBACK_BACKEND_PORT=3720

# ---------------------------------------------------------------- ports

# The `server.port` from one config file, or empty. Deliberately a narrow awk rather than a YAML
# parser: this reads one integer out of a file whose shape is fixed, and a dependency for that
# would be the tail wagging the dog.
port_from() {
  awk '
    /^server:/ { in_server = 1; next }
    /^[^[:space:]]/ { in_server = 0 }
    in_server && /^[[:space:]]+port:/ { print $2; exit }
  ' "$1" 2>/dev/null || true
}

# The overlay wins, as it does for the server itself.
backend_port() {
  local port
  port=$(port_from "$ROOT/config/config.local.yaml")
  [ -n "$port" ] || port=$(port_from "$ROOT/config/config.yaml")
  printf '%s' "${port:-$FALLBACK_BACKEND_PORT}"
}

# ---------------------------------------------------------------- finding our processes

# The working directory of a process, or empty when it cannot be read.
cwd_of() {
  lsof -p "$1" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -1 || true
}

# Whether a working directory belongs to this repo's dev servers.
is_ours() {
  case "$1" in
    "$ROOT"/apps/server | "$ROOT"/apps/server/* | "$ROOT"/apps/web | "$ROOT"/apps/web/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The ports a process is listening on, space-separated, for the report.
ports_of() {
  lsof -nP -p "$1" 2>/dev/null |
    awk '/LISTEN/ { n = split($9, a, ":"); print a[n] }' |
    sort -u | tr '\n' ' ' | sed 's/ *$//' || true
}

# Every dev server of this repo still running, one pid per line.
#
# Two sources, because neither is enough alone. TCP listeners catch the servers holding a port —
# the harmful ones. A command match catches the `tsx watch` that would *spawn* one back on the
# next file change, which a port scan cannot see while its child is between restarts. Both are
# then filtered by working directory, which is what makes the broad command match safe.
candidates() {
  {
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $2 }'
    # The bracketed first letters are so this grep does not match its own command line, which
    # contains the pattern verbatim — an unmatchable-but-present pid is a confusing thing to
    # find in the report on the one run where it happens to survive long enough.
    ps -eo pid=,command= |
      grep -E '[t]sx/dist|[v]ite/bin/vite|[s]rc/index\.ts' |
      awk '{ print $1 }'
  } |
    sort -u |
    while read -r pid; do
      [ -n "$pid" ] || continue
      # Never this script, and never whatever launched it.
      case "$pid" in "$$" | "$PPID") continue ;; esac
      is_ours "$(cwd_of "$pid")" || continue
      printf '%s\n' "$pid"
    done
}

# The subset of the given pids that is still alive.
alive_of() {
  local pid
  for pid in $1; do
    kill -0 "$pid" 2>/dev/null && printf '%s\n' "$pid"
  done
  return 0
}

# ---------------------------------------------------------------- stopping

# TERM everything, then KILL whatever is still there after a grace period. SIGTERM first and not
# SIGKILL: the server has a shutdown path for an in-flight document parse, and a parse killed
# mid-write is a source left half-parsed.
stop_repo_dev_servers() {
  local quiet=${1:-}
  local pids remaining pid i

  pids=$(candidates)
  if [ -z "$pids" ]; then
    [ -n "$quiet" ] || echo "  nothing running"
    return 0
  fi

  if [ -z "$quiet" ]; then
    echo "  pid     ports          directory"
    for pid in $pids; do
      printf '  %-7s %-14s %s\n' "$pid" "$(ports_of "$pid")" "$(cwd_of "$pid")"
    done
  fi

  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  i=0
  while [ "$i" -lt 10 ]; do
    remaining=$(alive_of "$pids")
    [ -z "$remaining" ] && return 0
    sleep 0.5
    i=$((i + 1))
  done

  remaining=$(alive_of "$pids")
  if [ -n "$remaining" ]; then
    [ -n "$quiet" ] || echo "  not stopping; sending SIGKILL"
    for pid in $remaining; do
      kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 0.5
  fi
}

# Refuse to start on top of a port we cannot have. Returns non-zero when one of *our* ports is
# still held, which after a sweep means something is respawning and worth looking at by hand.
PORTS_TAKEN=0
check_ports() {
  local port holder holder_cwd
  PORTS_TAKEN=0

  for port in $(backend_port) $WEB_PORTS; do
    holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $2 }' | head -1)
    [ -n "$holder" ] || continue
    holder_cwd=$(cwd_of "$holder")

    if is_ours "$holder_cwd"; then
      printf '  %s is still held by %s (%s)\n' "$port" "$holder" "${holder_cwd#"$ROOT"/}"
      PORTS_TAKEN=1
    elif [ "$port" = "$(backend_port)" ]; then
      # The backend cannot climb to the next port, so anything else holding it is fatal.
      printf '  %s is held by another process (%s) — the API will not be able to bind\n' \
        "$port" "${holder_cwd:-pid $holder}"
      PORTS_TAKEN=1
    else
      printf '  %s is held by another project (%s) — vite will take the next free port\n' \
        "$port" "${holder_cwd:-pid $holder}"
    fi
  done

  [ "$PORTS_TAKEN" -eq 0 ]
}

# ---------------------------------------------------------------- running

DEV_PID=""

on_exit() {
  local status=$?
  # Cleared first: this runs from an EXIT trap, and `exit` below must not re-enter it.
  trap - INT TERM HUP EXIT

  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    # Negative pid: the whole process group, which is why the group was made in the first place.
    kill -TERM -"$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi

  # Whatever outlived the group. Quiet unless it actually finds something, so a plain Ctrl-C
  # does not print a cleaning report nobody asked for.
  leftovers=$(candidates)
  if [ -n "$leftovers" ]; then
    echo
    echo "→ stopping what outlived this run:"
    stop_repo_dev_servers
  fi

  exit "$status"
}

start() {
  local backend
  backend=$(backend_port)

  echo
  echo "→ pnpm dev"
  echo "  API  http://127.0.0.1:$backend"
  echo "  app  http://localhost:5173"
  echo "  Ctrl-C stops both; so does killing this script."
  echo

  # Job control, and the functional line of this file: it is what puts the job in a process group
  # of its own, so one signal reaches pnpm, both watchers and anything they spawned.
  set -m
  # `</dev/null` because a background job that reads the terminal is stopped by SIGTTIN, and vite
  # reads stdin for its interactive shortcuts. Losing those is the price of a stop that stops.
  pnpm dev </dev/null &
  DEV_PID=$!

  trap on_exit INT TERM HUP EXIT
  # `|| true` so `set -e` does not skip the trap's cleanup on a non-zero exit.
  wait "$DEV_PID" || true

  # Reached only if the dev run ended by itself; the trap then runs the cleanup.
}

# ---------------------------------------------------------------- entry

case "${1:-}" in
  -h | --help)
    sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --status)
    # What this script sees, without touching any of it — the mode to reach for when the sweep
    # reports something unexpected and you want to know why before anything is signalled.
    pids=$(candidates)
    if [ -z "$pids" ]; then
      echo "no dev server of this repo is running"
    else
      echo "pid     ports          directory"
      for pid in $pids; do
        printf '%-7s %-14s %s\n' "$pid" "$(ports_of "$pid")" "$(cwd_of "$pid")"
      done
    fi
    echo
    if check_ports; then
      echo "all ports free"
    fi
    ;;
  --stop)
    echo "→ stopping this repo's dev servers"
    stop_repo_dev_servers
    echo
    if check_ports; then
      echo "→ all ports free"
    else
      exit 1
    fi
    ;;
  "")
    echo "→ stopping this repo's dev servers"
    stop_repo_dev_servers
    echo
    if ! check_ports; then
      echo
      echo "refusing to start on top of that. Investigate the pids above — something is"
      echo "respawning them, or they belong to a shell that is still alive."
      exit 1
    fi
    start
    ;;
  *)
    echo "unknown argument: $1" >&2
    echo "usage: scripts/dev.sh [--stop]" >&2
    exit 2
    ;;
esac
