#!/usr/bin/env bash
# 折叠统计：按会话列出 prune / 折叠次数 / 耗时 / 失败。
# 用途：改压缩配置前后各跑一次，做同口径对比。
#   bash dsh/tools/compaction-stats.sh [会话目录] [--since HH:MM]
# 判据（改配置后）：
#   · summary 次数下降 = 折叠更少走模型
#   · compaction/end 带 error 的条数必须为 0（0 秒折叠是失败，不是便宜）
set -uo pipefail
DIR=${1:-$HOME/.dsh/sessions/--home-loong-~6587~6863-llamacpp-strata-engine--}
[ -d "$DIR" ] || { echo "会话目录不存在: $DIR" >&2; exit 1; }

python3 - "$DIR" <<'PY'
import glob, json, os, subprocess, sys
d = sys.argv[1]
hdr = "%-10s %-30s %5s %5s %7s %6s  %s" % ("会话", "模型", "prune", "start", "summary", "失败", "耗时(秒)")
print(hdr); print("-" * (len(hdr) + 10))
tot = {"prune": 0, "start": 0, "summary": 0, "fail": 0}
for f in sorted(glob.glob(os.path.join(d, "*/session.v4.jsonl.zstd")), key=os.path.getmtime, reverse=True):
    try:
        raw = subprocess.run(["zstd", "-d", "-c", f], capture_output=True, timeout=180).stdout.decode("utf-8", "ignore")
    except Exception:
        continue
    model = ""; prune = st = su = fail = 0; starts = []; durs = []
    for line in raw.splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type", "")
        if t == "request/header" and not model:
            cfg = (((e.get("data") or {}).get("header") or {}).get("config") or {})
            model = cfg.get("model") or ""
        elif t == "compaction/prune":
            prune += 1
        elif t == "compaction/start":
            st += 1; starts.append(e.get("time", 0))
        elif t == "compaction/summary":
            su += 1
        elif t == "compaction/end":
            data = e.get("data") or {}
            if data.get("error"):
                fail += 1
            if starts:
                durs.append(round((int(e.get("time", 0)) - int(starts.pop())) / 1000))
    if prune or st:
        sid = os.path.basename(os.path.dirname(f)).split("-")[1][:8]
        print("%-10s %-30s %5d %5d %7d %6d  %s" % (sid, model[:30], prune, st, su, fail, durs[:8]))
        tot["prune"] += prune; tot["start"] += st; tot["summary"] += su; tot["fail"] += fail
print("-" * (len(hdr) + 10))
print("合计: prune=%d  start=%d  summary=%d  失败=%d" % (tot["prune"], tot["start"], tot["summary"], tot["fail"]))
print()
print("判据：summary 下降 = 更少走模型；失败必须 = 0（0 秒折叠若带 error，是压了等于没压）")
PY
