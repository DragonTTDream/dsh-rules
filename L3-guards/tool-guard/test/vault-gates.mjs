// 凭据来源两条硬闸（2026-10-22）
// ① inlineCredentialGate：命令里写死明文凭据 ⇒ 拦（命令原文进会话日志 / ps / 子进程环境）
// ② secretFileGate：去 .env / credentials.json / .netrc 里翻密钥 ⇒ 拦（vault 已是免密入口）
import { apply, inlineCredentialGate, secretFileGate } from "../index.js";

let fail = 0;
const check = (c, m, e = "") => { if (c) console.log(`  ✓ ${m}`); else { fail += 1; console.log(`  ✗ ${m}${e ? "  " + e : ""}`); } };

console.log("=== 明文凭据闸 ===");
check(typeof inlineCredentialGate({ cmd: 'curl -H "Authorization: Bearer sk-abcdef1234567890" https://x' }) === "string", "Authorization 字面令牌 ⇒ 拦");
check(inlineCredentialGate({ cmd: 'curl -H "Authorization: Bearer $TOKEN" https://x' }) === undefined, "Bearer $TOKEN 变量 ⇒ 放行");
check(typeof inlineCredentialGate({ cmd: "sshpass -p hunter2 ssh user@host" }) === "string", "sshpass -p 明文 ⇒ 拦");
check(inlineCredentialGate({ cmd: "sshpass -p \"$(dsh-vault get ssh)\" ssh user@host" }) === undefined, "sshpass 用命令替换 ⇒ 放行");
check(typeof inlineCredentialGate({ cmd: "mysql -h db --password=s3cretpw -u app" }) === "string", "--password= 明文 ⇒ 拦");
check(inlineCredentialGate({ cmd: "dsh-vault get db | mysql --password-stdin" }) === undefined, "--password-stdin ⇒ 放行（不误伤）");
check(typeof inlineCredentialGate({ cmd: "git clone https://user:ghp_secret@github.com/o/r.git" }) === "string", "URL 里 user:pass ⇒ 拦");
check(typeof inlineCredentialGate({ cmd: "export TAVILY_TOKEN=abcd1234efgh" }) === "string", "敏感名赋值字面量 ⇒ 拦");
check(inlineCredentialGate({ cmd: "export TAVILY_TOKEN=$(dsh-vault get tavily)" }) === undefined, "赋值用命令替换 ⇒ 放行");
check(inlineCredentialGate({ cmd: "export PATH=/usr/local/bin:/usr/bin" }) === undefined, "普通变量赋值 ⇒ 放行（不误伤）");
check(inlineCredentialGate({ cmd: "echo hi", enabled: false }) === undefined, "负样本：enabled:false ⇒ 不拦");

console.log("=== 密钥文件闸 ===");
check(typeof secretFileGate({ cmd: "cat .env" }) === "string", "cat .env ⇒ 拦");
check(typeof secretFileGate({ cmd: "grep -i token .env.local" }) === "string", "grep .env.local ⇒ 拦");
check(typeof secretFileGate({ cmd: "cat credentials.json" }) === "string", "cat credentials.json ⇒ 拦");
check(typeof secretFileGate({ cmd: "source ~/.netrc" }) === "string", "source .netrc ⇒ 拦");
check(secretFileGate({ cmd: "cat .env.example" }) === undefined, ".env.example 模板 ⇒ 放行");
check(secretFileGate({ cmd: "cp .env.example .env" }) === undefined, "拷贝模板（cat/cp 非读取类）⇒ 放行");
check(secretFileGate({ cmd: "ls -l .env" }) === undefined, "只 ls 文件名 ⇒ 放行（不误伤）");
check(secretFileGate({ cmd: "dsh-vault get db", enabled: false }) === undefined, "负样本：enabled:false ⇒ 不拦");

console.log("=== 接入守卫 ===");
const mk = (extra = {}) => {
  let g = null;
  apply(
    { tools: { guard: (fn) => { g = fn; return () => {}; }, register: () => () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined, logger: { info: () => {} } },
    { logFile: `/tmp/vg-${process.pid}-${Math.random().toString(36).slice(2)}.log`, requireSnapshot: false, hostServices: [],
      requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, repeatDenyAt: 0, planFile: "/tmp/none-vg.md", stallAt: 0, ...extra },
  );
  return g;
};
{
  const g = mk();
  const b = (command) => g({ name: "bash", arguments: { command }, agent: { id: "s1" } });
  const r1 = b('curl -H "Authorization: Bearer sk-abcdef1234567890" https://x');
  check(typeof r1 === "string" && r1.includes("dsh-vault"), "接入后：明文令牌被拦且指到 dsh-vault");
  check(b("dsh-vault get x | mysql --password-stdin") === undefined, "接入后：dsh-vault 管道用法放行");
  const r2 = b("cat .env");
  check(typeof r2 === "string" && r2.includes("vault"), "接入后：cat .env 被拦");
}
console.log("=== 负样本：两条闸关掉后全放行 ===");
{
  const g = mk({ denyInlineCredentials: false, denySecretFileRead: false });
  const b = (command) => g({ name: "bash", arguments: { command }, agent: { id: "s1" } });
  check(b('curl -H "Authorization: Bearer sk-abcdef1234567890" https://x') === undefined, "闸关 ⇒ 明文令牌不拦");
  check(b("cat .env") === undefined, "闸关 ⇒ cat .env 不拦");
}

console.log(`\n失败 ${fail}`);
console.log(fail === 0 ? "VAULT-GATES GREEN" : "VAULT-GATES RED");
process.exit(fail === 0 ? 0 : 1);
