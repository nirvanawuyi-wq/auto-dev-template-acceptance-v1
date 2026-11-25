由 auto-dev-for-novice 自动生成，请勿直接修改

# 新项目模板

这是 `auto-dev-for-novice` 的新项目模板。它由源仓库的 `template/` 目录自动同步而来，**只改源仓库里的 `template/`，不要直接改本仓库**。

## 里面有什么

| 位置 | 内容 |
|---|---|
| `.gitignore` | 忽略 `.env*`（保留 `.env.example`）、`*.local`、依赖、构建产物、本机工具状态 |
| `docs/workflow-manual.md` | 瘦身版手册：行动清单、阶段视图、正文 §0～§4、§7、附录 B |
| `docs/field-notes.md` | 实测记录的空骨架；手册里所有"记进 `docs/field-notes.md`"都指向它 |
| `docs/requirements.md` | 粘贴你需求原话的地方（别写隐私） |
| `docs/intake-checklist.*` | 接入清单的机器可读格式：说明、JSON Schema、样例 |
| `docs/fix-entry.md` | 验收后"说一句问题就返修"的入口说明（不是提示词） |
| `prompts/` | 手册里的 14 条提示词，加 4 条自拟提示词，见 `prompts/README.md` |

## 怎么用

用 GitHub 的模板功能建新项目（把尖括号里的内容换成你自己的）：

```
gh repo create <新项目名> --template <模板仓库所有者>/auto-dev-for-novice-template --private --clone
```

先读 `docs/workflow-manual.md` 的行动清单，再把需求原话粘进 `docs/requirements.md`，从 C1 开始。

## 哪些目录由首个项目冒烟通过后补入

下面这些目前只有占位（`.gitkeep`），要等首个项目跑通并冻结后才补入真实内容，在此之前不要当作已经有：

- `.ai/cezar/workflows/`：四张工作流图
- `.ai/bin/`：检查与提交脚本（含 `setup-worktree.sh`）
- `.ai/prompts/`：审查提示词、`must-human.md`
- `.github/workflows/` 和 `.github/protected-paths.txt`：受保护路径与 CI 工作流

## 不在这里的

体检脚本等本机工具不在模板里，它们放在源仓库的 `tools/`，不会被复制进任何项目。模板里不含任何令牌、登录态或个人信息。
