# alemonjs-aichat 开发记录

## 2026-05-03 任务总结

### 任务一：正则表达式自动触发规则 (Issue #IJGYB9)

**需求**：配置文件中允许使用正则表达式配置规则，聊天中符合规则自动触发AI聊天，不需要艾特。

**修改文件（6个）：**

| 文件 | 改动说明 |
|------|----------|
| `src/config.ts` | 新增正则规则 Redis 存储方法（增删查改+匹配） |
| `src/middleware/mw.ts` | 仅艾特模式下检查正则匹配，匹配则放行并标记 `regexTriggered` |
| `src/response/zreply/res.ts` | 正则触发的消息跳过概率过滤，直接响应 |
| `src/response/setting/res.ts` | 新增 `/添加正则规则` `/删除正则规则` `/正则规则列表` `/清空正则规则` 命令 |
| `src/routes/commands.ts` | 注册新命令路由 |
| `src/data/help.json` | 帮助文档更新 |

**Redis 数据结构：**
```
ai:regex_rules:{guid}  → 正则规则 JSON 数组
```

**使用示例：**
```
/添加正则规则 .*早上好.*     → 消息含"早上好"时自动触发
/添加正则规则 ^小鱼           → 消息以"小鱼"开头时自动触发
/正则规则列表                 → 查看当前规则
/删除正则规则 1               → 删除第1条规则
```

---

### 任务二：修复日期年份缺失 Bug

**需求**：机器人不能获取正确日期年份，系统提示词使用的 `getTimeString()` 方法只返回月日。

**修改文件（1个）：**

| 文件 | 改动说明 |
|------|----------|
| `src/api/format.ts` | 返回格式从 `MM-DD HH:mm` 改为 `YYYY-MM-DD HH:mm` |

---

### 任务三：Docker 容器环境切换 (Issue #IJE8BN)

**需求**：允许白名单用户切换到系统环境执行指令，支持群容器、用户容器、系统环境三种 exec 模式。

**修改文件（7个）：**

| 文件 | 改动说明 |
|------|----------|
| `src/types.ts` | 新增 `ContainerConfig` 接口，`AIChatConfig` 添加 `superAdmin`/`groupContainer`/`userContainer` |
| `src/config.ts` | 新增容器管理方法：创建/切换/环境初始化/超级管理员判断 |
| `src/api/aitools.ts` | exec 工具重写：`docker exec` 持久化容器 或 宿主机直接执行 |
| `src/response/setting/res.ts` | 新增 `/切换群容器` `/切换用户容器` `/切换系统环境` 命令 |
| `src/middleware/mw.ts` | 首次触发自动初始化 exec 环境（群聊→群容器，私聊→用户容器） |
| `src/routes/commands.ts` | 注册新命令路由 |
| `src/data/help.json` | 帮助文档更新 |

**配置文件 `alemon.config.yaml` 示例：**
```yaml
aiChat:
  superAdmin: ["3501869534"]
  groupContainer:
    image: "ubuntu:latest"
    memory: "256m"
    cpus: "0.5"
    pidsLimit: 64
  userContainer:
    image: "ubuntu:latest"
    memory: "128m"
    cpus: "0.25"
    pidsLimit: 32
```

**Redis 数据结构：**
```
ai:container:group:{groupId}        → 群容器配置 JSON
ai:container:user:{userId}          → 用户容器配置 JSON
ai:container:env:{groupId}:{userId} → 群聊中该用户的当前 exec 配置
ai:container:env:private:{userId}   → 私聊中该用户的当前 exec 配置
```

**容器自动创建逻辑：**
- 群容器：群聊中首次触发 AI 聊天时自动创建，所有用户默认指向群容器
- 用户容器：用户手动 `/切换用户容器` 或私聊首次触发时自动创建
- 系统环境：仅超级管理员在私聊中可切换

**用户命令：**
```
/切换群容器     → exec 指向当前群的 Docker 容器（所有用户可用）
/切换用户容器   → exec 指向自己的 Docker 容器（所有用户可用）
/切换系统环境   → exec 在宿主机执行（仅超级管理员私聊可用）
```
