---
status: active
verified_at: 2026-10-22
verify_cmd: bin/gotchas-verify/utf16-config.sh
verify_sla_days: 90
strength: must
fault_layer: model
fault_why: 知识缺口：文本层与字节层不是同一个东西
sink_why: "读文件当下才发现；除非对每次配置读取加字节嗅探，否则不可静态判"
---

# 配置里明明有值，程序读出来是空（UTF-16LE + BOM）

## 症状（下次会冒出来的话）
- 「config.ini 里明明写着 `TIME=07:30`，脚本 grep 出来是空的」
- 肉眼打开编辑器看得见，`grep '^KEY=' file` 返回 0 行 / 空串
- `cat -A` 看到每两个字符中间夹着 `^@`（NUL），行首有 `M-^?M-~`
- 症状关键词：读不到 空值 看得见 grep不中 BOM UTF-16 零宽 ^@ M-^?

## 判据（怎么确认）
```
file config.ini            # → "Unicode text, UTF-16, little-endian text"
od -c config.ini | head    # → 377 376 T \0 I \0 M \0 E \0 = \0 ...
od -A x -t x1z config.ini  # → ff fe 54 00 49 00 ...（ff fe = LE BOM，每个 ASCII 后跟 00）
```
- 行首字节是 `ff fe`（UTF-16LE 的 BOM），不是文件内容的一部分。
- 锚定匹配 `grep '^TIME='` **必失配**：第 1 个字符是 `\377`，正则要求行首是 `T`。
- 中间夹的 `\0`（NUL）让普通文本工具（cut/awk/sed 逐行）把值截断在第一个 NUL 前 → 空串。

## 正解（能直接抄的骨架）
一次性转成 UTF-8（`iconv -f UTF-16` 会自动吃掉 BOM，别用 `-f UTF-16LE`，那会把 BOM 当字符留下）：
```
cp -a config.ini config.ini.bak.$(date +%Y%m%dT%H%M%S)   # 先快照（R-12）
iconv -f UTF-16 -t UTF-8 config.ini > c.tmp && mv c.tmp config.ini
file config.ini                                          # → ASCII text
./deploy.sh                                              # → scheduled at 07:30
```
只想去 NUL 保留 BOM 的 `tr -d '\000'` **不够**：BOM 还在行首，锚定 grep 依旧失配。

## 反例（别这么干）
- 「文件我看过了，内容是对的」→ 肉眼/编辑器会解码显示，看不见 BOM 与 NUL。**看内容不算看过字节**。
- `tr -d '\000'` 单独用：去掉了 NUL 却留着 `ff fe`，锚定匹配继续失败。
- `-f UTF-16LE`：把 `ff fe` 当成正文里的字符转出来，UTF-8 输出行首多了 `ef bb bf`（UTF-8 BOM），下一轮锚定匹配又栽。

## 通用判据（一句话）
**「肉眼看得见、程序读不到」⇒ 第一件事 `file` + `od -c` 看字节层，别在文本层找 bug。**
编辑器按 Unicode 解码给你看；grep/cut/awk 按字节匹配，BOM 与 NUL 对它们是真实字符。

## 边界

适用**按字节或单字节 locale** 读取的工具（grep/cut/awk/sed）；消费端支持 `--encoding`/`iconv` 时可直接转码，不必改数据文件。
只解释「文件里明明有值、程序读不到/读成空」；**不解释**「读到了值但内容不对」（那多半是 CRLF、行尾空格、BOM 残留）。
不覆盖无 BOM 的 UTF-16（需启发式探测，容易误判，不做）。
