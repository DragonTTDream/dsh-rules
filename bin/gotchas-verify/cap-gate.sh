#!/usr/bin/env bash
# 验「热档无上限必然只增不减」这条经验的闸门（真跑，不是读过）
# 判据四条全对才 PASS：拦无 cap 行 / 放过合规 / 拦「续N」续写 / reviewed 超期出 WARN
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
GATE="$ROOT/bin/cap-check.sh"
[ -x "$GATE" ] || { echo "FAIL 闸门脚本不存在（$GATE）"; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf 'plain doc without any cap declaration\nline2\n' > "$T/no-cap.md"
printf 'cap: 4KB\nowner: tester\nreviewed: 2026-10-22\n---\nsmall doc with a cap line\n' > "$T/with-cap.md"
printf 'cap: 4KB\nowner: tester\nreviewed: 2026-10-22\n---\n结案条目 (9)\n续3：后来又改了一次\n' > "$T/cont.md"
printf 'cap: 4KB\nowner: tester\nreviewed: 2026-01-01\n---\nstale reviewed\n' > "$T/stale.md"
out_no=$(bash "$GATE" --require-cap "$T/no-cap.md" 2>&1);  rc_no=$?
out_yes=$(bash "$GATE" --require-cap "$T/with-cap.md" 2>&1); rc_yes=$?
out_cont=$(bash "$GATE" --require-cap "$T/cont.md" 2>&1);   rc_cont=$?
out_stale=$(bash "$GATE" --require-cap "$T/stale.md" 2>&1); rc_stale=$?
ok=1
[ "$rc_no" -ne 0 ]   || { echo "FAIL 无上限声明的文件被放行了"; ok=0; }
echo "$out_no"   | grep -q '无上限声明'      || { echo "FAIL 没报出「无上限声明」"; ok=0; }
[ "$rc_yes" -eq 0 ] || { echo "FAIL 合规文件被误杀：$out_yes"; ok=0; }
[ "$rc_cont" -ne 0 ]  || { echo "FAIL 续写标记被放行了"; ok=0; }
echo "$out_cont" | grep -q '续写标记'        || { echo "FAIL 没报出「续写标记」这条红"; ok=0; }
echo "$out_stale" | grep -q 'WARN'          || { echo "FAIL reviewed 超期没出 WARN"; ok=0; }
if [ "$ok" = 1 ]; then
  echo "CAP-GATE PASS（拦无声明 / 放过合规 / 拦续写 / 超期出 WARN）"; exit 0
fi
echo "CAP-GATE FAIL"; exit 1
