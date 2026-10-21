# 本机数据层 · 入口、实测事实与陷阱

> 本机部署：`daily_stock_analysis`（DSA，MIT）—— **只用数据层，不跑它的 LLM 流水线**。
> 部署根：`/home/loong/文档/Study/Money/股票分析框架/部署-dsa`
> 本文件所有事实均本机实测；未实测的标注。

## 1. 为什么只用数据层

DSA 的 LLM 流水线**不联网检索**，写不出传导链、证据标签、最强反方。分工定死：**DSA 出数据，模型出检索与判断。**

本机单模型常驻数十 GB，**DSA 的 LLM 不得接本机 llama**（抢内存）。要 LLM 推送放云端（GitHub Actions + Gemini/DeepSeek 免费额度）。

## 2. 四个入口（全部实测 exit 0）

```bash
cd "/home/loong/文档/Study/Money/股票分析框架/部署-dsa"

# ① 个股全量数据 → JSON（15 项探测）
.venv/bin/python 探测-数据层.py <代码>          # → 数据层实测_<代码>.json

# ② 日线与异动定位（暴涨日/暴跌日）
.venv/bin/python 探测-异动定位.py <代码>        # → 日线_<代码>.csv

# ③ 大盘复盘（无 LLM key 可跑）
cd repo && ../.venv/bin/python main.py --dry-run --no-notify --force-run
#   → repo/reports/market_review_YYYYMMDD.md

# ④ 指定股票（大盘复盘 + 个股取数，个股不落报告）
cd repo && ../.venv/bin/python main.py --dry-run --stocks <代码> --no-notify --force-run
```

**代码格式**：A股 `600519`（6 位数字）；港股 `hk00700`（`hk` 前缀）；美股 `AAPL`、`2330.TW`；指数 `sh000016`、`000300.CSI`。

## 3. 实测事实（写脚本/读结果时必须知道）

> 下表「证据」列是**实测样本日志**，样本标的为某只深市 A 股。**规则本身与标的无关** —— 换任何代码行为一致。

| 事实 | 证据 |
|---|---|
| `--dry-run` = 官方「仅获取数据，不进行 AI 分析」 | `main.py:324` |
| **无 `.env`、无 LLM key 跑通** | 实测 exit 0 |
| 无 LLM 时大盘复盘走模板兜底，**数据真实** | `generate_review status=fallback_template reason=no_analyzer` |
| 个股侧明确跳过 LLM | `[<代码>] 跳过 AI 分析（dry-run 模式）` |
| 数据落 SQLite | `repo/data/stock_analysis.db` |
| **断点续传**：同日重跑跳过取数（秒级） | `<样本日> 数据已存在，跳过获取（断点续传）` |
| `--force-run` 跳过交易日检查 | 周末/节假日必加 |
| `--etf-rotation` 官方标注「不调用 LLM」 | `main.py:472`（未实测） |
| 日志落盘 | `repo/logs/stock_analysis_YYYYMMDD.log` + `..._debug_...` |
| 数据层峰值 RSS | 162 MB（14/15 探测通过） |
| LLM 配置项 | `ANSPIRE_API_KEYS` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`，`GENERATION_BACKEND=litellm` |

## 4. 数据陷阱表（别再踩）

| 陷阱 | 事实 | 处理 |
|---|---|---|
| **北向个股净买入不可得** | akshare `stock_hsgt_north_net_flow_in_em` 已移除（实测 `AttributeError`）；**2024-08-19 起停止披露** | 记 `blocked`。**任何声称能给逐日北向个股净买入的工具当可疑处理** |
| 沪深港通汇总 | 只有涨跌家数与交易状态，**无净买入额** | 不得当作北向金额 |
| **周末报价是上一交易日收盘** | `realtime_quote` 星期日返回 10-09 收盘，price/change_pct/volume/volume_ratio 与日线**逐位一致** | 写"今天涨了 X%"前跑 `date '+%A'` 核验，并与日线 CSV 末行比对 |
| 东财系限流 | `push2.eastmoney.com` / `push2his` 多次 `RemoteDisconnected` / `JSONDecodeError` | 靠新浪/腾讯 fallback；失败记缺口 |
| 个股资金流（主力/北向） | **接口级不稳定**：东财系资金流接口实测多次 `JSONDecodeError` / `RemoteDisconnected`，对 A 股标的返回 `not_supported` | 记缺口，**不写"无资金异动"** |
| 概念排行 | 实测全源失败（`TencentFetcher返回空结果`） | 记缺口 |
| akshare 多进程 | 脚本体必须包在 `if __name__ == "__main__":` 内 | 写探测脚本必加 |
| `pip` 命令 | 用 `python3 -m pip` | — |
| tiktoken cp314 | 无 wheel | 用 uv 的 Python 3.12 |
| `/tmp` 是 tmpfs | 吃内存 | 产物进工作区 |
| 龙虎榜 | 有接口，返回"不在榜"是真结果 | 记 `不在榜`，不是失败 |

## 5. 取数后的强制核验（三条）

1. **核验交易日**：`date '+%Y-%m-%d %A'` → 非交易日时报价 as-of 是上一交易日。
2. **报价与日线比对**：realtime 的 price/change_pct/volume 与日线末行一致 → 它是收盘数据（`current`），不是 `live`。
3. **失败项写进"缺失证据"**：接口名 + 错误 + 什么能补上。**不用替代值填。**

## 6. 检索层（本机 harness 提供，DSA 不参与）

- `advanced_search`（带 timeRange，用于"最近一个月"类）
- `multi_search`（多引擎交叉验证，用于需要多源确认的承重数字）
- `web_fetch`（取原文，引用要带 URL）
- `platform_search`（GitHub/V2EX/雪球类站点定向）

**检索轮次建议**（一轮完整个股分析）：产业链上下游 → 销量与结构 → 地缘与政策 → 宏观与利率 → 资金面 → 权威评级与目标价。**每轮带出处与日期。**

## 7. 方法论原文位置（要读原话时）

```
部署-dsa/方法论补丁/
├── research-conventions/SKILL.md
│   └── references/evidence.md
├── impact-analysis/SKILL.md
│   └── references/channels.md
├── sector-overview/SKILL.md
├── competitive-analysis/SKILL.md
└── 来源声明.md          ← Apache-2.0 许可与转写声明
```

本技能的 `references/evidence.md` 与 `channels.md` 是**精简可用版**；要逐条原话读上面。

## 8. 卸载

```bash
rm -rf "/home/loong/文档/Study/Money/股票分析框架/部署-dsa"
rm -rf ~/.cache/pip
```
依据 `部署-dsa/卸载指南.md`：未写 shell 配置、无 cron、无 systemd、未动系统 Python、未用 apt。
