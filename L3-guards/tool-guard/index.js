/**
 * dsh-tool-guard — 把 process-shell-safety 里「可静态判定」的纪律换成硬防线
 *
 * 机制层落点（为什么这些纪律必须下沉到代码强制，见 ../deny-list.md）：
 *   ctx.tools.guard(fn)  —— 单调守卫，在所有 tools/pre-execute 监听之后求值；
 *   返回字符串即拒绝，且「监听顺序无法把拒绝翻回允许」。拒绝理由以
 *   `Error: <reason>` + isError:true 回灌模型 ⇒ 拒绝消息是路标，不是墙。
 *
 * 设计红线：
 *   1) 窄面：只判 bash / pwsh / arbitrate_run，别的全不碰（判据 2）。
 *   2) denylist 起步，allowlist 未成熟前不把 agent 锁死（判据 3）。
 *   3) 归一化后匹配：拆段 + 去反斜杠转义，堵「换行藏命令」「\\ && 转义操作符」（判据 8）。
 *      不拦 `$()` / `${}` —— 合法用法太广，误杀面大于绕过收益。
 *   4) 自身出错一律 fail-open（返回 undefined）并记日志：防线坏了不能把生产锁死。
 *   5) 命中即 fail-closed。
 *   6) 每次拒绝追加一行日志（判据 5），异步 fire-and-forget（guard 必须同步）。
 *   7) 逃生口：enabled 开关 + allowPatterns 豁免正则。
 */

import { appendFile, copyFileSync, existsSync, mkdir, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "tool-guard";
export const inject = ["tools"];

export const Config = z.object({
  enabled: z.boolean(),
  logFile: z.string(),
  allowPatterns: z.array(z.string()),
  disposeAllow: z.array(z.string()),
  hostServices: z.array(z.string()),
  denyDestructive: z.boolean(),
  denyBypass: z.boolean(),
  denyPkillF: z.boolean(),
  denyRestartWithBackground: z.boolean(),
  denyRestartInScript: z.boolean(),
  requireSnapshot: z.boolean(),
  autoSnapshot: z.boolean(),
  maxAutoSnapshotBytes: z.number(),
  snapshotSlot: z.string(),
  snapshotTargets: z.array(z.string()),
  snapshotExempt: z.array(z.string()),
});

const DEFAULTS = {
  enabled: true,
  logFile: "~/.dsh/tool-guard.log",
  allowPatterns: [],
  // 可抛弃区：这些根下面的具名子项允许直接递归强删，不问。
  // 只打算删"自己刚建的临时目录"的人不该被拦（实测 190 次拒绝里 46 次是这类）。
  // 根本身（/tmp、/var/tmp）不在此列：整根强删仍然拒。
  disposeAllow: [],
  hostServices: [],   // 填你自己宿主服务的名字，如 ["app.service"]
  denyDestructive: true,
  denyBypass: true,
  denyPkillF: true,
  denyRestartWithBackground: true,
  denyRestartInScript: true,
  requireSnapshot: true,
  // 自动快照：写入宿主消费集时，目标若是「小文件」就当场拍一张再放行，
  // 而不是拒掉让模型再跑一次 snap.sh。
  // 依据：97 次闸门拒绝里 52 次的目标是文件（最大 36 KB），逐次人肉拍快照纯属流程税。
  // 只对已存在的普通文件生效；目录、超大文件、不存在的路径仍走拒绝 + 路标。
  autoSnapshot: false,
  maxAutoSnapshotBytes: 8388608,
  snapshotSlot: "~/.dsh/snapshots/latest",
  // 宿主消费集：运行中的服务 / profile 启动时加载 / 每步注入的指令
  snapshotTargets: [
    "~/.dsh/profiles",
    "~/.dsh/skills",
    "~/.dsh/skillsets",
    "~/.dsh/AGENTS.md",
    "~/.config/systemd/user",
    // 你自研插件的代码目录也加进来（改它们等于改宿主行为）
    // "~/my-plugin",
  ],
  // 豁免：快照位自身 / 临时区 / 工作区文档 / 防线自己的日志
  snapshotExempt: [
    "~/.dsh/snapshots",
    "~/.dsh/tool-guard.log",
    "/tmp",
    "~/workspace",   // 换成你自己不受宿主消费的目录
  ],
};

/** 拆段：堵「换行后藏命令」与链式操作符 */
function segments(cmd) {
  return String(cmd)
    .replace(/\\\s*&&/g, "&&")   // 去反斜杠转义的操作符（\ &&）
    .replace(/\\\s*\|\|/g, "||")
    .replace(/\\\s*\|/g, "|")
    .split(/[\n;]+|\s&&\s|\s\|\|\s|\s\|\s|&&|\|\||\|\(|\$\(/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(seg) {
  return seg.split(/\s+/).filter(Boolean);
}

/** argv[0] 的可执行名（去绝对路径），用于窄面匹配。跳过前缀包装器：`sudo rm -rf` 必须等于 `rm -rf` */
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nice", "nohup", "setsid", "stdbuf", "command", "exec", "disown"]);
function argv0(seg) {
  return parseArgv(seg).exe;
}

/** 返回 { exe, rest }：rest 是 argv[1:]，包装器与 VAR= 前缀已跳过 */
function parseArgv(seg) {
  const t = tokens(seg);
  let i = 0;
  while (i < t.length) {
    const tok = t[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { i += 1; continue; }
    if (WRAPPERS.has(basename(tok))) { i += 1; continue; }
    break;
  }
  return { exe: basename(t[i] || ""), rest: t.slice(i + 1) };
}

function flagsOf(seg) {
  return tokens(seg).filter((t) => t.startsWith("-"));
}


/** 系统目录：整根递归强删一律拒（不是"逐命令批准"，是没有商量的余地） */
const TIER0_ROOTS = new Set([
  "/", "/home", "/usr", "/etc", "/var", "/boot", "/opt", "/srv", "/root",
  "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/run",
]);

/**
 * 递归强删的单个目标判据。返回拒绝理由，或 undefined 表示放行。
 * 分三档：根部/变量/通配 ⇒ 拒；可抛弃区内的具名子项 ⇒ 放；其余 ⇒ 拒并给隔离区路标。
 */
function rmTargetVerdict(target, disposeAllow) {
  const raw = String(target).replace(/^['"]|['"]$/g, "");
  if (!raw) return "`rm -rf` 目标为空，拒绝。";
  if (/[$`]/.test(raw)) {
    return "Never 级：`rm -rf $VAR` 变量未校验即禁。先 `echo \"$VAR\"` 核对展开后的绝对路径，确认是本次产生的路径，再逐个点名删除（R-03 / R-12）。";
  }
  if (["/", "/*", ".", "..", "./*", "*", "~", "~/"].includes(raw)) {
    return "Never 级：对根目录 / 当前目录 / 通配符 / 家目录无界递归强删即禁。改成只删本次产生的具名路径（R-03）。";
  }
  const abs = raw.startsWith("~") ? expand(raw) : raw;
  if (abs.startsWith("/")) {
    if (TIER0_ROOTS.has(abs) || /^\/home\/[^/]+$/.test(abs)) {
      return "Never 级：对系统目录或整个家目录做递归强删即禁（R-03）。";
    }
    const inDispose = disposeAllow.some((r) => abs !== r && under(abs, [r]));
    if (inDispose) return undefined;
    const zones = disposeAllow.length ? disposeAllow.join(" ") : "（未配置 disposeAllow）";
    return `破坏性动词需逐命令批准：\`rm -rf\` 打在 \`${raw}\` 上。免批区（可抛弃区）：${zones}。两个合规走法：① 移到隔离区（\`mv\` 到带时间戳的 trash 目录，可恢复优先于消失）；② 先报出确切路径与影响面，得到点头再跑（R-03 / R-12）。`;
  }
  // 相对路径：以 .. 开头或含通配 ⇒ 可能逃出当前目录，拒；否则视作当前目录下的具名项
  if (raw.startsWith("..") || raw.includes("*")) {
    return `相对路径 \`${raw}\` 可能逃出当前目录，拒绝。改成明确路径，或移进隔离区（R-03）。`;
  }
  return undefined;
}

/** R-03：破坏性动词。返回路标理由，或 undefined */
function destructive(seg, disposeAllow = []) {
  const exe = argv0(seg);
  const tk = tokens(seg);
  const fl = flagsOf(seg);
  const has = (re) => tk.some((t) => re.test(t));

  if (exe === "rm") {
    const recursive = fl.some((f) => /^--recursive$/.test(f) || (/^-[^-]/.test(f) && f.includes("r")));
    const force = fl.some((f) => /^--force$/.test(f) || (/^-[^-]/.test(f) && f.includes("f")));
    if (recursive && force) {
      const targets = parseArgv(seg).rest.filter((t) => !t.startsWith("-"));
      if (!targets.length) return "`rm -rf` 未给目标：拒绝（R-03）。";
      for (const target of targets) {
        const verdict = rmTargetVerdict(target, disposeAllow);
        if (verdict) return verdict;
      }
      return undefined; // 全部落在可抛弃区 / 当前目录具名项 ⇒ 放行
    }
  }

  if (exe === "find" && (tk.includes("-delete") || (tk.includes("-exec") && tk.some((t) => /^(rm|unlink)$/.test(t))))) {
    const root = parseArgv(seg).rest.find((t) => !t.startsWith("-")) || "";
    const absRoot = root.startsWith("~") ? expand(root) : root;
    if (absRoot.startsWith("/") && disposeAllow.some((r) => absRoot !== r && under(absRoot, [r]))) return undefined;
    return "破坏性动词需逐命令批准：`find … -delete` / `-exec rm` 等同递归强删。把搜索根限定在可抛弃区可直接放行；否则先列出将被删的清单交用户核对（R-03 / R-12）。";
  }

  if (exe === "git") {
    const sub = parseArgv(seg).rest[0] || "";
    if (sub === "reset" && tk.includes("--hard")) {
      return "`git reset --hard` 丢弃未提交改动，属逐命令批准项。先 `git status --short` 看清既有改动并 commit / 备份，再向用户报备（R-12）。";
    }
    if (sub === "clean" && fl.some((f) => f.includes("f"))) {
      return "`git clean -f` 删除未跟踪文件，属逐命令批准项。先 `git clean -nd` 干跑列出清单交用户核对（R-03）。";
    }
    if (sub === "stash" && ["drop", "clear", "pop"].includes(parseArgv(seg).rest[1])) {
      return "`git stash " + parseArgv(seg).rest[1] + "` 丢弃暂存内容，属逐命令批准项。先 `git stash list` 与 `git stash show` 核对（R-03）。";
    }
    if (sub === "push" && (tk.includes("--force") || tk.includes("-f"))) {
      return "不要用 `git push --force`。改用 `git push --force-with-lease`（远端被他人更新时安全失败）。";
    }
  }

  if (["dnf", "yum"].includes(exe) && (tk.includes("remove") || tk.includes("-e"))) {
    return "系统包移除属逐命令批准项（内核误删事故即属此类）。先报出包名与依赖影响面，得到用户点头（R-03）。";
  }
  if (exe === "rpm" && tk.includes("-e")) {
    return "`rpm -e` 移除包属逐命令批准项。先报出包名与依赖影响面，得到用户点头（R-03）。";
  }
  if (exe === "dd" && tk.some((t) => /^if=/.test(t))) {
    return "`dd` 直写设备/文件属逐命令批准项。先报出 if=/of= 的绝对路径与字节数（R-03）。";
  }
  if (/^(mkfs(\.\w+)?|fdisk|parted)$/.test(exe)) {
    return "磁盘格式化/分区操作属逐命令批准项，且属 Never 级风险。停下交真人前台确认（R-03）。";
  }
  if (exe === "killall" && tk.includes("-9")) {
    return "`killall -9` 按名字广播强杀，会连带杀掉无关进程与你自己的载体。改用精确 PID：先 `ps -o pid,ppid,cmd -p <PID>` 核对（R-07）。";
  }
  if (["npm", "yarn", "pnpm", "bun"].includes(exe) && tk.includes("--force")) {
    return "`audit fix --force` 会跨大版本改依赖，属逐命令批准项。先报出将变更的包与版本跨度（R-03）。";
  }
  return undefined;
}

/** R-03：绕过 wrapper / 自动喂确认 */
function bypass(seg) {
  const exe = argv0(seg);
  if (/^\/(bin|usr\/bin|usr\/sbin)\/(rm|git|kill|killall)$/.test(exe)) {
    return "用绝对路径绕过 wrapper 属「绕过防线」，禁止。改用被包装的命令；认为必须绕过 → 先问用户并说明为什么（R-03）。";
  }
  if (/\.real$/.test(exe)) {
    return "调用 `*.real` 备份二进制属「绕过防线」，禁止（R-03）。";
  }
  // 只保留「喂进 rm/git」的无空格形态（带空格的由拆段接走）；
  // 喂进提权器的形态已改由 interactivePipe 按管道右侧判定（见其注释）
  if (/\becho\b[^\n]*\|\s*(rm|git)\b/.test(seg)) {
    return "把确认答案用 `echo … |` 喂进 rm/git = 「自己确认」，禁止。停下交真人前台确认（R-03）。";
  }
  const tk = tokens(seg);
  if (tk.some((t) => /^(SAFEEXEC|GUARD|SANDBOX|HOOK|APPROVAL)[A-Z_]*=/.test(t))) {
    return "设置「关掉检查」的环境变量属「绕过防线」，禁止。认为必须绕过 → 先问用户并说明为什么（R-03）。";
  }
  return undefined;
}

/** R-07：pkill -f 自匹配；pgrep -f 的永不退出循环 */
function selfMatch(seg) {
  const exe = argv0(seg);
  const tk = tokens(seg);
  if (exe === "pkill" && (tk.includes("-f") || tk.includes("--full"))) {
    return "`pkill -f` 匹配所有进程的完整命令行，包括运行这条命令的 shell 自己 → 会杀掉你自己的载体。改用 `pidof <可执行名>` 判在不在，再用精确 PID 杀（先 `ps -o pid,ppid,cmd -p <PID>` 核对）（R-07）。";
  }
  if (/\bpgrep\s+-[a-z]*f\b/.test(seg) && /\buntil\b/.test(seg)) {
    return "`until ! pgrep -f …; do …; done` 永不退出：pgrep 匹配到调用它的 shell 自己。改用 `pidof` 或 PID 文件（R-07）。";
  }
  return undefined;
}

/** 管道右侧 = 「交互式提权消费」⇒ 把确认答案/密码喂给自己（R-03）。
 *  只认提权器读 stdin 的形态：sudo -S / --stdin / 合并短选项里的 -S、pkexec、doas、su、confirm*。
 *  数据管道不算：`echo "内容" | sudo tee /etc/x`（写配置文件的标准写法）、
 *  `… | sudo -u nobody …`、`… | ssh …`、heredoc 体内 `grep … | sudo tee`。
 *  2026-10-19 实测收窄：旧判据 `echo … | sudo` 位置无关（跨换行/跨引号/跨 heredoc），
 *  日志 8 条 R-03 拒绝里 6 条是这种误杀，真命中只有 2 条（`echo <password> | sudo -S`）。
 *  注意：这里不能用 parseArgv —— 它会把 `sudo` 当包装器跳掉（那是破坏性判据要的语义）。 */
function interactivePipe(cmd) {
  const rights = String(cmd).split(/\s*(?:\|\&|2>\&1\s*\||\|)\s*/).slice(1);
  for (const right of rights) {
    const t = tokens(right);
    const exe = basename(t[0] || "");
    if (!exe) continue;
    const stdinSudo = exe === "sudo" && t.slice(1).some((x) => x === "--stdin" || /^-[A-Za-z]*S[A-Za-z]*$/.test(x));
    if (stdinSudo || exe === "pkexec" || exe === "doas" || exe === "su" || /^confirm/.test(exe)) {
      return `管道右侧是交互式提权消费（\`${exe}${stdinSudo ? " -S" : ""}\` 读 stdin）= 把确认答案/密码喂给自己，禁止。停下交真人前台确认（R-03）。数据管道（\`| sudo tee\` 等）不属本判据。`;
    }
  }
  return undefined;
}

/** 整条命令级判据（跨管道、跨换行的形态，拆段后看不到） */
function wholeCommand(cmd) {
  if (/: *\(\) *[:{]/.test(cmd) && cmd.includes(":|:&")) {
    return "fork bomb，禁止执行。";
  }
  // 把确认答案/密码喂进交互式提权提示（跨管道）
  const pipe = interactivePipe(cmd);
  if (pipe) return pipe;
  // pgrep -f 直接管道给杀手，且无 comm 过滤（技能认可的唯一合法形态是带 comm 过滤）
  if (/\bpgrep\s+-[a-z]*f\b/.test(cmd) && /\b(xargs[^\n]*\bkill\b|\|\s*kill\b|\|\s*pkill\b)/.test(cmd)
      && !/ps\s+-o\s+comm/.test(cmd) && !/\bcomm=/.test(cmd)) {
    return "`pgrep -f … | xargs kill` 会把匹配到的祖先进程（含你自己的 shell）一起杀掉。合法形态是带 comm 过滤：`pgrep -f … | while read p; do [ \"$(ps -o comm= -p $p)\" = python ] && kill \"$p\"; done`；先用 `ps -o pid,ppid,cmd -p <PID>` 核对（R-07）。";
  }
  return undefined;
}

/** R-12：重启宿主与后台拉起同条命令 */
function restartWithBackground(cmd, services) {
  const restart = new RegExp(`systemctl[^\\n]*\\brestart\\b[^\\n]*(${services.join("|")})`);
  if (!restart.test(cmd)) return undefined;
  // 后台操作符必须是独立的 `&`：`&&` 是链式操作符，不是后台
  // （2026-10-15 实测：`[ … ] && { … }` 里的 `&&` 被当成后台 ⇒ 合法重启被误杀）
  const backgrounded = /\bsetsid\b|\bnohup\b|\bdisown\b/.test(cmd) || /(?:^|[\s;])&(?!&)/.test(cmd);
  if (!backgrounded) return undefined;
  return "宿主重启会切断当前会话载体，连带杀掉同一调用内启动的脚本与后台 job（`setsid nohup disown` 同样被回收），闸门会跑到中途无人收尾。拆成三个独立调用：① 执行动作且本调用内不重启，当场核对产物；② 单独调用只重启；③ 单独调用跑测量与判据。需要跨重启存活就交给 systemd unit（R-12）。";
}

function expand(p) {
  return String(p).replace(/^~/, homedir());
}

/* ── 快照闸门（规则 R-12「改动可回退」的机制层兜底）────────────────
 * 判据：写入「被运行中的宿主消费的产物」⇒ 单槽快照位里必须有该目标的快照 ⇒ 无则拒绝。
 * 按消费者分类，不按文件位置分类（R-12 第一条）。
 * 已知保证不了的：快照新鲜度（闸门看不出快照是不是本次动手前做的）⇒ 靠纪律。
 */

/** snap.sh 的镜像命名：去掉前导 /，其余 / 换成 __ */
function mirrorName(p) {
  return p.replace(/^\//, "").replace(/\//g, "__");
}

/** 目标自身有快照，或某个祖先目录有 tar.gz 快照 */
function snapshotExists(slot, p) {
  const self = join(slot, mirrorName(p));
  if (existsSync(self) || existsSync(`${self}.tar.gz`)) return true;
  let cur = p;
  for (let i = 0; i < 12; i += 1) {
    const next = dirname(cur);
    if (next === cur) break;
    if (existsSync(`${join(slot, mirrorName(next))}.tar.gz`)) return true;
    cur = next;
  }
  return false;
}


/** 闸门放行前的自动快照：只对已存在的小文件同步拍一张，失败就退回拒绝。 */
function tryAutoSnapshot(slot, p, maxBytes) {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > maxBytes) return false;
    const dest = join(slot, mirrorName(p));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p, dest);
    return true;
  } catch {
    return false;
  }
}

function under(p, prefixes) {
  return prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

/**
 * 从 shell 命令里取「内容会被改写的绝对路径」。
 *
 * 第一版只做一件事：把写入类动词后面所有以 / 或 ~ 开头的 token 全算成写入点。
 * 代价是两类系统性误杀（2026-10-21 日志回放）：
 *   - 方向不分：`cp <插件文件> /tmp/备份` 把**源**也当成写入点；
 *   - 动词不分：`chmod` / `mkdir` / `touch` 根本不改内容，拍了快照和没拍一样。
 *
 * 现在按动词分类：
 *   metadata 类 ⇒ 不计（快照对它们没有意义）
 *   方向敏感类 ⇒ 只取目的地
 *   其余内容类 ⇒ 取全部目标
 */
/** 会被快照闸门关心的动词全集（metadata 类在内，但会被上面的判据先排除） */
const WRITE_VERBS = new Set([
  "rm", "mv", "cp", "install", "tee", "dd", "truncate", "rsync", "patch",
  "chmod", "chown", "chgrp", "ln", "touch", "mkdir", "rmdir", "tar", "unzip", "sed",
]);
const METADATA_VERBS = new Set(["chmod", "chown", "chgrp", "touch", "mkdir", "rmdir", "ln"]);
const DEST_ONLY_VERBS = new Set(["cp", "install", "rsync"]);
const CONTENT_VERBS = new Set(["rm", "mv", "tee", "dd", "truncate", "patch", "unzip", "sed", "tar"]);

function isPathish(tk) {
  return tk.startsWith("/") || tk.startsWith("~");
}
function clean(tk) {
  return expand(tk.replace(/^['"]|['"]$/g, ""));
}
/** 取某个选项后面紧跟的值（-C dir / -d dir / -t dir / --directory=dir） */
function optValue(rest, names) {
  for (let i = 0; i < rest.length; i += 1) {
    const tk = rest[i];
    for (const n of names) {
      if (tk === n && rest[i + 1]) return rest[i + 1];
      if (tk.startsWith(`${n}=`)) return tk.slice(n.length + 1);
      if (n.length === 2 && tk.startsWith(n) && tk.length > 2) return tk.slice(n.length); // -Cdir
    }
  }
  return undefined;
}

export function shellWriteTargets(cmd) {
  const out = [];
  // 重定向目标永远算
  for (const m of String(cmd).matchAll(/(?:^|[\s;])>>?\s*(['"]?)(\/[^\s'"]+)\1/g)) out.push(m[2]);

  for (const seg of segments(cmd)) {
    const argv = parseArgv(seg);
    const exe = basename(argv.exe);
    if (!exe || METADATA_VERBS.has(exe) || !WRITE_VERBS.has(exe)) continue;

    const rest = argv.rest;
    const operands = rest.filter((t) => !t.startsWith("-"));

    if (exe === "sed") {
      if (!rest.includes("-i")) continue;
      for (const tk of operands.slice(1)) if (isPathish(tk)) out.push(clean(tk));
      continue;
    }
    if (exe === "tar") {
      const dir = optValue(rest, ["-C", "--directory"]);
      if (dir) out.push(clean(dir));
      continue;
    }
    if (exe === "unzip") {
      const dir = optValue(rest, ["-d"]);
      if (dir) out.push(clean(dir));
      continue;
    }
    if (exe === "dd") {
      for (const tk of rest) if (/^of=/.test(tk)) out.push(clean(tk.slice(3)));
      continue;
    }
    if (DEST_ONLY_VERBS.has(exe)) {
      const td = optValue(rest, ["-t", "--target-directory"]);
      const dest = td || operands[operands.length - 1];
      if (dest && isPathish(dest)) out.push(clean(dest));
      continue;
    }
    // 内容类其余：rm / mv / tee / truncate / patch —— 全部目标都算（mv 的源也是被移走的）
    for (const tk of operands) if (isPathish(tk)) out.push(clean(tk));
  }
  return out;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const logFile = expand(cfg.logFile);
  const services = cfg.hostServices.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const allow = cfg.allowPatterns.map((p) => new RegExp(p));
  const disposeAllow = (cfg.disposeAllow || []).map(expand);
  const enabled = cfg.enabled !== false;
  const slot = expand(cfg.snapshotSlot);
  const autoSnap = cfg.autoSnapshot === true;
  const maxAutoSnapBytes = Number(cfg.maxAutoSnapshotBytes) || 8388608;
  const targets_prefix = cfg.snapshotTargets.map(expand);
  const exempt_prefix = cfg.snapshotExempt.map(expand);

  try { mkdir(logFile.replace(/\/[^/]*$/, ""), { recursive: true }); } catch { /* 目录已存在 */ }

  const log = (line) => {
    appendFile(logFile, `${new Date().toISOString()} ${line}\n`, () => {}); // 异步 fire-and-forget
  };

  const check = (exec) => {
    if (!enabled) return undefined;
    const name = exec?.name;
    const isShell = name === "bash" || name === "pwsh";
    const isArb = name === "arbitrate_run";
    const isFileWrite = name === "write" || name === "edit";

    // 快照闸门（§12）：写入宿主消费集 ⇒ 必须有单槽快照
    if (cfg.requireSnapshot !== false && (isShell || isFileWrite)) {
      const targets = isFileWrite
        ? [String(exec?.arguments?.file_path ?? "")].filter(Boolean).map(expand)
        : shellWriteTargets(String(exec?.arguments?.command ?? ""));
      const hits = targets
        .map((p) => ({ raw: p, abs: p.startsWith("/") ? p : "" }))
        .filter(({ abs }) => abs && under(abs, targets_prefix) && !under(abs, exempt_prefix));
      for (const { abs } of hits) {
        if (snapshotExists(slot, abs)) continue;
        if (autoSnap && tryAutoSnapshot(slot, abs, maxAutoSnapBytes)) {
          log(`AUTOSNAP target=${abs}`);
          continue;
        }
        return `宿主消费集内的写入没有快照，失败无法自动回退（规则 R-12）。先跑：snap.sh '${abs}'（单槽，仅留最新），再执行本次写入；还原用 restore.sh '${abs}'。豁免前缀：${cfg.snapshotExempt.join(" ")}`;
      }
    }

    if (!isShell && !isArb) return undefined; // 窄面（判据 2）

    const cmd = isShell ? exec?.arguments?.command : exec?.arguments?.script;
    if (typeof cmd !== "string" || !cmd) return undefined;
    if (allow.some((re) => re.test(cmd))) return undefined; // 逃生口

    const segs = segments(cmd);

    // 整条命令级判据先跑（跨管道/跨换行的形态，拆段后看不到）
    const whole = wholeCommand(cmd);
    if (whole) return whole;

    if (cfg.denyRestartInScript !== false && isArb && services.some((s) => new RegExp(`\\brestart\\b[^\\n]*${s}`).test(cmd))) {
      return "arbitrate_run 的脚本里含宿主重启：脚本会随会话载体被回收，marker 永远读不到。把重启拆成独立调用（③ 之后单独重启），脚本里不要重启宿主（R-12）。";
    }
    if (cfg.denyRestartWithBackground !== false && isShell) {
      const r = restartWithBackground(cmd, services);
      if (r) return r;
    }
    if (cfg.denyPkillF !== false) {
      for (const s of segs) { const r = selfMatch(s); if (r) return r; }
    }
    if (cfg.denyBypass !== false) {
      for (const s of segs) { const r = bypass(s); if (r) return r; }
    }
    if (cfg.denyDestructive !== false) {
      for (const s of segs) { const r = destructive(s, disposeAllow); if (r) return r; }
    }
    return undefined;
  };

  // guard 必须同步；自身出错一律 fail-open，绝不因防线故障锁死生产
  const dispose = ctx.tools.guard((exec) => {
    try {
      const reason = check(exec);
      if (reason) log(`DENY tool=${exec?.name} reason="${reason.slice(0, 90)}…" cmd=${String(exec?.arguments?.command ?? exec?.arguments?.script ?? "").slice(0, 160)}`);
      return reason;
    } catch (e) {
      log(`GUARD-ERROR tool=${exec?.name} err=${e?.message}`);
      return undefined;
    }
  });

  ctx.effect(() => dispose, "tool-guard: dispose monotonic guard");
  ctx.logger?.info?.(`tool-guard: guard registered (enabled=${enabled}, log=${logFile})`);
}

// 不要加 `export default apply`。
// cordis-plugin-loader 的 unwrapExports = `exports.default ?? exports`（lib/index.js:664-669）：
// 有 default 导出 ⇒ 命名空间被折叠成裸函数 ⇒ cordis 看不到 name / inject / Config，
// `inject: ["tools"]` 失效 ⇒ ctx.tools 不存在 ⇒ apply 抛错、插件被静默跳过（2026-10-15 实测踩过）。
