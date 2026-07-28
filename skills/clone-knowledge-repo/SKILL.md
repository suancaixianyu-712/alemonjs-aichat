---
name: clone-knowledge-repo
description: 将公开 Git 仓库克隆到 public/{guid}/ 内作为 AI 知识库，并要求 AI 在回答前先搜索已克隆仓库内容
---

# Clone Knowledge Repo

这个技能用于把用户提供的公开仓库加入当前 AI agent 工作目录，作为知识库或参考代码。仓库必须克隆到 `public/{guid}/` 内，不能克隆到系统其他位置。

## Tools

- `AgentListWorkspaces`: 当不知道之前克隆到哪个 `guid` 时，先列出 `public/` 下现有工作目录。
- `AgentCreateWorkspace`: 没有 `guid` 时先创建工作目录。
- `AgentCloneRepository`: 受限克隆公开 http/https Git 仓库，默认浅克隆到 `knowledge/{仓库名}`。
- `AgentSearchFiles`: 在已克隆仓库中按文件名和内容搜索关键字。
- `AgentListFiles`: 克隆后查看仓库结构。
- `AgentReadFileLines`: 读取仓库中的说明文档、源码或配置片段。

## Workflow

1. 确认本次任务使用的 `guid`；没有则调用 `AgentCreateWorkspace`。
2. 调用 `AgentCloneRepository`，传入用户给出的 `repoUrl`。除非用户指定目录，否则不要传 `targetPath`。
3. 克隆成功后，调用 `AgentListFiles` 查看返回的 `path`。
4. 回答用户前，先用 `AgentSearchFiles` 搜索关键字，再决定要读哪些文件。
5. 优先读取 `README`、`docs`、`examples`、`package.json`、入口文件等高价值文件。
6. 将仓库内容作为参考知识使用；如果要修改当前项目文件，继续使用 `code-agent` 里的文件工具。

## Rules

- 只能克隆公开 `http://` 或 `https://` 仓库；不要使用 SSH 地址、本地路径或带 token 的 URL。
- 不要调用终端命令、Docker、容器、远程节点或其他代码执行工具来克隆仓库。
- 不要把仓库克隆到 `public/{guid}/` 之外。
- 不要删除或覆盖已有目录；如果目标目录已存在，换一个 `targetPath`。
- 克隆下来的仓库默认是知识库，只读参考，除非用户明确要求才修改其中的文件。
- 在回复“本地没有”之前，先对 `knowledge/` 或克隆返回的目录调用 `AgentSearchFiles` 或 `AgentListFiles`；如果连 `guid` 都不确定，先调用 `AgentListWorkspaces`。
