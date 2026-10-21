// pollDecision 单测：喂状态，不等真实时间。
// 起因：空转检测藏在工具内部，只能真跑 60 秒才能验 → 把判定抽成纯函数。
// 每次真跑窗口去验证判定的代价 = 一次静默 60 秒 + 一次用户误判"它卡住了"。
import { pollDecision } from "../index.js";

let fail = 0;
const check = (cond, msg, extra = "") => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fail += 1; console.log(`  ✗ ${msg}${extra ? "  " + extra : ""}`); }
};
const d = (o) => pollDecision(o);

console.log("=== marker 最高优先 ===");
check(d({ marker: "ok" }).reason === "marker", "有 marker ⇒ marker");
check(d({ marker: "ok", alive: false, elapsed: 9999 }).reason === "marker", "marker 压过'进程已死'与超时");
check(d({ marker: "script-died" }).reason === "marker", "脚本自己写 marker=script-died 也算拿到 marker");

console.log("=== 进程已死：细分为 no-start / script-died ===");
check(d({ alive: false, size: 0, elapsed: 9 }).reason === "no-start", "零输出 + 进程没了 ⇒ no-start");
check(d({ alive: false, size: 120, elapsed: 9 }).reason === "script-died", "有输出 + 进程没了 ⇒ script-died");
check(d({ alive: false, size: -1, elapsed: 9 }).reason === "no-start", "日志文件都没生成 ⇒ no-start");

console.log("=== 给进程留起步时间（failFast 下限 3 秒）===");
check(d({ alive: false, size: 0, elapsed: 2 }).done === false, "2 秒内死掉先不判（可能还没来得及起）");
check(d({ alive: false, size: 0, elapsed: 3, failFast: 3 }).reason === "no-start", "failFast=3 时到 3 秒判");
check(d({ alive: false, size: 0, elapsed: 7 }).done === false, "默认 failFast=8 ⇒ 7 秒还不判");
check(d({ alive: false, size: 0, elapsed: 8 }).reason === "no-start", "默认 failFast=8 ⇒ 8 秒判");
check(d({ alive: false, size: 0, elapsed: 9, failFast: 30 }).done === false, "failFast 配大时按大的等");

console.log("=== 空转：进程活着但日志静默 ===");
check(d({ alive: true, size: 10, quietSec: 599, stallMin: 10, elapsed: 100 }).done === false, "9 分 59 秒还不算");
check(d({ alive: true, size: 10, quietSec: 600, stallMin: 10, elapsed: 700 }).reason === "stall", "整 10 分钟 ⇒ stall");
check(d({ alive: true, quietSec: 99999, stallMin: 0 }).done === false, "stallMin=0 ⇒ 关掉，永不判空转");

console.log("=== 真的超时才叫 timeout ===");
check(d({ alive: true, quietSec: 0, elapsed: 900, cap: 900 }).reason === "timeout", "到 cap ⇒ timeout");
check(d({ alive: true, quietSec: 300, stallMin: 10, elapsed: 400, cap: 900 }).done === false, "有输出且在 cap 内 ⇒ 继续等");

console.log("=== 优先级：死了优先报死，不报 timeout ===");
check(d({ alive: false, size: 5, elapsed: 900, cap: 900 }).reason === "script-died", "既到 cap 又已死 ⇒ 报 script-died（更有信息量）");

console.log("=== 默认值兜底 ===");
check(d({}).done === false, "空输入 ⇒ 继续等");
check(d({ alive: false, size: 0, elapsed: 3, failFast: 0 }).reason === "no-start", "failFast=0 也按下限 3 秒");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "POLL-DECISION GREEN" : "POLL-DECISION RED");
process.exit(fail === 0 ? 0 : 1);
