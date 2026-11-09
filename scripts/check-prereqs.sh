#!/usr/bin/env bash
# Report required and optional tools. Exits non-zero if a required one is missing.
set -uo pipefail
missing=0
check() { # name required(1/0) version-cmd...
  local name=$1 required=$2; shift 2
  if command -v "$name" >/dev/null; then printf "  ok       %-8s %s\n" "$name" "$("$@" 2>&1 | head -1)"
  elif [[ $required == 1 ]]; then printf "  MISSING  %s (required)\n" "$name"; missing=1
  else printf "  -        %s (optional, later phases)\n" "$name"; fi
}
check node 1 node --version
check pnpm 1 pnpm --version
check cargo 1 cargo --version
check python3 1 python3 --version
check ffmpeg 0 ffmpeg -version
check ollama 0 ollama --version
exit $missing
