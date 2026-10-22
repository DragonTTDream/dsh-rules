#!/usr/bin/env bash
# 验证「编码契约」：UTF-16LE+BOM 的文件对按字节匹配的工具不可见，iconv 后可见
set -uo pipefail
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
python3 - "$d/config.ini" <<'PY'
import sys, pathlib
pathlib.Path(sys.argv[1]).write_bytes(b"\xff\xfe" + "TIME=07:30\n".encode("utf-16-le"))
PY
grep -q '^TIME=' "$d/config.ini" && { echo "断言失败：grep 竟然命中"; exit 1; }
v=$(iconv -f UTF-16 -t UTF-8 "$d/config.ini" | sed -n 's/^TIME=//p')
[ "$v" = "07:30" ] || { echo "断言失败：iconv 后值=[$v]"; exit 1; }
echo "OK 复现成功：原始 grep 不中，iconv 后得 07:30 ⇒ 先看字节再谈解析"
