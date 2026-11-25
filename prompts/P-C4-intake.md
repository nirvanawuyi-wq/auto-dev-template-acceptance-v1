> 用在 C4（动作 1）；使用者：干活 agent（主会话）。来源：主手册 v0.9，逐字抽取，`[...]` 为要你自己换的占位。

读 docs/plan.md 和 docs/workflow-manual.md，按手册第 3.6 节格式生成 docs/intake-checklist.md。列出开跑前必须配置的所有外部依赖（账号、密钥、域名、服务、测试额度/测试币、权限）。
要求：
1. 每项写清：去哪个网站点什么、预算上限或告警、固定回调地址、四处密钥落点（本机 .env.local / 服务器环境文件 / Vercel Preview / GitHub Secrets，按附录 B.7）、凭据冒烟方式、在哪一步验、当前状态（未开始/已配置/已验证）。
2. 需要等待的项（域名解析、账号审核、ICP 备案、充值）排最前面。
3. 只列沙箱/测试/开发环境；生产和不可逆操作相关项单独放在文末"人工操作"一栏，无人值守运行中不使用。
4. 把附录 B.6 的人工设置列进去：GitHub Pro 前提、main-lock、integration 规则集、Vercel 导入仓库与放行密钥、db-admin Environment。Vercel 套餐也列清楚：Hobby 的并发构建数和商用限制先核对（按 3.6）；CI 等待时间据实调整。
