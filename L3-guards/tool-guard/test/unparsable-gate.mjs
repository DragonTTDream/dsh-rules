// 不可解析输入闸（2026-10-22 用户裁决，逐字）：
//   「解析不出动作的输入 = 缺口：既不是指令，也不是批准，也不是"继续"。」
// 覆盖：纯函数判据（标点/空白/表情 + mutating 组合）+ 接线（write / edit / bash 写盘目标 / 计划文件跳过）+ 会话隔离。
//
// 快照与回退（动手前做的快照，原样可粘贴）：
//   cp /home/loong/dsh-tool-guard/index.js.bak-20261022-pre-unparsable /home/loong/dsh-tool-guard/index.js
//   cp /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261022-pre-unparsable /home/loong/dsh-tool-guard/run-suite.sh
//   rm -f /home/loong/dsh-tool-guard/test/unparsable-gate.mjs
//   cp /home/loong/dsh-tool-guard/index.js.bak-20261022-pre-unparsable "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/index.js"
//   cp /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261022-pre-unparsable "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/run-suite.sh"
//   rm -f "/home/loong/文档/Harnessworks/dsh-rules/L3-guards/tool-guard/test/unparsable-gate.mjs"
//   复验：cd /home/loong/dsh-tool-guard && node --check index.js && bash run-suite.sh
// 关掉本闸的开关（只用于收窄误杀，不是"关掉就没事"）：cfg.denyUnparsableWrites = false
import { apply, unparsableGate, isParsableUserText, noteUserText } from "../index.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const check = (c, m, e = "") => {
  if (c) console.log(`  ✓ ${m}`);
  else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); }
};
const label = (s) => JSON.stringify(s);
const mkTemp = (prefix) => join(tmpdir(), `${prefix}${process.pid}-${Math.random().toString(36).slice(2)}`);
const mkGuard = (logFile, planFile) => {
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} },
      effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    {
      logFile,
      planFile,
      requireSnapshot: false,
      repeatDenyAt: 0,
      stallAt: 0,
      hostServices: [],
      requireTodoEveryMutations: 0,
      requireTodoEveryMinutes: 0,
      nudgeDelegationAfterReads: 0,
      nudgeTodoAfterMinutes: 0,
      staticCheckMode: "off",
    },
  );
  return g;
};

const root = mkTemp("unparsable-");
mkdirSync(root, { recursive: true });
const ws = join(root, "ws");
mkdirSync(join(ws, "plans"), { recursive: true });

// ── ① 纯函数：不可解析 + 改盘 ⇒ 拦 ────────────────────────────────────────
console.log("=== ① 不可解析 + mutating ⇒ 必拦 ===");
const UNPARSABLE = ["？", "。", "？。", "！", "   ", "\t", "　", "\n\t", "🙂", "✅", "……", "—"];
for (const t of UNPARSABLE) {
  check(typeof unparsableGate({ userText: t, mutating: true }) === "string", `${label(t)} + mutating ⇒ 拦`);
  check(isParsableUserText(t) === false, `${label(t)} ⇒ 判为不可解析`);
}

console.log("=== ② 同样的输入，只读调用（mutating:false）⇒ 放行 ===");
for (const t of UNPARSABLE) {
  check(unparsableGate({ userText: t, mutating: false }) === undefined, `${label(t)} + mutating:false ⇒ 放行`);
}

console.log("=== ③ 本轮取不到用户消息（空串）⇒ 放行（自动续跑轮不许被卡死）===");
check(unparsableGate({ userText: "", mutating: true }) === undefined, "空 userText + mutating ⇒ 放行");
check(unparsableGate({ mutating: true }) === undefined, "没传 userText + mutating ⇒ 放行");
check(unparsableGate({ userText: "？", mutating: true, enabled: false }) === undefined, "cfg.denyUnparsableWrites=false ⇒ 放行（开关生效）");

console.log("=== ④ 解析得出动作 ⇒ 放行（不许把合法输入当缺口）===");
for (const t of ["删除串的计划", "上限按你推荐的来", "AB 先执行", "删掉它", "把 3 个副本归档"]) {
  check(unparsableGate({ userText: t, mutating: true }) === undefined, `${label(t)} + mutating ⇒ 放行`);
}

console.log("=== ⑤ 拒绝理由：逐字回显 + 缺口三判 + 只准回问 + 授权形状 + session_facts ===");
const r5 = unparsableGate({ userText: "？", mutating: true });
check(typeof r5 === "string" && r5.includes("？"), "理由里逐字回显了本轮消息（含「？」）");
check(r5.includes(JSON.stringify("？")), "回显是 JSON.stringify 原文（标点不被改写）");
check(r5.includes("不是指令") && r5.includes("不是批准") && r5.includes("不是「继续」"), "写明：不是指令、不是批准、不是继续");
check(r5.includes("只准回问"), "写明：只准回问");
check(r5.includes("明确授权词") && r5.includes("指到具体动作"), "写明：授权需本轮明确授权词 + 能指到具体动作");
check(r5.includes("session_facts"), "写明：引用原话用 session_facts");

// ── ⑥ 接线：改盘类调用才过闸（write / edit / 有写盘目标的 bash），计划文件跳过 ──
console.log("=== ⑥ 接线（守卫）：write / edit / bash 写盘目标 / 计划文件跳过 ===");
const guard = mkGuard(join(root, "guard.log"), join(root, "plans-mirror", "{cwd}", "active.md"));
const W = { id: "session-W", session: { header: { cwd: ws } } };
noteUserText(W, "？");
const wPath = join(ws, "note.txt");
const gw = guard({ name: "write", arguments: { file_path: wPath, content: "x" }, agent: W });
check(typeof gw === "string" && gw.includes("？"), "write + 本轮「？」 ⇒ 拦，且逐字回显", String(gw || "").slice(0, 60));
const ge = guard({ name: "edit", arguments: { file_path: wPath, old_string: "x", new_string: "y" }, agent: W });
check(typeof ge === "string", "edit + 本轮「？」 ⇒ 拦");
const gb = guard({ name: "bash", arguments: { command: `echo hi > ${wPath}` }, agent: W });
check(typeof gb === "string" && gb.includes("？"), "bash 有写盘目标（重定向）+ 本轮「？」 ⇒ 拦", String(gb || "").slice(0, 60));
const gbr = guard({ name: "bash", arguments: { command: "ls -la; cat /etc/hostname" }, agent: W });
check(gbr === undefined, "bash 只读侦察（无写盘目标）⇒ 放行", String(gbr || "").slice(0, 60));
const gread = guard({ name: "read", arguments: { file_path: "/etc/hostname" }, agent: W });
check(gread === undefined, "read ⇒ 放行", String(gread || "").slice(0, 60));
const gplan = guard({ name: "write", arguments: { file_path: join(ws, "plans", "active.md"), content: "---\nstatus: draft\n---\n# 方案\n" }, agent: W });
check(gplan === undefined, "写计划文件本身照旧允许（plan 目标跳过本闸，否则 draft 死锁）", String(gplan || "").slice(0, 70));
const gplanb = guard({ name: "bash", arguments: { command: `echo x > ${join(ws, "plans", "active.md")}` }, agent: W });
check(gplanb === undefined, "bash 只写计划文件 ⇒ 放行（plan 目标跳过）", String(gplanb || "").slice(0, 70));

// ── ⑦ 会话隔离：状态按 agent，绝不做全局单例 ──────────────────────────────
console.log("=== ⑦ 会话隔离：A 的「？」拦 A，不拦 B，也不漏进无 agent 的调用 ===");
const guard2 = mkGuard(join(root, "guard2.log"), join(root, "plans-mirror", "{cwd}", "active.md"));
const A = { id: "session-A", session: { header: { cwd: join(ws, "a") } } };
const B = { id: "session-B", session: { header: { cwd: join(ws, "b") } } };
mkdirSync(join(ws, "a"), { recursive: true });
mkdirSync(join(ws, "b"), { recursive: true });
noteUserText(A, "？");
noteUserText(B, "删掉它");
const ga = guard2({ name: "write", arguments: { file_path: join(ws, "a", "f.txt"), content: "1" }, agent: A });
check(typeof ga === "string" && ga.includes("？"), "A 本轮「？」 ⇒ A 的写盘被拦", String(ga || "").slice(0, 60));
const gb2 = guard2({ name: "write", arguments: { file_path: join(ws, "b", "f.txt"), content: "1" }, agent: B });
check(gb2 === undefined, "B 本轮「删掉它」⇒ B 的写盘放行（A 的缺口不影响 B）", String(gb2 || "").slice(0, 70));
const gno = guard2({ name: "write", arguments: { file_path: join(ws, "a", "g.txt"), content: "2" } });
check(gno === undefined, "没有 agent 的调用 ⇒ 放行（A 的原话不漏进全局槽；续跑轮不被凭空拦）", String(gno || "").slice(0, 70));
const gauto = guard2({ name: "write", arguments: { file_path: join(ws, "a", "h.txt"), content: "3" }, agent: B });
check(gauto === undefined, "同一守卫实例里 B 继续写 ⇒ 仍放行（闸门不累积、不跨轮结转）", String(gauto || "").slice(0, 70));

rmSync(root, { recursive: true, force: true });

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "UNPARSABLE-GATE GREEN" : "UNPARSABLE-GATE RED");
process.exit(fail === 0 ? 0 : 1);
