> **自拟，非手册原文。** 这是 `docs/intake-checklist.json` 的格式说明，配套 `intake-checklist.schema.json`（JSON Schema draft 2020-12）。手册 3.6 节和附录 B.7 仍是权威源；两者冲突时以手册为准。

# 接入清单（机器可读版）格式说明

`docs/intake-checklist.md` 是给人看的表格；`docs/intake-checklist.json` 是同一份内容的机器可读版，由干活 agent 按 `P-C4-intake-machine` 提示词转换，由你在本机用校验脚本检查。样例见 `intake-checklist.sample.json`（手册 3.6 节 12 行样例表的转换结果）。

校验命令（在你自己的电脑上，仓库根目录运行；校验脚本不会复制进项目）：

```
python -I tools/preflight/validate_intake.py docs/intake-checklist.json
```

通过退出码 0；有违规退出码 1 并逐条打印"字段路径 + 违反的规则"，**不打印值**；退出码 2 表示脚本或 Schema 自身有问题。

## 1. 总体结构

| 顶层字段 | 含义 |
|---|---|
| `schema_version` | 固定为 `1` |
| `items` | 沙箱/测试/开发环境的接入项。顺序同 md，需要等待的项排最前 |
| `manual_only` | 生产和不可逆操作相关项，**无人值守运行中不使用**（可为空数组） |

## 2. `items` 每一项的字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写字母、数字、连字符，整个文件内唯一 |
| `name` | 是 | 项目名称 |
| `where_to_get` | 是 | 去哪里取、点什么（对应 md 的"你要做什么"） |
| `budget_alert` | 是 | 预算或告警；没有写 `null`（md 里的"—"） |
| `callback_url` | 是 | 固定回调地址（路径或不带查询串的 URL）；没有写 `null`。示例用 `example.com`，不得带 `?`、`#`、`@` |
| `placements` | 是 | 四处落点，见第 3 节。值只写变量名 |
| `forbidden_placements` | 是 | 禁止落点，见第 4 节 |
| `smoke` | 是 | 冒烟方式，只能从第 5 节的预定义类型里选 |
| `verify_step` | 是 | 在哪一步验，枚举 `D1` / `D3` / `E2` / `E3` |
| `status` | 是 | 状态四档，见第 6 节 |
| `evidence` | 是 | 脱敏证据，见第 7 节；没有写 `null` |
| `waiting_for` | `pending` 时必填 | 在等什么（域名解析、账号审核、充值等） |
| `credential_scopes` | 带机器账号令牌时必填 | 令牌权限范围，不得含 `workflow`（R7） |
| `notes` | 否 | 备注。md 里写了多个验证步骤时，枚举内的主检查放 `verify_step` / `smoke`，其余（含 A1、D2、G2 这类枚举外步骤）写这里 |

关于 `verify_step`：手册 3.6 节有些行写了多个步骤，或写了 A1 / D2 / G2。机器版只收一个主检查，选能由体检脚本自动做的那一步；枚举外的步骤是人工步骤，写进 `notes`。

## 3. 四处落点 `placements`

对应附录 B.7 的四列。GitHub 一列拆成"仓库级 Secrets"和"`db-admin` Environment"两个键，所以共五个键，**必须全部出现**，没有就写空数组 `[]`（md 里的"—"）：

| 键 | 落点 |
|---|---|
| `local_env_local` | 本机 `.env.local` |
| `server_env_file` | 服务器环境文件或服务配置 |
| `vercel_preview` | Vercel Preview |
| `github_repo_secrets` | GitHub 仓库级 Secrets |
| `github_environment_db_admin` | GitHub Environment `db-admin`（目前唯一接受的 Environment） |

每个键的值是**变量名数组**，变量名只能是大写字母、数字、下划线。**绝不写密钥值。** 不是环境变量的凭据（AI 命令行登录、机器账号登录）用大写的逻辑名代表，如 `AGENT_CLI_LOGIN`，并在 `notes` 说明。

## 4. 禁止落点 `forbidden_placements`

数组，元素取自五个落点键加 `git_repository`。含义：这一项的变量**不许**出现在这些地方。

- 必须含 `git_repository`（密钥永不进仓库）。
- 列在这里的落点，对应 `placements` 里必须是空数组（R10，自相矛盾会被拒绝）。
- 没有任何变量的项（如规则集），建议把六个全列上。
- 用到 `db-admin` 的项，必须同时禁止 `local_env_local`、`server_env_file`、`vercel_preview`、`github_repo_secrets`（R3）。

## 5. 冒烟方式 `smoke`（只许预定义类型，不许自由写命令）

每个类型的字段都是固定的，**多写任何字段（如 `command`）都会被拒绝**。需要别的检查方式时，用 `manual` 并把人怎么确认写清楚，不要自造类型。

| `type` | 必填参数 | 说明 |
|---|---|---|
| `http_status` | `base`（`preview_url` / `integration_url` / `callback_url`）、`url_path`（以 `/` 开头，无查询串）、`method`（`GET` / `HEAD`）、`expect_status`（100-599） | 可选 `with_automation_bypass: true`，表示带 Vercel 放行头请求 |
| `query_balance` | `what`（查什么，至少 4 个字）、`read_only`（必须为 `true`）、`expect`（`reachable` / `balance_at_least`） | `expect` 为 `balance_at_least` 时必须给 `threshold`，为 `reachable` 时不许给 |
| `dns_resolve` | `domain`、`record_type`（`A` / `AAAA` / `CNAME` / `MX` / `TXT` / `NS`）、`expect_value` | 域名可写占位 `<域名>` |
| `tcp_connect` | `host`、`port`（1-65535） | 可选 `timeout_seconds`（1-30）。只测端口通不通 |
| `gh_api_read` | `api_path`（以 `/repos`、`/orgs`、`/user`、`/users`、`/rate_limit` 开头，无查询串，无 `..`）、`method`（只能 `GET`）、`expect_status`、`expect`（预期结果的文字说明） | 只读 `gh api`；路径里的占位用英文，如 `<owner>`、`<repo>` |
| `file_perm` | `path`（以 `/` 或 `~/` 开头，不含空格、引号和 shell 符号）、`expect_mode`（如 `600`） | 只查权限位 |
| `manual` | `how_to_confirm`（人怎么确认，至少 12 个字）、`expect`（至少 4 个字） | 人工确认 |

`manual_only` 里的项只能用 `manual`。

## 6. 状态四档 `status`

| 值 | 含义 | 附带规则 |
|---|---|---|
| `not_started` | 未开始 | `evidence` 必须是 `null` |
| `pending` | 已发起（等待项） | 必须写 `waiting_for` |
| `configured` | 已配置 | `evidence` 可有可无 |
| `verified` | 已验证 | `evidence` 必须有，且 `conclusion` 为 `pass` |

转换 md 为 JSON 时状态**照抄**，不得因为写了 JSON 就升档。md 里没有"已发起"这一档的，按 md 原状态填。

## 7. 脱敏证据 `evidence`

只允许三个字段，多写会被拒绝：

| 字段 | 说明 |
|---|---|
| `conclusion` | `pass` / `fail` / `pending` |
| `checked_at` | 时间，格式 `2026-01-01T08:00:00Z` |
| `summary` | 脱敏摘要，如 `HTTP 200`；最长 120 字，只允许字母数字、中文、空格和 `.,:%()/_=-` |

`summary` 里出现形如令牌的串会被拒绝（R6）：`ghp_`、`gho_`、`github_pat_`、`sk-`、`eyJ`、`xox*-`、`AKIA…`、`-----BEGIN`、`0x` 加 32 位以上十六进制，以及连续 24 个以上的字母数字串。其他文本字段用同一套规则，门槛放宽到连续 40 个以上。

## 8. 规则编号对照（校验输出里的 `R*`）

| 编号 | 规则 | 依据 |
|---|---|---|
| R1 | 冒烟方式只能是预定义类型，不许自由命令 | 本文第 5 节 |
| R2 | 状态只有四档 | 本文第 6 节 |
| R3 | `SUPABASE_ACCESS_TOKEN` 和数据库密码（变量名形如 `*_DB_PASSWORD`、`PGPASSWORD`）只能出现在 `github_environment_db_admin`，其他落点**一律判为非法** | 附录 B.7 |
| R4 | 主网私钥、助记词、生产密钥、`ALLOW_MAINNET` 不得出现在任何落点。变量名含 `MAINNET`、`MNEMONIC`、`SEED_PHRASE`，或含独立的 `PROD` / `PRODUCTION` 一段，即判非法 | 附录 B.7 |
| R5 | 生产和不可逆项只放 `manual_only`，不带落点、不带 `verify_step`，`unattended_use` 必须为 `false` | 手册 3.6 节、P-C4-intake |
| R6 | 证据和文本字段不得含令牌形串 | 本文第 7 节 |
| R7 | GitHub 机器账号令牌的 `credential_scopes` 不得含 `workflow`；落点里出现 `MACHINE_ACCOUNT_TOKEN` 或 `GH_TOKEN` 时必须声明 `credential_scopes` | 附录 B.7 |
| R8 | 机器账号令牌、AI 命令行登录、Cezar 口令、通知令牌与 `chat_id`（逻辑名 `MACHINE_ACCOUNT_TOKEN`、`GH_TOKEN`、`AGENT_CLI_LOGIN`、`CEZAR_SERVICE_PASSPHRASE`、`NOTIFY_BOT_TOKEN`、`NOTIFY_CHAT_ID`）只能放 `server_env_file` | 附录 B.7 |
| R9 | `VERCEL_AUTOMATION_BYPASS_SECRET` 只能放 `github_repo_secrets` | 附录 B.7 |
| R10 | 禁止落点必须含 `git_repository`；列为禁止的落点不得有变量 | 本文第 4 节 |
| R11 | 格式：UTF-8 无 BOM、无重复键、无换行等控制字符、`id` 唯一 | 本文 |

R8、R9 靠变量名识别，所以请使用上表的约定名；换了名字就不受这两条保护。

## 9. 如何扩展

新增冒烟类型、新增 Environment 或放宽任一规则，都要同时改 Schema、校验脚本的测试样例和本文，并重跑 `tools/preflight/tests/intake_bad/` 下的反例。**不要让干活 agent 改这些文件**：校验脚本在 `tools/` 下，不会进项目，就是为了让它碰不到"尺子"。
