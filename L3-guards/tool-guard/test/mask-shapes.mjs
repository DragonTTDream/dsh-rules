import { missingCommands, missingSourcePaths, staticCheckIssues } from '/home/loong/dsh-tool-guard/index.js';

const cases = [
  ['多行内联 python（旧版误杀 6 次）', `python3 -c "
import json, sys
try:
    pass
except Exception as l:
    print(l)
"`],
  ['heredoc 正文（旧版把 EOF 当命令）', `python3 - <<'PY'
import json
for line in open('/tmp/x'):
    print(line)
PY`],
  ['单行内联 python', `python3 -c "import sys; print(sys.argv)"`],
  ['正常多命令', `cd /tmp && ls -la | grep foo`],
  ['远端命令写在引号里', `ssh host "cd /opt && ./run.sh --x"`],
  ['真拼错（必须仍被拒）', `gti status`],
  ['真拼错 2（必须仍被拒）', `cd /tmp && sl -la`],
];

let bad = 0;
for (const [name, script] of cases) {
  const mc = missingCommands(script);
  console.log((mc.length ? 'HIT ' : 'ok  ') + name.padEnd(30) + JSON.stringify(mc));
}

// 断言：前 5 条不许命中，后 2 条必须命中
const expectClean = cases.slice(0, 5);
const expectHit = cases.slice(5);
for (const [name, s] of expectClean) if (missingCommands(s).length) { console.log('FAIL 误杀:', name); bad++; }
for (const [name, s] of expectHit) if (!missingCommands(s).length) { console.log('FAIL 漏判:', name); bad++; }

// 源路径检查不受影响
const sp = missingSourcePaths('scp /tmp/definitely-missing-dir-xyz/a.exe host:/tmp/');
console.log('源路径（父目录不存在 ⇒ 不判）:', JSON.stringify(sp));
console.log(bad === 0 ? 'MASK GREEN' : `MASK RED (${bad})`);
