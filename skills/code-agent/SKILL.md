---
name: code-agent
description: 使用项目文件工具在 public/{guid}/ 工作目录内搜索、阅读、创建、修改、插入和删除代码文件；在说本地没有之前先搜索已克隆知识库
---

# Code Agent

这个技能用于在项目工作区中编写和修改代码。所有文件操作都必须限制在 `public/{guid}/` 目录内，工具参数中的路径一律写成相对 `public/{guid}/` 的路径。

## Tools

- `AgentListWorkspaces`: 当不知道之前项目所在的 `guid` 时，先列出 `public/` 下现有工作目录。
- `AgentCreateWorkspace`: 创建 `public/{guid}/` 工作目录并返回后续文件工具使用的 `guid`。
- `AgentCloneRepository`: 将公开 Git 仓库浅克隆到 `public/{guid}/` 内，作为只读参考知识库。
- `AgentGitOperation`: 在当前项目内查看当前分支、列出分支、查看远端，以及切换到已有分支。
- `AgentSearchFiles`: 在当前项目和 `knowledge/` 中按文件名或内容搜索。
- `AgentReviewProjectCommand`: 审核项目命令是否安全。
- `AgentProjectCommand`: 在 `public/{guid}/` 内做环境检测、受限命令执行、解压缩、重命名和创建目录。
- `AgentListFiles`: 获取文件夹文件列表。先用它了解项目结构，`folderPath` 默认为 `.`。
- `AgentReadFileLines`: 读取文本文件指定行范围。编辑前先读取相关片段，避免覆盖未知内容。
- `AgentCreateFile`: 创建新文件。默认不覆盖已有文件。
- `AgentWriteFile`: 覆盖或追加写入文件。覆盖前必须确认目标文件内容。
- `AgentInsertFile`: 在指定行之前插入内容。适合添加 import、函数、配置项或局部代码块。
- `AgentDeleteFile`: 删除文件。只在用户明确要求或确认文件确实不再需要时使用。

## Workflow

1. 确认本次任务使用的 `guid`；如果不知道之前项目在哪个 `guid` 下，先调用 `AgentListWorkspaces` 查找；如果没有现成 `guid`，调用 `AgentCreateWorkspace` 创建，不能用终端命令生成。
2. 如果用户提供仓库作为参考或要求添加知识库，调用 `AgentCloneRepository` 克隆到 `knowledge/{仓库名}` 或明确指定的相对目录。
3. 需要查看仓库分支、确认当前分支、查看远端或切换到已有分支时，优先使用 `AgentGitOperation`。
4. 需要脚手架创建、依赖安装、打包、环境检测、解压缩或重命名时，优先使用 `AgentProjectCommand`；对 `run` 命令可以先调用 `AgentReviewProjectCommand`。
5. 在开始写代码前，先用 `AgentSearchFiles` 搜当前项目和 `knowledge/`；如果用户提到“参考项目”“本地仓库”“知识库”，优先搜索 `knowledge/`。
6. 调用 `AgentListFiles` 查看相关目录。
7. 调用 `AgentReadFileLines` 读取要修改的文件片段；大文件按范围分段读取。
8. 优先使用 `AgentInsertFile` 或小范围 `AgentWriteFile` 修改文件；避免无依据地重写整个文件。
9. 新文件使用 `AgentCreateFile`，已有文件需要覆盖时才使用 `overwrite=true` 或 `AgentWriteFile` 的 `overwrite` 模式。
10. 修改后再次读取关键行，确认结果符合预期。

## Rules

- 只能使用本技能列出的 `Agent*` 工具做增、查、改、删和受限仓库克隆；不要调用 `exec`、终端命令、Docker、容器、远程节点或任何代码执行工具。
- 查找 `public/{guid}` 下已有项目或知识库时，先用 `AgentListWorkspaces`、`AgentListFiles`、`AgentSearchFiles`；不要用 `exec`，因为它的默认工作目录不是 `public/{guid}`。
- Git 操作优先使用 `AgentGitOperation`；目前只允许看分支、看远端和切换到已有分支，不要尝试提交、推送、拉取、合并、变基、重置或打标签。
- 项目命令只通过 `AgentProjectCommand` 执行；不要绕过它直接跑 shell。
- 克隆下来的仓库只作为知识库阅读参考，除非用户明确要求，否则不要修改知识库仓库内容。
- 在回复“本地没有”“仓库里没有”“没找到对应实现”之前，先对 `knowledge/` 和当前项目至少执行一次 `AgentSearchFiles` 或 `AgentListFiles` 检查。
- 不要传绝对路径，不要使用 `../` 试图离开 `public/{guid}/`。
- 读取行号从 1 开始；插入时 `lineNumber` 表示插入到该行之前。
- 如果要在文件末尾插入，先读取文件总行数，然后把 `lineNumber` 设为 `totalLines + 1`。
- 对代码文件保持原有风格，尽量做小而清晰的改动。
- 如果工具返回 `success: false`，先根据 `error` 调整路径或行号，不要连续重复同一个失败调用。
