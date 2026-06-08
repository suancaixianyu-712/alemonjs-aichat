# alemonjs-aichat

AlemonJS 的 AI 聊天插件，支持多模型配置、上下文对话、提示词、好感度、工具调用、AI 修图、TTS 语音回复、图片审核等功能。

当前版本：`1.0.38`

## 1. 安装

安装中遇到 AlemonJS 框架问题时，可先参考 [AlemonJS 文档](https://alemonjs.com/docs)。

### 已有 AlemonJS 项目

在你的 AlemonJS 项目根目录执行：

```sh
yarn add alemonjs-aichat
```

如果使用 npm：

```sh
npm install alemonjs-aichat
```

然后在 `alemon.config.yaml` 中启用插件：

```yaml
apps:
  - alemonjs-aichat
```

重启 AlemonJS 后即可使用。

### 从零开始部署

适合还没有 AlemonJS 项目的环境。

```sh
mkdir alemonjs-bot
cd alemonjs-bot
yarn init -y
yarn add alemonjs @alemonjs/onebot alemonjs-aichat
```

创建 `alemon.config.yaml` 后启动：

```sh
npx alemonc start
```

如果使用 OneBot，请先启动 NapCat 等 OneBot 服务端，再配置下面的 `onebot.url`。

## 2. 基础配置

`alemon.config.yaml`

```yaml
apps:
  - alemonjs-aichat

login: onebot

redis:
  host: '127.0.0.1'
  port: 6379
  user: ''
  password: ''

aiChat:
  redis:
    host: '127.0.0.1'
    port: 6379
    user: ''
    password: ''
  searchApiKey: ''
  xaiImgProxy: ''
  ttsServer:
    host: 'http://127.0.0.1:8005'
  baidu:
    ak: ''
    sk: ''
  skills_dir:
    - './skills'

onebot:
  url: 'ws://127.0.0.1:3001'
  token: ''
  reverse_enable: false
  reverse_port: 17158
  master_id:
    - '你的QQ号'
```

说明：

- `aiChat.redis` 优先级高于全局 `redis`，不需要单独 Redis 时可以删除 `aiChat.redis`。
- 插件使用的 Redis key 以 `ai:` 为主。
- `searchApiKey` 默认为空，未配置时网页搜索工具可能不可用。
- `xaiImgProxy` 默认为空，服务器无法直接访问 XAI 图片时再填写代理地址。

## 3. 可选功能配置

### AI 修图

AI 修图基于 XAI 的 Grok 接口。需要先添加一个 Grok 模型：

```text
#添加ai grok https://api.x.ai/v1 <你的apiKey> grok-4-1-fast-non-reasoning
```

如果服务器无法直接访问 XAI，可自行准备一个转发到 `https://api.x.ai/v1` 的代理服务，也可以参考源码仓库中的 `daili.js` 脚本。

```text
#添加ai grok http://127.0.0.1:3002/x/v1 <你的apiKey> grok-4-1-fast-non-reasoning
```

如平台无法直接发送 `https://imgen.x.ai` 图片，可在 `aiChat.xaiImgProxy` 配置图片代理地址。

### 网页搜索

网页搜索功能基于 [SerpApi](https://serpapi.com)，需要申请 key 后配置：

```yaml
aiChat:
  searchApiKey: '<你的SerpApiKey>'
```

### 语音回复

语音回复依赖 GPT-SoVITS 推理服务。启动推理服务后配置：

```yaml
aiChat:
  ttsServer:
    host: 'http://127.0.0.1:8005'
```

可使用 `/开启语音回复`、`/关闭语音回复` 控制当前会话是否使用语音回复。

### 图片审核

图片审核依赖百度云内容安全审核服务：

```yaml
aiChat:
  baidu:
    ak: '<你的AK>'
    sk: '<你的SK>'
```

使用 `/不可以色色`、`/可以色色` 开启或关闭图片审核。未配置 AK/SK 时图片审核不可用。

### OneBot 平台

OneBot 平台可使用 [NapCat](https://napneko.github.io/) 等服务端。创建 WebSocket 服务后配置：

```yaml
login: onebot

onebot:
  url: 'ws://127.0.0.1:3001'
  token: ''
  reverse_enable: false
  reverse_port: 17158
  master_id:
    - '你的QQ号'
```

其他平台请参考 [AlemonJS 连接平台文档](https://alemonjs.com/docs/environment)。

## 4. 使用

首次使用前，需要先添加一个 AI 配置：

```text
#添加ai <名称> <主机地址> <api_key> <模型>
```

示例：

```text
#添加ai default https://api.openai.com/v1 sk-xxxx gpt-4.1-mini
```

常用指令：

| 指令 | 作用 |
| --- | --- |
| `#添加ai` | 添加一个 AI，重名时更新 |
| `#切换ai` | 切换 AI 配置并保留当前对话 |
| `#开启聊天` / `#关闭聊天` | 在当前位置启用或关闭 AI 聊天 |
| `#ai配置` | 显示当前使用的配置 |
| `#ai状态` | 查看当前会话状态、工具和上下文统计 |
| `#添加提示词` | 添加一个提示词 |
| `#提示词列表` | 查看当前配置的所有提示词 |
| `#切换提示词` | 切换提示词并保留当前对话 |
| `#清空对话` | 清空当前对话并保留好感度 |
| `#开启好感度` | 开启好感度功能 |
| `#好感度` | 查看自己的好感度 |
| `/工具列表` | 查看工具状态 |
| `/开启工具` / `/关闭工具` | 开启或关闭工具调用 |
| `/开启工具提示` / `/关闭工具提示` | 开启或关闭工具调用提示 |
| `/开启工具调用内容` / `/关闭工具调用内容` | 控制工具调用前模型返回内容是否发送 |
| `#ai帮助` | 查看更多指令 |
