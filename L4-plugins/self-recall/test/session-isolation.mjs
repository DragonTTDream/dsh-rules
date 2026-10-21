// 会话隔离（self-recall 侧）：session_facts 只能读到本会话的记录。
// 2026-10-22 实测：模块级单槽 ⇒ 隔壁会话读到了这边会话的「最新用户消息」，看起来像"串台"。
import { apply } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

let tools = {};
apply(
  {
    tools: { guard: () => () => {}, register: (t) => { tools[t.name] = t; return () => {}; } },
    effect: () => {}, on: () => () => {}, get: () => undefined, set: () => {}, logger: { info: () => {}, warn: () => {} },
  },
  { endpoint: "http://127.0.0.1:1", model: "none", localModels: [], warmAfterRun: false, logFile: `/tmp/iso-${process.pid}.log` },
);

const note = globalThis.__selfRecallNoteFact;
check(typeof note === "function", "测试钩子存在");

const A = { id: "session-A" };
const B = { id: "session-B" };

note(A, { text: "本条是 A 会话的话", at: Date.now(), turn: 3, seq: 1 });

const ra = await tools.session_facts.execute({}, { agent: A });
check(ra.known === true && ra.text === "本条是 A 会话的话", "A 读到自己的话");

const rb = await tools.session_facts.execute({}, { agent: B });
check(rb.known === false, "B 读不到 A 的话（按会话隔离）", JSON.stringify(rb.text));
check(rb.text === "", "B 的 text 必须是空串，不能回落到别人");

note(B, { text: "B 自己的话", at: Date.now(), turn: 1, seq: 2 });
const rb2 = await tools.session_facts.execute({}, { agent: B });
check(rb2.text === "B 自己的话", "B 授权后读到自己");
const ra2 = await tools.session_facts.execute({}, { agent: A });
check(ra2.text === "本条是 A 会话的话", "A 的记录没被 B 覆盖");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "RECALL-SESSION-ISO GREEN" : "RECALL-SESSION-ISO RED");
process.exit(fail === 0 ? 0 : 1);
