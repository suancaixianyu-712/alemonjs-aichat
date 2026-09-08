# AlemonJS Aichat 快速安装

本分支是可直接启动的 AlemonJS 骨架。安装脚本会从 Git 仓库的 `release`
分支拉取 Aichat 源码，并放入 `packages/alemonjs-aichat`。插件源码不会从 npm
安装，也不包含在本分支中。

## 环境要求

- Node.js 22 或更高版本（建议使用受支持的 LTS 版本）
- Git
- Yarn 1.x
- 可用的 Redis 服务
- OneBot 实现（例如 NapCat）及其正向 WebSocket 地址

检查环境：

```sh
node -v
git --version
yarn -v
```

如果系统没有 Yarn，可先安装：

```sh
npm install --global yarn
```

## 快速安装

```sh
git clone -b 快速安装 --single-branch https://gitee.com/suancaixianyu/alemonjs-aichat.git alemon-aichat
cd alemon-aichat
yarn setup
```

`yarn setup` 会依次完成以下操作：

1. 从 `release` 分支克隆插件源码到 `packages/alemonjs-aichat`；
2. 首次安装时从 `alemon.config.example.yaml` 创建本地配置；
3. 安装启动工程和插件的运行依赖。

如果 `packages/alemonjs-aichat` 已存在，安装脚本不会覆盖它。需要更新现有
插件时请使用后文的更新命令。

## 配置

编辑安装目录中的 `alemon.config.yaml`。该文件已被 Git 忽略，不会随提交上传。

最少需要配置 OneBot 和 Redis：

```yaml
login: onebot

apps:
  - alemonjs-aichat

db:
  redis:
    host: '127.0.0.1'
    port: 6379
    password: ''
    db: 0

onebot:
  url: 'ws://127.0.0.1:3001'
  token: ''
  reverse_enable: false
  reverse_port: 17158
  master_id:
    - '你的QQ号'
```

完整的可选项和注释见 `alemon.config.example.yaml`。

### 配置 AI

启动机器人后，可以通过指令添加 AI：

```text
#添加ai deepseek https://api.deepseek.com/v1 <你的API Key> deepseek-chat
```

也可以在 `alemon.config.yaml` 中声明一个 AI：

```yaml
alemonjs-aichat:
  ai:
    name: deepseek
    host: https://api.deepseek.com/v1
    key: sk-xxxxxxxx
    model: deepseek-chat
```

接口地址是否需要 `/v1`，请以模型供应商的文档为准。

### 本地浏览器搜索

Aichat 可以直接调用运行机器人所在电脑上的 Chrome 或 Edge，无需配置搜索 API
Key。默认自动寻找浏览器，也可以显式指定 Edge：

```yaml
alemonjs-aichat:
  localBrowser:
    channel: msedge
    headless: true
    # executablePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

`channel` 可设置为 `msedge` 或 `chrome`。

## 启动

确保 Redis、OneBot 和对应的 QQ 客户端已经运行，然后执行：

```sh
yarn start
```

停止机器人可按 `Ctrl+C`。

首次启动后，使用 `#添加ai` 或 YAML 中声明的 AI 配置模型，再发送
`#开启对话` 启用聊天。

### 后台运行

确认前台启动正常后，先按 `Ctrl+C` 停止前台进程，再执行：

```sh
yarn start:pm2
yarn logs
```

停止后台进程使用 `yarn stop`；更新代码后再次执行 `yarn start:pm2` 即可重启。
该命令不配置系统开机自启。

## 更新 Aichat

```sh
yarn update:aichat
```

更新脚本只处理 `packages/alemonjs-aichat`：它会确认目录是干净的 `release`
分支，执行 `git pull --ff-only origin release`，然后重新安装依赖。若插件目录中
存在未提交修改，脚本会停止，避免覆盖本地改动。
检查未跟踪文件时仅排除安装生成的 `node_modules` 目录。

更新后需要重启正在运行的机器人。安装曾因网络中断失败时，也可以使用此命令
继续安装运行依赖；本地 `alemon.config.yaml` 不会被覆盖。

## 手动安装

如果不使用安装脚本，等价命令如下：

```sh
git clone -b 快速安装 --single-branch https://gitee.com/suancaixianyu/alemonjs-aichat.git alemon-aichat
cd alemon-aichat
git clone -b release --single-branch https://gitee.com/suancaixianyu/alemonjs-aichat.git packages/alemonjs-aichat
```

复制配置文件：

Windows PowerShell：

```powershell
Copy-Item alemon.config.example.yaml alemon.config.yaml
```

Linux 或 macOS：

```sh
cp alemon.config.example.yaml alemon.config.yaml
```

最后安装依赖并启动：

```sh
yarn install --production=true --link-folder .yarn-links
yarn start
```

## 常见问题

### 提示目标目录已存在

`packages/alemonjs-aichat` 已存在时，`yarn setup` 不会删除或覆盖该目录。若它是
此前安装的 `release` 分支，使用 `yarn update:aichat` 更新即可。

### 更新时提示存在未提交修改

进入 `packages/alemonjs-aichat`，先提交或自行备份修改，再重新执行更新命令。
更新脚本不会自动清理源码目录。

### 无法连接 Redis

确认 Redis 服务已启动，并检查 `db.redis` 下的主机、端口、密码和数据库编号。
Aichat 不再使用旧的 `aiChat.redis` 配置。

### 插件没有响应

确认配置使用 `apps`（复数），且其中包含 `alemonjs-aichat`；随后检查 OneBot
WebSocket 地址、Token 和主人 QQ 号是否正确。

更多 AlemonJS 文档见 [https://alemonjs.com/docs](https://alemonjs.com/docs)。
