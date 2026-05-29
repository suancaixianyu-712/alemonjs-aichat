---
name: global-memory
description: 优先检索长期记忆和历史聊天归档，避免在可查到旧记录时误说“不记得”或“之前没有聊过”
---

# Global Memory

这个技能用于继续之前的话题、回忆用户偏好、查找旧聊天记录，以及在新会话里找回之前的上下文。

## Tool

- `MemoryOperation`: 读写用户长期记忆，获取和搜索历史聊天归档。

## Workflow

1. 如果用户提到“之前”“上次”“刚才”“还记得吗”“我们聊过”“你说过”等延续性表述，先检查系统自动注入的“系统预检索记忆”。
2. 如果自动注入的记忆还不够，调用 `MemoryOperation`：
   - 获取用户长期记忆：`operation=get` + `dataType=user`
   - 获取历史归档列表：`operation=get` + `dataType=chatHistory`
   - 搜索相关历史：`operation=get` + `dataType=chatHistory` + `data=search:关键词`
   - 读取某条归档详情：`operation=get` + `dataType=chatHistory` + `data=guid:id`
3. 先根据搜索结果锁定最相关的归档，再读取详情，不要一上来遍历所有历史。
4. 回答时优先引用与当前问题直接相关的记忆；如果历史记忆与用户当前说法冲突，以用户当前说法为准。
5. 当用户明确提供了新的长期偏好、身份信息或稳定习惯时，可用 `MemoryOperation` 的 `user` 类型写入长期记忆。

## Rules

- 在说“我不记得”“之前没聊过”“没有这段历史”之前，先看系统自动检索到的记忆，必要时再调用 `MemoryOperation` 搜索。
- 不要把不确定的历史记忆说成确定事实；如果记忆片段不完整，应明确说明是“根据历史归档看起来像是”。
- 搜索历史时优先提取主题词、项目名、命令名、文件名、报错文本等高信息量关键词。
- 用户要求开始全新话题时，不要强行引用旧记忆；只有在确实相关时才使用。
