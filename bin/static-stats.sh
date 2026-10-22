#!/usr/bin/env bash
# static-stats.sh —— 静态检查台账统计：拦得准不准，只看这一个输出
#
# 用法：
#   bin/static-stats.sh                    # 台账 = $GUARD_STATIC_LOG 或 ~/.dsh/static-check.jsonl
#   bin/static-stats.sh --ledger <路径>    # 指到临时台账（自测 / 跑批用）
#   bin/static-stats.sh --by-shell         # 额外按 bash / pwsh 分列
#
# 口径（每个数字都能追到台账行，不靠记忆）：
#   命中行  = 非 verdict 且非 exempt 的行（一行 = 一次静态检查命中）
#   E 档    = tier:"E" 的命中行（可拦档：只有它会拦）
#   W 档    = tier:"W" 的命中行（只记台账，永不拦）
#   fp/true = bin/static-verdict.sh 追加的 kind:"verdict" 行，按 ref 关联到命中行
#   precision = true / (true + fp)；未复核条数单列（precision 只反映已复核的部分）
#   豁免    = kind:"exempt" 行数（我豁免了多少次 + 各 rule 分布）
set -uo pipefail

LEDGER="${GUARD_STATIC_LOG:-$HOME/.dsh/static-check.jsonl}"
BY_SHELL=0
if [ "${1:-}" = "--ledger" ]; then LEDGER="${2:?--ledger 后面要给路径}"; shift 2; fi
[ "${1:-}" = "--by-shell" ] && BY_SHELL=1
[ -f "$LEDGER" ] || { echo "台账不存在: $LEDGER（守卫没命中过就没有台账）"; exit 0; }

awk -v byshell="$BY_SHELL" '
BEGIN { rules[1] = "syntax"; rules[2] = "command-missing"; rules[3] = "path-missing" }
{
  if (index($0, "\"kind\":\"verdict\"") > 0) {
    if (match($0, /"ref":[0-9]+/)) {
      ref = substr($0, RSTART + 6, RLENGTH - 6) + 0;
      if (index($0, "\"verdict\":\"fp\"") > 0) V[ref] = "fp";
      else if (index($0, "\"verdict\":\"true\"") > 0) V[ref] = "true";
    }
    next;
  }
  if (index($0, "\"kind\":\"exempt\"") > 0) {
    ex++;
    if (match($0, /"rule":"[^"]*"/)) exrule[substr($0, RSTART + 8, RLENGTH - 9)]++;
    next;
  }
  n++;
  # 注意：awk 程序体内只写 ASCII（本机 locale 是 C，gawk 对程序源里的非 ASCII 报「无效字符」）；
  #       中文只出现在字符串字面量与 printf 格式串里，那里是安全的。
  tier = (index($0, "\"tier\":\"E\"") > 0) ? "E" : "W";   # 历史行(2026-10-22 前)没有 tier => 记 W
  if (tier == "E") E++; else W++;
  for (i = 1; i <= 3; i++) {
    r = rules[i];
    hit = (index($0, "\"" r "\"") > 0);
    if (!hit) {   # 历史行只有中文文案没有 rule 字段 => 按文案归 rule
      if (r == "syntax" && index($0, "语法错") > 0) hit = 1;
      if (r == "path-missing" && index($0, "源路径不存在") > 0) hit = 1;
      if (r == "command-missing" && index($0, "命令不存在") > 0) hit = 1;
    }
    if (hit) { rc[r]++; if (tier == "E") rE[r]++; else rW[r]++ }
  }
  if (index($0, "\"shell\":\"pwsh\"") > 0) pwsh++; else bashc++;
  if (index($0, "\"decision\":\"deny\"") > 0) deny++;
  if (index($0, "\"exemptInvalid\"") > 0) exInvalid++;
}
END {
  k = 0; m = 0;
  for (ref in V) { if (ref + 0 <= n) { if (V[ref] == "true") k++; else if (V[ref] == "fp") m++ } }
  u = n - k - m; if (u < 0) u = 0;
  prec = (k + m > 0) ? sprintf("%.2f", k / (k + m)) : "n/a（一条没标，precision 无意义）";
  printf "命中 %d 次 / E 档 %d / W 档 %d / 已标 fp %d / true %d / precision = %d/(%d+%d) = %s（未标 %d 条）\n", n, E, W, m, k, k, k, m, prec, u;
  printf "实际拦下（decision=deny 的命中行）%d 条；豁免 %d 次；无效豁免（缺原因）命中行 %d 条\n", deny, ex, exInvalid;
  print "── 按 rule 分列（命中行含该 rule / E / W）──";
  for (i = 1; i <= 3; i++) { r = rules[i]; printf "  %-16s %3d  E=%-3d W=%-3d\n", r, rc[r] + 0, rE[r] + 0, rW[r] + 0; }
  if (ex > 0) { print "── 豁免按 rule ──"; for (r in exrule) printf "  %-16s %3d\n", r, exrule[r] + 0; }
  if (byshell == 1) { print "── 按 shell ──"; printf "  bash %d / pwsh %d\n", bashc + 0, pwsh + 0; }
  print "注：precision 只反映已复核部分；W 档永不进拦截，所以拦速与准度分开看。";
}' "$LEDGER"
