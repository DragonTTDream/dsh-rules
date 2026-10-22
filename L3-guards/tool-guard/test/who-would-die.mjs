// 「杀之前先知道是谁」：拒绝模式挑杀时，把会命中的进程连归属一起贴出来。
import { apply, patternOf, whoWouldDie } from "../index.js";
import { spawn } from "node:child_process";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 从命令里取模式 ===");
check(patternOf('kill $(pgrep -f "windowB2a.sh")') === "windowB2a.sh", "命令替换形态");
check(patternOf("pgrep -f windowB2a.sh | xargs kill") === "windowB2a.sh", "管道形态");
check(patternOf("pkill -f node") === "node", "pkill 形态");
check(patternOf("ls -la") === "", "不含模式 ⇒ 空");

console.log("=== whoWouldDie：真的能指出进程与归属 ===");
const tok = `probe-${process.pid}-${Date.now()}`;
// 起一个 cmdline 里含该 token 的进程（shell 里的注释会留在 argv 里）
// 注意：bash -c "sleep 60 # tok" 会被优化成直接 exec sleep，注释从 argv 消失 ⇒ 用两条命令保住 argv
const child = spawn("bash", ["-c", `sleep 60; : ${tok}`], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 300));
const rows = whoWouldDie(tok);
check(rows.length >= 1, "能列出命中进程", `rows=${rows.length}`);
check(rows.some((r) => r.includes(String(child.pid))), "包含目标 pid", rows.join(" | "));
check(rows.some((r) => r.includes("foreign")), "标注为 foreign");

// 用同一个受控进程验证 self 标注（"node" 这类宽模式会被 8 行上限截断，测不准）
const selfRows = whoWouldDie(tok, { selfPids: new Set([child.pid]) });
check(selfRows.some((r) => r.includes("self")), "自己的进程会被标成 self 而非隐藏", selfRows.join(" | "));

try { process.kill(child.pid, "SIGKILL"); } catch { /* 已退出 */ }

console.log("=== 守卫拒绝消息里带「会命中谁」 ===");
let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
  { logFile: `/tmp/who-${process.pid}.log`, requireSnapshot: false, repeatDenyAt: 0, hostServices: [] },
);
const msg = String(guard({ name: "bash", arguments: { command: `kill $(pgrep -f "self-recall-smoke-UNIQUE")` } }) || "");
check(msg.includes("会命中这些进程") || msg.includes("当前没有进程的 cmdline 含该模式"), "拒绝消息里有「会命中谁」段");
check(msg.includes("proc_kill") && msg.includes("proc_list"), "并指向 proc_kill / proc_list 的正确路径");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "WHO-WOULD-DIE GREEN" : "WHO-WOULD-DIE RED");
process.exit(fail === 0 ? 0 : 1);
