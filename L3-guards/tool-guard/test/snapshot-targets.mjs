// 写入点识别：只认"内容会被改写"的路径，按动词分类 + 方向敏感。
// 背景：线上 97 条快照闸门拒绝里，有一批是 cp 的源被当成写入点、chmod 这类
// 根本不改内容的动作也要求快照（2026-10-21 日志回放）。
import { shellWriteTargets } from "../index.js";

const CASES = [
  // [命令, 期望识别出的写入点]
  ["cp /opt/plugin/index.js /tmp/bak", ["/tmp/bak"], "cp 只算目的地，源不算"],
  ["cp -a src/ /opt/plugin/lib", ["/opt/plugin/lib"], "cp -a 多参数仍取末尾目的地"],
  ["cp -t /opt/plugin a b", ["/opt/plugin"], "cp -t 指定目的目录"],
  ["install -m 644 a /opt/plugin/x", ["/opt/plugin/x"], "install 目的地"],
  ["rsync -a src/ /opt/plugin/", ["/opt/plugin/"], "rsync 目的地"],
  ["rm -r /opt/plugin/lib", ["/opt/plugin/lib"], "rm 目标"],
  ["mv /opt/plugin/a /opt/plugin/b", ["/opt/plugin/a", "/opt/plugin/b"], "mv 源被移走也算"],
  ["chmod 644 /opt/plugin/index.js", [], "chmod 不改内容 ⇒ 不计"],
  ["chown -R u:g /opt/plugin", [], "chown 不计"],
  ["touch /opt/plugin/x", [], "touch 不计"],
  ["mkdir -p /opt/plugin/new", [], "mkdir 不计"],
  ["ln -sf /opt/plugin/a /opt/plugin/b", [], "ln 不计"],
  ["echo x > /opt/plugin/cfg.yml", ["/opt/plugin/cfg.yml"], "重定向目标"],
  ["echo x >> /opt/plugin/cfg.yml", ["/opt/plugin/cfg.yml"], "追加重定向"],
  ["sed -i 's/a/b/' /opt/plugin/cfg.yml", ["/opt/plugin/cfg.yml"], "sed -i 文件"],
  ["sed 's/a/b/' /opt/plugin/cfg.yml", [], "不带 -i 的 sed 只读"],
  ["tar -xzf /tmp/a.tgz -C /opt/plugin", ["/opt/plugin"], "tar 解包 -C 目录"],
  ["tar -C/opt/plugin -xzf /tmp/a.tgz", ["/opt/plugin"], "tar 紧凑写法 -Cdir"],
  ["unzip -q a.zip -d /opt/plugin", ["/opt/plugin"], "unzip -d 目录"],
  ["dd if=/tmp/i of=/opt/plugin/disk", ["/opt/plugin/disk"], "dd 只认 of="],
  ["truncate -s 0 /opt/plugin/log", ["/opt/plugin/log"], "truncate 目标"],
  ["ls -la /opt/plugin", [], "只读命令不计"],
  ["grep -rn x /opt/plugin", [], "grep 不计"],
  ["cat /opt/plugin/a > /tmp/b", ["/tmp/b"], "读源写目标，只算目标"],
];

let fail = 0;
for (const [cmd, want, why] of CASES) {
  const got = shellWriteTargets(cmd);
  const ok = JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
  if (ok) console.log(`  ✓ ${why}`);
  else { fail += 1; console.log(`  ✗ ${why}\n      cmd=${cmd}\n      want=${JSON.stringify(want)}\n      got =${JSON.stringify(got)}`); }
}
console.log(`\n总计 ${CASES.length} 项，失败 ${fail}`);
console.log(fail === 0 ? "TARGETS GREEN" : "TARGETS RED");
process.exit(fail === 0 ? 0 : 1);
