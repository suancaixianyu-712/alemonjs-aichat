---
name: use-alemon
description: 当用户需要控制某些开关或者添加配置时, 调用alemonjs框架指令, 来帮助用户更好的使用alemonjs框架的工具, 如配置ai, 切换模型等功能
---

# Use Alemon Skill

本技能用于执行 AlemonJS 框架指令。可以调用 `GetCommand` 获取所有可用指令，再根据用户需求调用 `ExecuteAlemonCommand` 实际执行。

不要在回复中输出 `<command=...>` 标签，也不要只让用户手动发送指令。框架指令必须通过 `ExecuteAlemonCommand` 工具执行。工具会沿用当前消息的真实用户、会话和权限，不会绕过主人或管理员权限检查。每次工具调用只执行一条完整指令。

# Workflow

## 1. 查看当前ai配置

根据需求直接调用 `ExecuteAlemonCommand`：

```json
{ "command": "#ai配置" }
```

需要 AI 列表时调用：

```json
{ "command": "#ai列表" }
```

## 2. 切换模型

需要注意是切换模型还是切换ai
当用户需要切换模型时，调用：

```json
{ "command": "#切换模型 [模型名称]" }
```

当用户需要切换 AI 时，先调用工具 `getAlemonjsConfig({type:'get', key:'ailist', value:""})` 获取当前 AI 配置，然后根据需求调用框架指令。如果没有这个 AI，或者无法获取，就回复用户无法切换，并建议检查 AI 列表。

```json
{ "command": "#切换AI [AI名称]" }
```

## 更多

语音使用全局配置：`#添加语音配置 <模型id>` 会列出已有 AI 配置，等待用户选择序号或完整配置 ID；不要自动猜测用户要复用哪个配置。
`#语音列表` 查看已添加的模型，`#切换语音模型 <模型id>` 修改全局默认模型，`#设置音色 <voice>` 修改当前模型的音色。
生成语音请调用 `GenerateSpeech` 工具。

遇到此处未列出的框架功能，先调用 `GetCommand` 获取准确格式，再调用 `ExecuteAlemonCommand`。不要猜测指令，也不要把指令标签混入最终回复。
