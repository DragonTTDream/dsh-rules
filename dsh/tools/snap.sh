#!/usr/bin/env bash
# 单槽快照：仅留最新一份，新快照替换旧快照。
# 用法: snap.sh <绝对路径> [更多绝对路径...]
set -euo pipefail
SLOT="$HOME/.dsh/snapshots/latest"
MAN="$SLOT/MANIFEST.tsv"
mkdir -p "$SLOT"; [ -f "$MAN" ] || printf 'time\ttarget\tsnapshot\n' > "$MAN"
mirror() { printf '%s' "${1#/}" | sed 's#/#__#g'; }
for t in "$@"; do
  case "$t" in /*) ;; *) echo "拒绝: 必须绝对路径: $t"; exit 2 ;; esac
  if [ -d "$t" ]; then
    dest="$SLOT/$(mirror "$t").tar.gz"
    tar -czf "$dest" -C "$(dirname "$t")" "$(basename "$t")"
    cmd="tar -xzf '$dest' -C '$(dirname "$t")'"
  elif [ -f "$t" ]; then
    dest="$SLOT/$(mirror "$t")"
    cp -a "$t" "$dest"
    cmd="cp -a '$dest' '$t'"
  else
    echo "拒绝: 目标不存在: $t"; exit 2
  fi
  tmp="$MAN.new"
  awk -F'\t' -v tgt="$t" 'NR==1 || $2!=tgt' "$MAN" > "$tmp"
  printf '%s\t%s\t%s\n' "$(date '+%F %T')" "$t" "$dest" >> "$tmp"
  mv "$tmp" "$MAN"
  echo "快照: $t -> $dest"
done
