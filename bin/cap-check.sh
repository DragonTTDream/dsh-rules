#!/usr/bin/env bash
# cap-check.sh —— 文档体积闸门（形态照 logrotate：先声明上限，到线触发轮转）
#
# 两种用法：
#   bin/cap-check.sh                      # 扫本仓（规则/技能/研究/事故），用内置默认上限，不要求写 cap 行
#   bin/cap-check.sh --require-cap DIR…   # 扫工作区：每个 *.md 必须在头部声明 `cap:` 行，没写就报红
#
# 内置默认上限（本机事实，数字在这里，不进 L0 规则正文）：
#   规则文件正文 30 行 · 技能正文 500 行 · 方案/README/MEMORY/交接 30 KB · 日志/流水/取证 50 KB
# 判据：
#   1) 没声明 cap 行 ⇒ FAIL（无闸门的文件必然只增不减）
#   2) 体积/行数超过声明值（或内置默认）⇒ FAIL，并提示「整段下沉 + 一行指针」
#   3) 快照/归档/数据目录 ⇒ SKIP（冷档是下沉目的地，不设闸门）
#   4) 活文档出现「续2/续3…」续写标记 ⇒ FAIL（结案条目禁续写，新结论开新条目）
#   5) --require-cap 模式下活文档缺 owner:/reviewed: ⇒ FAIL；reviewed 超 30 天 ⇒ WARN
#      （日志/流水/取证是冷档目的地，4/5 不追它们）
# 退出码：0 全绿，1 有 FAIL。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQ_CAP=0
PATHS=()
for a in "$@"; do
  case "$a" in
    --require-cap) REQ_CAP=1 ;;
    *) PATHS+=("$a") ;;
  esac
done
[ "${#PATHS[@]}" -gt 0 ] || PATHS=("$ROOT/L0-always-on" "$ROOT/L1-scoped" "$ROOT/L2-skills" "$ROOT/research" "$ROOT/incidents")

fail=0
say() { printf '%-5s %s\n' "$1" "$2"; }
bad() { say "FAIL" "$1"; fail=1; }

is_cold() { case "$1" in */快照/*|*/archive/*|*/快照/*|*/ROM下载/*|*.bak*|*.template.md|*_template*) return 0;; *) return 1;; esac; }

kb() { echo $(( $1 * 1024 )); }

FILES=()
for d in "${PATHS[@]}"; do
  if [ -f "$d" ]; then
    FILES+=("$d")
  elif [ -d "$d" ]; then
    while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$d" -name '*.md' -print0 2>/dev/null)
  else
    bad "路径不存在: $d"
  fi
done

for f in "${FILES[@]}"; do
    is_cold "$f" && continue
    bytes=$(wc -c < "$f")
    # 头部 8 行内找 cap 声明：cap: 30KB | cap: 500lines | cap: 30k
    declared=$(head -8 "$f" | awk -F': *' '/^cap:/{print $2; exit}')
    body_lines=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2' "$f" | grep -c .)

    case "$f" in
      */SKILL.md) lim_lines=500; lim_bytes=$(kb 50) ;;
      *L0-always-on*) lim_lines=30; lim_bytes=$(kb 50) ;;
      *) lim_lines=0; lim_bytes=$(kb 30) ;;
    esac
    case "$f" in *日志*|*流水*|*取证*) lim_bytes=$(kb 50);; esac

    if [ -n "$declared" ]; then
      case "$declared" in
        *lines) lim_lines=${declared%lines}; lim_lines=${lim_lines// /} ;;
        *[Kk][Bb]) lim_bytes=$(kb "${declared%[Kk][Bb]}");;
        *[Kk]) lim_bytes=$(kb "${declared%[Kk]}");;
        *) bad "$f: cap 写法不认识「$declared」（用 30KB 或 500lines）" ;;
      esac
      tag="声明 cap:$declared"
    elif [ "$REQ_CAP" -eq 1 ]; then
      bad "$f: 无上限声明（头部 8 行内没有 cap: 行）⇒ 无闸门的文件必然只增不减"
      continue
    else
      tag="内置默认"
    fi

    [ "$lim_lines" -gt 0 ] && [ "$body_lines" -gt "$lim_lines" ] \
      && bad "$f: 正文 $body_lines 行 > 上限 $lim_lines 行（$tag）⇒ 整段下沉到日志/，原处留一行指针"
    [ "$bytes" -gt "$lim_bytes" ] \
      && bad "$f: ${bytes} B > 上限 ${lim_bytes} B（$tag）⇒ 最老段落整段下沉到日志/，原处留一行指针"

    # 判据 4/5 只管「活文档」：日志/流水/取证是冷档目的地，历史里的续写标记与 owner 不追（2026-10-22 拍板）
    case "$f" in
      *日志*|*流水*|*取证*) hot=0 ;;
      *L0-always-on*|*L1-scoped*|*L2-skills*|*/SKILL.md*) hot=2 ;;   # 规则/技能正文里出现「续N」是在举例，不是违规
      *) hot=1 ;;
    esac
    if [ "$hot" -eq 1 ]; then
      cont=$(grep -cE '续[2-9]|（续[0-9]' "$f" 2>/dev/null || true)
      [ "${cont:-0}" -gt 0 ] && bad "$f: 出现续写标记 ${cont} 处 ⇒ 结案条目禁止续写，新结论开新条目"
      if [ "$REQ_CAP" -eq 1 ]; then
        case "$f" in
          */SKILL.md|*L0-always-on*|*L1-scoped*) ;;
          *)
            grep -q '^owner:' "$f" || bad "$f: 缺 owner:（这份文档谁负责）"
            rv=$(grep -oP '^reviewed:\s*\K\d{4}-\d{2}-\d{2}' "$f" | head -1)
            if [ -z "$rv" ]; then
              bad "$f: 缺 reviewed:（上次复查日期）"
            else
              age=$(( ( $(date -u +%s) - $(date -u -d "$rv" +%s) ) / 86400 ))
              [ "$age" -gt 30 ] && say "WARN" "$f: reviewed 已 ${age} 天（>30）⇒ 收尾时当场复查并更新日期"
            fi ;;
        esac
      fi
    fi

    [ "$bytes" -le "$lim_bytes" ] && say "OK" "$f: ${bytes} B / 正文 ${body_lines} 行（$tag）"
  done

[ "$fail" -eq 0 ] && say "OK" "cap 闸门全绿" || say "FAIL" "cap 闸门有红项"
exit "$fail"
