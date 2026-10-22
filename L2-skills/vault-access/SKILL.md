---
name: vault-access
description: 取密钥、令牌、账号口令时的唯一入口：用已免密的 dsh-vault CLI（list / get / env），而不是读 .env 或 credentials.json，也不是把明文写进命令行。含条目不存在时该做什么。用户提到 API key、token、密码、数据库口令、远端登录、要调第三方服务时用。
whenToUse: 需要 API key / access token / 账号密码 / 数据库口令 / SSH 口令、要调第三方服务、要连远端主机、某条命令缺凭据、或正想从 .env / credentials.json / .netrc 里找值时。
---

# 取密钥

> 唯一来源是 vault。CLI 已免密（主密码由本机加密凭据解锁），**不要读文件、不要问用户、不要绕**。

## 三条命令

```bash
dsh-vault list              # 找条目：标题/用户名/主机，不含秘密
dsh-vault get <条目名>       # 取一个值到 stdout，直接进管道或变量
dsh-vault env               # 整组 "env" 标签条目，KEY=VALUE 一次拿
```

- 取到的值**不要贴进对话**：`K=$(dsh-vault get xxx)` 然后引用变量。
- 看有哪些字段（不含秘密）：`dsh-vault show <条目名>`。
- 一次性验证码：`dsh-vault totp <条目名>`。
- 只想确认条目在不在：`dsh-vault get <条目名> --mask`。

## 没有这个条目

- 让用户用 `vault_add`（写库要用户确认）或在 Settings → Credentials 里加。
- **不要**退回 `.env` / `credentials.json` / `.netrc`，也不要让用户把口令贴进对话。

## 坑

- 命令行里写字面量凭据会被守卫拦（会进会话日志与 `ps`）；一律用 `$(dsh-vault get …)`。
- `dsh-vault env` 只导出带 `env` 标签的条目；没标签的用 `dsh-vault get <名>` 照样能取。
- 脚本需要多个值时用 `dsh-vault env`，别一条条 `get`。
