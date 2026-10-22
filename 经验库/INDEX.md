# 经验库索引

> 写条目前先读 [写法规格.md](写法规格.md)（12 条硬要求 + 五段模版）。
> 决定补到哪一层读 [防复发规格.md](防复发规格.md)（判层四问 + 七步 + 负样本）。
> 一行一条。**按症状 grep 这里**，命中了再看详情文件。
> **归属列** = 这次失败该在哪一层修：`harness`（守卫/lint/配置）· `model`（知识/判据）· `interaction`（接口设计）。
> **验证列** = `日期 / SLA天 / auto|manual`：`auto` 由 `bin/lint-gotchas.sh --refresh` 真跑过。

| 症状关键词（会遇到的原话） | 判据 | 正解 | 归属 | 验证 | 详情 |
|---|---|---|---|---|---|
| 秒退 零输出 毫秒级退出 启动失败 exit 0x2 9009 | 程序**没起来**，不是崩溃 | 先查 exit code / LastTaskResult，别翻程序日志 | `model` | 2026-10-22 / 90d / auto | [秒退无输出.md](秒退无输出.md) |
| 引号 空格 argv schtasks /TR 被切 参数丢失 畸形 | Windows 只有命令行字符串，没有 argv | 引号写进 .bat；任务指无空格路径；起始于也要无空格 | `model` | 2026-10-22 / 90d / manual | [Windows引号被切.md](Windows引号被切.md) |
| 计划 方案 status draft 写不进去 被拦 换个会话也拦 | 计划文件是**全局单文件**，别的会话的 draft 会拦住你 | 给计划加 `session:` 字段；历史文件不拦 | `harness` | 2026-10-22 / 30d / auto | [计划门跨会话.md](计划门跨会话.md) |
| 配置读不到 空值 肉眼看得见 grep^KEY=不中 cat -A见^@ M-^? BOM UTF-16 | `file`+`od -c`：行首 `ff fe`(LE BOM)，字符间夹 `00`(NUL)；锚定匹配必失配 | `iconv -f UTF-16 -t UTF-8`（吃 BOM），别用 `-f UTF-16LE`/裸 `tr -d '\0'` | `model` | 2026-10-22 / 90d / auto | [配置读不到-UTF16.md](配置读不到-UTF16.md) |
| 存活 起没起来 exit0 日志ok 探测不准 $! 跨会话属性丢弃 | 成功判据由被检查的调用自报=不算证据 | 带外三件套：PID+comm+etime / 心跳 mtime / tasklist SESSION | `interaction` | 2026-10-22 / 30d / auto | [成功声明不算证据.md](成功声明不算证据.md) |
| 中文注释 语法错 变量为空 0x80040005 -2147467259 编码 | 写编码≠解释器读编码（PS5.1 无 BOM 按 GBK） | 脚本正文 ASCII-only，或 UTF-8 BOM，或 pwsh 7 | `model` | 2026-10-22 / 90d / manual | [脚本被错误解码.md](脚本被错误解码.md) |
| 日志没生成 文件空 看不见失败 stdout 黑洞 GUI windowsgui 输出丢了 | 进程起来了但失败没有进程外见证者 | 错误走 stderr/显式 sink；启动器 `> out.log 2>&1`；forbidigo 禁 `fmt.Print*` | `harness` | 2026-10-22 / 90d / auto | [输出通道黑洞.md](输出通道黑洞.md) |

## 按归属层看（该在哪修）

| 归属 | 条目数 | 该做什么 |
|---|---|---|
| `harness` | 2 | 下沉 L3 守卫 / lint / 配置——模型犯不了 |
| `interaction` | 1 | 改接口设计（别让成功由被检查者自报） |
| `model` | 4 | 只能进 L0/L2 的判据与知识——模型得自己守住 |

## 维护命令

```bash
bash bin/lint-gotchas.sh            # 只检查（五段/时间戳/归属/SLA/去标识/长度）
bash bin/lint-gotchas.sh --refresh  # 真跑每条 verify_cmd，通过则把 verified_at 盖成今天
```
