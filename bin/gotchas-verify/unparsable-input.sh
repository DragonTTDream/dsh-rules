#!/usr/bin/env bash
# 验证「不可解析的输入不是意图，更不是批准」这条经验的判据（真跑，不是读过）
# 判据三层：
#   1) 不可解析判定：去掉标点/空白/表情后无 CJK·字母·数字 ⇒ 不可解析
#   2) 授权判定：本轮消息须含明确授权词且能指到动作 ⇒ 才算批准；符号消息必须判"无授权"
#   3) 关键断言：不可解析 ⇒ 必然「不是指令 ∧ 不是批准 ∧ 不是继续」三者同时成立
set -uo pipefail
python3 - <<'PY'
import re, sys
CJK = re.compile(r'[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]')
WORD = re.compile(r'[A-Za-z0-9]')
# 标点/符号/空白/常见表情符号（判"剩余内容"时全部剥掉）
STRIP = re.compile(r'[\s\W_]+', re.UNICODE)
AUTH = re.compile(r'批准|同意|授权|准了|全做|按建议|按你推荐|照此做|去做|执行|删掉|删除|移动|改名|装|启用|重启|停服务|回退')
NEG = re.compile(r'不要|别|先不|先别|无需|暂时|不准|禁止|勿|不必|不急')  # 否定句优先（R-03 一票否决）
CONTINUE = re.compile(r'继续|接着|下一步|往下')
def strip_sym(s): return STRIP.sub('', s)
def unparsable(s):
    r = strip_sym(s)
    return not (CJK.search(r) or WORD.search(r))
def approval(s):
    """返回 (是否授权, 是否可解析)。不可解析 ⇒ 授权恒为假；命中否定标记 ⇒ 一票否决。"""
    if unparsable(s): return (False, False)
    if NEG.search(s): return (False, True)
    return (bool(AUTH.search(s)), True)
def is_continue(s):
    if unparsable(s): return False
    return bool(CONTINUE.search(s))

cases_unparsable = ["？", "。", "？。", "！", "…", "??", "  ", ".", "？!？", "*"]
cases_parsable   = ["上限按你推荐的来", "删除串的计划", "AB 先执行", "5 步全做", "重启宿主", "好的，按建议跑", "go", "1"]
cases_denied     = ["先别删", "不要重启", "先不要动它"]   # 否定句：不是授权
cases_noreq      = ["好的", "行", "嗯", "知道"]            # 认可，不含授权词
cases_req        = ["批准重启", "删掉它", "按你推荐的来全做"]

bad = []
for s in cases_unparsable:
    a, p = approval(s)
    if not unparsable(s): bad.append(f"应判不可解析却没判：{s!r}")
    if a: bad.append(f"不可解析被判成批准：{s!r}")
    if is_continue(s): bad.append(f"不可解析被判成继续：{s!r}")
for s in cases_parsable:
    if unparsable(s): bad.append(f"应可解析却判不可解析：{s!r}")
for s in cases_denied:
    a, _ = approval(s)
    if a: bad.append(f"否定句被判成批准：{s!r}")
for s in cases_noreq:
    a, _ = approval(s)
    if a: bad.append(f"认可词被判成授权：{s!r}")
for s in cases_req:
    a, _ = approval(s)
    if not a: bad.append(f"明确授权词没被判成授权：{s!r}")
# 核心不变式：凡判为批准者，必可解析
for s in cases_parsable + cases_noreq + cases_denied + cases_unparsable + cases_req:
    a, p = approval(s)
    if a and not p: bad.append(f"批准却不可解析（不变式被破）：{s!r}")
if bad:
    print("UNPARSABLE-LINT FAIL")
    for b in bad: print(" -", b)
    sys.exit(1)
print(f"UNPARSABLE-LINT PASS（{len(cases_unparsable)} 例判不可解析且三判据全否 / "
      f"{len(cases_parsable)} 例可解析 / {len(cases_denied)} 否定句不算授权 / "
      f"{len(cases_noreq)} 认可词不算授权 / 不变式：批准必可解析）")
PY
PYRC=$?
[ "$PYRC" = 0 ] && exit 0 || exit 1
