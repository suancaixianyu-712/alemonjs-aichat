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
xaiImgProxy: "http://127.0.0.1:3002/ximgen"
```

ai修图依赖于xai, 需要使用该功能必须添加一个grok模型, 在启动机器人后, 使用以下指令添加

```
#添加ai grok https://api.x.ai/v1 <你的apiKey> grok-4.5
```

通常情况下nodejs不会使用本地的代理, 因此你可能需要自己解决一下无法访问ai的问题, 例如另写一个脚本, 脚本已经预备好了, 下载项目中的`daili.js`然后运行它即可(Clash的默认端口一般是7890, 可能需要修改一下daili.js中的端口)

```sh
node daili
```

如果你使用的是`daili.js`, 那么地址需要改为`http://127.0.0.1:3002/x/v1`

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

## 4.使用

需要先使用`#添加ai`,配置一个ai后才能使用对话功能,本项目仅支持`Chat Completions API`, 因此在填写主机地址时可能需要加上`/v1`,请根据供应商文档适当添加

| 指令        | 作用                         |
| ----------- | ---------------------------- |
| #添加ai     | 添加一个ai, 重名时更新       |
| #切换ai     | 切换一个ai配置并保留当前对话 |
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
