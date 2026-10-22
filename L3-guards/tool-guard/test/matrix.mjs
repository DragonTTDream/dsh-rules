// fixture 矩阵：命中/不命中全表。纯函数级，不碰真实路径（R-01）
import { apply, setSessionUserText } from "../index.js";

let guard = null;
const fakeCtx = {
  tools: { guard: (fn) => { guard = fn; return () => {}; } },
  effect: () => {},
  logger: { info: () => {} },
};
apply(fakeCtx, { logFile: "/tmp/dsh-guard-test/guard.log", hostServices: ["app.service"], requireSnapshot: false, requireTodoEveryMutations: 0, repeatDenyAt: 0, stallAt: 0, requireTodoEveryMinutes: 0 });

// 2026-10-22：重启类命令现在要求本轮授权；矩阵里的「合法重启」用例先给授权上下文
setSessionUserText("重启宿主并停服务");

const DENY = [
  ["pkill -f main.py", "R-07 pkill -f"],
  ["pgrep -f foo | xargs kill", "R-07 pkill/pgrep -f 变体? 见备注"],
  ["until ! pgrep -f foo; do sleep 1; done", "R-07 永不退出循环"],
  ["rm -rf /tmp/foo", "R-03 递归强删"],
  ["rm -fr /tmp/foo", "R-03 任意顺序"],
  ["rm --recursive --force /tmp/foo", "R-03 长选项"],
  ["rm -r -f /tmp/foo", "R-03 分离选项"],
  ["rm -rf $TARGET", "Never 变量未校验"],
  ["rm -rf ~", "Never home 无界"],
  ["rm -rf /home/someone", "Never home 无界"],
  ["find . -name '*.log' -delete", "R-03 find -delete"],
  ["find /tmp -exec rm {} \\;", "R-03 find -exec rm"],
  ["git reset --hard HEAD~1", "R-03 git reset --hard"],
  ["git clean -fd", "R-03 git clean -f"],
  ["git stash drop", "R-03 git stash drop"],
  ["git stash clear", "R-03 git stash clear"],
  ["git push --force", "R-03 push --force → 路标"],
  ["git push -f origin main", "R-03 push -f"],
  ["dnf remove kernel", "R-03 系统包移除"],
  ["dnf -y remove glibc", "R-03 系统包移除"],
  ["rpm -e foo", "R-03 rpm -e"],
  ["dd if=/dev/zero of=/dev/sda bs=1M", "R-03 dd"],
  ["mkfs.ext4 /dev/sdb", "R-03 mkfs"],
  ["fdisk /dev/sdb", "R-03 fdisk"],
  ["killall -9 python", "R-03 killall -9"],
  ["pnpm audit fix --force", "R-03 audit fix --force"],
  ["npm audit fix --force", "R-03 audit fix --force"],
  [":(){ :|:& };:", "R-03 fork bomb"],
  ["/bin/rm -rf /tmp/x", "R-03 绝对路径绕过"],
  ["/usr/bin/git reset --hard", "R-03 绝对路径绕过"],
  ["/usr/local/bin/rm.real -rf /tmp/x", "R-03 *.real 绕过"],
  ["echo yes | sudo rm -rf /tmp/x", "R-03 喂确认"],
  ["echo SECRETPW | sudo -S -n true", "R-03 喂 sudo 密码（-S 读 stdin）"],
  ["echo pw | sudo --stdin rm -f /tmp/a", "R-03 --stdin 喂密码"],
  ["echo pw|sudo -S true", "R-03 无空格管道变体"],
  ["echo y | pkexec apt-get install foo", "R-03 pkexec"],
  ["echo y | doas rm -f /tmp/a", "R-03 doas"],
  ["echo y | su -c 'rm -rf /tmp/x'", "R-03 su 喂密码"],
  ["echo confirm | confirm-install", "R-03 confirm 包装器"],
  ["echo SECRETPW | sudo -S systemctl restart app.service", "R-03 喂密码 + 宿主重启"],
  ["SAFEEXEC=0 pnpm install", "R-03 关检查环境变量"],
  ["setsid bash gate.sh > /dev/null 2>&1 < /dev/null & systemctl --user restart app.service", "R-12 事故形态"],
  ["nohup ./gate.sh &\nsystemctl --user restart app.service", "R-070 换行藏命令"],
  ["true \\&& rm -rf /tmp/z", "判据8 反斜杠转义操作符"],
  ["echo hi\nrm -rf /tmp/y", "判据8 换行藏命令"],
  ["systemctl --user restart app.service && pkill -f node", "组合：pkill -f"],
  ["sudo rm -rf /tmp/x", "包装器穿透：sudo rm -rf"],
  ["sudo git reset --hard", "包装器穿透：sudo git reset --hard"],
  ["nohup rm -rf /tmp/x &", "包装器穿透：nohup rm -rf"],
  ["pgrep -f node | xargs kill", "pgrep -f 管道给杀手且无 comm 过滤"],
  ["pgrep -f node | xargs -I{} kill {}", "同上变体"],
  ["systemctl --user restart app.service & sleep 2", "独立后台 & + 宿主重启"],
  ["disown; systemctl --user restart app.service", "disown + 宿主重启"],
];

const ALLOW = [
  ["ls -la", "普通"],
  ["systemctl --user restart app.service", "合法单独重启（必须放行）"],
  ["systemctl --user restart app.service  # 单独一条", "合法单独重启"],
  ["sudo systemctl restart app.service", "合法单独重启"],
  ["systemctl --user show app.service -p ActiveState", "查询"],
  ["systemctl --user is-active app.service", "查询"],
  ["pidof github-mcp-server", "R-07 推荐做法"],
  ["pgrep -x nginx", "R-07 推荐做法"],
  ["rm /tmp/single.txt", "无 -rf"],
  ["rm -r /tmp/dir", "递归无强删"],
  ["rm -f /tmp/a", "强删无递归"],
  ["git status --short", "普通"],
  ["git add -A && git commit -m x", "普通"],
  ["git push --force-with-lease", "推荐做法（必须放行）"],
  ["git checkout main", "切分支"],
  ["git stash list", "查询"],
  ["git stash show", "查询"],
  ["pnpm install", "普通"],
  ["pnpm add -E dsh-vault@1.10.75", "更新安装"],
  ["npm view x version", "查询"],
  ["npm run build", "普通"],
  ["echo \"measure-step-1\"", "普通"],
  ["python3 -c \"print(sum(range(1000)))\"", "普通"],
  ["docker restart chef", "容器正确停止方式"],
  ["curl -s http://127.0.0.1:1234/v1/models", "查询"],
  ["find . -name '*.ts'", "find 无删除"],
  ["find /tmp -type f -exec echo {} \\;", "find -exec echo 无害"],
  ["dd --help", "dd 无 if="],
  ["mkdir -p /tmp/a", "普通"],
  ["cat file.txt", "普通"],
  ["grep -rn foo .", "普通"],
  ["setsid ./app --port 8188 > app.log 2>&1 < /dev/null &", "合法后台拉起（无重启）"],
  ["kill 12345", "精确 PID"],
  ["killall nginx", "无 -9"],
  ["zsh -c 'echo hi'", "普通"],
  ["tar czf /tmp/a.tgz /tmp/a", "普通"],
  ["cp a b", "普通"],
  ["mv a b", "普通"],
  ['pgrep -f "venv/bin/python main.py" | while read p; do [ "$(ps -o comm= -p $p)" = python ] && kill "$p"; done', "技能认可的唯一合法 pgrep -f 形态（comm 过滤）"],
  ["kill \"$(cat app.pid)\"", "PID 文件做法"],
  ["pkill -P $$", "只杀自己后代"],
  ["systemctl --user restart app.service && echo ok", "合法重启 + && 链式（&& 不是后台）"],
  ['systemctl --user restart app.service; for i in $(seq 1 30); do [ "$(systemctl --user is-active app.service)" = "active" ] && { echo ok; break; }; sleep 1; done', "实测被误杀过的合法重启（含 && 与 $()）"],
  ["systemctl --user restart app.service || echo fail", "合法重启 + || 链式"],
  // 2026-10-19 R-03 收窄：数据管道不是「自己确认」（日志实测 6 条误杀形态）
  ["echo \"1.2.3.4 h1\" | sudo tee -a /etc/hosts", "误杀修复:写 hosts 内容"],
  ["echo \"net.ipv4.ip_forward=1\" | sudo tee /etc/sysctl.d/99-f.conf", "误杀修复:写配置文件"],
  ["echo \"x\" | sudo tee /tmp/out.txt", "误杀修复:tee 普通路径"],
  ["echo \"a\" | sudo -u nobody sh -c 'cat > /tmp/f'", "误杀修复:降权执行"],
  ["echo '=== 远端 ==='; ssh h 'grep x /etc/y | sudo tee -a /etc/y'", "误杀修复:ssh 远端体内管道"],
  ["echo \"=== 快照 ===\"; sudo -n cp a b; grep -n x y | sudo tee -a z", "误杀修复:状态打印 + 后随管道"],
  ["cat src.conf | sudo tee /etc/app.conf >/dev/null", "数据管道:非 echo"],
  ["printf 'x\\n' | sudo tee /etc/app.conf", "数据管道:printf"],
  ["echo hi | ssh host 'sudo ls'", "管道目标是 ssh"],
  ["echo hi; ls -l | wc -l", "普通管道"],
];

let fail = 0;
console.log("=== 应拒绝 ===");
for (const [cmd, why] of DENY) {
  const r = guard({ name: "bash", arguments: { command: cmd } });
  const ok = typeof r === "string" && r.length > 0;
  if (!ok) { fail++; console.log(`  MISS  ${why}\n        cmd=${JSON.stringify(cmd)}`); }
  else console.log(`  deny ✓ ${why}`);
}
console.log("=== 应放行 ===");
for (const [cmd, why] of ALLOW) {
  const r = guard({ name: "bash", arguments: { command: cmd } });
  const ok = r === undefined;
  if (!ok) { fail++; console.log(`  FALSE-POSITIVE  ${why}\n        cmd=${JSON.stringify(cmd)}\n        reason=${String(r).slice(0, 70)}`); }
  else console.log(`  allow ✓ ${why}`);
}
console.log("=== 窄面：非 shell 工具一律放行 ===");
for (const n of ["read", "write", "edit", "web_search", "present", "job_kill"]) {
  const r = guard({ name: n, arguments: { command: "rm -rf /tmp/x" } });
  if (r !== undefined) { fail++; console.log(`  FALSE-POSITIVE  ${n}`); } else console.log(`  allow ✓ ${n}`);
}
console.log("=== arbitrate_run 脚本内含重启 ===");
const arb = guard({ name: "arbitrate_run", arguments: { script: "systemctl --user restart app.service\nsleep 3\necho marker=1" } });
if (typeof arb === "string") console.log("  deny ✓ arbitrate_run 内含重启");
else { fail++; console.log("  MISS  arbitrate_run 内含重启"); }
const arb2 = guard({ name: "arbitrate_run", arguments: { script: "sleep 1\necho marker=1" } });
if (arb2 === undefined) console.log("  allow ✓ arbitrate_run 无重启");
else { fail++; console.log("  FALSE-POSITIVE  arbitrate_run 无重启"); }
console.log("=== 逃生口 allowPatterns ===");
let g2 = null;
apply({ tools: { guard: (fn) => { g2 = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
  { logFile: "/tmp/dsh-guard-test/guard2.log", requireTodoEveryMutations: 0, requireTodoEveryMinutes: 0, allowPatterns: ["^pkill -f main\\.py$"] });
const e1 = g2({ name: "bash", arguments: { command: "pkill -f main.py" } });
if (e1 === undefined) console.log("  allow ✓ 豁免生效");
else { fail++; console.log("  MISS  豁免未生效"); }
console.log("=== 开关 enabled:false ===");
let g3 = null;
apply({ tools: { guard: (fn) => { g3 = fn; return () => {}; } }, effect: () => {}, logger: { info: () => {} } },
  { logFile: "/tmp/dsh-guard-test/guard3.log", enabled: false });
const e2 = g3({ name: "bash", arguments: { command: "rm -rf /tmp/x" } });
if (e2 === undefined) console.log("  allow ✓ 观察模式只记日志");
else { fail++; console.log("  MISS  开关未生效"); }
console.log("=== 自身出错 fail-open ===");
const e3 = guard({ name: "bash", arguments: null });
if (e3 === undefined) console.log("  allow ✓ arguments 缺失不炸");
else { fail++; console.log("  MISS  fail-open 失效"); }
const e4 = guard(undefined);
if (e4 === undefined) console.log("  allow ✓ exec 缺失不炸");
else { fail++; console.log("  MISS  fail-open 失效"); }

console.log(`\n总计 ${DENY.length + ALLOW.length + 6 + 4} 项，失败 ${fail}`);
console.log(fail === 0 ? "MATRIX GREEN" : "MATRIX RED");
