// 后台子代理在单序列引擎上必须拒绝：它与主对话抢同一条推理序列。
// 实测：子代理 21:14:52–21:18:52 在跑，父会话同窗口又发了 3 步。
import { apply } from "../index.js";

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };

const build = (cfg = {}) => {
  let guard = null;
  apply(
    { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
    { logFile: `/tmp/bgsub-${process.pid}-${Date.now()}.log`, requireSnapshot: false, hostServices: [], requireTodoEveryMutations: 0, repeatDenyAt: 0, stallAt: 0, requireTodoEveryMinutes: 0, ...cfg },
  );
  return guard;
};

const g = build();

console.log("=== 必须拒：后台 / 缺省 ===");
{
  const r1 = g({ name: "subagent", arguments: { prompt: "x", run_in_background: true } });
  check(typeof r1 === "string" && r1.includes("单序列"), "显式 run_in_background: true ⇒ 拒");
  const r2 = g({ name: "subagent", arguments: { prompt: "x" } });
  check(typeof r2 === "string", "未给 run_in_background（默认 true）⇒ 拒");
  const r3 = g({ name: "subagent_fork", arguments: { prompt: "x", run_in_background: true } });
  check(typeof r3 === "string", "subagent_fork 同样拒");
  const r4 = g({ name: "subagent", arguments: JSON.stringify({ prompt: "x", run_in_background: true }) });
  check(typeof r4 === "string", "arguments 是 JSON 字符串时也能判");
}

console.log("=== 必须放：前台等 ===");
{
  const r = g({ name: "subagent", arguments: { prompt: "x", run_in_background: false } });
  check(r === undefined, "run_in_background: false ⇒ 放行");
}

console.log("=== 不误伤别的工具 ===");
{
  check(g({ name: "bash", arguments: { command: "echo hi" } }) === undefined, "普通 bash 不受影响");
  check(g({ name: "todo_write", arguments: { todos: [] } }) === undefined, "todo_write 不受影响");
  check(g({ name: "list_agents", arguments: {} }) === undefined, "list_agents 不受影响");
}

console.log("=== 关掉开关就恢复原样 ===");
{
  const g2 = build({ denyBackgroundSubagent: false });
  check(g2({ name: "subagent", arguments: { prompt: "x", run_in_background: true } }) === undefined, "denyBackgroundSubagent:false ⇒ 放行");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "BGSUB GREEN" : "BGSUB RED");
process.exit(fail === 0 ? 0 : 1);
