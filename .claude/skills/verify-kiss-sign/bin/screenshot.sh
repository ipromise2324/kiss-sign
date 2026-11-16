#!/usr/bin/env bash
# Usage: screenshot.sh <page.html> <out.png> [width] [height]
#
# Renders a local kiss-sign HTML page (report.generated.<language>.html, verify's page) in headless Chrome and writes a PNG.
# The pages load nothing from outside, so no network is needed. Height defaults to 4000 px; raise it for a long report.
# Chrome runs with a throwaway profile under the output's folder and is removed afterwards.
set -euo pipefail

page=${1:?usage: screenshot.sh <page.html> <out.png> [width] [height]}
out=${2:?usage: screenshot.sh <page.html> <out.png> [width] [height]}
width=${3:-1280}
height=${4:-4000}

chrome=${CHROME:-}
for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" "$(command -v chromium || true)" "$(command -v google-chrome || true)"; do
  [[ -z $chrome && -n $candidate && -x $candidate ]] && chrome=$candidate
done
[[ -n $chrome ]] || { echo "no Chrome or Chromium found; set CHROME=<binary>" >&2; exit 1; }

page=$(cd "$(dirname "$page")" && pwd)/$(basename "$page")
mkdir -p "$(dirname "$out")"
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
profile=$(mktemp -d "$(dirname "$out")/.chrome-profile.XXXXXX")
trap 'rm -rf "$profile"' EXIT

"$chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check --hide-scrollbars \
  --user-data-dir="$profile" --window-size="$width,$height" --screenshot="$out" "file://$page" >/dev/null 2>&1
[[ -s $out ]] || { echo "Chrome wrote no screenshot" >&2; exit 1; }
echo "$out"
