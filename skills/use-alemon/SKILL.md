---
name: use-alemon
description: 当用户需要控制某些开关或者添加配置时, 调用alemonjs框架指令, 来帮助用户更好的使用alemonjs框架的工具, 如配置ai, 切换模型等功能
---

# Use Alemon Skill

本技能仅作为框架指令使用示例,你可以调用GetCommand来获取所有可用指令,根据用户需求发送command来执行

# Workflow

## 1. 查看当前ai配置

根据需求在回复中添加一个命令

```txt
<command=#ai配置>
<command=#ai列表>
```

## 2. 切换模型

需要注意是切换模型还是切换ai
当用户需要切换模型时, 发送一个命令

```txt
<command=#切换模型 [模型名称]>
```

当用户需要切换ai时, 先调用工具getAlemonjsConfig({type:'get', key:'ailist', value:""})获取当前ai配置, 然后根据需求发送一个命令, 如果没有这个ai,或者无法获取,就回复用户无法切换, 请检查ai列表指令获取当前可用ai

```txt
<command=#切换AI [AI名称]>
```

## 3. 打开或关闭语音回复

根据需求在回复中添加一个命令

```txt
<command=#[开启|关闭]语音回复>
```

## 更多...
