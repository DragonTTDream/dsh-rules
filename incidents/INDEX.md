# 事故 → 规则 反向索引

> 由 `bin/index.sh` 生成，**不要手改**。正向引用看各规则的 `evidence:` 字段。

| 事故 | 日期 | 状态 | 覆盖/催生的规则 |
|---|---|---|---|
| [INC-2026-09-23-blamed-external](INC-2026-09-23-blamed-external.md) | 2026-09-23 | observed | R-14 |
| [INC-2026-09-23-broke-host-service](INC-2026-09-23-broke-host-service.md) | 2026-09-23 | observed | R-12 |
| [INC-2026-09-23-lost-context-plan](INC-2026-09-23-lost-context-plan.md) | 2026-09-23 | observed | R-06 |
| [INC-2026-09-23-memory-bloat](INC-2026-09-23-memory-bloat.md) | 2026-09-23 | observed | R-11 |
| [INC-2026-09-23-unverified-claim](INC-2026-09-23-unverified-claim.md) | 2026-09-23 | verbatim | R-01 |
| [INC-2026-10-03-noise-as-report](INC-2026-10-03-noise-as-report.md) | 2026-10-03 | verbatim | R-08 |
| [INC-2026-10-03-overreach](INC-2026-10-03-overreach.md) | 2026-10-03 | verbatim | R-03 |
| [INC-2026-10-03-wrote-into-others-docs](INC-2026-10-03-wrote-into-others-docs.md) | 2026-10-03 | verbatim | R-05 |
| [INC-2026-10-15-kill-self-shell](INC-2026-10-15-kill-self-shell.md) | 2026-10-15 | verbatim | R-07、R-12 |
| [INC-2026-10-19-loop-pollution](INC-2026-10-19-loop-pollution.md) | 2026-10-19 | verbatim | R-13 |
| [INC-2026-10-21-guard-log-leak](INC-2026-10-21-guard-log-leak.md) | 2026-10-21 | verbatim | R-07、R-12 |
| [INC-2026-10-21-guard-too-blunt](INC-2026-10-21-guard-too-blunt.md) | 2026-10-21 | verbatim | R-03、R-12 |
| [INC-2026-10-21-snapshot-gate-friction](INC-2026-10-21-snapshot-gate-friction.md) | 2026-10-21 | verbatim | R-12 |

## 反向查：某条规则由哪些事故支撑

- **R-01** ← INC-2026-09-23-unverified-claim.md
- **R-02** ← INBOX.md
- **R-03** ← INC-2026-10-03-overreach.md
- **R-04** ← INBOX.md
- **R-05** ← INC-2026-10-03-wrote-into-others-docs.md
- **R-06** ← INC-2026-09-23-lost-context-plan.md
- **R-07** ← INC-2026-10-15-kill-self-shell.md
- **R-08** ← INC-2026-10-03-noise-as-report.md
- **R-09** ← INBOX.md
- **R-10** ← INBOX.md
- **R-11** ← INC-2026-09-23-memory-bloat.md
- **R-12** ← INC-2026-09-23-broke-host-service.md
- **R-13** ← INC-2026-10-19-loop-pollution.md
- **R-14** ← INC-2026-09-23-blamed-external.md
- **R-15** ← INBOX.md
