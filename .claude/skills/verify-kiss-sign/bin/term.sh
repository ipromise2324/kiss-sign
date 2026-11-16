#!/usr/bin/env bash
# Usage:
#   term.sh start <run> <dir>           start a tmux server of its own (socket ksv-<run>) with one 220x60 window in <dir>
#                                       running a plain bash (prompt "ksv$ "), carrying KISS_SIGN_HOME from the caller
#   term.sh type <run> <text>           type <text> literally, then Enter, as a signer would
#   term.sh wait <run> <regex> [secs]   wait until the LAST non-empty line matches the extended regex (default 120 s),
#                                       so an earlier prompt in the scrollback never counts; exit 1 on timeout
#   term.sh idle <run> [secs]           wait until the command has finished and the shell prompt is back; print its exit code
#   term.sh screen <run>                print the visible screen and its scrollback
#   term.sh save <run> <file>           write the screen and scrollback to <file>
#   term.sh stop <run>                  kill this run's tmux server only
# kiss-sign's prompts refuse a pipe, so every answer to `card new`, `card seal`, `template approve` and `book add` goes
# through this real terminal.
set -euo pipefail

cmd=${1:?usage: term.sh start|type|wait|idle|screen|save|stop <run> ...}
run=${2:?run name missing}
tmux=(tmux -L "ksv-$run")

case $cmd in
  start)
    dir=${3:?usage: term.sh start <run> <dir>}
    : "${KISS_SIGN_HOME:?export KISS_SIGN_HOME first (new-run.sh prints it)}"
    # -f /dev/null keeps the user's tmux.conf out; bash without rc files keeps the screen to kiss-sign's own output.
    "${tmux[@]}" -f /dev/null new-session -d -s drive -x 220 -y 60 -c "$dir" -e "KISS_SIGN_HOME=$KISS_SIGN_HOME" \
      -e 'PS1=ksv$ ' -e BASH_SILENCE_DEPRECATION_WARNING=1 bash --noprofile --norc
    ;;
  type)
    "${tmux[@]}" send-keys -t drive -l -- "${3?text missing}"
    "${tmux[@]}" send-keys -t drive Enter
    ;;
  wait)
    pattern=${3:?regex missing}
    secs=${4:-120}
    for ((i = 0; i < secs * 2; i++)); do
      if "${tmux[@]}" capture-pane -p -J -t drive | grep -v '^[[:space:]]*$' | tail -1 | grep -Eq -- "$pattern"; then exit 0; fi
      sleep 0.5
    done
    echo "timeout after ${secs}s waiting for: $pattern" >&2
    "${tmux[@]}" capture-pane -p -J -t drive | grep -v '^$' | tail -20 >&2
    exit 1
    ;;
  idle)
    "$0" wait "$run" '^ksv\$ ?$' "${3:-120}"
    "${tmux[@]}" send-keys -t drive -l -- 'echo "exit=$?"'
    "${tmux[@]}" send-keys -t drive Enter
    "$0" wait "$run" '^ksv\$ ?$' 10
    "${tmux[@]}" capture-pane -p -J -t drive | grep -E '^exit=[0-9]+$' | tail -1
    ;;
  screen)
    "${tmux[@]}" capture-pane -p -J -S - -t drive | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
    ;;
  save)
    file=${3:?file missing}
    "${tmux[@]}" capture-pane -p -J -S - -t drive | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$file"
    ;;
  stop)
    "${tmux[@]}" kill-server 2>/dev/null || true
    ;;
  *)
    echo "unknown command $cmd" >&2; exit 2
    ;;
esac
