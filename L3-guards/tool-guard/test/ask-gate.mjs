// 提问闸（第二版）：判据是**可逆性 + 是否带默认值**，不是猜用户心情。
// 社区依据：Bezos 单/双行道（可逆自己定，不可逆上报）+ 12-factor #7（求助是结构化工具调用）+ KnowNO（只在超阈值不确定时求助）。
import { apply, askGate, noteUserText } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 第一道：没标可逆性 ⇒ 拒，并给模板 ===");
const noMark = askGate({ userText: "把这三条路写清楚", question: "走哪条？", options: "A 快 / B 稳" });
check(typeof noMark === "string" && noMark.includes("[one-way]"), "拒绝理由里给出标注模板");
check(noMark.includes("双行道") || noMark.includes("two-way"), "并说明可逆不该问");

console.log("=== [two-way] 可逆 ⇒ 拒（自己定 + 说明） ===");
const two = askGate({ userText: "改这个函数", question: "[two-way] 变量名用 a 还是 b？" });
check(typeof two === "string" && two.includes("可逆"), "可逆提问被拒");
check(two.includes("说明你选了哪条"), "并要求在回复里说明选择");

console.log("=== [one-way] 不可逆：没默认值 ⇒ 拒 ===");
const oneNoDefault = askGate({ userText: "跑一下", question: "[one-way] 可以直接重建索引吗？" });
check(typeof oneNoDefault === "string" && oneNoDefault.includes("默认"), "不可逆缺默认值被拒");

console.log("=== [one-way] + 默认值 ⇒ 放行 ===");
const ok = askGate({ userText: "跑一下", question: "[one-way] 重建索引不可逆（约 40 分钟）。默认：先做只读校验，不动索引。回退：快照。" });
check(ok === undefined, "不可逆 + 默认 + 回退 ⇒ 允许问");

console.log("=== 第二道：用户在按住 ⇒ 连 one-way 也不问 ===");
for (const t of ["先别动，我在分析", "还没定稿，我看看", "我正在读材料", "等我说的"]) {
  check(typeof askGate({ userText: t, question: "[one-way] 默认：不做" }) === "string", `「${t}」⇒ 拒`);
}

console.log("=== 接入守卫 ===");
let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
  { logFile: `/tmp/ask2-${process.pid}.log`, requireSnapshot: false, repeatDenyAt: 0, stallAt: 0, hostServices: [] },
);
const A = { id: "s-A" };
noteUserText(A, "把这三条路的取舍写清楚");
const r = guard({ name: "ask_user_question", agent: A, arguments: { questions: [{ id: "r", header: "[two-way]", question: "走哪条？" }] } });
check(typeof r === "string", "守卫拦下可逆提问");

noteUserText(A, "跑一下");
const r2 = guard({ name: "ask_user_question", agent: A, arguments: { questions: [{ id: "r", header: "[one-way]", question: "默认：先只读校验" }] } });
check(r2 === undefined, "不可逆 + 默认 ⇒ 放行");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "ASK-GATE GREEN" : "ASK-GATE RED");
process.exit(fail === 0 ? 0 : 1);
