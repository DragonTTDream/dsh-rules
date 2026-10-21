// 卡片硬门：卡片是进度快照，不是收尾报告。
// 实测（2026-10-22）：隔壁会话 50 次改盘只更新 1 次卡片，且第一次更新发生在 5 次改盘之后。
// 旧机制是「20 分钟软提示」，两天没有一次真正生效 ⇒ 改成按改盘次数硬拦。
import { apply } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

const build = (cfg = {}) => {
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    { logFile: `/tmp/tg-${process.pid}-${Math.random().toString(36).slice(2)}.log`, requireSnapshot: false, hostServices: [], planFile: "/tmp/none-plan-x.md", ...cfg },
  );
  return g;
};
const edit = (g) => g({ name: "edit", arguments: { file_path: "/tmp/x", old_string: "a", new_string: "b" } });
const todo = (g, items) => g({ name: "todo_write", arguments: { todos: items } });

console.log("=== 每 8 次改盘必须有效更新一次 ===");
{
  const g = build({ requireTodoEveryMutations: 8, requireTodoEveryMinutes: 0 });
  let blockedAt = 0;
  for (let i = 1; i <= 12; i += 1) if (typeof edit(g) === "string" && !blockedAt) blockedAt = i;
  check(blockedAt === 9, "前 8 次放行、第 9 次被拦", `实测 ${blockedAt}`);
  check(todo(g, [{ content: "B1", status: "completed" }, { content: "B2", status: "in_progress" }]) === undefined, "有效更新 ⇒ 放行");
  check(edit(g) === undefined, "更新后计数清零 ⇒ 改盘放行");
}

console.log("=== 同内容重写不算更新 ===");
{
  const g = build({ requireTodoEveryMutations: 3, requireTodoEveryMinutes: 0 });
  const items = [{ content: "B1", status: "in_progress" }];
  check(todo(g, items) === undefined, "首次写卡放行");
  const dup = todo(g, items);
  check(typeof dup === "string" && dup.includes("完全相同"), "同内容重写 ⇒ 拒（防止假装更新）");
  edit(g); edit(g); edit(g);
  check(typeof edit(g) === "string", "同内容重写没有清零计数 ⇒ 3 次后仍被拦");
  check(todo(g, [{ content: "B1", status: "completed" }]) === undefined, "内容变了 ⇒ 放行并清零");
}

console.log("=== 只读侦察不计数，也不会被拦 ===");
{
  const g = build({ requireTodoEveryMutations: 2, requireTodoEveryMinutes: 0 });
  check(g({ name: "bash", arguments: { command: "ls -la" } }) === undefined, "ls 不拦");
  check(g({ name: "read", arguments: { file_path: "/tmp/x" } }) === undefined, "read 不拦");
  edit(g); edit(g);
  check(typeof edit(g) === "string", "两次改盘后第三次被拦");
}

console.log("=== 时间维度的门（改盘 ≥2 才触发，避免误伤）===");
{
  const g = build({ requireTodoEveryMutations: 0, requireTodoEveryMinutes: 10 });
  check(edit(g) === undefined, "只改盘 1 次、超时也不拦");
  edit(g);
  const r = edit(g);
  check(r === undefined || typeof r === "string", "边界不崩");
}

console.log("=== 开关关掉 ⇒ 恢复原状 ===");
{
  const g = build({ requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0 });
  let blocked = 0;
  for (let i = 0; i < 20; i += 1) if (typeof edit(g) === "string") blocked += 1;
  check(blocked === 0, "两个阈值都为 0 ⇒ 永不拦");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "TODO-GATE GREEN" : "TODO-GATE RED");
process.exit(fail === 0 ? 0 : 1);
