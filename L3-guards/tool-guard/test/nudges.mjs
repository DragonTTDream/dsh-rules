// 两条软提示守卫的契约：
//   nudgeDelegationAfter —— 连续 N 次工具调用没派子代理 ⇒ 提示一次（deny 后立即重置，不形成墙）
//   nudgeTodoAfterBash   —— 连续 N 次 shell 调用没更新任务卡片 ⇒ 提示一次
// 两者都必须：默认关、只弹一次、不吞掉真正的拒绝。
import { apply } from "../index.js";

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };

const build = (cfg) => {
  let guard = null;
  apply(
    { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
    { logFile: `/tmp/nudge-${process.pid}-${Date.now()}.log`, requireSnapshot: false, hostServices: [], ...cfg },
  );
  return guard;
};
const bash = (g, cmd = "echo hi") => g({ name: "bash", arguments: { command: cmd } });

console.log("=== 默认关：连跑 20 次也不提示 ===");
{
  const g = build({});
  let hits = 0;
  for (let i = 0; i < 20; i += 1) if (bash(g) !== undefined) hits += 1;
  check(hits === 0, "未配置时零提示");
}

console.log("=== 委派提示：第 N 次弹出，之后重置 ===");
{
  const g = build({ nudgeDelegationAfter: 3 });
  check(bash(g) === undefined && bash(g) === undefined, "前 2 次放行");
  const r = bash(g);
  check(typeof r === "string" && r.includes("子代理"), "第 3 次弹出委派提示");
  check(bash(g) === undefined, "提示后立即重置，下一次放行（软提示不是墙）");
  bash(g);
  const r2 = bash(g);
  check(typeof r2 === "string", "再过 3 次又弹一次");
}

console.log("=== 委派提示：派过子代理就清零 ===");
{
  const g = build({ nudgeDelegationAfter: 3 });
  bash(g); bash(g);
  g({ name: "subagent", arguments: { prompt: "x" } });
  check(bash(g) === undefined, "派完子代理后计数清零，不会立刻弹");
}

console.log("=== 卡片提示：第 N 次 shell 弹出 ===");
{
  const g = build({ nudgeTodoAfterBash: 2 });
  check(bash(g) === undefined, "第 1 次放行");
  const r = bash(g);
  check(typeof r === "string" && r.includes("任务卡片"), "第 2 次弹出卡片提示");
  check(bash(g) === undefined, "提示后重置");
  g({ name: "todo_write", arguments: { todos: [] } });
  check(bash(g) === undefined, "更新过卡片后计数清零（第一次不弹）");
}

console.log("=== 不吞真拒绝 ===");
{
  const g = build({ nudgeDelegationAfter: 1, nudgeTodoAfterBash: 1 });
  const r = g({ name: "bash", arguments: { command: "rm -rf /" } });
  check(typeof r === "string" && (r.includes("Never") || r.includes("递归强删")), "never 级拒绝优先于软提示");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "NUDGES GREEN" : "NUDGES RED");
process.exit(fail === 0 ? 0 : 1);
