// 递归强删的分档判据：目标决定风险，不是"用了 rm -rf"决定风险。
// 背景：线上 190 次拒绝里 46 次是删自己刚建的临时目录，全被一刀切挡住。
import { apply } from "../index.js";

let guard = null;
apply(
  { tools: { guard: (fn) => { guard = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
  {
    logFile: "/tmp/dsh-guard-test/tiers.log",
    requireSnapshot: false,
    disposeAllow: ["/tmp", "/var/tmp", "~/.dsh-work"],
  },
);

const verdict = (cmd) => guard({ name: "bash", arguments: { command: cmd } });

const ALLOW = [
  ["rm -rf /tmp/foo", "可抛弃区内的具名子项"],
  ["rm -rf /tmp/a /tmp/b", "多目标全在可抛弃区"],
  ["rm -rf /var/tmp/zz", "第二个可抛弃根"],
  ["rm -rf ~/.dsh-work/run-20261021", "配置的家目录内工作区"],
  ["rm -rf scratch", "当前目录下的具名项"],
  ["rm -rf ./scratch", "显式相对路径"],
  ["rm -rf __pycache__", "构建缓存"],
  ["find /tmp/sheet -name '*.log' -delete", "搜索根在可抛弃区"],
];

const DENY = [
  ["rm -rf /", "根目录"],
  ["rm -rf /*", "根目录通配"],
  ["rm -rf ~", "整个家目录"],
  ["rm -rf .", "当前目录整体"],
  ["rm -rf ..", "父目录"],
  ["rm -rf *", "通配"],
  ["rm -rf $TARGET", "变量未校验"],
  ["rm -rf /home/someone", "整个用户目录"],
  ["rm -rf /etc", "系统配置"],
  ["rm -rf /tmp", "可抛弃根自身（必须拒）"],
  ["rm -rf /var/tmp", "可抛弃根自身（必须拒）"],
  ["rm -rf /home/someone/docs", "不在可抛弃区的绝对路径"],
  ["rm -rf ~/workspace", "未配置的绝对路径"],
  ["rm -rf ../other", "相对路径逃出当前目录"],
  ["find . -delete", "搜索根是当前目录"],
  ["find /etc -name '*.conf' -delete", "搜索根是系统目录"],
];

let fail = 0;
console.log("=== 应放行（可抛弃区 / 当前目录具名项）===");
for (const [cmd, why] of ALLOW) {
  const r = verdict(cmd);
  if (r === undefined) console.log(`  allow ✓ ${why}`);
  else { fail += 1; console.log(`  FALSE-POSITIVE  ${why}\n        reason=${String(r).slice(0, 80)}`); }
}
console.log("=== 应拒绝 ===");
for (const [cmd, why] of DENY) {
  const r = verdict(cmd);
  if (typeof r === "string" && r.length > 0) console.log(`  deny ✓ ${why}`);
  else { fail += 1; console.log(`  MISS  ${why}\n        cmd=${JSON.stringify(cmd)}`); }
}

console.log(`\n总计 ${ALLOW.length + DENY.length} 项，失败 ${fail}`);
console.log(fail === 0 ? "TIERS GREEN" : "TIERS RED");
process.exit(fail === 0 ? 0 : 1);
