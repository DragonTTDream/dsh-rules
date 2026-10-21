// 重跑治理的判定（纯函数，离线可验）。
// 依据：Temporal 的 transient/intermittent/permanent 三分；Google SRE 的尝试预算；Reflexion 的"重试要带自我批判"。
import { classifyFailure, decideRerun } from "../index.js";

let fail = 0;
const check = (cond, msg, extra = "") => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fail += 1; console.log(`  ✗ ${msg}${extra ? "  " + extra : ""}`); }
};

console.log("=== 失败三分：permanent 必须有日志证据 ===");
check(classifyFailure("script-died", "bash: line 3: syntax error near unexpected token") === "permanent", "语法错 ⇒ permanent");
check(classifyFailure("script-died", "./windowB.sh: No such file or directory") === "permanent", "文件不存在 ⇒ permanent");
check(classifyFailure("no-start", "Permission denied") === "permanent", "权限拒绝 ⇒ permanent");
check(classifyFailure("script-died", "开始装载") === "transient", "有输出但无错误特征 ⇒ transient（可能是被杀）");
check(classifyFailure("no-start", "") === "transient", "零输出无证据 ⇒ transient（不冤枉它）");
check(classifyFailure("stall", "G1 装载 + 首张图") === "intermittent", "stall ⇒ intermittent");
check(classifyFailure("timeout", "") === "intermittent", "timeout ⇒ intermittent");
check(classifyFailure("marker", "done") === "transient", "成功 ⇒ transient（换环境重跑无害）");
check(classifyFailure("", "") === "transient", "空 reason ⇒ transient");

console.log("=== 重跑去向 ===");
check(decideRerun({}).action === "allow", "首次提交 ⇒ 放行");
check(decideRerun({ prev: { reason: "script-died", logTailTail: "开始" } }).why === "transient",
  "上次是被杀（transient）⇒ 原样放行");

const perm = decideRerun({ prev: { reason: "no-start", logTailTail: "No such file or directory", attempt: 1 } });
check(perm.action === "deny" && perm.why === "permanent", "上次是路径错（permanent）⇒ 拒");

const noChange = decideRerun({ prev: { reason: "stall", attempt: 1 } });
check(noChange.action === "deny" && noChange.why === "need-change", "stall 重跑但没写 change ⇒ 拒");

const withChange = decideRerun({ prev: { reason: "stall", attempt: 1 }, change: "上次卡在 G1 冷编码；这次把 encoder 换成 CPU 再测" });
check(withChange.action === "allow" && withChange.why === "intermittent+change", "stall + 写了 change ⇒ 放行");

const budget = decideRerun({ prev: { reason: "stall", attempt: 2 }, change: "x", attemptBudget: 2 });
check(budget.action === "deny" && budget.why === "budget-exhausted", "预算用完（attempt 2 / budget 2）⇒ 拒");

const circuit = decideRerun({ prev: { reason: "stall", attempt: 1 }, change: "x", circuitAfter: 3, sameReasonStreak: 3 });
check(circuit.action === "deny" && circuit.why === "circuit-open", "连续 3 次同因 ⇒ 熔断");

check(decideRerun({ prev: { reason: "stall", attempt: 9 }, change: "x", attemptBudget: 0 }).action === "allow",
  "attemptBudget=0 ⇒ 不限次数");
check(decideRerun({ prev: { reason: "stall", attempt: 1 }, change: "x", circuitAfter: 0, sameReasonStreak: 99 }).action === "allow",
  "circuitAfter=0 ⇒ 不熔断");
check(decideRerun({ prev: { reason: "stall", attempt: 1 }, change: "   " }).action === "deny",
  "change 只有空白 ⇒ 视同没写");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "RERUN GREEN" : "RERUN RED");
process.exit(fail === 0 ? 0 : 1);
