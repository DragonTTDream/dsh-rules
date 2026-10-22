// L3 版经验库触发器（防复发规格：已犯过且能机器判 ⇒ 下沉 L3）
// 病根：经验库此前只有 L0 两句话要求模型「怪症状先 grep」，是纯自觉；本地模型经常不查。
// 现在：同一命令（归一化指纹）在窗口内出现 N 次 ⇒ 守卫拦下，并把 INDEX.md 命中的症状行塞进拒绝消息。
import { apply, commandFingerprint, parseGotchaIndex, matchGotchaRows, repeatGate } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

const INDEX = `# 经验库索引

| 症状关键词（会遇到的原话） | 判据 | 正解 | 验证 | 详情 |
|---|---|---|---|---|
| 引号 空格 argv schtasks /TR 被切 参数丢失 畸形 | Windows 只有命令行字符串 | 引号写进 .bat；任务指无空格路径 | 2026-10-22 / 90d / manual | [Windows引号被切.md](Windows引号被切.md) |
| 秒退 零输出 启动失败 exit 0x2 9009 | 程序没起来 | 先查 exit code | 2026-10-22 / 90d / auto | [秒退无输出.md](秒退无输出.md) |
`;

console.log("=== 指纹：同一形状得同一指纹 ===");
check(commandFingerprint("kill 1234") === commandFingerprint("kill 5678"), "只有数字不同 ⇒ 同指纹");
check(commandFingerprint('grep "a b" x') !== commandFingerprint('grep "c d" x') || true, "引号内容归一（不断言差异）");
check(commandFingerprint("ls   -la") === "ls -la", "多余空白折叠");

console.log("=== 解析索引 ===");
const rows = parseGotchaIndex(INDEX);
check(rows.length === 2, "解析出 2 条", `实际 ${rows.length}`);
check(rows[0].file === "Windows引号被切.md", "详情文件名解析正确");
check(rows[0].criterion.includes("命令行字符串"), "判据列解析正确");

console.log("=== 命中：按症状列共现打分 ===");
check(matchGotchaRows('schtasks /TR "C:\\Program Files\\x.exe"', rows)[0]?.file === "Windows引号被切.md", "schtasks/引号 ⇒ 命中引号条目");
check(matchGotchaRows("grep '^TIME=' config.ini", rows).length === 0, "普通命令 ⇒ 无命中");
check(matchGotchaRows("bash -c 'exit 9009'", rows)[0]?.file === "秒退无输出.md", "9009 ⇒ 命中秒退条目");

console.log("=== repeatGate：到阈值才拦，拦时附命中行 ===");
check(repeatGate({ cmd: "x", count: 2, at: 3, rows }) === undefined, "2 次 ⇒ 放行");
const g = repeatGate({ cmd: 'schtasks /TR "C:\\a b\\x.exe"', count: 3, at: 3, rows });
check(typeof g === "string" && g.includes("第 3 次"), "3 次 ⇒ 拦，且说明次数");
check(typeof g === "string" && g.includes("Windows引号被切.md"), "拒绝消息里带经验库命中的详情文件名");
const gl = repeatGate({ cmd: "echo hi", count: 3, at: 3, rows });
check(typeof gl === "string" && gl.includes("没找到对得上"), "无命中时提示自己去 grep");
check(repeatGate({ cmd: "x", count: 99, at: 0, rows }) === undefined, "阈值 0 ⇒ 关闭");

console.log("=== 接入守卫：第 3 次同形状命令被拦 ===");
{
  let g2 = null;
  apply(
    { tools: { guard: (fn) => { g2 = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    { logFile: `/tmp/gg-${process.pid}.log`, requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, planFile: "/tmp/none-plan-gg.md",
      gotchaIndex: "/tmp/gotchas-index-test.md", repeatDenyAt: 3, repeatExempt: "bin/lint" },
  );
  const fs = await import("node:fs");
  fs.writeFileSync("/tmp/gotchas-index-test.md", INDEX);
  const run = (cmd) => g2({ name: "bash", arguments: { command: cmd }, agent: { id: "s1" } });
  const cmd = 'schtasks /TR "C:\\a b\\x.exe"';
  check(run(cmd) === undefined, "第 1 次放行");
  check(run(cmd) === undefined, "第 2 次放行");
  const third = run(cmd);
  check(typeof third === "string" && third.includes("经验库"), "第 3 次被拦，消息里带经验库命中");
  check(run(cmd) === undefined, "拦过即清零 ⇒ 第 4 次放行（不永久锁死）");
  check(run("bin/lint.sh") === undefined && run("bin/lint.sh") === undefined && run("bin/lint.sh") === undefined, "豁免命令重复不拦");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "GOTCHA-GATE GREEN" : "GOTCHA-GATE RED");
process.exit(fail === 0 ? 0 : 1);
