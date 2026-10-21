# 依赖与 bundle 清单（摘要）

> 权威在 `~/.dsh/profiles/web/package.json`。该文件含 `link:/home/<user>/...` 这类本机路径，
> 不进公开仓；本文件只记**装了什么**，重装时按名字装回。

## 自制插件（用 link 挂载，本机路径）

| 插件 | 作用 | 仓内 |
|---|---|---|
| `dsh-self-recall` | 保活 + 串行资源仲裁（`arbitrate_*`） | `L4-plugins/self-recall/` |
| `dsh-vision-forward` | 视觉带外转发（`vision`） | `L4-plugins/vision-forward/` |
| `dsh-tool-guard` | 强制守卫（`ctx.tools.guard`） | `L3-guards/tool-guard/` |

## 社区插件（版本以 package.json 为准，装回时锁同版本）

`dsh-vault` · `dsh-free-search` · `dsh-my-guardian` · `dsh-token-monitor` · `dsh-session-manager`
· `dsh-chime` · `dsh-web-fetch-enhanced` · `dsh-web-mobile` · `dshmarket`
· `@mzzsfy/dsh-model-capability-editor` · `@weibaohui/skills-management` · `billion-context`
· `@deepseek-ai/dsh-mcp-client`

## 已禁用但保留配置的

- `mcp-github`（49 工具 = 12,235 token 常驻/请求；改走 `gh-axi`）— 恢复 = 删掉 `disabled: true`
- `hindsight` / `browserskill` / `tool-plugin-manager`
