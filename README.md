## 1.安装

安装中遇到问题可访问alemonjs官网查询[https://alemonjs.com/docs](https://alemonjs.com/docs)

### 在AlemonX安装

在robot页面右侧选择`插件`-`AI`就能找到, 确认为`release`点击`安装`

#### 在 AlemonX 中使用网页控制台

安装或更新插件后重启机器人，在 AlemonX 的插件 Web 入口打开 Aichat。沿用当前配置页、聊天页和样式，支持原网页的群配置、各项开关、AI 切换/删除、模型与提示词切换、上下文长度、会话选择、流式聊天、清空聊天和图片显示。

- 原有独立网页继续保留，但机器人启动时不再自动监听。主人发送 `#开启网页 8080`（或 `/开启网页 8080`）即可按指定端口启动；`#关闭网页` 关闭，`#网页状态` 查看状态。端口范围为 1–65535，不填时沿用本次运行中上次使用的端口，首次默认读取 `JSXP_PORT`、`PORT`，否则使用 8080。运行中需先关闭再换端口，端口占用会提示失败。
- 也可在 AlemonX 配置页的“独立网页”区域填写端口并点击“开启独立网页”，同一区域提供状态和关闭按钮。开启后，独立页面地址为 `http://机器人地址:端口/panel/config` 和 `/panel/chat`，样式与功能保持原样。
- AlemonX 使用框架的 Web 服务端口（`serverPort`）。作为插件加载时，入口为该服务下的 `/apps/alemonjs-aichat/`；作为主工程运行时为 `/app/`。入口会进入同一套管理页面。
- 在 AlemonX 中，页面、表单、流式请求和图片都走当前插件的同源路径，不需要浏览器另连机器人的 `8080` 端口。两种入口使用相同业务逻辑和 Redis 数据。
- 关闭独立网页不影响 AlemonX 入口。启停状态不持久化，重启机器人后保持关闭；不再需要通过 `AICHAT_PANEL_DISABLED` 禁止自动启动。开发命令 `npm run view` 仍会显式启动独立网页预览。

接入参考 [alemonjs-load-yunzai](https://github.com/yunzaijs/alemonjs-load-yunzai)：`package.json` 声明 `alemonjs.web.config.serverPort` 和 `alemonjs.web.root`，`src/index.ts` 的 `register()` 返回 `koaRouter`。本插件通过 `web/index.html` 进入服务端渲染页面，保留现有前端，不另建一套配置或聊天页面。

开发时运行 `npm run build` 更新 `lib`，分发时同时保留 `web/` 目录（已加入 npm 发布白名单）。改动不会自动更新 AlemonX 中另一份已安装的插件，需将该安装目录更新到新版本并重启机器人。

运行 `npm run test:panel-web` 可构建并检查独立入口及 AlemonJS 的主工程/插件挂载、全部表单操作、流式响应、图片和资源路径。测试使用 Node.js 24 的模块 mock 替换 Redis 与 AI 外部依赖，不会修改真实数据或调用付费模型；实际 AlemonX 界面和真实 AI 服务仍需在对应运行环境中联调。

### 作为私有包安装

```sh
git clone -b release https://gitee.com/suancaixianyu/alemonjs-aichat.git ./packages/alemonjs-aichat
yarn
```

## 2.配置

#### 配置app

在配置中添加该插件, 才能正常触发指令

如果使用的是git拉取项目的方式, 就不需要配置这个

```yaml
app:
  - "alemonjs-aichat"
```

#### 配置 Redis

Aichat 通过 `@alemonjs/db` 使用 AlemonJS 的全局 Redis 连接，请在全局数据库配置中设置 Redis，不再为 Aichat 单独配置连接。

`alemon.config.yaml`

```yaml
db:
  redis:
    # host默认 127.0.0.1
    host: "127.0.0.1"
    # 端口号默认 6379
    port: 6379
    # 无密码则留空或者不写, 默认无密码
    password: ""
    # Redis 数据库编号默认 0
    db: 0
```

#### 配置AI修图 (可选)

修图基于xai的grok接口实现, 该接口返回的图片也是xai的, 在特定平台中可能无法发送此图片,这时候可以用自己写个代理将图片转为可访问状态

已知无需转换的平台: `QQ`,`Bubble`
`alemon.config.yaml`

```yaml
# 代理默认可不填
httpProxy: "http://127.0.0.1:7897"
```

ai修图依赖于xai, 需要使用该功能必须添加一个grok模型, 在启动机器人后, 使用以下指令添加

```
#添加ai grok https://api.x.ai/v1 <你的apiKey> grok-4.5
```

Node.js 默认不会自动使用系统代理。如需通过 Clash 等本地代理访问 AI 服务，请配置 `httpProxy`。程序会保留每条 AI 配置中的服务器地址，并在网络层通过该代理发起请求，不需要额外启动转发脚本。

例如 xAI 的服务器地址仍填写 `https://api.x.ai/v1`，OpenAI 填写 `https://api.openai.com/v1`；不要把 AI 服务器地址填写成本地 HTTP 代理地址。

#### 配置搜索工具

启用 `LocalBrowser` 工具，直接调用运行 AlemonJS 的本机 Chrome 或 Edge
完成网页搜索和访问，无需搜索 API Key。默认自动寻找浏览器并以无界面模式运行；
如需指定浏览器，可在 `aiChat` 下配置：

```yaml
aiChat:
  localBrowser:
    channel: "msedge" # 可选：msedge 或 chrome
    headless: true
    # executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
```

#### 公共知识库

公共知识库位于服务进程工作目录下的 `public/knowledge/`（在主工程启动时为 `alemonjs/public/knowledge/`），启动时自动创建。把需要共享的文档或参考项目放入此目录，所有平台的群聊和私聊均可查询。

- 读取不需要开启 agent：使用 `AgentListWorkspaces`、`AgentListFiles`、`AgentSearchFiles` 或 `AgentReadFileLines`，并设置 `scope=public`。
- 维护仅限主人，且须先在当前会话执行 `#开启agent`。创建、编辑、删除、克隆及 Git 操作复用现有 Agent 工具，同样设置 `scope=public`。
- 所有路径参数相对于 `public/knowledge/`。不传 `scope` 或使用 `scope=session` 时，仍访问当前会话自己的项目；`guid` 由系统自动绑定。
- 每个会话单独禁用的工具仍不可用。公共目录只存放适合共享的资料，不会自动收录聊天记录或私人记忆。

例如，搜索公共文档使用 `AgentSearchFiles`，参数为 `{"scope":"public","query":"开发接口"}`；读取命中文档使用 `AgentReadFileLines`，参数为 `{"scope":"public","filePath":"docs/api.md"}`（会话标识由系统注入）。

#### 主人服务器 agent 权限

框架确认当前发言者是主人，并且主人已在当前会话执行 `#开启agent` 后，可使用服务器高权限模式：

- Agent 文件、搜索和项目工具设置 `scope=root` 后，以 Linux `/root` 为工作目录（Windows 开发环境以当前盘根目录为工作目录），可在该目录内读取、创建、修改和删除文件。
- `RunServerCommand` 可把 `workingDirectory` 设置为 `/root` 等任意现有目录，并执行任意 Shell 指令；主人模式跳过项目路径限制、本地命令黑名单和 AI 二次审核。
- `isMaster`、会话 guid 和 `reviewGuid` 均由框架覆盖注入，模型参数不能伪造主人或借用其他会话的 agent 开关。
- 普通用户、未开启 agent 的主人以及被单独禁用的工具继续沿用原有限制。
- 工具链绑定发起用户；执行期间只有发起者的补充消息可进入当前上下文，其他用户的消息和停止指令不会影响这轮任务。其他用户触发 AI 时会收到排队位置，消息在当前轮结束后按到达顺序作为独立 AI 对话执行，不会混入当前工具链。

### Codex CLI 多轮任务工具

AI 可以调用 `RunCodex` 将任务交给机器人所在机器的 Codex CLI。先在运行机器上安装
`@openai/codex` 并完成 `codex login`；机器人复用该机器的 Codex 认证和配置。

可在 AlemonX 配置页设置 `codexTool`，或在 YAML 的插件命名空间中配置：

```yaml
alemonjs-aichat:
  codexTool:
    # 可选，省略时从 PATH 寻找 codex；也可用环境变量 CODEX_TOOL_BINARY 覆盖。
    # binary: 'C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd'
    # 工作目录必须存在，显式 projectPath 只能选择它或它的子目录。
    projectPath: 'D:\projects\my-app'
    # model: 你的 Codex 模型名称
    autoApprove: true
    timeoutSeconds: 600
```

未配置 `codexTool.projectPath` 时，自动使用当前聊天的 `public/{guid}/` 工作目录。
`autoApprove=true` 使用 `workspace-write` 并由 Codex 自动审核操作；`false` 使用
`read-only`。配置的目录范围同样检查符号链接，不能通过链接跳到外部目录。
单次任务默认 600 秒，最大 1800 秒。Windows 支持 npm 安装生成的 `codex.cmd`，
也支持配置 `.exe` 或 Codex 的 `.js` 启动文件。

工具参数示例：

```json
{"prompt":"检查项目并修复测试"}
{"prompt":"继续完成上次修复，并说明测试结果"}
{"action":"listSessions"}
{"prompt":"开始另一项任务","newSession":true}
{"action":"switchSession","sessionId":"上面列表返回的会话 UUID"}
{"prompt":"继续旧任务","sessionId":"上面列表返回的会话 UUID"}
```

首次调用创建会话；后续省略 `sessionId` 时自动续接。独立任务需传
`newSession=true`。会话记录保存在 Redis，按聊天、发起用户和真实工作目录隔离；
只能列出和恢复通过该作用域的工具创建的会话。机器人重启后可继续之前的任务，
但 Codex 自身的本地会话文件也必须保留。更换工作目录后使用独立的会话记录。

执行期间同一作用域的运行和切换操作会被拒绝，查询可用。发起用户发送 `#stop`
可终止当前 CLI 进程及其子进程，保留会话以便后续恢复；普通成员在完全访问群中
通过此独立 CLI 工具执行时继续强制只读。输出包括最终结果、命令/文件活动、
会话 UUID、Token 用量和失败信息，内部推理事件不作为工具结果返回。

运行 `npm run test:codex` 构建并验证多轮续接、会话隔离、目录范围、进程中止和超时。
测试使用模拟 CLI 和 Redis，不调用真实模型。

CLI 的多轮执行依据 [OpenAI 官方的会话续接说明](https://learn.chatgpt.com/docs/non-interactive-mode)。

## 4.使用

需要先使用`#添加ai`,配置一个ai后才能使用对话功能,本项目仅支持`Chat Completions API`, 因此在填写主机地址时可能需要加上`/v1`,请根据供应商文档适当添加

| 指令        | 作用                         |
| ----------- | ---------------------------- |
| #添加ai     | 添加一个ai, 重名时更新       |
| #切换ai     | 切换一个ai配置并保留当前对话 |
| #锁定AI     | 主人按序号批量锁定ai配置     |
| #解锁AI     | 主人按序号批量解除ai配置锁定 |
| #开启对话   | 在当前位置启用ai聊天         |
| #ai配置     | 显示当前使用的配置           |
| #添加提示词 | 添加一个提示词               |
| #提示词列表 | 查看当前配置的所有提示词     |
| #切换提示词 | 切换一个提示词并保留当前对话 |
| #清空对话   | 清空当前对话并保留好感度     |
| #开启好感度 | 好感度会影响回复时的语气     |
| #好感度     | 查看自己的好感度             |
| #ai帮助     | 查看更多指令                 |

### 例子

```
#添加ai deepseek https://api.deepseek.com/v1 sk-kfcvme50 deepseek-v4-flash
```
