# 任务总结：远程节点 + Slurm + Singularity 容器支持

## 时间
2026-05-04 16:30 - 17:30

---

## 需求概述
为 alemonjs-aichat 项目添加远程节点连接功能，支持：
1. SSH 密钥认证连接远程节点
2. 通过 Slurm 管理作业
3. 操作 Singularity 容器
4. 用户可切换群容器/用户容器/远程节点/Singularity 容器

---

## 实现内容

### 一、配置文件改动
**文件：** `alemon.config.yaml`

新增 `remoteNodes` 配置项，与 `groupContainer`、`userContainer` 并行：

```yaml
aiChat:
  # ... 现有配置 ...
  
  # 远程登录节点配置
  remoteNodes:
    - name: "node1"
      host: "192.168.1.100"
      port: 22
      user: "username"
      keyFile: "/path/to/id_rsa"
      password: ""
      slurm: true
      singularity: true
      workdir: "/home/user/workspace"
      
    - name: "gpu-node"
      host: "gpu.example.com"
      user: "alemon"
      keyFile: "~/.ssh/id_ed25519"
      slurm: true
      singularity: true
      slurmPartition: "gpu"
      defaultImage: "/share/images/pytorch.sif"
```

**Redis 配置优化：** 新增 `socket` 字段，支持手动指定 Unix Socket 路径

---

### 二、新增代码模块

#### 1. `src/remoteNodes.ts` - 远程节点管理
**功能：**
- SSH 连接管理（使用 ssh2 库，支持密钥文件和密码认证）
- 连接池管理（缓存 SSH 连接）
- 直接执行命令（类似 shell，超时默认 30 秒）
- Slurm 作业管理：
  - `submitSlurmJob()` - 提交作业（自动生成 sbatch 脚本）
  - `querySlurmJob()` - 查询作业状态（squeue/sacct）
  - `cancelSlurmJob()` - 取消作业（scancel）
  - `getSlurmJobOutput()` - 查看作业日志
- Singularity 支持：
  - `listSingularityImages()` - 列出远程节点上的镜像

**主要接口：**
```typescript
export class RemoteNodeManager {
  getNode(name: string): RemoteNodeConfig | undefined;
  listNodes(): RemoteNodeConfig[];
  execute(nodeName: string, command: string, timeout?: number): Promise<string>;
  submitSlurmJob(nodeName: string, script: string, options?): Promise<{ jobId, output }>;
  querySlurmJob(nodeName: string, jobId?: string): Promise<string>;
  cancelSlurmJob(nodeName: string, jobId: string): Promise<string>;
  getSlurmJobOutput(nodeName: string, jobId: string): Promise<string>;
  listSingularityImages(nodeName: string, searchPath?: string): Promise<string[]>;
  testConnection(nodeName: string): Promise<boolean>;
}
```

---

#### 2. `src/userEnv.ts` - 用户环境管理
**功能：**
- 用户环境存储（Redis key: `ai:user:env:{groupId}:{userId}`）
- 环境类型：`system` | `group` | `user` | `remote` | `singularity`
- 环境切换和查询

**主要接口：**
```typescript
export type EnvType = "system" | "group" | "user" | "remote" | "singularity";

export interface UserEnvConfig {
  type: EnvType;
  nodeName?: string;          // 远程节点名称
  singularityImage?: string;  // Singularity 镜像路径
  containerName?: string;     // 容器名称（group/user）
}

// 获取/设置用户环境
getUserEnv(groupId: string, userId: string): Promise<UserEnvConfig | null>;
setUserEnv(groupId: string, userId: string, config: UserEnvConfig): Promise<void>;
initUserEnv(groupId: string, userId: string): Promise<UserEnvConfig>;

// 切换环境
switchToSystem(groupId, userId): Promise<string>;
switchToGroup(groupId, userId): Promise<string>;
switchToUser(groupId, userId): Promise<string>;
switchToRemote(groupId, userId, nodeName: string): Promise<string>;
switchToSingularity(groupId, userId, nodeName: string, image?: string): Promise<string>;

// 查询
getEnvDescription(groupId, userId): Promise<string>;
listAvailableEnvs(): Promise<string>;
getExecCommandEnv(groupId, userId): Promise<{ type, nodeName, nodeConfig, singularityImage }>;
```

---

#### 3. `src/api/aitools.ts` - 修改 exec 函数
**改动：**
- 导入 `getExecCommandEnv`、`remoteNodeManager`
- 修改 `exec` 函数，根据环境类型选择执行方式：
  - `system` → 直接在宿主机执行（原有逻辑）
  - `group` / `user` → 在 Docker 容器中执行（原有逻辑）
  - `remote` → 通过 SSH 在远程节点执行（新增）
  - `singularity` → 通过 SSH 在远程节点的 Singularity 容器中执行（新增）

**执行流程：**
```typescript
exec: async ({ userId, groupId, command }) => {
  const envInfo = await getExecCommandEnv(groupId, userId);
  
  if (envInfo.type === "remote") {
    // SSH 执行
    return await remoteNodeManager.execute(envInfo.nodeName, command);
  }
  
  if (envInfo.type === "singularity") {
    // Singularity 执行
    const singularityCmd = `singularity exec ${image} sh -c '${command}'`;
    return await remoteNodeManager.execute(envInfo.nodeName, singularityCmd);
  }
  
  // ... 原有逻辑（system、group、user）
}
```

---

#### 4. `src/response/env/res.ts` - 环境切换命令处理
**新增命令：**

| 命令 | 功能 | 示例 |
|------|------|------|
| `/查看环境` | 查看当前环境和可用环境列表 | `/查看环境` |
| `/切换环境 system` | 切换到系统环境（仅私聊+超级管理员） | `/切换环境 system` |
| `/切换环境 group` | 切换到群容器（仅群聊） | `/切换环境 group` |
| `/切换环境 user` | 切换到用户容器 | `/切换环境 user` |
| `/切换环境 remote <节点名>` | 切换到远程节点 | `/切换环境 remote node1` |
| `/切换环境 singularity <节点名> [镜像]` | 切换到 Singularity 容器 | `/切换环境 singularity gpu-node pytorch.sif` |

**Slurm 作业管理命令：**

| 命令 | 功能 | 示例 |
|------|------|------|
| `/slurm 提交 <脚本>` | 提交 Slurm 作业 | `/slurm 提交 python train.py` |
| `/slurm 状态 [JobID]` | 查询作业状态 | `/slurm 状态` 或 `/slurm 状态 12345` |
| `/slurm 日志 <JobID>` | 查看作业日志 | `/slurm 日志 12345` |
| `/slurm 取消 <JobID>` | 取消作业 | `/slurm 取消 12345` |
| `/slurm 列表` | 列出我的作业 | `/slurm 列表` |

**其他命令：**

| 命令 | 功能 | 示例 |
|------|------|------|
| `/测试节点 <节点名>` | 测试远程节点连接 | `/测试节点 node1` |
| `/列出镜像 [节点名]` | 列出远程节点上的 Singularity 镜像 | `/列出镜像 gpu-node` |

---

### 三、依赖库
已安装：`ssh2`（SSH 客户端）

---

## 使用流程

### 1. 配置远程节点
编辑 `alemon.config.yaml`，添加 `remoteNodes` 配置：
```yaml
aiChat:
  remoteNodes:
    - name: "my-node"
      host: "192.168.1.100"
      port: 22
      user: "your-username"
      keyFile: "/path/to/your/id_rsa"  # 或留空使用密码
      password: ""  # 可选，如果不用密钥
      slurm: true     # 如果节点支持 Slurm
      singularity: true  # 如果节点支持 Singularity
      workdir: "/home/yourname"  # 可选
```

### 2. 测试连接
```
/测试节点 my-node
```

### 3. 切换环境
```
/切换环境 remote my-node
```
或
```
/切换环境 singularity my-node /path/to/image.sif
```

### 4. 执行命令
现在使用 `/exec` 命令会在你切换的环境中执行。

### 5. Slurm 作业管理（如果使用 Slurm）
```
/slurm 提交 python train.py
→ 返回 Job ID

/slurm 状态 12345
→ 查看作业状态

/slurm 日志 12345
→ 查看作业输出
```

---

## Redis 存储结构

### 用户环境配置
- Key: `ai:user:env:{groupId}:{userId}` 或 `ai:user:env:private:{userId}`
- Value: JSON 字符串
```json
{
  "type": "remote",
  "nodeName": "my-node",
  "singularityImage": "/path/to/image.sif"
}
```

---

## 注意事项

1. **SSH 密钥文件权限**：确保密钥文件权限正确（建议 600）
2. **Slurm 命令**：确保远程节点已安装 Slurm（sbatch、squeue、scancel、sacct）
3. **Singularity 命令**：确保远程节点已安装 Singularity
4. **防火墙**：确保本地机器可以访问远程节点的 SSH 端口（默认 22）
5. **工作目录**：切换环境后，命令会在 `workdir` 或默认目录下执行

---

## 下一步建议

1. **错误重试**：SSH 连接失败时自动重试
2. **并行执行**：支持同时在多个远程节点上执行命令
3. **文件传输**：支持从本地到远程节点的文件上传/下载
4. **环境隔离**：不同群聊的用户环境完全隔离
5. **Web UI**：提供网页界面管理远程节点和环境切换

---

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `alemon.config.yaml` | 修改 | 添加 remoteNodes 配置 |
| `src/remoteNodes.ts` | 新增 | 远程节点管理模块 |
| `src/userEnv.ts` | 新增 | 用户环境管理模块 |
| `src/api/aitools.ts` | 修改 | 修改 exec 函数支持远程执行 |
| `src/response/env/res.ts` | 新增 | 环境切换命令处理 |

---

## 编译测试

```bash
cd D:\IdeaProjects\alemonjs-aichat
npm run build
```

构建成功，生成了 lib/ 目录下的编译文件。

---

## 已完成 ✅

- [x] 配置文件添加 remoteNodes
- [x] Redis 配置优化（增加 socket 字段）
- [x] 远程节点管理模块（SSH 连接、命令执行）
- [x] Slurm 作业管理（提交、查询、取消、日志）
- [x] Singularity 容器操作
- [x] 用户环境管理（切换、查询）
- [x] exec 函数修改（支持远程和 Singularity）
- [x] 命令处理（/切换环境、/slurm、/测试节点 等）
- [x] 编译测试通过

---

## 待用户配置 🔧

1. 修改 `alemon.config.yaml` 中的 `remoteNodes`，填写真实的节点信息
2. 确保远程节点已安装 Slurm 和 Singularity（如果使用）
3. 测试连接：`/测试节点 <节点名>`
4. 切换环境并开始使用

---

**实现完成！** 🎉
