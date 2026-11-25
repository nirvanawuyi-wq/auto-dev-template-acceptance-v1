> **自拟，非手册原文。** 用在 C4 之后（`P-C4-intake` 生成的 docs/intake-checklist.md 已过你的审看）；使用者：干活 agent（主会话）。`[...]` 为要你自己换的占位。

读 docs/intake-checklist.md（唯一内容来源）、docs/intake-checklist.schema.md、docs/intake-checklist.schema.json，以及 docs/workflow-manual.md 的第 3.6 节和附录 B.7，把 docs/intake-checklist.md 转成 docs/intake-checklist.json。docs/intake-checklist.sample.json 是手册样例表转出来的示范，照它的写法。
要求：
1. 严格按 schema.md 的字段写，md 里每一行对应 items 里一个条目，顺序不变（需要等待的项仍在最前）。字段缺失就按 schema 的约定写 null 或空数组，不要自造字段。
2. 四处落点只写变量名，绝不写密钥值；md 里的"—"写空数组。不是环境变量的凭据用大写逻辑名，并在 notes 说明。
3. 冒烟方式只许从预定义类型里选：http_status、query_balance、dns_resolve、tcp_connect、gh_api_read、file_perm、manual。不许写自由命令，不许自造类型或多余字段；选不出合适类型就用 manual，并把人怎么确认写清楚。
4. verify_step 只能是 D1 / D3 / E2 / E3。md 里写了多个步骤或枚举外步骤（A1、D2、G2）时，枚举内的主检查放 verify_step 和 smoke，其余写进 notes。
5. 状态照抄 md 的原状态，对应 not_started / pending / configured / verified 四档；md 写"已发起"或等待项的，用 pending 并填 waiting_for。转换不是验证，不得因为写了 JSON 就升档。
6. 密钥分层按附录 B.7：SUPABASE_ACCESS_TOKEN 和数据库密码只放 github_environment_db_admin；主网私钥、助记词、生产密钥、ALLOW_MAINNET 不进任何落点；机器账号令牌不带 workflow 权限，并填 credential_scopes。forbidden_placements 按 B.7 填，必须含 git_repository。
7. 生产和不可逆操作相关项只放 manual_only，不写落点，unattended_use 写 false。其余项不要放进去。
8. evidence 只写状态结论、时间和脱敏摘要（如"HTTP 200"）；md 里没有验证记录就写 null。不要抄任何令牌、口令、服务器地址或 chat_id；如果 md 里已经出现疑似真实密钥值，不要抄进 JSON，停下来告诉我。
9. 示例和占位用 example.com、<项目名>、<owner>、<repo>，不写真实域名、账号名、服务器地址。
10. 文件用 UTF-8（无 BOM）、LF，2 空格缩进。不要改 docs/intake-checklist.md、schema.md、schema.json，也不要自己写校验脚本。md 与 JSON 有出入时以 md 为准并告诉我。
完成后汇报：条目数、manual_only 条数、哪些行无法完全映射（含放进 notes 的内容）。我会在本机运行 `python -I tools/preflight/validate_intake.py docs/intake-checklist.json` 校验；校验没过的违规项再回来改。
