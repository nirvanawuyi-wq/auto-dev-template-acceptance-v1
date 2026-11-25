# prompts：提示词索引

按"来源"分两类。使用时把 `[...]` 占位换成你自己的内容。提示词里引用手册内容的地方写的是"第 3.x 节""附录 B.x"，指向 `docs/workflow-manual.md`。

## 一、手册原文（14 条，逐字抽取）

| 文件 | 用在哪一步 | 使用者 |
|---|---|---|
| `P-C1-ask.md` | C1 动作 1：AI 读需求后追问 | 干活 agent（主会话） |
| `P-C1-check.md` | C1 动作 3：你答完问卷后 | 干活 agent（主会话） |
| `P-C2-draft.md` | C2 动作 1：起草方案 | 干活 agent（主会话） |
| `P-C2-revise.md` | C2 动作 2：修订 | 干活 agent（主会话） |
| `P-C2-review.md` | C2 动作 3：换模型的新窗口里审查 | 审查 agent（另一个模型家族） |
| `P-C2-adopt.md` | C2 动作 4：回到第一个会话采纳意见 | 干活 agent（回到第一个会话） |
| `P-C3-final.md` | C3 动作 1：定稿计划 | 干活 agent（主会话） |
| `P-C3-review.md` | C3 动作 2：换模型的新窗口里审查 | 审查 agent（另一个模型家族） |
| `P-C3-adopt.md` | C3 动作 3：回到第一个会话采纳意见 | 干活 agent（回到第一个会话） |
| `P-C4-intake.md` | C4 动作 1：生成 `docs/intake-checklist.md` | 干活 agent（主会话） |
| `P-C4-accept.md` | C4 动作 2：生成 `docs/acceptance-script.md` | 干活 agent（主会话） |
| `P-D1-config.md` | D1 动作 1：新会话里逐项配凭据并冒烟 | 干活 agent（新开会话） |
| `P-F2-fix.md` | F2 动作 3：每条问题一个 fix 分支 | 干活 agent |
| `P-G1-skin.md` | G1 第 1 层：本地试装皮肤（不走 Cezar） | 干活 agent（本地会话） |

## 二、自拟提示词（4 条，非手册原文）

手册在这几处要求 AI 干活，但没给提示词，所以补上。它们**只是草稿，需要项目一的真实数据来验**。

| 文件 | 用在哪一步 | 使用者 |
|---|---|---|
| `P-D3-write.md`（自拟） | D3 动作 4；A2 动作 1 备模板也用它：写工作流图、脚本、提示词 | 干活 agent（主会话，新开） |
| `P-C4-intake-machine.md`（自拟） | C4 之后：把审看过的 `docs/intake-checklist.md` 转成机器可读的 `docs/intake-checklist.json` | 干活 agent（主会话） |
| `P-F2-report.md`（自拟） | F1 批次收尾（`final-report` 的汇总步骤）和 F2 动作 1 | 干活 agent 写报告，你读 |
| `P-G3-retro.md`（自拟） | G3 动作 1：复盘并出回写草案 | 干活 agent 出草案，你逐条批准 |

## 三、基础设计

- `P-hero-image.md` 用于缺合适首页主图的项目。先根据项目简介生成一张，核对桌面和手机效果。

## 不是提示词的

- `docs/fix-entry.md` 是返修入口的说明文档（你怎么说问题、五步怎么走），放在 `docs/`，不在本目录。它在 F2 里配合 `P-F2-fix.md` 使用，但自己不是提示词。
