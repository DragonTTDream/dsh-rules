// 跨机执行两条硬闸（2026-10-22）
// ① ps1EncodingGate：Windows 脚本含非 ASCII 且无 BOM ⇒ PS 5.1 按 ANSI 码页解，中文粘连成语法错。
// ② chainedRemoteGate：scp/sftp 与 sc create/schtasks 串在一条 && ⇒ 上游失败被静默跳过。
// 依据：社区把"不容忍例外的规则"放 hooks/permissions/linter，不放 AGENTS.md。
import { apply, ps1EncodingGate, chainedRemoteGate } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 编码闸·纯函数 ===");
check(typeof ps1EncodingGate({ path: "/tmp/x.ps1", content: "echo 完成" }) === "string", "中文明文 .ps1 ⇒ 拦");
check(ps1EncodingGate({ path: "/tmp/x.ps1", content: "echo done" }) === undefined, "纯 ASCII .ps1 ⇒ 放行");
check(ps1EncodingGate({ path: "/tmp/x.ps1", content: "\uFEFFecho 完成" }) === undefined, "带 UTF-8 BOM ⇒ 放行");
check(ps1EncodingGate({ path: "/tmp/x.sh", content: "echo 完成" }) === undefined, "非 Windows 脚本 ⇒ 不管（不误伤）");
check(ps1EncodingGate({ path: "/tmp/x.ps1", content: "echo 完成", enabled: false }) === undefined, "负样本：enabled:false ⇒ 不拦");
check(typeof ps1EncodingGate({ cmd: "cat > /tmp/y.ps1 <<'EOF'\necho 中文\nEOF" }) === "string", "heredoc 写 .ps1 含中文 ⇒ 拦");
check(ps1EncodingGate({ cmd: "cat > /tmp/y.ps1 <<'EOF'\necho hi\nEOF" }) === undefined, "heredoc 写 ASCII .ps1 ⇒ 放行");
check(ps1EncodingGate({ cmd: "echo 中文 > /tmp/notes.md" }) === undefined, "非 .ps1 重定向 ⇒ 不管");

console.log("=== 联动闸·纯函数 ===");
const chain = "scp /tmp/svc.exe host:/d/svc.exe && ssh host 'sc create S binPath= /d/svc.exe'";
check(typeof chainedRemoteGate({ cmd: chain }) === "string", "scp && sc create ⇒ 拦");
check(chainedRemoteGate({ cmd: "scp /tmp/a host:/d/a && ssh host \"test -f /d/a\" && ssh host 'sc create S' " }) === undefined, "链里带落地证据 test -f ⇒ 放行");
check(chainedRemoteGate({ cmd: "scp /tmp/a host:/d/a" }) === undefined, "单条 scp（无 &&）⇒ 放行");
check(chainedRemoteGate({ cmd: "ls && sc create S" }) === undefined, "无搬运步骤 ⇒ 放行");
check(chainedRemoteGate({ cmd: chain, enabled: false }) === undefined, "负样本：enabled:false ⇒ 不拦");

console.log("=== 接入守卫 ===");
const mk = (extra = {}) => {
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    { logFile: `/tmp/rx-${process.pid}-${Math.random().toString(36).slice(2)}.log`, requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0, planFile: "/tmp/none-rx.md", stallAt: 0, staticCheckMode: "off", ...extra },
  );
  return g;
};
{
  const g = mk();
  const w = (path, content) => g({ name: "write", arguments: { file_path: path, content }, agent: { id: "s1" } });
  const chinese = w("/tmp/t.ps1", "echo 完成");
  check(typeof chinese === "string" && chinese.includes("BOM"), "write 中文 .ps1 被拦且提示 BOM");
  check(w("/tmp/t.ps1", "echo done") === undefined, "write ASCII .ps1 放行");
  const b = (command) => g({ name: "bash", arguments: { command }, agent: { id: "s1" } });
  const ch = b(chain);
  check(typeof ch === "string" && ch.includes("SRC MISSING"), "bash 里 scp && sc create 被拦且给分步骨架");
  check(b("scp /tmp/a host:/d/a && ssh host \"test -f /d/a\" && ssh host 'sc create S'") === undefined, "带 test -f 的链放行");
}
console.log("=== 负样本：两条闸关掉后全放行 ===");
{
  const g = mk({ denyNonAsciiPs1: false, denyChainedRegistration: false });
  const w = g({ name: "write", arguments: { file_path: "/tmp/t2.ps1", content: "echo 完成" }, agent: { id: "s1" } });
  const b = g({ name: "bash", arguments: { command: chain }, agent: { id: "s1" } });
  check(w === undefined && b === undefined, "开关关 ⇒ 中文 .ps1 与 && 链都不拦");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "REMOTE-EXEC-GUARDS GREEN" : "REMOTE-EXEC-GUARDS RED");
process.exit(fail === 0 ? 0 : 1);
