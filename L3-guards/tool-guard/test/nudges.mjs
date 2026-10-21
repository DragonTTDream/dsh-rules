// 两条软提示的契约（2026-10-21 第二次修正）：
//   委派提示：只数**读类命令**（cat/tail/grep/find/curl/ssh/openfiles…），编辑与构建不计。
//             起因：按"调用次数"计，6 分钟内两次命中全是 sed -i / 跑脚本 —— 纯误伤。
//   卡片提示：改**时间驱动**（距上次 todo_write 的分钟数），不再数 bash 次数。
import { apply } from "../index.js";

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };
const build = (cfg = {}) => {
  let guard = null;
  apply(
    { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
    { logFile: `/tmp/nudge2-${process.pid}-${Date.now()}.log`, requireSnapshot: false, hostServices: [], requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, ...cfg },
  );
  return guard;
};
const sh = (g, c) => g({ name: "bash", arguments: { command: c } });

console.log("=== 默认关 ===");
{
  // 四个提示键全部显式置 0：用例描述契约，不依赖某个部署的 DEFAULTS
  const g = build({ nudgeDelegationAfter: 0, nudgeTodoAfterBash: 0, nudgeDelegationAfterReads: 0, nudgeTodoAfterMinutes: 0 });
  let hits = 0;
  for (let i = 0; i < 25; i += 1) if (sh(g, "cat big.log") !== undefined) hits += 1;
  check(hits === 0, "未配置时零提示");
}

console.log("=== 委派提示：只数读类命令 ===");
{
  const g = build({ nudgeDelegationAfterReads: 3 });
  check(sh(g, "sed -i 's/a/b/' x.py") === undefined, "编辑命令不计");
  check(sh(g, "go build ./...") === undefined, "构建命令不计");
  check(sh(g, "git commit -m x") === undefined, "git 不计");
  check(sh(g, "cat a.log") === undefined, "第 1 条读类");
  check(sh(g, "tail -50 b.log") === undefined, "第 2 条读类");
  const r = sh(g, "grep -rn foo src/");
  check(typeof r === "string" && r.includes("子代理"), "第 3 条读类 ⇒ 弹出委派提示");
  check(sh(g, "cat c.log") === undefined, "提示后重置");
}

console.log("=== 编辑流连跑 20 次也不弹（这就是之前的 bug）===");
{
  const g = build({ nudgeDelegationAfterReads: 5 });
  let hits = 0;
  for (let i = 0; i < 20; i += 1) if (sh(g, `sed -i 's/a${i}/b/' calc.py && python3 calc.py`) !== undefined) hits += 1;
  check(hits === 0, "纯编辑/跑脚本流零误伤");
}

console.log("=== 委派提示：派过子代理就清零 ===");
{
  const g = build({ nudgeDelegationAfterReads: 3 });
  sh(g, "cat a"); sh(g, "cat b");
  g({ name: "subagent", arguments: { prompt: "x", run_in_background: false } });
  check(sh(g, "cat c") === undefined, "前台子代理后计数清零");
}

console.log("=== 卡片提示：时间驱动 ===");
{
  const g = build({ nudgeTodoAfterMinutes: 0 });
  check(sh(g, "cat a") === undefined, "分钟数为 0 ⇒ 关");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "NUDGES GREEN" : "NUDGES RED");
process.exit(fail === 0 ? 0 : 1);
