#!/usr/bin/env bash
# Usage: cleanup.sh <run>
#
# Tears down one run made by new-run.sh: kills that run's tmux server (socket ksv-<run>) and nothing else, checks that
# no file in the evidence folder holds an API key from the run's .env, then removes everything else in the run folder:
# home/ (keys, cards, verdicts), clone/, and scratch files such as tx JSON. The evidence folder is kept and listed.
set -euo pipefail

run=${1:?usage: cleanup.sh <run>}
[[ $run =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad run name" >&2; exit 2; }
root=${KSV_ROOT:-${TMPDIR:-/tmp}/kiss-sign-verify}
dir=$root/$run
evidence=${KSV_EVIDENCE:-$dir/evidence}

tmux -L "ksv-$run" kill-server 2>/dev/null || true

if [[ -f $dir/home/.env && -d $evidence ]]; then
  while IFS= read -r line; do
    value=${line#*=}
    [[ ${#value} -ge 8 ]] || continue
    if grep -rlF -- "$value" "$evidence" >/dev/null 2>&1; then
      echo "an API key appears in $evidence; remove it before sharing, cleanup stopped" >&2
      exit 1
    fi
  done < <(grep -E '^[A-Z_]+_API_KEY=' "$dir/home/.env" || true)
fi

if [[ -d $dir ]]; then
  # Compare real paths, so a trailing slash or a /tmp symlink cannot make the evidence folder look like scratch.
  dir=$(cd "$dir" && pwd -P)
  [[ -d $evidence ]] && evidence=$(cd "$evidence" && pwd -P)
  find "$dir" -mindepth 1 -maxdepth 1 ! -path "$evidence" -exec rm -rf {} +
  rmdir "$dir" 2>/dev/null || true
fi
echo "kept $evidence:"
ls -la "$evidence" 2>/dev/null || echo "  (no evidence folder)"
