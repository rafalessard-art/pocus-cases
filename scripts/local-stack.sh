#!/bin/bash
# Local development lifecycle for the portal (macOS, OrbStack or Docker Desktop, Supabase CLI).
#
#   bash scripts/local-stack.sh up       # start what is needed, leave anything already running alone
#   bash scripts/local-stack.sh status   # what is running (no keys printed)
#   bash scripts/local-stack.sh backup   # data-only dump of the LOCAL database to .local-backups/
#   bash scripts/local-stack.sh down     # stop this project's Supabase containers (data is kept)
#   bash scripts/local-stack.sh down --runtime   # …and quit OrbStack, only if nothing else runs in it
#
# Also: npm run local:up / local:status / local:backup / local:down.
# Never touches a hosted project, never deletes volumes or data, never stops other containers.
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/.."

# Node 22 (Homebrew), as everywhere else in this repo
if command -v brew >/dev/null && [ -d "$(brew --prefix node@22 2>/dev/null)/bin" ]; then
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi

docker_up() { docker info >/dev/null 2>&1; }
supabase_up() { supabase status >/dev/null 2>&1; }
project_id() { sed -n 's/^project_id *= *"\(.*\)"/\1/p' supabase/config.toml | head -1; }
other_containers() { # running containers that are not this project's Supabase stack
  local pid; pid=$(project_id)
  docker ps --format '{{.Names}}' 2>/dev/null | grep -v -- "_${pid}\$" | grep -v -- "-${pid}\$" | grep -vc '^$'
}

start_runtime() {
  docker_up && return 0
  if command -v orb >/dev/null || [ -d /Applications/OrbStack.app ]; then
    echo "starting OrbStack…"
    open -ga OrbStack 2>/dev/null || orb start >/dev/null 2>&1
  elif [ -d /Applications/Docker.app ]; then
    echo "starting Docker Desktop…"
    open -ga Docker
  else
    echo "No container runtime found. Install OrbStack (free): https://orbstack.dev"; return 1
  fi
  for _ in $(seq 1 60); do docker_up && return 0; sleep 2; done
  echo "The container runtime did not start within 2 minutes."; return 1
}

local_only() { # refuse anything that is not on this machine
  local u
  u=$(supabase status -o env 2>/dev/null | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')
  case "$u" in http://127.0.0.1:*|http://localhost:*|'') ;; *) echo "ABORT: API is not local ($u)"; exit 1;; esac
}

cmd=${1:-status}
case "$cmd" in
  up)
    start_runtime || exit 1
    if supabase_up; then echo "Supabase: already running"; else echo "starting the local Supabase stack (keeps existing data)…"; supabase start >/dev/null || exit 1; fi
    local_only
    bash "$SELF" status
    ;;
  status)
    echo "node $(node -v 2>/dev/null || echo 'missing') $(case "$(node -v 2>/dev/null)" in v22.*) echo '(ok)';; *) echo '(Node 22 required: brew install node@22)';; esac)"
    if docker_up; then echo "container runtime: running ($(docker info --format '{{.OperatingSystem}}' 2>/dev/null)) · other containers: $(other_containers)"; else echo "container runtime: stopped"; fi
    if supabase_up; then
      supabase status -o env 2>/dev/null | grep -E '^(API_URL|DB_URL|STUDIO_URL|MAILPIT_URL|INBUCKET_URL)=' | sed 's/^/supabase /; s/postgres:postgres@/…@/'
    else echo "supabase: stopped"; fi
    pgrep -f "supabase functions serve" >/dev/null && echo "edge functions: serving" || echo "edge functions: not serving"
    echo "git: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
    ;;
  backup)
    supabase_up || { echo "Supabase is not running (bash scripts/local-stack.sh up)"; exit 1; }
    local_only
    mkdir -p .local-backups
    f=".local-backups/local-$(date +%Y%m%d-%H%M%S).sql"
    supabase db dump --local --data-only -f "$f" >/dev/null 2>&1 && echo "local database saved to $f (restore: psql \"\$DB_URL\" -f $f after a reset)" || { echo "backup failed"; exit 1; }
    ;;
  down)
    pkill -f "supabase functions serve" 2>/dev/null
    if supabase_up; then echo "stopping this project's Supabase containers (data volumes are kept)…"; supabase stop >/dev/null; fi
    if [ "${2:-}" = "--runtime" ] && docker_up; then
      if [ "$(other_containers)" -eq 0 ]; then
        echo "quitting OrbStack (nothing else was running)…"; (orb stop >/dev/null 2>&1 || osascript -e 'quit app "OrbStack"' >/dev/null 2>&1)
      else
        echo "leaving the container runtime running: other containers are in use"
      fi
    fi
    bash "$SELF" status
    ;;
  *) echo "usage: $SELF up|status|backup|down [--runtime]"; exit 2;;
esac
