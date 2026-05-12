import { Client, ConnectConfig } from "ssh2";
import { getConfigValue } from "alemonjs";
import fs from "fs";
import path from "path";

export interface RemoteNodeConfig {
  name: string;
  host: string;
  port: number;
  user: string;
  keyFile?: string;
  password?: string;
  slurm: boolean;
  singularity: boolean;
  workdir?: string;
  slurmPartition?: string;
  defaultImage?: string;
}

interface ConnectionInfo {
  client: Client;
  ready: boolean;
}

export class RemoteNodeManager {
  private nodes: Map<string, RemoteNodeConfig> = new Map();
  private connections: Map<string, ConnectionInfo> = new Map();

  constructor() {
    this.loadConfig();
  }

  /**
   * 从配置文件加载远程节点配置
   */
  private loadConfig(): void {
    const configValue = getConfigValue();
    const aiChatConfig = configValue.aiChat || {};
    const remoteNodes = aiChatConfig.remoteNodes || [];

    for (const node of remoteNodes) {
      if (node.name) {
        this.nodes.set(node.name, {
          name: node.name,
          host: node.host || "localhost",
          port: node.port || 22,
          user: node.user || "",
          keyFile: node.keyFile || "",
          password: node.password || "",
          slurm: node.slurm || false,
          singularity: node.singularity || false,
          workdir: node.workdir || "",
          slurmPartition: node.slurmPartition || "",
          defaultImage: node.defaultImage || "",
        });
      }
    }
    console.log(`[RemoteNode] 已加载 ${this.nodes.size} 个远程节点配置`);
  }

  /**
   * 获取节点配置
   */
  getNode(name: string): RemoteNodeConfig | undefined {
    return this.nodes.get(name);
  }

  /**
   * 列出所有可用节点
   */
  listNodes(): RemoteNodeConfig[] {
    return Array.from(this.nodes.values());
  }

  /**
   * 解析密钥文件路径（支持 ~ 展开）
   */
  private resolveKeyPath(keyFile: string): string {
    if (keyFile.startsWith("~")) {
      return path.join(process.env.HOME || process.env.USERPROFILE || "", keyFile.slice(1));
    }
    return keyFile;
  }

  /**
   * 建立 SSH 连接
   */
  private async connect(nodeName: string): Promise<Client> {
    const node = this.nodes.get(nodeName);
    if (!node) {
      throw new Error(`未找到远程节点: ${nodeName}`);
    }

    // 如果已有连接，检查是否可用，否则重新连接
    const existing = this.connections.get(nodeName);
    if (existing && existing.ready) {
      try {
        const testResult = await this.executeQuick(nodeName, "echo ok", 3000);
        if (testResult.trim() === "ok") {
          return existing.client;
        }
      } catch {
        console.log(`[RemoteNode] 连接 ${nodeName} 已失效，重新连接`);
      }
    }

    const config: ConnectConfig = {
      host: node.host,
      port: node.port,
      username: node.user,
    };

    // 优先使用密钥文件
    if (node.keyFile) {
      const keyPath = this.resolveKeyPath(node.keyFile);
      if (fs.existsSync(keyPath)) {
        config.privateKey = fs.readFileSync(keyPath, "utf8");
        console.log(`[RemoteNode] 使用密钥文件: ${keyPath}`);
      } else {
        console.warn(`[RemoteNode] 密钥文件不存在: ${keyPath}，尝试密码认证`);
        if (node.password) {
          config.password = node.password;
        }
      }
    } else if (node.password) {
      config.password = node.password;
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      
      client.on("ready", () => {
        console.log(`[RemoteNode] 已连接到 ${nodeName} (${node.host}:${node.port})`);
        this.connections.set(nodeName, { client, ready: true });
        resolve(client);
      });

      client.on("error", (err) => {
        console.error(`[RemoteNode] 连接失败 ${nodeName}:`, err.message);
        reject(err);
      });

      client.on("close", () => {
        console.log(`[RemoteNode] 连接已关闭 ${nodeName}`);
        this.connections.delete(nodeName);
      });

      client.connect(config);
    });
  }

  /**
   * 执行远程命令（直接执行模式，类似 shell）
   * @param nodeName 节点名称
   * @param command 要执行的命令
   * @param timeout 超时时间（毫秒），默认 30 秒
   * @returns 命令输出
   */
  async execute(nodeName: string, command: string, timeout: number = 30000): Promise<string> {
    const client = await this.connect(nodeName);
    const node = this.nodes.get(nodeName)!;

    // 如果设置了工作目录，先 cd 进去
    const fullCommand = node.workdir 
      ? `cd "${node.workdir}" && ${command}`
      : command;

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const done = (err: Error | null, result?: string) => {
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(result || "");
      };

      timer = setTimeout(() => {
        done(new Error(`命令执行超时（${timeout}ms）`));
      }, timeout);

      client.exec(fullCommand, (err, stream) => {
        if (err) {
          done(err);
          return;
        }

        let output = "";
        let errorOutput = "";

        stream.on("close", (code: number, signal: string) => {
          if (code !== 0) {
            done(new Error(`命令退出码: ${code}\n${errorOutput || output}`));
          } else {
            done(null, output);
          }
        });

        stream.on("data", (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          errorOutput += data.toString();
        });
      });
    });
  }

  /**
   * 快速执行命令（用于健康检查，不打印日志）
   */
  private executeQuick(nodeName: string, command: string, timeout: number): Promise<string> {
    const client = this.connections.get(nodeName)?.client;
    if (!client) throw new Error("无可用连接");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("超时")), timeout);
      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let output = "";
        stream.on("data", (d: Buffer) => (output += d.toString()));
        stream.on("close", () => {
          clearTimeout(timer);
          resolve(output);
        });
        stream.stderr.on("data", () => {});
      });
    });
  }

  /**
   * 通过 Slurm 提交作业
   * @param nodeName 节点名称
   * @param script 要执行的脚本或命令
   * @param options Slurm 选项
   * @returns Slurm Job ID
   */
  async submitSlurmJob(
    nodeName: string, 
    script: string, 
    options?: {
      jobName?: string;
      partition?: string;
      image?: string;
      output?: string;
      error?: string;
    }
  ): Promise<{ jobId: string; output: string }> {
    const node = this.nodes.get(nodeName);
    if (!node) {
      throw new Error(`未找到远程节点: ${nodeName}`);
    }
    if (!node.slurm) {
      throw new Error(`节点 ${nodeName} 未启用 Slurm 支持`);
    }

    // 构建 sbatch 脚本
    let sbatchScript = "#!/bin/bash\n";
    sbatchScript += `#SBATCH --job-name=${options?.jobName || "alemonjs_job"}\n`;
    
    if (options?.partition || node.slurmPartition) {
      sbatchScript += `#SBATCH --partition=${options?.partition || node.slurmPartition}\n`;
    }
    
    if (options?.output) {
      sbatchScript += `#SBATCH --output=${options.output}\n`;
    } else {
      sbatchScript += `#SBATCH --output=slurm-%j.out\n`;
    }
    
    if (options?.error) {
      sbatchScript += `#SBATCH --error=${options.error}\n`;
    }

    // 如果指定了 Singularity 镜像，使用 singularity 执行
    if (options?.image || node.defaultImage) {
      const image = options?.image || node.defaultImage!;
      sbatchScript += `\nsingularity exec ${image} ${script}\n`;
    } else {
      sbatchScript += `\n${script}\n`;
    }

    // 将脚本内容通过 base64 安全传输到远程节点
    const remoteScriptPath = `/tmp/alemonjs_sbatch_${Date.now()}.sh`;
    const encodedScript = Buffer.from(sbatchScript).toString("base64");
    await this.execute(nodeName, `echo ${encodedScript} | base64 -d > ${remoteScriptPath}`);
    
    // 提交作业
    const result = await this.execute(nodeName, `sbatch ${remoteScriptPath}`);
    
    // 解析 Job ID
    const match = result.match(/Submitted batch job (\d+)/);
    if (!match) {
      throw new Error(`无法解析 Slurm Job ID，输出: ${result}`);
    }

    const jobId = match[1];
    console.log(`[RemoteNode] Slurm 作业已提交: JobID=${jobId}, 节点=${nodeName}`);

    return { jobId, output: result };
  }

  /**
   * 查询 Slurm 作业状态
   */
  async querySlurmJob(nodeName: string, jobId?: string): Promise<string> {
    const node = this.nodes.get(nodeName);
    if (!node || !node.slurm) {
      throw new Error(`节点不支持 Slurm`);
    }

    const command = jobId 
      ? `sacct -j ${jobId} --format=JobID,JobName,State,ExitCode,Start,End,Elapsed`
      : `squeue -u ${node.user}`;
    
    return await this.execute(nodeName, command);
  }

  /**
   * 取消 Slurm 作业
   */
  async cancelSlurmJob(nodeName: string, jobId: string): Promise<string> {
    const node = this.nodes.get(nodeName);
    if (!node || !node.slurm) {
      throw new Error(`节点不支持 Slurm`);
    }

    return await this.execute(nodeName, `scancel ${jobId}`);
  }

  /**
   * 查看 Slurm 作业输出日志
   */
  async getSlurmJobOutput(nodeName: string, jobId: string): Promise<string> {
    const command = `cat slurm-${jobId}.out 2>/dev/null || echo "日志文件不存在"`;
    return await this.execute(nodeName, command);
  }

  /**
   * 列出远程节点上的 Singularity 镜像
   */
  async listSingularityImages(nodeName: string, searchPath?: string): Promise<string[]> {
    const node = this.nodes.get(nodeName);
    if (!node || !node.singularity) {
      throw new Error(`节点不支持 Singularity`);
    }

    const path = searchPath || "/share/images";
    const result = await this.execute(nodeName, `find ${path} -name "*.sif" 2>/dev/null || echo ""`);
    
    return result.split("\n").filter(line => line.trim() !== "");
  }

  /**
   * 测试节点连接
   */
  async testConnection(nodeName: string): Promise<boolean> {
    try {
      const result = await this.execute(nodeName, "whoami", 5000);
      console.log(`[RemoteNode] 连接测试成功 ${nodeName}: ${result.trim()}`);
      return true;
    } catch (err: any) {
      console.error(`[RemoteNode] 连接测试失败 ${nodeName}:`, err.message);
      return false;
    }
  }

  /**
   * 关闭所有连接
   */
  disconnectAll(): void {
    for (const [name, conn] of this.connections) {
      try {
        conn.client.end();
        console.log(`[RemoteNode] 已断开连接: ${name}`);
      } catch (err) {
        // ignore
      }
    }
    this.connections.clear();
  }
}

// 导出单例
export const remoteNodeManager = new RemoteNodeManager();
