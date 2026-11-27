#!/usr/bin/env bash
# Usage: [KSV_LANGUAGE=en|zh-TW] new-run.sh <run> <safe address> [--clone]
#
# Makes an isolated verification run under ${KSV_ROOT:-${TMPDIR:-/tmp}/kiss-sign-verify}/<run>/:
#   home/      a fresh KISS_SIGN_HOME, initialised with `init --safe <safe> --language ${KSV_LANGUAGE:-en}`, holding only the API keys
#   evidence/  proof artifacts; cleanup.sh keeps it (override with KSV_EVIDENCE)
#   clone/     with --clone: a plain git clone of origin's main with pnpm install, the only checkout `verify` accepts
# Without --clone, init runs from the checkout this script lives in.
# The keys are copied from ~/.kiss-sign/.env by name and never printed; nothing else under ~/.kiss-sign is read.
# The Safe must be another Safe, such as the `safe` of a testdata/safe-tx fixture, never the configured one.
# Prints the shell lines that point later commands at the run.
set -euo pipefail

run=${1:?usage: new-run.sh <run> <safe address> [--clone]}
safe=${2:?usage: new-run.sh <run> <safe address> [--clone]}
mode=${3:-}
[[ $run =~ ^[A-Za-z0-9._-]+$ ]] || { echo "run name: letters, digits, . _ - only" >&2; exit 2; }

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
root=${KSV_ROOT:-${TMPDIR:-/tmp}/kiss-sign-verify}
dir=$root/$run
evidence=${KSV_EVIDENCE:-$dir/evidence}
if [[ -e $dir/home ]]; then echo "$dir/home already exists; run cleanup.sh $run first or pick another run name" >&2; exit 1; fi
mkdir -p "$dir/home" "$evidence"
chmod 700 "$dir/home"

checkout=$repo
if [[ $mode == --clone ]]; then
  url=$(git -C "$repo" remote get-url origin)
  git clone --quiet "$url" "$dir/clone"
  (cd "$dir/clone" && pnpm install --silent >/dev/null)
  checkout=$dir/clone
elif [[ -n $mode ]]; then
  echo "unknown option $mode" >&2; exit 2
fi

(cd "$checkout" && KISS_SIGN_HOME="$dir/home" bin/kiss-sign init --safe "$safe" --language "${KSV_LANGUAGE:-en}" >/dev/null)
grep -E '^(ALCHEMY|ETHERSCAN|DRPC)_API_KEY=' "$HOME/.kiss-sign/.env" > "$dir/home/.env" || true
chmod 600 "$dir/home/.env"
(cd "$checkout" && KISS_SIGN_HOME="$dir/home" bin/kiss-sign key list) >&2

cat <<EOF
export KSV_RUN=$run
export KSV_DIR=$dir
export KSV_EVIDENCE=$evidence
export KSV_CHECKOUT=$checkout
export KISS_SIGN_HOME=$dir/home
EOF
