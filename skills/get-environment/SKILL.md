---
name: get-environment
description: 获取当前运行环境信息
---

# Get Environment Skill

获取当前运行环境的详细信息。

## Workflow

1. 执行系统信息采集命令
2. 收集以下信息(请先获取操作系统, 根据操作系统适当调整获取指令)：使用RunCommand工具函数执行以下命令获取环境信息：
   - 操作系统：执行 `ver` 或 `uname -a`
   - 硬盘使用情况：执行 `df -h` 或 `wmic logicaldisk get size,freespace,caption`

   - 内存使用情况：执行 `free -h` 或 `wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value`
   - 当前路径：执行 `cd`
   - Node 版本：执行 `node --version`
   - npm 版本：执行 `npm --version`
   - ollama 版本：执行 `ollama -v`

3. 整理结果返回给用户

## Output Format

```text
操作系统: <操作系统信息>
硬盘使用情况: <硬盘使用情况信息>
内存使用情况: <内存使用情况信息>
当前路径: <当前路径信息>
Node 版本: <Node 版本信息>
npm 版本: <npm 版本信息>
ollama 版本: <ollama 版本信息>
```
