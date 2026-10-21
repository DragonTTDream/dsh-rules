// 同一脚本重复提交的守卫：重跑前必须先读上次的证据（R-14）。
// 实测依据：2026-10-22 arbitrate_run 超时后，模型在 40 分钟内重跑两次，
// 始终没打开那份一直在写的 data2/windowB.log。
import { apply } from "../index.js";

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };
const build = (cfg = {}) => {
  let guard = null;
  apply(
    { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
    { logFile: `/tmp/dup-${process.pid}-${Date.now()}.log`, requireSnapshot: false, hostServices: [], ...cfg },
  );
  return guard;
};
const run = (g, script) => g({ name: "arbitrate_run", arguments: { label: "t", script } });

console.log("=== 第一次放行，第二次拒 ===");
{
  const g = build();
  check(run(g, "bash windowB.sh") === undefined, "首次提交 ⇒ 放行");
  const r = run(g, "bash windowB.sh");
  check(typeof r === "string" && r.includes("已经提交过一次"), "同一脚本再提交 ⇒ 拒");
  check(typeof r === "string" && r.includes("R-14"), "拒绝理由指向 R-14");
  check(typeof r === "string" && (r.includes("job.log") || r.includes("logTail")), "并给出该读什么");
}

console.log("=== 改过就能跑（那是「我看过了」的凭证）===");
{
  const g = build();
  run(g, "bash windowB.sh");
  check(run(g, "bash windowB.sh  # 看过 job.log：卡在 G1") === undefined, "改了注释 ⇒ 放行");
  check(run(g, "bash windowB.sh") !== undefined, "原样再提交 ⇒ 仍拒");
}

console.log("=== label 变了但脚本没变 ⇒ 仍拒（防换壳重跑）===");
{
  const g = build();
  g({ name: "arbitrate_run", arguments: { label: "a", script: "sleep 1" } });
  const r = g({ name: "arbitrate_run", arguments: { label: "b", script: "sleep 1" } });
  check(typeof r === "string", "只换 label 不换脚本 ⇒ 拒");
}

console.log("=== 不误伤别的工具 ===");
{
  const g = build();
  check(g({ name: "bash", arguments: { command: "echo hi" } }) === undefined, "bash 重复执行不受影响");
  check(g({ name: "bash", arguments: { command: "echo hi" } }) === undefined, "bash 再跑一次也不受影响");
  check(g({ name: "arbitrate_status", arguments: {} }) === undefined, "arbitrate_status 不受影响");
}

console.log("=== 开关关掉就恢复原样 ===");
{
  const g = build({ denyDuplicateScript: false });
  run(g, "x");
  check(run(g, "x") === undefined, "denyDuplicateScript:false ⇒ 允许重复");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "DUP-SCRIPT GREEN" : "DUP-SCRIPT RED");
process.exit(fail === 0 ? 0 : 1);
