#!/bin/sh
# Screenshots one element of a self-contained HTML page at 2x, everything around it hidden.
# The page's Content-Security-Policy is dropped from the temporary copy so the cropping script runs:
#   sh docs/diagrams/crop.sh <page.html> '<css selector>' <index> <out.png> [window width]
# Set CHROME to the Chrome binary when it is not at the macOS default path.
set -eu
page=$1; selector=$2; index=$3; out=$4; width=${5:-1100}
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
script="<script>
(() => {
  const el = document.querySelectorAll($(printf '%s' "$selector" | jq -Rs .))[$index];
  if (!el) return;
  for (let n = el; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  const width = el.getBoundingClientRect().width, pad = 24;
  let top = el;
  for (let n = el.parentElement; n !== document.body; n = n.parentElement) { const c = n.tagName === 'DETAILS' ? Object.assign(document.createElement('div'), { className: n.className }) : n.cloneNode(false); c.removeAttribute('style'); c.appendChild(top); top = c; }
  const symbols = [...document.querySelectorAll('svg')].filter((s) => s.querySelector('symbol'));
  document.body.replaceChildren(...symbols, top);
  for (let n = el.parentElement; n !== document.body; n = n.parentElement) Object.assign(n.style, { display: 'block', margin: '0', padding: '0' });
  document.body.style.margin = '0';
  document.body.style.padding = pad + 'px';
  Object.assign(el.style, { width: width + 'px', margin: '0' });
  const r = el.getBoundingClientRect();
  document.body.dataset.crop = [Math.floor(r.left - pad), Math.floor(r.top - pad), Math.ceil(r.width + 2 * pad), Math.ceil(r.height + 2 * pad)].join(',');
})();
</script>"
printf '%s' "$script" > "$work/inject.html"
python3 -I -c 'import re, sys; p, s = (open(f).read() for f in sys.argv[1:3]); p = re.sub(r"<meta http-equiv=\"Content-Security-Policy\"[^>]*>", "", p); i = p.rindex("</body>"); sys.stdout.write(p[:i] + s + p[i:])' "$page" "$work/inject.html" > "$work/page.html"
flags="--headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --disable-extensions --user-data-dir=$work/profile"
crop=$("$chrome" $flags --window-size="$width,1000" --dump-dom "file://$work/page.html" 2>/dev/null | sed -n 's/.*data-crop="\([0-9,]*\)".*/\1/p')
[ -n "$crop" ] || { echo "no element $index for $selector in $page" >&2; exit 1; }
IFS=, read -r x y w h <<EOF
$crop
EOF
"$chrome" $flags --force-device-scale-factor=2 --window-size="$width,$((y + h))" --screenshot="$work/full.png" "file://$work/page.html" 2>/dev/null
sips -s format png --cropOffset $((y * 2)) $((x * 2)) -c $((h * 2)) $((w * 2)) "$work/full.png" --out "$out" >/dev/null
echo "$out: ${w}x${h} CSS px at 2x"
