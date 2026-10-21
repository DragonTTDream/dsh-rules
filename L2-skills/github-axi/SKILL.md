---
name: github-axi
description: GitHub 操作走 gh-axi（gh 的 agent 向包装，TOON 紧凑输出）。含命令速查、全局 flag、高频配方与已知坑。
whenToUse: 要读写 GitHub 的 issue / PR / CI run / release / repo / gist / project / secret / 讨论，或查仓库、分支、提交、workflow、API 时；用户提到 GitHub 链接、PR 号、CI 红了、提个 PR、合分支、关 issue 时。
---

# GitHub 走 gh-axi

> 为什么走 gh-axi 不走 GitHub MCP：MCP 的工具 schema **常驻、每个请求都付**；gh-axi 常驻 0，`gh-axi --help` 一次覆盖全部命令。实测数字与六路线横评见 `Deepseekword/系统深度体检-2026-10-14.md` §30–§32。

## 0. 铁律

1. **用 `gh-axi`，不用 `gh`**（输出体积 0.72x，且发现成本 1/7）。只有 gh-axi 没覆盖的才退回 `gh`。
2. **不要调 `mcp__github__*`** —— 该条目已 `disabled: true`，schema 不在上下文里。
3. 写操作（create / merge / close / delete / rerun / fork / repo create）先说后动，等用户点头。
4. 令牌在 gh keyring（`gh auth status` 可查）。**不要把令牌打印或写进对话/文件。**

## 1. 全局形态

```
gh-axi [<command>] [<subcommand>] [args] [flags]
```

- `-R/--repo <owner/name>` —— **跟在命令后面**，空格或 `=` 都行。例 `gh-axi issue list -R cli/cli`
- `--hostname <host>` 或 `GH_HOST` 环境变量 —— 企业版/GitHub 自建
- 无参数 = dashboard（自己的 open issues + PRs + 通知）
- `--help` / `-v`

17 个命令：`(空)=dashboard` `issue` `pr` `discussion` `stack` `run` `workflow` `release` `repo` `label` `gist` `project` `secret` `variable` `search` `api` `setup`

## 2. 高频配方

```bash
gh-axi                                   # 我有什么 open 的
gh-axi issue list -R o/r --state open --limit 10
gh-axi issue view 42 -R o/r --comments
gh-axi issue create -R o/r --title "…" --body-file b.md --label bug
gh-axi issue comment 42 -R o/r --body "…"
gh-axi pr list -R o/r --state open
gh-axi pr view 42 -R o/r --comments --reviews --checks
gh-axi pr diff 42 -R o/r
gh-axi pr checks 42 -R o/r
gh-axi pr create -R o/r --title "…" --body-file b.md --base main --head feat
gh-axi pr merge 42 -R o/r              # 写操作，先问
gh-axi run list -R o/r --limit 5
gh-axi run view <id> -R o/r --log-failed
gh-axi run rerun <id> -R o/r --failed
gh-axi workflow run <name> -R o/r --ref main   # 触发起用 workflow，不是 run
gh-axi repo view o/r
gh-axi repo list <owner>
gh-axi search "query"
gh-axi api /repos/o/r/pulls/42 --jq '.title'
gh-axi api POST /repos/o/r/issues --field title="Bug"
```

子命令全集：`gh-axi <命令> --help`（issue 14 个 / pr 15 个 / run 7 个 / repo 6 个）。

## 3. 输出形态与读法

- 输出是 **TOON**（紧凑表）：`count: 10 of 1039 total` + `issues[10]{number,title,state,author,created}:` + 每行一条。
- 末尾常有 `help[N]:` —— 那是它给的下一步提示，**照着用，别再去查 `--help`**。
- 长文本会被截断；要全文加 `--full`。日志长输出保留尾部并给 `full_log` 路径供 grep。

## 4. 已知坑（本机踩过）

| 坑 | 说明 |
|---|---|
| `gh` 的 JSON 字段名和直觉不一致 | CI run 的 id 字段是 **`databaseId`**，不是 `runNumber`（实测 `gh run list --json runNumber` 直接报错）。gh-axi 无此问题 |
| 触发 workflow 用 `workflow run`，不是 `run` | `run` 只管已存在的 run；dispatch 要 `gh-axi workflow run <name> --ref <ref>` |
| `--attach` 要 gh ≥ 2.99.0 | 发行版仓库的 gh 常低于此 → 装系统包前先 `gh --version` 核对 |
| 耗时不可作为路线判据 | 同一批任务里两条路线互有胜负，方向不稳定 → 由 API/网络抖动主导，只比体积 |
| 令牌 scope 是全量 | 含 `delete_repo` / `user` / `admin:org` 等高危项 → **删库、改账号、动组织类操作一律先问** |

## 5. 回退

`gh-axi` 不覆盖的动作用 `gh`。gh 的 `--json` 字段表用 `gh <cmd> --help` 查 —— 每次几百到上千 token，比 gh-axi 贵一个量级，别当查询器用。
