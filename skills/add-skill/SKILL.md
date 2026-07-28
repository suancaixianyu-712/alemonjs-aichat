---
name: add-skill
description: 添加并登记新技能, 例如根据用户需求创建新技能, 或将现有技能组合成新技能; 创建后通过 RunServerCommand 将技能目录写入 alemon.config.yaml 的 aiChat.skills_dir
---

# Add Skill

添加新技能的技能。

当前运行环境有权限边界: AI 不能假设自己可以写入软件包内置的 `./skills` 目录、宿主机任意绝对路径或进程工作目录外的文件。新增技能时必须优先使用当前可用的 `Agent*` 文件工具, 将文件写入 `public/{guid}/` 工作目录内。

技能路径有两类:

- 内置技能目录: 软件包中的 `./skills`。这是只读来源, 除非用户明确说明当前环境有权限直接修改软件包源码, 否则不要把新技能写到这里。
- 用户自定义技能目录: 由 `alemon.config.yaml` 中的 `aiChat.skills_dir` 指定。默认可配置为 `["./skills"]`, 在受限环境中建议配置为包含某个可写工作区, 例如 `["./skills", "./public/<guid>/skills"]`。

在当前受限权限下, 默认把新技能创建到 `public/{guid}/skills/<skill-name>/SKILL.md`。创建完成后, 必须使用 `RunServerCommand` 读取服务目录中的 `alemon.config.yaml`, 并确保 `./public/<guid>/skills` 已登记到 `aiChat.skills_dir`。登记的是 `skills` 父目录, 不是单个技能目录。

所有新建的技能必须要新建一个目录, 例如`./skills/my-skill`, 在该目录下创建一个`SKILL.md`文件, 并将技能的名称和描述写入文件中, 如果需要使用工具函数, 则在该目录下创建一个`<tool>.js`文件, 并将工具函数写入文件中。
脚本文件需要能够通过命令行直接执行, 并支持传参, 例如`node <tool>.js <arg1> <arg2>`, 脚本必须是执行后就能得到结果的, 不能是需要用户交互的, 例如`node <tool>.js`后需要用户输入一些内容才能得到结果的脚本是不允许的。

此外脚本必须写清楚输入输出的格式, 例如输入是一个字符串, 输出是一个字符串, 输入是一个文件路径, 输出是一个文件路径等, 以便AI能够正确地使用工具函数。

脚本必须为JavaScript文件, 以便AI能够正确地使用工具函数, 其他语言的脚本文件是不允许的。

## Tools

- `AgentListWorkspaces`: 不知道可用 `guid` 时, 先列出 `public/` 下已有工作区。
- `AgentCreateWorkspace`: 没有可用工作区时创建 `public/{guid}/`。
- `AgentListFiles`: 查看目标 `skills` 目录和已有技能。
- `AgentReadFileLines`: 读取已有技能内容, 用于组合、复用或避免覆盖。
- `AgentCreateFile`: 创建新的 `SKILL.md` 或工具脚本。默认不要覆盖已有文件。
- `AgentWriteFile`: 只在已经确认需要覆盖或追加时使用。
- `AgentProjectCommand`: 只用于必要的受限检查, 例如创建目录或运行脚本自检。
- `RunServerCommand`: 读取和安全更新服务目录中的 `alemon.config.yaml`; 调用时必须传当前会话的 `reviewGuid`。

## Workflow

1. 接收用户提供的技能需求
2. 确认本次使用的 `guid`
   - 如果用户已经给出 `guid`, 直接使用
   - 如果不知道 `guid`, 先调用 `AgentListWorkspaces`
   - 如果没有合适的工作区, 调用 `AgentCreateWorkspace`
3. 规范化技能名
   - 使用小写短横线命名, 例如 `my-skill`
   - 只允许字母、数字和短横线
   - 不允许绝对路径、`../`、空格或会逃逸目录的名称
4. 判断是创建新技能, 还是将现有技能组合成新技能
   - 需要查看已有技能时, 先用 `getSKILLDetail` 读取内置或已配置技能
   - 需要查看工作区内已有技能时, 用 `AgentListFiles` 和 `AgentReadFileLines`
5. 创建目标目录和文件
   - 目标路径固定为 `skills/<skill-name>/SKILL.md`, 该路径是相对 `public/{guid}/` 的路径
   - 目录不存在时, 可用 `AgentProjectCommand` 的 `mkdir` 创建 `skills/<skill-name>`
   - 用 `AgentCreateFile` 创建 `skills/<skill-name>/SKILL.md`
   - 如果必须添加工具脚本, 只创建 JavaScript 文件, 例如 `skills/<skill-name>/<tool>.js`
6. 写入 `SKILL.md`
   - 文件必须包含 frontmatter: `name` 和 `description`
   - 正文要写清楚触发场景、工作流、可用工具、输入输出和限制
   - 如果包含脚本, 必须写清脚本命令、参数和输出格式
7. 写完后用 `AgentReadFileLines` 读取 `SKILL.md`, 确认内容已经落盘
8. 用 `RunServerCommand` 读取配置
   - `reviewGuid` 必须使用当前会话的群号或 guid
   - 从服务进程工作目录读取 `alemon.config.yaml`
   - 只分析 `aiChat.skills_dir` 是否已经包含 `./public/<guid>/skills`; 不要在最终回复中输出配置里的密钥、密码或令牌
9. 用 `RunServerCommand` 登记技能目录
   - 如果路径已经存在, 不重复写入
   - 如果 `skills_dir` 是字符串, 转为数组并保留原值
   - 如果 `skills_dir` 是数组, 保留所有原目录并追加新目录
   - 如果没有 `skills_dir`, 在 `aiChat` 下创建数组配置
   - 只修改 `aiChat.skills_dir`, 保持其他配置内容不变
   - 写入前创建同目录临时文件和备份; 新内容写入临时文件后再替换原配置; 替换成功并验证后删除备份; 失败时恢复原配置
10. 再次用 `RunServerCommand` 读取 `aiChat.skills_dir`, 确认 `./public/<guid>/skills` 已经写入且没有重复
11. 返回新技能的名称、描述、文件路径、配置登记结果和生效提示
   - 只有复读验证成功时, 才能声称配置已经写入
   - 技能列表存在进程内缓存; 配置写入成功后提示用户重启或刷新服务, 不要擅自重启
   - 如果 `RunServerCommand` 审核未通过、配置文件不存在或写入失败, 保留已经创建的技能文件并明确报告配置登记失败

## Output Format

```text
技能名称: <技能名称>
技能描述: <技能描述>
技能路径: public/<guid>/skills/<技能名称>/SKILL.md
配置登记: 已将 ./public/<guid>/skills 写入 alemon.config.yaml 的 aiChat.skills_dir / 登记失败: <原因>
生效提示: 配置成功后需要重启或刷新服务以清理技能缓存
```

## Rules

- 不要使用终端命令、Docker、容器或任意宿主机文件路径来创建技能文件。
- `alemon.config.yaml` 不在 `public/{guid}/` 内, 只能通过带自动审核的 `RunServerCommand` 读取和写入; 不要用 Agent 文件工具越界修改配置。
- 不要写入软件包内置 `./skills` 目录, 除非用户明确说明当前环境允许直接修改源码且可用工具确实能访问该目录。
- 所有通过 Agent 文件工具创建的路径都必须相对 `public/{guid}/`, 不要传绝对路径。
- 不要使用 `../` 试图离开工作区。
- 已有同名技能时, 先读取确认, 再询问用户是否覆盖或改名; 不要静默覆盖。
- 如果需要组合多个已有技能, 在新 `SKILL.md` 中写明组合顺序和每个被组合技能的职责边界。
- 如果新技能依赖运行脚本, 脚本必须是非交互式 JavaScript 文件, 并且能够通过 `node <tool>.js <args>` 直接返回结果。
- 更新 `skills_dir` 时必须保留已有的 `./skills` 和其他自定义目录, 不得用新目录覆盖整个配置项。
- 不要把 `public/<guid>/skills/<skill-name>` 写入 `skills_dir`; 加载器需要的是 `./public/<guid>/skills`。
