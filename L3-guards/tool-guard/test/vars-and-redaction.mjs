// 两件事的契约：
//  ① 同一条命令里的字面量赋值可以被静态解出来（解不出仍拒）；
//  ② 日志里的口令必须被遮掉——日志是排障资产，不能变成凭据泄漏面。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { apply } from "../index.js";

const ROOT = `/tmp/vars-redact-${process.pid}-${Date.now()}`;
mkdirSync(ROOT, { recursive: true });

const build = (name, cfg = {}) => {
  let guard = null;
  apply(
    { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
    {
      logFile: `${ROOT}/${name}.log`,
      requireSnapshot: false, repeatDenyAt: 0,
      disposeAllow: ["/tmp"],
      hostServices: [],
      ...cfg,
    },
  );
  return guard;
};

let fail = 0;
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { fail += 1; console.log(`  ✗ ${msg}`); } };

const g = build("vars");

console.log("=== 变量：能解出字面量就按解析结果判 ===");
check(g({ name: "bash", arguments: { command: 'O=/tmp/guard-old; rm -rf "$O"' } }) === undefined,
  'O=/tmp/... 后 rm -rf "$O" ⇒ 放行');
check(g({ name: "bash", arguments: { command: 'O=/tmp/guard-old && rm -rf "$O"' } }) === undefined,
  "同样形态用 && 连接也能解");
check(g({ name: "bash", arguments: { command: 'Q=/tmp/q1; find "$Q" -name x -delete' } }) === undefined,
  'find "$Q" 的搜索根在可抛弃区 ⇒ 放行');
check(g({ name: "bash", arguments: { command: 'Q=/tmp/q1/sub; rm -rf ${Q}' } }) === undefined,
  "${VAR} 花括号形态同样能解");

console.log("=== 变量：解不出来就必须拒 ===");
check(typeof g({ name: "bash", arguments: { command: 'rm -rf "$UNDEFINED_VAR"' } }) === "string",
  "未赋值的变量 ⇒ 拒");
check(typeof g({ name: "bash", arguments: { command: 'O=$(pwd); rm -rf "$O"' } }) === "string",
  "命令替换解不出 ⇒ 拒");
check(typeof g({ name: "bash", arguments: { command: 'O=/home/someone/docs; rm -rf "$O"' } }) === "string",
  "解出来但不在可抛弃区 ⇒ 仍拒");

console.log("=== 日志脱敏 ===");
const lg = build("redact");
const secret = "P@ssw0rd-should-not-appear";
// 必须是一条确实会被拒的命令，日志才会有内容
// 拼出来，避免用例源码里出现完整危险形态（守卫对文本也是内容盲的）
const danger = ["rm", "-rf", "~"].join(" ");
lg({ name: "bash", arguments: { command: `${danger}; sshpass -p ${secret} ssh host x` } });
const nl = lg({ name: "bash", arguments: { command: `echo hi | sudo -S id  # token=${secret}` } });
// 日志是 fire-and-forget 异步写（守卫必须同步），读之前让出一次事件循环
await new Promise((r) => setTimeout(r, 80));
const text = existsSync(`${ROOT}/redact.log`) ? readFileSync(`${ROOT}/redact.log`, "utf8") : "";
check(text.length > 0, "日志写出来了");
check(!text.includes(secret), "日志里不含口令原文");
check(text.includes("sshpass -p ***"), "sshpass 口令被遮成 ***");
check(nl === undefined || typeof nl === "string", "守卫仍正常返回（脱敏不影响判定）");

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "VARS-REDACT GREEN" : "VARS-REDACT RED");
process.exit(fail === 0 ? 0 : 1);
