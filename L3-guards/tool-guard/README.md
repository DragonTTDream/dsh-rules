# tool-guard — 把「能静态判定的纪律」换成硬拒绝

模型看不到这个插件，也绕不过它：它在工具真正执行前做一次单调检查，命中就拒，
并把**为什么拒 + 该怎么做**回灌给模型。拒绝消息是路标，不是墙。

- 为什么这一层存在：[`../deny-list.md`](../deny-list.md)
- 源码：[`index.js`](index.js)
- 陷阱用例：[`test/matrix.mjs`](test/matrix.mjs)（117 项，当前全绿）

## 它拦什么

| 编号 | 拦什么 | 例子 |
|---|---|---|
| G-1 | 按完整命令行匹配的进程查询与杀灭 | `pkill -f <模式>`、`until ! pgrep -f <模式>; do …` |
| G-2 | 破坏性动词 | `rm -rf`、`git reset --hard`、`git clean -f`、`find -delete`、包移除、`dd`、`mkfs`、`killall -9` |
| G-3 | 绕过手法 | 绝对路径调 `rm`、`*.real`、`echo … \|` 喂确认、设「关掉检查」的环境变量 |
| G-4 | 重启 + 后台叠加 | 同一条命令里既重启宿主又 `&` / `setsid` / `nohup` / `disown` |
| G-5 | 脚本内的重启 | 提交给长任务的脚本正文里含宿主重启 |
| G-6 | 无快照写宿主消费集 | 写入运行中服务在读的路径，而该路径没有快照 |

## 生成物静态检查：分级放行（E 拦 / W 只记）

第一版是「看到即拦」，台账 25 行全 deny、69 条命中里 66 条是「命令不存在」，其中两类**已实测是误报**：
脚本里自己定义的函数（`check(){ … }; check`）、`case` 分支的通配模式（`*快照*)`、`*R-11-*.md)`）。
现在按形状分两档，**只有 E 档允许拦**：

| 档 | 判据（逐条写死，全满足才是 E） |
|---|---|
| E `syntax`（bash，含 `arbitrate_run`） | **判据 2026-10-23 起交给 shellcheck**：`shellcheck -s bash -f json -S <shellcheckSeverity> -`，stdin 喂脚本（不写临时文件）。`level=error` ⇒ E；`warning/info/style` ⇒ W。**必带 `-s bash`**——不带时 `rm -rf /` 会多出 SC2148（level=error）：实测带 `-s bash` 是 0 条，不带是 1 条。shellcheck 就绪时**不再跑 `bash -n`**（同一问题不在两处报）；未就绪 ⇒ 显式降级（见下）并回退 `bash -n` 出 E。多条 E 折叠成一条，SC 码进台账 `codes:[…]` |
| E `command-missing` | 该词元在**简单命令的 argv0 位**；形态 `[A-Za-z][A-Za-z0-9._-]*`（不含 `$ * ?` 引号 花括号 斜杠）；不在本脚本里被 `NAME()` / `function NAME` 定义；不是内建（表内置在 `SHELL_BUILTINS`，含 `readonly`/`times`）；不在 `case…esac` 的模式位；不是 `command -v`/`type`/`hash` 的参数；不在 heredoc 正文；在 PATH 与 `/bin /usr/bin /usr/local/bin /sbin /usr/sbin ~/.local/bin` **全部**查无；且 shell 是 bash。**保留自研**：实测 shellcheck 对 `mkdri /tmp/a` 是 0 条（它不判命令存在性） |
| E `path-missing` | 沿用原判据（绝对字面源 + 父目录存在 + 文件不存在），本来就保守。shellcheck 也不判这个 |
| E `syntax`（pwsh） | **2026-10-23 起是真判据**：`pwshParser: auto`（默认）⇒ 懒加载 `import("tree-sitter")` + `import("tree-sitter-powershell")`（**只能动态 import**：实测 `require("tree-sitter-powershell")` 抛 `ERR_REQUIRE_ASYNC_MODULE`）。解析出 `ERROR`/`MISSING` 节点 ⇒ E，逐条 `code:"TS-ERROR"`、`text` 带节点类型与行列（取前 4 个），折叠成一条进拒绝文案。实测形状（逐字）：坏 `$x = 1 +` + `if (` + `Write-Host "hi` ⇒ `root=ERROR` + 2 个 ERROR 节点；合法 `$x = Get-Process \| Where-Object { $_.CPU -gt 1 }` + `Write-Output $x` ⇒ `root=program` + 0 个 |
| W（永不拦） | 函数名、`case` 通配、变量展开、引号载荷、子 shell/`$()` 内部、heredoc 正文、非字面形态、pwsh 的 cmdlet、shellcheck 的 warning/info/style 档 |
| W `shellcheck-missing` | **显式降级**：`shellcheckPath` 不存在/不可执行/spawn 失败/超时/JSON 坏 ⇒ 不报错、不拦，出这一条 W，并且拒绝文案里写明「shellcheck 未就绪（路径/权限），语法判据本轮失明」。台账行带 `notices:[…]`。**不接受"判据坏了算通过"** |
| W `pwsh-no-parser` | **显式降级**：`pwshParser:off`，或 `auto` 但解析器没装 / 装载超时（预算内没到）/ 装载中（首次调用时 import 还没落地）/ Parser 构造或解析抛错 ⇒ 出这一条 W，`reason` 写明是哪一种，文案「pwsh 无语法解析器，本轮语法判据未参与检查（非通过）」。用户明确不接受 pwsh 静默全 W。**装载失败会缓存**（不每次重试，否则每次 pwsh 调用都付一遍 2s 预算） |
| W `non-bash-shebang` | **缺口1（2026-10-23）**：首行 shebang 的解释器不在 `sh/bash/dash/zsh/ksh/env` 白名单（例 `#!/usr/bin/env python3`、`#!/usr/bin/node`、`#!/usr/bin/pwsh`）⇒ **跳过 shellcheck**，出这一条 W（写明解释器与「已跳过，非通过」），`command-missing` / `path-missing` 照跑。实测：python 正文喂 `-s bash -S error` 出 SC1036/SC1088/SC1065 三条噪声 E——拦下来等于把"解释器不匹配"报成"脚本语法错" |

开关与失效症状：

- `staticCheckMode: off | log | deny`，默认 **log**。
- `staticCheckLogUntil`（默认 `2026-10-29`）：`mode=log` 且今天晚于该日 ⇒ **自动按 deny 处置**（灰度到期收紧）；写成非 ISO 日期或留空 ⇒ 不收紧（宁可继续灰度，不可把生产锁死）。
- `shellcheckPath`（默认 `/home/loong/.local/bin/shellcheck`）/ `shellcheckSeverity`（默认 `error`，用户批准的中档：error 拦、warning 只记）/ `shellcheckExclude`（默认 `[]`，元素 `SC2148` 或裸数字 `2148`；剔除按整脚本生效，台账 `excluded:[…]` 留痕）/ `shellcheckTimeoutMs`（默认 **`15000`**，**必带超时**：实测每次 2ms、2 万行 4.5s ⇒ 原默认 5000 会撞线，缺口3 已抬到 15000；撞线文案写明「超时 Ns（shellcheckTimeoutMs=…，默认 15000）」）。
- `pwshParser`（默认 **`auto`**）：`off` ⇒ `{available:false, reason:'config off'}`；`auto` ⇒ 懒加载两个 npm 包（`tree-sitter@0.25.1` + `tree-sitter-powershell@0.26.4`，装在 `~/dsh-tool-guard/node_modules`）。装载产物是**模块引用缓存**（只读装载产物，不是 per-agent 状态：里面没有 agent 身份/计数/历史；可变的按 agent 键）。装载在插件加载阶段"预约"、宿主启动不等它，import 有 `pwshLoadBudgetMs=2000ms` 预算（DEFAULTS 项，**不是配置键**：宿主 Config schema 严格，多一个键整份配置被拒）。
- 失效症状①「改了不生效」：先确认不是 effectiveMode 把 log 抬成了 deny（今天已过到期日）。
- 失效症状②「台账没新行」：mode 被显式设成 `off`，或命中全被行内豁免（台账里会有 `kind:"exempt"` 行）。
- 失效症状③「语法错没拦」：台账行有 `rule:"shellcheck-missing"` ⇒ shellcheck 没就绪（本轮语法判据失明，已写进拒绝文案），此时 bash 语法走 `bash -n` 兜底。
- 失效症状④「某个 SC 码不见了」：它在 `shellcheckExclude` 里（台账 `excluded:[SC…]`）。
- 失效症状⑤「python/node 脚本被 shellcheck 拦下来」：台账应出现 `rule:"non-bash-shebang"`（出现 = 已跳过，非通过）；没出现 = 首行不是 shebang，或解释器基名被判成 bash 系。
- 失效症状⑥「bash 脚本被跳过了」：白名单 `SHEBANG_BASH_INTERPRETERS` 写漏名字——**改代码，改配置没用**（该白名单不是配置键）。
- 失效症状⑦「pwsh 语法错没拦」：台账行 `rule:"pwsh-no-parser"` ⇒ 看它的 `reason` 分辨是 off / 装载中 / 装载超时 / 求值抛错；`codes:["TS-ERROR"]` 出现才是真判据跑过。
- 失效症状⑧「撞线只看到 spawn 失败」：升级后降级文案写明「超时 Ns（shellcheckTimeoutMs=…，默认 15000）」，看到这句就是撞线，不是 shellcheck 坏了。

**notices 让模型看见（缺口4，2026-10-23）**：`notices`（shellcheck 未就绪 / pwsh 无解析器 / 非 bash shebang 跳过）不再只进台账——
- `mode:"deny"`：拼进拒绝文案，前缀「**显式降级（不是「已检查通过」）**」（与改造前逐字一致）。
- `mode:"log"`：处置段**不返回文本**（返回字符串＝拒绝，会把灰度档的"放"变成"拦"，实测 `dsh-tools/lib/index.js:2646 guardReason`），
  所以走非拦截通道：`tools/post-execute` 返回 `{kind:"accept", additionalContexts:[UserMessage]}`（实测同型实现 `@deepseek-ai/dsh-repeat-tool-reminder`），
  文案前缀「**显式降级（未拦截，仅告知）**」。拦/放判定不变——判据仍是 E 命中，accept 只追加告知。

行内豁免（只关指定 rule，不产生新语义）：

```bash
# guard: allow command-missing 是本脚本里定义的函数
```

原因必填：去空白后 <3 字符 ⇒ 豁免**无效**，命中照常拦并写「豁免无效（缺原因）」，台账行带 `exemptInvalid`。
生效的豁免单独落一行 `kind:"exempt"`（可统计豁免了多少次）。

复核台账（precision 只看已复核部分）：

```bash
bin/static-stats.sh                       # 命中 N / E x / W y / fp m / true k / precision = k/(k+m)（未标 u）
bin/static-verdict.sh 12 fp "case 通配被当命令"   # 只追加 verdict 行，不改原行
```

台账新字段（历史行不改写）：`tier`、`rule`/`rules`、`shell`、`verdict:"unreviewed"`、`exempt`（可无）；
2026-10-23 再加 `codes:[…]`（本轮命中的判据码：SC 码 / `TS-ERROR`）、`excluded:[…]`（被 `shellcheckExclude` 剔除的码，剔除必留痕）、
`notices:[…]`（显式降级文案：shellcheck 失明 / pwsh 无解析器 / 非 bash shebang 跳过）——只有剔除没有命中时也会落一行，否则事后查不到「为什么没报」。
样本用例：[`test/static-check-samples.mjs`](test/static-check-samples.mjs)（末行 `STATIC-SAMPLES GREEN`）、
[`test/shellcheck-adapter.mjs`](test/shellcheck-adapter.mjs)（shellcheck 适配器 + pwsh 语义更新后的断言，末行 `SHELLCHECK-ADAPTER GREEN`）、
[`test/pwsh-parser.mjs`](test/pwsh-parser.mjs)（pwsh 真判据 + 缺口1/3/4，末行 `PWSH-PARSER GREEN`）。跑批：`bash run-suite.sh` ⇒ 「--- 跑了 13 个测试文件」+ `GUARD SUITE GREEN`（跑批不用管道吃 rc）。

## 递归强删：按目标分档，不按动词分档

第一版把 `rm -rf` 整类拒掉，结果是**删自己刚建的临时目录也要过一次人工**。
拿线上日志回放：56 条递归强删拒绝里，**53 条是这种噪音**（`/tmp` 下的临时目录、
`__pycache__`、当前目录下的具名草稿目录）。

新判据只看**目标**：

| 目标形态 | 判定 |
|---|---|
| `/`、`/*`、`.`、`..`、`*`、`~`、`$VAR`、`${VAR}` | **Never 级，一律拒** |
| 系统目录整根（`/etc`、`/usr`、`/var`…）或整个家目录 `/home/<user>` | **一律拒** |
| 落在 `disposeAllow` 里的**具名子项**（如 `/tmp/x`、`/var/tmp/x`、`~/.dsh-work/run-1`） | **放行** |
| `disposeAllow` 的**根本身**（如 `/tmp`） | 拒（整根强删不是清理） |
| 其它绝对路径 | 拒，理由里给两条合规走法（移隔离区 / 先报批） |
| 相对路径且不以 `..` 开头、不含通配 | **放行**（视作当前目录下的具名项） |
| 相对路径以 `..` 开头或含通配 | 拒（可能逃出当前目录） |

`find … -delete` / `-exec rm` 同规则：搜索根在可抛弃区内 ⇒ 放行，否则拒。

回放结果：`rm -rf` 56 条 → 放行 53；`find -delete` 10 条 → 放行 7
（仍拒的 3 条是搜索根写成变量的形态，变量值无法静态解析，保持拒绝）。

## 快照闸门：从人工仪式改成自动拍摄

闸门要求「写宿主消费集之前必须有快照」本身是对的。但它把**执行快照**这件事
推给了模型：先被拒一次、被告知跑 `snap.sh`、跑完再重写一次。97 次拒绝里有
**52 次**的目标是文件，最大的 36 KB——这笔流程税完全可以省掉。

现在：目标若是**已存在的普通文件**且小于 `maxAutoSnapshotBytes`，
守卫**同步拍一张**再放行，日志记 `AUTOSNAP`。

| 目标形态 | 行为 |
|---|---|
| 已存在的小文件（< 8 MB） | 自动拍摄 ⇒ 放行 |
| 目录 | 拒（整目录 tar 可能几百 MB，不能卡住每个工具调用） |
| 超大文件 | 拒 |
| 不存在的路径 | 拒（拍不出快照 = 没有退路） |

写入门店口径：`autoSnapshot: true` 才启用，默认关。

## 日志与凭据

守卫会把每次拒绝的命令前缀写进日志——**这是数据出口，不是纯内部字段**。

实测踩过：日志里出现 10 处 `sshpass -p <口令>`，文件权限还是 644。
现在：口令类字段一律遮蔽成 `***`（sshpass 口令、`--password`、各类
`*PASSWORD*/PASSWD/SECRET/TOKEN/API_KEY=`、`Authorization` 头，大小写不敏感），
日志权限每次启动收紧到 `600`。

教训见 [`../../incidents/INC-2026-10-21-guard-log-leak.md`](../../incidents/INC-2026-10-21-guard-log-leak.md)。

## 变量：能静态解出就按解析结果判

同一条命令里先赋值、再在删除或查找里引用，是日常高频形态：

```bash
Q=/tmp/build-scratch
# 之后在命令里引用 Q
```

第一版把所有"目标是变量"的情况一刀拒掉，误杀面很宽。现在会先收集同一条命令内的
**字面量赋值**（不含 `$` 与反引号的值），把 `$VAR` / `${VAR}` 前缀替换掉再判；
解不出来（未赋值、命令替换、来自外层环境）仍旧拒绝。

## 关键实现选择（都有代价，看懂再改）

1. **窄面**：只判 shell 工具、长任务脚本工具、文件写工具，别的一概不碰。
2. **归一化后匹配**：拆段 + 去反斜杠转义，堵「换行藏命令」。**不拦** `$()` / `${}`——
   合法用法太广，误杀面大于绕过收益。
3. **fail-open**：守卫自身出错一律放行并记日志。防线故障绝不能把生产锁死。
4. **单调**：在所有其他前置检查之后求值，返回值不被其他监听翻回允许。
5. **同步**：守卫函数必须同步返回；日志异步 fire-and-forget。
6. **逃生口**：`enabled: false` 降级成只记日志；`allowPatterns` 正则豁免。

## 一个真实误杀，写在这里免得别人再踩

守卫**只看命令字符串，不看文件内容**。所以用 shell heredoc 写一份「文档」时，
如果文档正文里含有 `pkill -f` 这类示例串，**写文档这个动作本身会被拒**。

判据：拒绝发生在执行前，触发源是命令串里的字面命中，与你要写去哪无关。

绕法（不是绕过防线，是选对写入通道）：这类含示例命令的文档用非 shell 的写文件工具落盘，
或用 `printf '%s'` 逐行拼、避免在命令串里出现完整形态。

## 跑陷阱用例

```bash
npm i                 # 只依赖 DSH 自带的 schema 库
node test/matrix.mjs  # 117 项，全绿才算没退化
```

矩阵是纯函数级：给一段命令，断言「必须拒」或「必须放行」。
改判别器前先跑一遍——**红了的用例比绿了的用例值钱**。
