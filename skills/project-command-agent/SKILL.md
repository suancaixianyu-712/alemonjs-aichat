---
name: project-command-agent
description: 在 public/{guid}/ 内安全地创建项目、检测环境、执行受限构建命令、解压缩文件和重命名文件，并自动审查命令安全
---

# Project Command Agent

这个技能用于在 `public/{guid}/` 工作目录内进行受限的项目级操作。它适合脚手架创建、安装依赖、运行构建脚本、查看环境版本、解压缩产物和重命名文件。

## Tools

- `AgentCreateWorkspace`: 没有工作目录时先创建 `public/{guid}/`。
- `AgentReviewProjectCommand`: 在真正执行前单独审查项目命令。
- `AgentProjectCommand`: 执行受限项目操作。
- `AgentListFiles`: 查看项目目录结构。
- `AgentReadFileLines`: 读取配置、日志和源码片段。

## Workflow

1. 确认或创建 `guid`。
2. 需要先看机器环境时，调用 `AgentProjectCommand`，传 `action: "inspect"`。
3. 需要运行项目命令时，优先先调用 `AgentReviewProjectCommand` 看审查结果；或者直接调用 `AgentProjectCommand` 的 `run`，它会自动审查后再执行。
4. 需要创建目录时用 `action: "mkdir"`。
5. 需要解压缩文件时用 `action: "extract"`。
6. 需要修改文件名或目录名时用 `action: "rename"`。
7. 运行完成后，用 `AgentListFiles`、`AgentReadFileLines` 或上传工具确认结果。

## Rules

- 所有操作都必须留在 `public/{guid}/` 内，不要传绝对路径，也不要使用 `../`。
- 不要调用终端命令、Docker、容器、远程节点或其他代码执行工具来替代这个技能。
- `run` 只适合受限的项目命令，例如 `npm.cmd run build`、`npm.cmd install`、`npx.cmd create-vite@latest app`。
- 如果审查结果是 `allowed: false`，不要重复硬跑同一个命令，先改命令或改方案。
- 脚手架和依赖安装命令虽然被限制在工作目录内执行，但第三方包本身仍可能带有自己的安装脚本；因此优先使用用户明确指定的模板或成熟模板。
