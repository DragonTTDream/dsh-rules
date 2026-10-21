// 提问闸：用户还在分析时，不许把方案收敛成选择题逼他拍板。
// 实测反例（2026-10-22）：用户正在权衡三条路，模型直接问「折叠提速走哪条？」。
import { apply, askGate } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 用户明确在按住（HOLD）⇒ 拒 ===");
for (const t of ["先别动，我在分析", "还没定稿，我看看", "我正在读这几份材料", "不急，想想再说", "等我说的"]) {
  check(typeof askGate({ userText: t, question: "走哪条？" }) === "string", `「${t}」⇒ 拒提问`);
}

console.log("=== 把决定权推回去（PUSHBACK）⇒ 拒 ===");
check(typeof askGate({ userText: "把这几条路的取舍写清楚", question: "走哪条？" }) === "string", "问「走哪条」而用户没让你定 ⇒ 拒");
check(typeof askGate({ userText: "改这个函数", question: "选哪个方案", options: "A 快 / B 稳" }) === "string", "问「选哪个方案」⇒ 拒");

console.log("=== 用户让你定 / 真需要授权 ⇒ 放行 ===");
check(askGate({ userText: "你定，选一个", question: "走哪条？" }) === undefined, "用户说「你定」⇒ 放行");
check(askGate({ userText: "改这个函数", question: "这个接口要连哪个库才符合你们规范？" }) === undefined, "正常信息缺口 ⇒ 放行");
check(askGate({ userText: "先别动，我在分析", question: "x", enabled: false }) === undefined, "开关关掉 ⇒ 不拦");

console.log("=== 接入守卫：ask_user_question 被拦 ===");
let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
  { logFile: `/tmp/ask-${process.pid}.log`, requireSnapshot: false, hostServices: [] },
);
const { noteUserText } = await import("../index.js");
const A = { id: "session-A" };
noteUserText(A, "先别动，我在分析这几条路");
const r = guard({
  name: "ask_user_question",
  agent: A,
  arguments: { questions: [{ id: "route", question: "折叠提速走哪条？", options: [{ label: "A 快" }, { label: "B 稳" }] }] },
});
check(typeof r === "string" && r.includes("还在分析"), "守卫拦下并说明「还在分析」");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "ASK-GATE GREEN" : "ASK-GATE RED");
process.exit(fail === 0 ? 0 : 1);
