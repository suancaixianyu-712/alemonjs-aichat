---
name: get-ainotes
description: 访问 AiNotes 笔记服务 API，查询/创建/编辑笔记、轮询整理任务、进行知识库问答。适用于「查笔记」「整理笔记」「知识问答」「note.suancaixianyu」「AiNotes」等场景
---

# Get AiNotes Skill

通过 HTTP 调用 [AiNotes](https://note.suancaixianyu.cn/) 笔记服务，完成笔记列表/详情查询、AI 整理与编辑、任务轮询、跨笔记知识问答。

## 基础信息

| 项 | 值 |
| --- | --- |
| 网页域名 | `https://note.suancaixianyu.cn/` |
| API 根地址 | `https://note.suancaixianyu.cn` |
| 内容类型 | 除流式接口外均为 `application/json` |
| 缓存 | 写接口与笔记读接口返回 `Cache-Control: no-store` |

请求时优先使用完整 URL，例如：

```text
https://note.suancaixianyu.cn/api/notes?compact=1
```

Cookie（浏览器会话场景；纯服务端调用时通常没有）：

- `ainotes-admin-session`：管理员会话（改标题、删笔记需要）
- `ainotes-guest-session`：游客会话（创建/编辑自己的笔记）

权限规则：

- **游客**：可浏览列表；`organize` 创建笔记会绑定游客身份；只能编辑自己创建的笔记
- **管理员**：可编辑任意笔记、改标题、删除笔记
- 未登录管理员时，`PATCH`/`DELETE` 笔记返回 `401`

**不要**在技能输出或脚本参数里硬编码管理员密码。需要管理权限时，请用户自行登录网页，或仅在用户明确提供账号密码时调用登录接口。

---

## Workflow 1: 健康检查

确认服务与依赖是否可用。

```http
GET /api/health
```

响应示例字段：

```json
{
  "app": "应用名",
  "timestamp": "ISO时间",
  "services": {
    "database": { "ok": true, "message": "...", "target": { "host": "...", "port": 5432, "name": "..." } },
    "redis": { "ok": true, "message": "...", "target": "redis://..." },
    "ai": { "ok": true, "message": "...", "target": { "host": "...", "model": "..." } }
  }
}
```

---

## Workflow 2: 管理员会话

### 2.1 检查是否已登录

```http
GET /api/admin/session
```

响应：`{ "isAuthenticated": true | false }`

### 2.2 登录

```http
POST /api/admin/session
Content-Type: application/json

{
  "username": "<管理员用户名>",
  "password": "<管理员密码>"
}
```

成功：`{ "isAuthenticated": true, "username": "..." }`，并设置 `ainotes-admin-session` Cookie。  
失败：`400`（缺字段）、`401`（账号或密码错误）。

### 2.3 登出

```http
DELETE /api/admin/session
```

响应：`{ "isAuthenticated": false }`

---

## Workflow 3: 列出笔记

```http
GET /api/notes
GET /api/notes?compact=1
```

- 默认：返回完整 `notes` 数组
- `compact=1`：**推荐列表场景使用**，会剥离图片 `previewUrl`/`dataUrl` 与音频 `dataUrl`，体积更小

响应：

```json
{
  "notes": [
    {
      "id": "uuid",
      "title": "标题",
      "markdown": "markdown 正文",
      "createdAt": "ISO时间",
      "updatedAt": "ISO时间",
      "messages": [],
      "ownership": { "mode": "admin" | "guest", "guestOwnerKey": "可选" },
      "permissions": {
        "canCurrentUserEdit": true,
        "isAdminSession": false,
        "isOwnedByCurrentGuest": false,
        "mode": "admin" | "guest"
      }
    }
  ]
}
```

整理输出时优先展示：`title`、`id`、`updatedAt`、markdown 摘要（截断前 200 字）、是否可编辑。

网页直链可按站点习惯使用：`https://note.suancaixianyu.cn/`（前端通过选中 noteId 展示详情）。

---

## Workflow 4: 获取单篇笔记详情

```http
GET /api/notes/{noteId}
```

成功：`{ "note": { ...NoteRecord } }`  
不存在：`404` + `{ "message": "笔记不存在。" }`

列表若为 compact 结果且需要图片/音频数据，应再调本接口补全。

---

## Workflow 5: 修改笔记标题（管理员）

```http
PATCH /api/notes/{noteId}
Content-Type: application/json

{
  "title": "新标题"
}
```

约束：`title` 去空格后长度 1–80。  
成功：`{ "note": { ...更新后的笔记 } }`  
未登录管理员：`401`；不存在：`404`；非法标题：`400`。

服务端会同步更新 markdown 首行 `# 标题`。

---

## Workflow 6: 删除笔记（管理员）

```http
DELETE /api/notes/{noteId}
```

成功：`{ "deletedNoteId": "{noteId}" }`  
未登录管理员：`401`；不存在：`404`。

删除前应向用户确认目标笔记标题与 id。

---

## Workflow 7: AI 整理新笔记 / 编辑已有笔记

异步任务：先提交拿到 `jobId`，再轮询任务状态。

```http
POST /api/notes/submit
Content-Type: application/json
```

### 请求体

```json
{
  "intent": "organize",
  "targetNoteId": "仅 intent=edit 时需要",
  "messages": [
    {
      "id": "客户端生成的 uuid",
      "createdAt": "ISO时间",
      "mode": "entry",
      "parts": [
        { "kind": "text", "text": "要整理或编辑的内容/指令" }
      ]
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `intent` | `organize`（默认，新建并整理）或 `edit`（按指令改已有笔记） |
| `targetNoteId` | `edit` 时必填，目标笔记 id |
| `messages` | 至少 1 条；每条 `parts` 至少 1 个 |
| `mode` | `entry` 或 `audio` |
| `parts[].kind` | `text` / `image` / `file` / `audio` |

各 part 形状：

```json
{ "kind": "text", "text": "文本" }

{
  "kind": "image",
  "name": "a.png",
  "mimeType": "image/png",
  "size": 1234,
  "previewUrl": "可选",
  "dataUrl": "可选 data URL",
  "textContent": "可选 OCR/说明"
}

{
  "kind": "file",
  "name": "a.md",
  "mimeType": "text/markdown",
  "size": 100,
  "textContent": "可选文本内容"
}

{
  "kind": "audio",
  "name": "a.webm",
  "mimeType": "audio/webm",
  "size": 2048,
  "dataUrl": "可选",
  "transcript": "可选转写"
}
```

### 响应

- HTTP **202**
- body：`{ "job": { "id", "status": "processing", "createdAt", "updatedAt", "message" } }`

错误：

- `404`：编辑目标不存在
- `403`：游客编辑非自己笔记（「游客模式下只能编辑自己创建的笔记。」）

### 简化调用（纯文本整理）

用户只给一段文字要记成笔记时：

```json
{
  "intent": "organize",
  "messages": [
    {
      "id": "<uuid>",
      "createdAt": "<now ISO>",
      "mode": "entry",
      "parts": [{ "kind": "text", "text": "<用户内容>" }]
    }
  ]
}
```

编辑已有笔记时把 `intent` 改为 `edit` 并带上 `targetNoteId`，`text` 写编辑指令。

---

## Workflow 8: 轮询整理/编辑任务

```http
GET /api/notes/jobs/{jobId}
```

成功：`{ "job": NoteJob }`  
不存在或过期：`404` + `{ "message": "任务不存在或已过期。" }`

`NoteJob`：

```json
{
  "id": "job-uuid",
  "status": "processing | completed | failed",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "message": "人类可读进度说明",
  "noteId": "完成后可选",
  "note": { "...NoteRecord，完成后可选" }
}
```

推荐轮询策略：

1. 提交后每 **1.5–2 秒** 查一次
2. `status === "processing"` 继续等
3. `completed`：展示 `note.title`、`note.markdown` 摘要与 `noteId`
4. `failed`：展示 `message`，停止轮询
5. 超过约 **2 分钟** 仍未完成则告知用户可稍后用 jobId 再查

---

## Workflow 9: 跨笔记知识问答

基于全部笔记检索后流式回答。

```http
POST /api/knowledge-chat
Content-Type: application/json

{
  "message": "用户问题",
  "history": [
    { "role": "user", "content": "上一轮问题" },
    { "role": "assistant", "content": "上一轮回答" }
  ]
}
```

约束：

- `message` 必填非空
- `history` 可选，最多 24 条；每条 `role` 为 `user` | `assistant`，`content` 非空

### 响应形态

1. **无笔记时**：普通 JSON

```json
{
  "result": {
    "reply": "当前还没有可检索的笔记，先整理出几篇笔记后再来问我。",
    "sources": []
  }
}
```

2. **正常问答**：`Content-Type: application/x-ndjson`，**按行** JSON 事件：

```json
{ "type": "reply-delta", "delta": "流式增量文本" }
{ "type": "result", "result": { "reply": "完整回答", "sources": [{ "id", "title", "excerpt" }] } }
{ "type": "error", "message": "错误说明" }
```

解析方式：

1. 若 `Content-Type` 含 `ndjson`，按 `\n` 拆行 `JSON.parse`
2. 拼接所有 `reply-delta.delta` 作为流式展示
3. 以最后的 `result.reply` 为准；附带 `sources` 作为引用来源
4. 收到 `error` 或 HTTP 非 2xx 时向用户说明失败原因

输出时建议列出引用来源笔记 id 与 title。

---

## 推荐决策树

| 用户意图 | 调用 |
| --- | --- |
| 服务好不好 / 健康吗 | `GET /api/health` |
| 有哪些笔记 / 列表 | `GET /api/notes?compact=1` |
| 某篇全文 / 详情 | `GET /api/notes/{id}` |
| 记一下 / 整理成笔记 | `POST /api/notes/submit` intent=`organize` → 轮询 job |
| 改这篇笔记内容 | `POST /api/notes/submit` intent=`edit` → 轮询 job |
| 只改标题 | `PATCH /api/notes/{id}`（需管理员） |
| 删笔记 | `DELETE /api/notes/{id}`（需管理员） |
| 根据笔记库提问 | `POST /api/knowledge-chat` |
| 管理员登录状态 | `GET/POST/DELETE /api/admin/session` |

---

## Output Format

### 笔记列表

```text
共 N 篇笔记：

1. 标题: <title>
   ID: <id>
   更新: <updatedAt>
   可编辑: 是/否
   摘要: <markdown 前 120 字...>
```

### 笔记详情

```text
标题: <title>
ID: <id>
创建: <createdAt>
更新: <updatedAt>
正文:
<markdown>
```

### 提交任务

```text
任务已提交
Job ID: <jobId>
状态: processing
说明: <message>
（正在轮询...）
```

完成后：

```text
任务完成
Job ID: <jobId>
笔记 ID: <noteId>
标题: <title>
正文摘要:
<markdown 摘要>
```

### 知识问答

```text
回答:
<reply>

引用来源:
- <title> (id: <id>)
  摘录: <excerpt>
```

### 错误

```text
操作失败: <message>
HTTP: <status>
建议: <下一步，例如刷新 noteId / 登录管理员 / 检查 job 是否过期>
```

---

## Rules

1. 列表优先 `compact=1`，避免把大图 base64 拉进上下文。
2. 提交任务后**必须**轮询 `/api/notes/jobs/{jobId}`，不要假设同步完成。
3. `edit` 前先 `GET` 确认笔记存在，并向用户展示将编辑的标题。
4. 删除与改标题需要管理员 Cookie；无权限时说明需在网页登录管理员，不要猜测密码。
5. 知识问答优先用 `/api/knowledge-chat`，不要自行把所有笔记 markdown 全量塞进本地模型上下文（服务端已做检索）。
6. 生成 `id`/`createdAt` 时使用 UUID 与 ISO-8601 UTC 时间。
7. 不要泄露环境变量、数据库连接串、Redis URL、AI Key；健康检查里的 `target` 对用户可做脱敏（只报 ok/not ok）。
8. 调用失败时返回接口 `message` 原文，便于排查。
)
