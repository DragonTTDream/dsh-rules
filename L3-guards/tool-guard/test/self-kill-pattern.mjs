// 「用命令行模式挑进程直接杀」的判据回归。
// 2026-10-22 实测事故：pgrep -f "windowB2a.sh" 系命令把本次调用链一起 SIGTERM（PID 3093118/3093675/3093682）。
// 旧规则只挡三种写法（pkill -f / 管道给 xargs kill / until 循环），命令替换与 while 循环全放行。
// 新判据：同一命令里「按模式挑进程」+「出现 kill」且无白名单 ⇒ 拒，与写法无关。
import { apply } from "../index.js";

let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
  { logFile: `/tmp/selfkill-${process.pid}.log` },
);

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };
const verdict = (cmd) => guard({ name: "bash", arguments: { command: cmd } });
const P = "windowB2a.sh";

console.log("=== 必须拒：模式挑杀的所有写法 ===");
const DENY = [
  ["pkill -f", `pkill -f ${P}`],
  ["管道给 xargs kill", `pgrep -f "${P}" | xargs kill`],
  ["xargs -r kill -TERM", `pgrep -f "${P}" | xargs -r kill -TERM`],
  ["命令替换 kill $(pgrep)", `kill $(pgrep -f "${P}")`],
  ["命令替换 + tr", `kill -TERM $(pgrep -f "${P}" | tr '\\n' ' ')`],
  ["while read 循环", `pgrep -f "${P}" | while read p; do kill "$p"; done`],
  ["ps|grep|awk|xargs kill", `ps -eo pid,cmd | grep ${P} | awk '{print $1}' | xargs -r kill`],
  ["分号串起来", `echo start; pgrep -f "${P}" | xargs kill`],
];
for (const [name, cmd] of DENY) check(typeof verdict(cmd) === "string", `${name} ⇒ 拒`);

console.log("=== 必须放行：只读与带白名单 ===");
const ALLOW = [
  ["只读查询（不杀）", `pgrep -f "${P}"`],
  ["只读 + 计数", `pgrep -f "${P}" | wc -l`],
  ["按可执行名挑（pidof）", `pidof python3`],
  ["带 comm 白名单过滤", `pgrep -f "${P}" | while read p; do [ "$(ps -o comm= -p $p)" = bash ] && kill "$p"; done`],
  ["直接杀已知 PID", `kill -TERM 4242`],
];
for (const [name, cmd] of ALLOW) check(verdict(cmd) === undefined, `${name} ⇒ 放行`);

console.log("=== 拒绝理由要给出合法替代 ===");
const r = String(verdict(`kill $(pgrep -f "${P}")`) || "");
check(r.includes("拆成两条命令"), "理由里写了「拆成两条命令」");
check(r.includes("pidof") || r.includes("comm="), "理由里给了合法形态");
check(r.includes("R-07"), "理由里指了规则编号");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "SELF-KILL GREEN" : "SELF-KILL RED");
process.exit(fail === 0 ? 0 : 1);
