import { redis } from "../redis";
import { getConfigValue } from "alemonjs";
import fs from "fs";
import { uploadImageToR2, uploadMediaToR2 } from "../s3";
import { TTSClient } from "./tts";
import { ChatCompletionTool } from "openai/resources";
import OpenAi, { toFile } from "openai";
import { loadSkillDetail } from "./loadSkill";
import help from "@src/data/help.json";
import redisClient from "../config";
import { isNonVisionModel } from "../response/zreply/getChatConfig";
import { isPrivateIP, validateURL } from "./security";
import { spawn } from "child_process";
import * as dns from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMessageTimeString } from "./format";
import { runLocalBrowser } from "./localBrowser";
import { runOpencode } from "./opencode";

const value = getConfigValue().aiChat || {};

const getPrompt = async (text: string): Promise<string> => {
  // 检查中文
  const hasChinese = /[\u4e00-\u9fa5]/g.test(text);
  const fanyiApi = "https://api.52vmy.cn/api/query/fanyi/youdao?msg=";
  if (hasChinese) {
    try {
      // 调用后端的 send_get_request 函数
      const responseText = await fetch(
        fanyiApi + encodeURIComponent(text),
      ).then((res) => res.text());
      // 将返回的 JSON 字符串解析为对象
      const data = JSON.parse(responseText);
      console.log("提示词翻译:", data.data.target);
      return data.data.target;
    } catch (error) {
      console.error("Error fetching translation:", error);
      return text; // 如果翻译失败，返回原始文本
    }
  } else {
    return text;
  }
};

export const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "StableDiffusionGenerateImage",
      description: "使用 Stable Diffusion 模型生成图像",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "正向提示词（prompt），越详细越好。建议包含：主体、动作、服装、场景、风格、光线、画质修饰词。\n推荐全英文且使用标签描述,当遇到动漫人物时,使用ta的英文名可以自动触发lora,不用额外lora标签\n括号的使用:[增强效果],(弱化效果), 示例：'[artist:ciloranko],artist:kazutake_hazano,[artist:kedama milk]，smile, short_hair, open_mouth, bangs, multiple_girls, skirt, black_hair, hair_ornament, red_eyes, long_sleeves, 2girls, sitting, school_uniform, :d, grey_hair, multicolored_hair, pleated_skirt, shoes, serafuku, choker, socks, sailor_collar, neckerchief, orange_eyes, petals, siblings, black_choker, brown_footwear, blue sky， pointing, loafers, red_neckerchief, bench, falling_petals'",
          },
          bad_prompt: {
            type: "string",
            description:
              "反向提示词（negative prompt），用于排除不想要的元素。\n示例：'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, deformed'",
            default:
              "(easynegative:1.1), (verybadimagenegative_v1.3:1), (low quality:1.2), (worst quality:1.2)",
          },
          direction: {
            type: "string",
            description:
              "图片方向, 横向: landscape, 纵向: portrait, 方形: square",
            enum: ["landscape", "portrait", "square"],
            default: "portrait",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "StableDiffusionImageToPrompt",
      description:
        "使用 Stable Diffusion 将图片转换为提示词, 它只对动漫图片有效, 只能用来提取动漫图片的提示词",
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "图片的URL地址，必须是你所收到的图片地址",
          },
        },
        required: ["image_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "DescribeImage",
      description: `用配置的识图 AI 描述图片内容（支持 OCR / 通用看图）。

【何时必须调用】
- 当前主模型是无法直接看图的纯文本模型时（如 deepseek、gpt-3.5、qwen-plus、moonshot、glm-4 文本版等）

【使用要求】
- image_url 必须使用消息里给出的完整图片 URL
- guid 必须传系统提示词中的「当前群号(reviewGuid)」
- 先调用本工具拿到描述，再基于描述回答用户，不要假装自己已经看到图片
- 若工具返回未配置识图 AI，提示用户使用 /设置识图ai <AI列表名称> 配置一个支持多模态的 AI`,
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "图片 URL，必须是你在消息中收到的图片地址",
          },
          guid: {
            type: "string",
            description:
              "当前群号(reviewGuid)。必填，用于读取该群配置的识图 AI，不是 public/{guid} 工作目录",
          },
          question: {
            type: "string",
            description:
              "可选。想重点了解图片的什么，例如「读出图中文字」「描述人物穿着」；不传则做通用详细描述",
          },
        },
        required: ["image_url", "guid"],
      },
    },
  },
  // {
  //   type: "function",
  //   function: {
  //     name: "SearchScbbsPost",
  //     description:
  //       "搜索《survivalcraft》(译名《生存战争》,也简称sc)论坛的帖子, 搜索时请尽量提供精确的关键词, 关键词最好只有一个. 在这里可以搜索到sc这个游戏相关的各种模组等资源或教程帖子和更新公告等内容, 但请注意不要搜索与游戏无关的内容, 否则可能会得到不相关的结果，若是搜索不到请减少关键词的数量或更换关键词",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         keyword: {
  //           type: "string",
  //           description: "搜索关键词",
  //         },
  //       },
  //       required: ["keyword"],
  //     },
  //   },
  // },

  {
    type: "function",
    function: {
      name: "Photoshop",
      description:
        "AI图片工具。不传 image_url 时按 instruction 直接生成图片；传入 image_url 时按 instruction 编辑图片。",
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description:
              "可选。需要编辑的图片URL地址，必须是你所收到的图片地址；不传时进入文生图模式。",
          },
          instruction: {
            type: "string",
            description:
              "图片需求描述，尽量详细和具体。不传 image_url 时描述要生成什么图；传入 image_url 时描述要怎么修改图片。例如：'生成一只在月球上奔跑的柯基，电影感光影' 或 '请将图片中的人物换成一个穿着宇航服的宇航员，背景改成月球表面，保持其他元素不变'",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "GPTGenerateImage",
      description:
        "使用 GPT 图像模型生成或编辑图片，适合各种风格的图像需求。支持中文提示词；传入 image_url 时会基于该图片进行编辑。",
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description:
              "可选。需要编辑的图片 URL，必须使用消息中给出的完整图片地址；不传时按 prompt 直接生成图片。",
          },
          prompt: {
            type: "string",
            description:
              "图片需求描述，支持中英文。不传 image_url 时描述要生成什么图；传入 image_url 时描述要如何修改图片。",
          },
          size: {
            type: "string",
            description:
              "图片尺寸，可选值：'1024x1024'（方形）、'1536x1024'（横向）、'1024x1536'（纵向）、'auto'（自动选择）",
            enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
            default: "1024x1024",
          },
          quality: {
            type: "string",
            description:
              "图片质量，可选值：'auto'（自动）、'high'（高质量）、'medium'（中等质量）、'low'（低质量）",
            enum: ["auto", "high", "medium", "low"],
            default: "auto",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "GetTTSModels",
      description:
        "获取可用的TTS模型列表, 可以用来选择不同的音色进行语音合成. 模型会不定期更新, 你可以定期调用这个工具来获取最新的模型列表. 当你想要使用TTS功能时, 可以先调用这个工具来获取可用的模型列表, 然后选择一个你喜欢的模型来进行语音合成. 例如, 你可以选择一个叫做'派蒙-默认'的模型来模仿派蒙的声音进行语音合成",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSKILLDetail",
      description: "获取技能详情",
      parameters: {
        type: "object",
        properties: {
          skillName: {
            type: "string",
            description: "要获取详情的技能名称",
          },
        },
        required: ["skillName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentListWorkspaces",
      description:
        "列出当前会话 guid 对应的 AI agent 工作目录。agent 权限需先由主人使用 #开启agent 开启。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "当前会话 guid，由系统自动注入",
          },
          includeKnowledge: {
            type: "boolean",
            description:
              "是否附带当前工作目录下 knowledge/ 的一级仓库目录名摘要",
            default: true,
          },
          maxResults: {
            type: "number",
            description: "最多返回多少个工作目录，默认 50，最大 200",
            default: 50,
          },
        },
        required: ["guid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentCreateWorkspace",
      description:
        "在当前会话 guid 对应的 public/ 下创建 AI agent 工作目录。agent 权限需先由主人使用 #开启agent 开启。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "当前会话 guid，由系统自动注入",
          },
        },
        required: ["guid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentCloneRepository",
      description:
        "克隆一个公开 http/https Git 仓库到 public/{guid}/ 内作为 AI 知识库。只能执行受限的 git clone，不能执行其他 git、终端、Docker 或容器操作。默认克隆到 knowledge/{仓库名}。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          repoUrl: {
            type: "string",
            description:
              "要克隆的公开 Git 仓库 URL，只允许 http/https，不允许 SSH、本地路径或带账号密码的 URL",
          },
          targetPath: {
            type: "string",
            description:
              "可选。克隆目标目录，必须是 public/{guid}/ 下的相对路径。默认 knowledge/{仓库名}",
          },
          branch: {
            type: "string",
            description: "可选。要克隆的分支或 tag 名称",
          },
          depth: {
            type: "number",
            description: "可选。浅克隆深度，默认 1，最大 50",
            default: 1,
          },
        },
        required: ["guid", "repoUrl"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentReviewProjectCommand",
      description:
        "审核将在 public/{guid}/ 工作目录中执行的项目命令是否安全。会先做本地规则审查，并在可用时使用当前 AI 配置做二次审查。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          command: {
            type: "string",
            description:
              "要审查的项目命令，例如 npm.cmd run build 或 npx.cmd create-vite@latest app",
          },
          workingDirectory: {
            type: "string",
            description:
              "可选。命令执行目录，必须是 public/{guid}/ 下的相对路径，默认为 .",
            default: ".",
          },
          reviewGuid: {
            type: "string",
            description:
              "可选。当前聊天或当前 AI 配置对应的 guid；不传时会尝试使用全局 AI 配置做二次审查",
          },
        },
        required: ["guid", "command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "RunServerCommand",
      description:
        "直接在服务器上执行运维指令，可用于查看状态、管理服务、Docker、PM2、日志和部署流程。执行前必须通过本地基础拦截和 AI 自动审核；审核不可用或未通过时不会执行。命令和输出中的公网 IP、密码、令牌、密钥等敏感信息会被自动隐藏，禁止尝试绕过脱敏或把这些信息写入网页、项目文件和公开内容。不要用它操作 public/{guid} 项目文件，AI agent 项目文件操作仍使用 Agent* 工具。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "要执行的服务器指令，例如 systemctl status nginx、docker ps、pm2 list、tail -n 100 app.log",
          },
          workingDirectory: {
            type: "string",
            description:
              "可选。服务器上的执行目录，可以是绝对路径或相对当前进程目录，默认为服务进程当前目录",
          },
          reviewGuid: {
            type: "string",
            description:
              "必填。传入当前群号，也就是系统提示词里的“当前群号(reviewGuid)”；私聊时也传当前会话的群号/guid。用于读取当前群 AI 配置并执行 AI 自动审核，不是 public/{guid} 项目工作目录ID。",
          },
          timeoutSeconds: {
            type: "number",
            description: "可选。命令超时时间，默认 120 秒，最大 600 秒",
            default: 120,
          },
        },
        required: ["command", "reviewGuid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentGitOperation",
      description:
        "在 public/{guid}/ 内的 Git 仓库执行受限 Git 操作：查看当前分支、获取分支列表、查看远端列表、切换到已有分支。禁止 commit、push、pull、merge、rebase、reset、tag、stash 等会改动历史或同步远端的操作。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          workingDirectory: {
            type: "string",
            description:
              "可选。Git 仓库所在目录，必须是 public/{guid}/ 下的相对路径，默认为 .",
            default: ".",
          },
          action: {
            type: "string",
            description:
              "Git 操作类型：currentBranch 当前分支；listBranches 分支列表；listRemotes 远端列表；switchBranch 切换到已有分支",
            enum: [
              "currentBranch",
              "listBranches",
              "listRemotes",
              "switchBranch",
            ],
          },
          branch: {
            type: "string",
            description:
              "action=switchBranch 时必填，要切换到的分支名。只允许已有本地分支，或已有的 origin/<branch> 远端分支。",
          },
          includeRemote: {
            type: "boolean",
            description:
              "action=listBranches 时可选，是否同时包含远端分支，默认 true",
            default: true,
          },
        },
        required: ["guid", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentProjectCommand",
      description:
        "在 public/{guid}/ 工作目录内执行受限的项目操作：环境检测、受限命令执行、解压缩、重命名和创建目录。run 动作会自动审查命令安全后再执行。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          action: {
            type: "string",
            description:
              "操作类型：inspect 环境检测；run 运行受限项目命令；extract 解压缩；rename 重命名；mkdir 创建目录",
            enum: ["inspect", "run", "extract", "rename", "mkdir"],
          },
          workingDirectory: {
            type: "string",
            description:
              "可选。操作目录，必须是 public/{guid}/ 下的相对路径，默认为 .",
            default: ".",
          },
          command: {
            type: "string",
            description: "action=run 时必填，要执行的受限项目命令",
          },
          reviewGuid: {
            type: "string",
            description:
              "可选。当前聊天或当前 AI 配置对应的 guid；用于自动审查 run 命令",
          },
          archivePath: {
            type: "string",
            description:
              "action=extract 时必填，要解压的压缩包路径，必须是 public/{guid}/ 下的相对路径",
          },
          destinationPath: {
            type: "string",
            description:
              "action=extract 时可选，解压目标目录，必须是 public/{guid}/ 下的相对路径，默认解压到当前目录",
          },
          sourcePath: {
            type: "string",
            description:
              "action=rename 时必填，源文件或目录路径，必须是 public/{guid}/ 下的相对路径",
          },
          targetPath: {
            type: "string",
            description:
              "action=rename 时必填，目标文件或目录路径，必须是 public/{guid}/ 下的相对路径",
          },
          directoryPath: {
            type: "string",
            description:
              "action=mkdir 时必填，要创建的目录路径，必须是 public/{guid}/ 下的相对路径",
          },
        },
        required: ["guid", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentReadFileLines",
      description:
        "读取项目 public/{guid}/ 目录内指定文本文件的指定行范围。适合写代码前查看文件片段。路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description:
              "要读取的文本文件路径，必须是 public/{guid}/ 下的相对路径",
          },
          startLine: {
            type: "number",
            description: "起始行号，从 1 开始",
            default: 1,
          },
          endLine: {
            type: "number",
            description: "结束行号，从 1 开始。单次最多返回 500 行",
          },
        },
        required: ["guid", "filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentWriteFile",
      description:
        "写入项目 public/{guid}/ 目录内指定文件。默认覆盖整个文件，也可追加到文件末尾。路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description: "要写入的文件路径，必须是 public/{guid}/ 下的相对路径",
          },
          content: {
            type: "string",
            description: "要写入的完整文本内容",
          },
          mode: {
            type: "string",
            description: "写入模式：overwrite 覆盖文件，append 追加到末尾",
            enum: ["overwrite", "append"],
            default: "overwrite",
          },
        },
        required: ["guid", "filePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentInsertFile",
      description:
        "向项目 public/{guid}/ 目录内指定文本文件的指定行之前插入内容。这个工具只负责插入，不会替换原有行；路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description:
              "要插入内容的文本文件路径，必须是 public/{guid}/ 下的相对路径",
          },
          lineNumber: {
            type: "number",
            description:
              "插入位置行号，从 1 开始。内容会插入到该行之前；传入总行数+1 表示追加到文件末尾",
          },
          content: {
            type: "string",
            description: "要插入的文本内容",
          },
        },
        required: ["guid", "filePath", "lineNumber", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentReplaceFileRange",
      description:
        "替换项目 public/{guid}/ 目录内指定文本文件的一段连续行内容。适合修改已有代码、配置或文案，而不是覆盖整个文件。路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description:
              "要替换内容的文本文件路径，必须是 public/{guid}/ 下的相对路径",
          },
          startLine: {
            type: "number",
            description: "起始行号，从 1 开始，且为包含关系",
          },
          endLine: {
            type: "number",
            description: "结束行号，从 1 开始，且为包含关系",
          },
          content: {
            type: "string",
            description: "替换后的文本内容。传空字符串表示删除该行范围",
          },
        },
        required: ["guid", "filePath", "startLine", "endLine", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentCreateFile",
      description:
        "在项目 public/{guid}/ 目录内创建新文件。默认不覆盖已有文件。路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description: "要创建的文件路径，必须是 public/{guid}/ 下的相对路径",
          },
          content: {
            type: "string",
            description: "新文件内容",
            default: "",
          },
          overwrite: {
            type: "boolean",
            description: "是否允许覆盖已存在文件",
            default: false,
          },
        },
        required: ["guid", "filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentDeleteFile",
      description:
        "删除项目 public/{guid}/ 目录内指定文件。只能删除文件，不能删除文件夹。路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description: "要删除的文件路径，必须是 public/{guid}/ 下的相对路径",
          },
        },
        required: ["guid", "filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentListFiles",
      description:
        "获取项目 public/{guid}/ 目录内指定文件夹的文件列表。路径必须是相对 public/{guid}/ 的相对路径。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          folderPath: {
            type: "string",
            description:
              "要列出的文件夹路径，必须是 public/{guid}/ 下的相对路径。默认为当前工作目录根部",
            default: ".",
          },
          recursive: {
            type: "boolean",
            description: "是否递归列出子目录",
            default: false,
          },
          maxDepth: {
            type: "number",
            description: "递归时的最大深度，默认 3",
            default: 3,
          },
        },
        required: ["guid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentSearchFiles",
      description:
        "在项目 public/{guid}/ 目录内按文件名和文件内容搜索，适合在已克隆的知识库或当前项目中查找 README、类名、函数名、配置项或关键字。不要在说“本地没有”之前跳过这个工具。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          query: {
            type: "string",
            description: "要搜索的关键词或文本片段",
          },
          folderPath: {
            type: "string",
            description:
              "可选。搜索起始目录，必须是 public/{guid}/ 下的相对路径，默认 .",
            default: ".",
          },
          mode: {
            type: "string",
            description:
              "搜索模式：filename 只搜文件名，content 只搜文件内容，both 两者都搜",
            enum: ["filename", "content", "both"],
            default: "both",
          },
          maxResults: {
            type: "number",
            description: "最多返回多少条结果，默认 20，最大 100",
            default: 20,
          },
        },
        required: ["guid", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentUploadFileToR2",
      description:
        "将项目 public/{guid}/ 目录内的构建产物或媒体文件上传到 R2，返回可公开访问的链接。路径必须是相对 public/{guid}/ 的相对路径；拿到链接后可直接发给用户，图片可用 <img=链接> 发送。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "项目工作目录ID，对应 public/{guid}/",
          },
          filePath: {
            type: "string",
            description: "要上传的文件路径，必须是 public/{guid}/ 下的相对路径",
          },
          fileName: {
            type: "string",
            description:
              "可选。上传后希望使用的文件名，例如 report.zip 或 preview.png。会自动清理非法字符；图片最终扩展名会跟随转换结果。",
          },
          uploadType: {
            type: "string",
            description:
              "上传类型。file 用于普通构建产物/压缩包/音视频等；image 会走图片压缩和格式转换流程",
            enum: ["file", "image"],
            default: "file",
          },
        },
        required: ["guid", "filePath"],
      },
    },
  },
  // {
  //   type: "function",
  //   function: {
  //     name: "EvalCode",
  //     description: "执行JavaScript代码",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         code: {
  //           type: "string",
  //           description: "要执行的JavaScript代码",
  //         },
  //       },
  //       required: ["code"],
  //     },
  //   },
  // },
  {
    type: "function",
    function: {
      name: "GetCommand",
      description:
        "获取当前框架可用的指令, 查看当前框架每个命令的使用方法和说明. 当用户需要获取指令列表时, 可以调用这个工具来获取当前框架可用的指令列表. 例如, 当用户输入'帮助'或'指令列表'等类似的关键词时, 你可以调用这个工具来获取指令列表并回复给用户. 指令列表会包含每个指令的文本和说明, 例如: [{ command: '帮助', description: '获取帮助信息' }, { command: '看看配置', description: '查看当前AI配置' }]",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "LocalBrowser",
      description:
        "调用运行 AlemonJS 的本机 Chrome/Edge 浏览器搜索网页或访问网页。需要获取最新信息、读取依赖 JavaScript 渲染的页面、或 SearchWeb 不可用时使用。只用于读取公网 HTTP/HTTPS 页面，不支持本机、局域网、文件地址、登录、点击、提交表单或下载。action=search 时传 query；action=visit 时传 url。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型：search 搜索网页；visit 访问并读取网页",
            enum: ["search", "visit"],
          },
          query: {
            type: "string",
            description: "action=search 时必填，搜索关键词",
          },
          url: {
            type: "string",
            description: "action=visit 时必填，要访问的公网 HTTP/HTTPS 地址",
          },
          engine: {
            type: "string",
            description: "搜索引擎，默认 bing",
            enum: ["bing", "google", "baidu"],
            default: "bing",
          },
          maxResults: {
            type: "number",
            description: "搜索结果数量，默认 5，最大 10",
            default: 5,
          },
          maxChars: {
            type: "number",
            description:
              "访问网页时返回的正文最大字符数，默认 12000，最大 30000",
            default: 12000,
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ExecuteAlemonCommand",
      description:
        "执行一条 AlemonJS 框架指令。用户要求查看配置、切换 AI/模型、开关功能、管理提示词或执行 GetCommand 返回的任意框架指令时，应直接调用本工具，不要在回复中输出 <command=...> 标签。指令会沿用当前消息的真实用户、会话和权限，由框架原有路由执行；本工具不会绕过主人或管理员权限检查。每次调用只执行一条完整指令。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "要执行的完整框架指令，必须以 / 或 # 开头，例如 /ai配置、#切换模型 gpt-5。参数应直接包含在这条字符串中。",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SubscribeNextUserMessage",
      description:
        "【高优先级群聊衔接工具】订阅当前用户的下一条发言。用户表示准备在下一条或稍后发送内容时必须调用，例如“给你看个东西”“你看看这个”“我发给你”“等下发图/文件”“下一条发”“我分几条说”；不要只回复“发吧/发来看看”却不调用工具。以上只是必须调用的典型场景，不是调用限制：除此之外，只要你想获取该用户的下一条发言，也可以直接调用，不需要满足任何前置条件。调用后，该用户接下来的一条非命令群消息即使没有艾特机器人，也会触发 AI 回复；订阅触发一次后自动失效，10 分钟内没有新消息也会过期。订阅对象、群聊和平台由框架根据当前消息注入，不要向用户索要参数。若还想获取后续下一条发言，可再次调用。",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ScheduleAITask",
      description:
        "设置、查看或取消当前会话的定时 AI 任务。创建任务后，到点会由 AI 主动向当前用户或群聊发消息。时间必须使用带时区的 ISO 8601 格式，例如 2026-08-12T08:00:00+08:00；repeat= daily 表示每天同一时间触发，once 表示只触发一次。任务只允许作用于当前会话，用户ID、平台和群号由系统自动记录，不要伪造。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型：create 创建；list 查看；cancel 取消",
            enum: ["create", "list", "cancel"],
          },
          runAt: {
            type: "string",
            description:
              "action=create 时必填，带时区的 ISO 8601 时间，例如 2026-08-12T08:00:00+08:00",
          },
          prompt: {
            type: "string",
            description:
              "action=create 时必填，到点触发 AI 时使用的事件和消息目标，例如“提醒用户起床，并用轻松的语气问候”",
          },
          repeat: {
            type: "string",
            description: "重复方式，默认 once",
            enum: ["once", "daily"],
            default: "once",
          },
          taskID: {
            type: "string",
            description: "action=cancel 时必填，要取消的任务ID",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "MemoryOperation",
      description:
        "用于主动读写用户的长期记忆，以及检索历史聊天归档。聊天中只要用户透露了以后可能有用的信息，就应当主动记录，不必等用户说“记住”。日常记录统一使用 operation=append、dataType=user；服务端会自动附加精确到分钟的记录时间并追加到旧记忆，不会覆盖旧内容。记录必须保留人物昵称或ID、谁说了什么、涉及对象、原话中的关键细节和必要上下文，能够保留原话时不要压缩成几个标签。例如用户小明(10001)说“张三昨天帮我修好了电脑，我觉得他很可靠”，应记录“小明(10001)说过：张三昨天帮他修好了电脑；小明因此认为张三很可靠”，不能只写“张三可靠”。第三方评价要保持为说话者的主观看法，不能写成客观事实。set 仅用于确实需要整体替换用户记忆的特殊情况。不要记录密码、令牌等秘密，也不要记录纯粹的一次性指令或未经用户表达的推测。需要延续旧话题时，可获取或搜索 chatHistory。",
      parameters: {
        type: "object",
        properties: {
          userID: {
            type: "string",
            description: "要获取或修改的用户数据的用户ID",
          },
          operation: {
            type: "string",
            description:
              "操作类型：append 追加一条带服务端时间的用户记忆，是日常记录的默认操作；get 获取数据；set 整体替换数据，仅用于确实需要完整重写的特殊情况",
            enum: ["get", "append", "set"],
          },
          dataType: {
            type: "string",
            description:
              "要获取或修改的数据类型，例如'user'表示用户相关,获取或修改用户数据，'chatHistory'表示历史对话与历史归档,历史对话只能获取不能修改",
            enum: ["user", "chatHistory"],
          },
          data: {
            type: "string",
            description:
              "记忆内容。append user 时只传本轮新增的详细记录，必须写清说话者昵称或ID、说过的内容、涉及对象和必要上下文，尽量保留原话信息，不要自行添加时间，时间由服务端附加。set user 时传完整替换内容。get user 时可留空；get chatHistory 时，留空返回摘要列表，传入 guid:id 获取归档详情，传入 search:关键词 搜索相关历史归档。",
          },
        },
        required: ["userID", "operation", "dataType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ping",
      description: `
检测目标主机是否可达。

【限制】
- 仅允许公网域名
- 禁止 IP 地址（防止内网扫描）
- 自动限制次数（例如 3 次）

`,
      parameters: {
        type: "object",
        properties: {
          host: { type: "string" },
        },
        required: ["host"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description: `
发送 HTTP 请求以获取网页或 API 数据。

【能力范围】
- 支持 GET / POST 请求
- 返回文本或 JSON 内容
- 自动处理常见编码

【限制】
- 禁止访问云元数据地址（如 169.254.169.254）
- 请求超时限制为 5 秒
- 响应大小限制（例如 1MB）

【使用建议】
- 优先使用此工具获取网页内容，而不是使用 shell
- 适合抓取网页、调用 API、获取数据
`,
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST"] },
          body: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAlemonjsConfig",
      description: `获取框架配置,详情请参考use-alemon技能说明`,
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "配置项的键,可用值请参考use-alemon技能说明",
          },
          value: {
            type: "string",
            description: "查找时传入值,可用值请参考use-alemon技能说明",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "RunOpencode",
      description: `启动本地 opencode(会通过 opencode serve 拉起一个带 Web 界面的服务), 并把提示词交给 opencode 去真实地读写代码、运行命令完成任务, 最后把 opencode 的输出结果返回给你。

【何时使用】
- 用户要求实现、修改、重构、调试某个本地项目, 或要求执行会改变项目代码的复杂编程任务时
- 需要 opencode 在指定项目目录里自主规划、写代码、运行命令并给出结论时
- 用户明确提到使用 opencode 时

【使用要求】
- projectPath 必须是本机上已存在的项目目录的绝对路径, 必须是 opencode 能直接访问的真实目录
- 第一次执行时不要传 sessionId, opencode 会新建会话; 后续需要延续同一任务上下文时, 把上次返回的 sessionId 传回来即可
- prompt 要写清楚任务目标和期望的产出; 复杂任务建议拆成多个步骤分次调用, 每次带着上次的 sessionId
- 默认 autoApprove=true, 允许 opencode 自动执行命令和修改文件; 若只想让 opencode 分析而不改动, 传 autoApprove=false
- 默认模型使用 opencode 配置的模型; 如需指定, 用 provider/model 格式, 例如 anthropic/claude-sonnet-4-5
- 执行完成后可打开返回的 serverUrl 在浏览器查看 opencode Web 界面和完整过程`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "操作类型：run 运行任务(默认)；listSessions 列出该项目已有的会话；serverInfo 只确保启动 opencode 服务并返回地址",
            enum: ["run", "listSessions", "serverInfo"],
            default: "run",
          },
          prompt: {
            type: "string",
            description:
              "action=run 时必填。要交给 opencode 执行的任务描述/提示词，例如「实现一个计算器页面并跑通测试」",
          },
          sessionId: {
            type: "string",
            description:
              "可选。opencode 会话 ID，传入则在该会话基础上继续(保留上下文)，不传则新建会话",
          },
          projectPath: {
            type: "string",
            description:
              "必填。项目目录的绝对路径，opencode 将在此目录中真实地工作",
          },
          model: {
            type: "string",
            description:
              "可选。指定模型，格式 provider/model，如 anthropic/claude-sonnet-4-5；不传使用 opencode 默认模型",
          },
          agent: {
            type: "string",
            description: "可选。指定 agent，默认 build",
          },
          autoApprove: {
            type: "boolean",
            description:
              "可选，默认 true。是否自动允许 opencode 执行命令/修改文件等操作；关闭后遇到需授权的操作会自动拒绝(适合只读分析)",
            default: true,
          },
          timeoutSeconds: {
            type: "number",
            description: "可选。单次运行超时时间(秒)，默认 600，最大 1800",
            default: 600,
          },
        },
        required: ["projectPath"],
      },
    },
  },
];

const AGENT_FILE_MAX_READ_LINES = 500;
const AGENT_FILE_MAX_LIST_ENTRIES = 500;
const AGENT_FILE_MAX_SEARCH_RESULTS = 100;
const PROJECT_COMMAND_MAX_OUTPUT = 24000;
const PROJECT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_PROJECT_COMMAND_BASES = new Set([
  "dotnet",
  "dotnet.exe",
  "npm",
  "npm.cmd",
  "npx",
  "npx.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "yarn.cmd",
  "bun",
  "bunx",
  "node",
  "node.exe",
  "git",
  "where",
  "where.exe",
]);
const ALLOWED_GIT_PROJECT_SUBCOMMANDS = new Set([
  "init",
  "status",
  "branch",
  "rev-parse",
  "log",
  "describe",
  "remote",
]);
const ALLOWED_DOTNET_PROJECT_SUBCOMMANDS = new Set([
  "--version",
  "--info",
  "--list-sdks",
  "--list-runtimes",
  "new",
  "restore",
  "build",
  "run",
  "test",
  "publish",
  "clean",
  "add",
  "remove",
  "list",
  "sln",
]);
const BLOCKED_PROJECT_COMMAND_PATTERNS = [
  {
    pattern: /&&|\|\||[;|<>`]|[$][(]/,
    reason: "不允许使用 shell 控制符、重定向、命令替换或反引号",
  },
  {
    pattern: /(^|[\s])(rm|del|erase|rmdir|rd)([\s]|$)/i,
    reason: "不允许使用删除命令",
  },
  {
    pattern:
      /(^|[\s])(powershell|pwsh|cmd|bash|sh|docker|ssh|scp|sftp|curl|wget)([\s]|$)/i,
    reason: "不允许执行受限外部命令",
  },
  { pattern: /\.\.[\\/]/, reason: "不允许通过 .. 离开 public 工作目录" },
];
const SERVER_COMMAND_DEFAULT_TIMEOUT_SECONDS = 120;
const SERVER_COMMAND_MAX_TIMEOUT_SECONDS = 600;
const BLOCKED_SERVER_COMMAND_PATTERNS = [
  {
    pattern: /\0/,
    reason: "命令包含非法空字符",
  },
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    reason: "不允许执行 fork bomb",
  },
  {
    pattern:
      /(^|[\s;&|])rm\s+(-[^\s]*r[^\s]*f|-f[^\s]*r|-[^\s]*rf[^\s]*)\s+(\/|\/\*|~|~\/|\$HOME)(\s|$)/i,
    reason: "不允许递归强制删除系统根目录或用户主目录",
  },
  {
    pattern: /(^|[\s;&|])(mkfs|mkswap|fdisk|parted|wipefs)([\s]|$)/i,
    reason: "不允许执行磁盘格式化或分区破坏类命令",
  },
  {
    pattern: /(^|[\s;&|])dd\s+[\s\S]*\bof=\/dev\//i,
    reason: "不允许使用 dd 写入块设备",
  },
  {
    pattern:
      /(^|[\s;&|])(env|printenv)([\s;&|]|$)|\/(?:proc|sys)\/[^\s;&|]*environ\b|\b(?:Get-ChildItem|Get-Item|gci|gi|dir)\s+env:/i,
    reason: "不允许读取完整环境变量，避免泄露密钥和服务器信息",
  },
  {
    pattern: /(?:169\.254\.169\.254|metadata\.google\.internal)/i,
    reason: "不允许访问云主机元数据服务",
  },
];

const SERVER_OUTPUT_REDACTED_VALUE = "[敏感信息已隐藏]";
const SERVER_PUBLIC_IP_REDACTED_VALUE = "[公网IP已隐藏]";

const isPublicIPv4Address = (value: string) => {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first, second, third] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return false;
  }
  return true;
};

const imageUrlToFile = async (imageUrl: string) => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`读取待编辑图片失败: HTTP ${response.status}`);
  }

  const contentType =
    response.headers.get("content-type")?.split(";")[0] || "image/png";
  if (!contentType.startsWith("image/")) {
    throw new Error(`待编辑链接不是图片: ${contentType}`);
  }

  const extension =
    contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1] || "png";
  return toFile(await response.arrayBuffer(), `input.${extension}`, {
    type: contentType,
  });
};

const redactPublicIpAddresses = (value: string, replacement: string) => {
  let redacted = false;
  let text = value.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (address) => {
    if (!isPublicIPv4Address(address)) return address;
    redacted = true;
    return replacement;
  });
  text = text.replace(/[0-9a-f:]*:[0-9a-f:]+/gi, (address) => {
    if (isIP(address) !== 6) return address;
    const normalized = address.toLowerCase();
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("2001:db8:")
    ) {
      return address;
    }
    redacted = true;
    return replacement;
  });
  return { text, redacted };
};

export const removePublicIpFromOutput = (value: string, isMaster?: boolean) => {
  if (isMaster === true || !value) return value;
  return redactPublicIpAddresses(value, "").text;
};

const PUBLIC_CONTENT_TOOL_FIELDS: Record<string, string[]> = {
  AgentWriteFile: ["content"],
  AgentInsertFile: ["content"],
  AgentReplaceFileRange: ["content"],
  AgentCreateFile: ["content"],
  RunServerCommand: ["command"],
};

export const removePublicIpFromToolArguments = (
  functionName: string,
  args: unknown,
  isMaster?: boolean,
) => {
  if (
    isMaster === true ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    return args;
  }
  const fields = PUBLIC_CONTENT_TOOL_FIELDS[functionName] || [];
  const target = args as Record<string, unknown>;
  for (const field of fields) {
    if (typeof target[field] === "string") {
      target[field] = removePublicIpFromOutput(target[field], false);
    }
  }
  return target;
};

const AGENT_TOOL_NAMES = new Set([
  "AgentListWorkspaces",
  "AgentCreateWorkspace",
  "AgentCloneRepository",
  "AgentReviewProjectCommand",
  "RunServerCommand",
  "AgentGitOperation",
  "AgentProjectCommand",
  "AgentReadFileLines",
  "AgentWriteFile",
  "AgentInsertFile",
  "AgentReplaceFileRange",
  "AgentCreateFile",
  "AgentDeleteFile",
  "AgentListFiles",
  "AgentSearchFiles",
  "AgentUploadFileToR2",
]);

export const isAgentTool = (functionName: string) =>
  AGENT_TOOL_NAMES.has(functionName);

export const assertAgentEnabled = async (guid?: string) => {
  if (!guid?.trim() || (await redisClient.getAgentSwitch(guid)) !== "1") {
    throw new Error("agent 功能默认关闭，请先使用 #开启agent");
  }
};

const redactServerToolText = (value: string) => {
  let redacted = false;
  const mark = (replacement: string) => {
    redacted = true;
    return replacement;
  };

  let text = value.replace(
    /-----BEGIN [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)[^-\r\n]*-----[\s\S]*?-----END [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)[^-\r\n]*-----/gi,
    () => mark(SERVER_OUTPUT_REDACTED_VALUE),
  );
  text = text.replace(
    /\b(?:https?|wss?|ftp):\/\/[^\s/@:]+:[^\s/@]+@/gi,
    (match) =>
      mark(match.replace(/\/\/[^@]+@/, `//${SERVER_OUTPUT_REDACTED_VALUE}@`)),
  );
  text = text.replace(
    /(^|[\s,{[])(["']?(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|private[_-]?key|authorization|cookie)["']?\s*[:=]\s*)([^\s,}\]\r\n]+)/gim,
    (_match, prefix: string, key: string) =>
      `${prefix}${key}${mark(SERVER_OUTPUT_REDACTED_VALUE)}`,
  );
  const ipResult = redactPublicIpAddresses(
    text,
    SERVER_PUBLIC_IP_REDACTED_VALUE,
  );
  text = ipResult.text;
  redacted ||= ipResult.redacted;

  return { text, redacted };
};

const toToolError = (error: unknown) => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

const assertPathInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error("路径超出 public/{guid}/ 工作目录");
  }
};

const getExistingAncestor = (target: string) => {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("无法解析目标路径");
    }
    current = parent;
  }
  return current;
};

const assertRealPathInside = (root: string, target: string) => {
  const realRoot = fs.realpathSync.native(root);
  const existing = getExistingAncestor(target);
  const realExisting = fs.realpathSync.native(existing);
  assertPathInside(realRoot, realExisting);

  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync.native(target);
    assertPathInside(realRoot, realTarget);
  }
};

const resolveAgentRoot = (guid: string) => {
  if (!guid || typeof guid !== "string") {
    throw new Error("guid 不能为空");
  }
  const safeGuid = guid.trim();
  if (!safeGuid || safeGuid === "." || safeGuid === "..") {
    throw new Error("guid 必须是 public 下的有效目录名");
  }
  if (
    path.isAbsolute(safeGuid) ||
    safeGuid.includes("/") ||
    safeGuid.includes("\\") ||
    safeGuid.includes("\0")
  ) {
    throw new Error("guid 只能作为 public 下的单级目录名");
  }

  const publicRoot = path.resolve(process.cwd(), "public");
  const root = path.resolve(publicRoot, safeGuid);
  assertPathInside(publicRoot, root);
  fs.mkdirSync(root, { recursive: true });
  assertRealPathInside(publicRoot, root);
  return root;
};

const createAgentGuid = (guid?: string) => {
  if (guid && guid.trim()) {
    resolveAgentRoot(guid);
    return guid.trim();
  }

  const guidValue = randomUUID();
  resolveAgentRoot(guidValue);
  return guidValue;
};

const listAgentWorkspaces = (includeKnowledge = true, maxResults = 50) => {
  const publicRoot = path.resolve(process.cwd(), "public");
  if (!fs.existsSync(publicRoot)) {
    return [];
  }

  const limit = Math.max(
    1,
    Math.min(normalizePositiveInteger(maxResults, 50, "maxResults"), 200),
  );
  const ignoredNames = new Set(["sandbox", "image_out"]);

  return fs
    .readdirSync(publicRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
    .map((entry) => {
      const root = path.join(publicRoot, entry.name);
      const knowledgeRoot = path.join(root, "knowledge");
      const knowledgeProjects =
        includeKnowledge && fs.existsSync(knowledgeRoot)
          ? fs
              .readdirSync(knowledgeRoot, { withFileTypes: true })
              .filter((item) => item.isDirectory())
              .map((item) => item.name)
              .slice(0, 20)
          : [];

      return {
        guid: entry.name,
        path: `public/${entry.name}`,
        hasKnowledge: knowledgeProjects.length > 0,
        knowledgeProjects,
      };
    })
    .sort((a, b) => a.guid.localeCompare(b.guid))
    .slice(0, limit);
};

const sanitizeRepositoryName = (repoUrl: string) => {
  const url = new URL(repoUrl);
  const lastSegment = url.pathname.split("/").filter(Boolean).pop() || "repo";
  const withoutGit = lastSegment.replace(/\.git$/i, "");
  const safeName = withoutGit.replace(/[^a-zA-Z0-9._-]/g, "-");
  return safeName || "repo";
};

const validateRepositoryUrl = async (repoUrl: string) => {
  const url = new URL(repoUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("仓库地址只允许 http/https");
  }
  if (url.username || url.password) {
    throw new Error("仓库地址不能包含账号密码或 token");
  }
  await validateURL(repoUrl);
};

const validateGitRef = (ref: string) => {
  if (!/^[a-zA-Z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error("branch 只能包含字母、数字、点、下划线、短横线和斜杠");
  }
};

const normalizeCloneDepth = (depth: unknown) => {
  const safeDepth = normalizePositiveInteger(depth, 1, "depth");
  return Math.min(safeDepth, 50);
};

const resolveCloneTargetPath = (repoUrl: string, targetPath?: string) => {
  const safeTargetPath = targetPath?.trim();
  if (safeTargetPath) {
    if (safeTargetPath === "." || safeTargetPath === "/") {
      throw new Error("targetPath 不能是工作目录根部");
    }
    return safeTargetPath;
  }
  return `knowledge/${sanitizeRepositoryName(repoUrl)}`;
};

const resolveAgentPath = (guid: string, inputPath = ".") => {
  if (path.isAbsolute(inputPath) || inputPath.includes("\0")) {
    throw new Error("只能使用相对 public/{guid}/ 的路径");
  }

  const root = resolveAgentRoot(guid);
  const target = path.resolve(root, inputPath || ".");
  assertPathInside(root, target);
  assertRealPathInside(root, target);

  return {
    root,
    target,
    relativePath: path.relative(root, target).replace(/\\/g, "/") || ".",
  };
};

const ensureParentDirectory = (target: string) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
};

const ensureGitRepository = async (cwd: string) => {
  const result = await runSpawnCommand({
    file: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd,
  });

  if (result.exitCode !== 0 || result.output.trim().toLowerCase() !== "true") {
    throw new Error("目标目录不是 Git 仓库");
  }
};

const getGitCurrentBranch = async (cwd: string) => {
  const result = await runSpawnCommand({
    file: "git",
    args: ["branch", "--show-current"],
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || "获取当前分支失败");
  }
  return result.output.trim();
};

const listGitBranches = async (cwd: string, includeRemote: boolean) => {
  const args = ["branch", "--list"];
  if (includeRemote) {
    args.push("--all");
  }

  const result = await runSpawnCommand({
    file: "git",
    args,
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || "获取分支列表失败");
  }

  return result.output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .map((line) => {
      const current = line.startsWith("*");
      const name = line.replace(/^\*\s*/, "").trim();
      if (!name || name === "HEAD detached at") {
        return null;
      }
      return {
        name,
        current,
        remote: name.startsWith("remotes/"),
      };
    })
    .filter(
      (item): item is { name: string; current: boolean; remote: boolean } =>
        !!item,
    );
};

const listGitRemotes = async (cwd: string) => {
  const result = await runSpawnCommand({
    file: "git",
    args: ["remote", "-v"],
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || "获取远端列表失败");
  }

  const remotes = new Map<
    string,
    { name: string; fetch?: string; push?: string }
  >();
  for (const line of result.output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, type] = match;
    const current = remotes.get(name) || { name };
    if (type === "fetch") current.fetch = url;
    if (type === "push") current.push = url;
    remotes.set(name, current);
  }

  return [...remotes.values()];
};

const switchGitBranch = async (cwd: string, branch: string) => {
  validateGitRef(branch);

  const localBranches = await listGitBranches(cwd, false);
  const localExists = localBranches.some((item) => item.name === branch);

  if (localExists) {
    const result = await runSpawnCommand({
      file: "git",
      args: ["switch", branch],
      cwd,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.output.trim() || "切换本地分支失败");
    }
    return {
      branch,
      source: "local" as const,
      output: result.output,
    };
  }

  const remoteBranches = await listGitBranches(cwd, true);
  const remoteName = `remotes/origin/${branch}`;
  const remoteExists = remoteBranches.some((item) => item.name === remoteName);
  if (!remoteExists) {
    throw new Error("目标分支不存在，本地和 origin 远端都未找到该分支");
  }

  const result = await runSpawnCommand({
    file: "git",
    args: ["switch", "--track", `origin/${branch}`],
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || "切换远端跟踪分支失败");
  }
  return {
    branch,
    source: "origin" as const,
    output: result.output,
  };
};

const readStructuredTextFile = (target: string) => {
  const raw = fs.readFileSync(target, "utf-8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = raw.endsWith("\r\n") || raw.endsWith("\n");
  const withoutTrailingNewline = hasTrailingNewline
    ? raw.replace(/(?:\r\n|\n)$/, "")
    : raw;

  return {
    raw,
    lines: withoutTrailingNewline.length
      ? withoutTrailingNewline.split(/\r?\n/)
      : [],
    eol,
    hasTrailingNewline,
  };
};

const readTextLines = (target: string) => readStructuredTextFile(target).lines;

const writeStructuredTextFile = ({
  target,
  lines,
  eol,
  hasTrailingNewline,
}: {
  target: string;
  lines: string[];
  eol: "\n" | "\r\n";
  hasTrailingNewline: boolean;
}) => {
  let nextContent = lines.join(eol);
  if (hasTrailingNewline && lines.length > 0) {
    nextContent += eol;
  }
  fs.writeFileSync(target, nextContent, "utf-8");
};

const isLikelyTextFile = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return true;
  const binaryExtensions = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".7z",
    ".rar",
    ".pdf",
    ".mp3",
    ".wav",
    ".ogg",
    ".mp4",
    ".avi",
    ".mov",
    ".exe",
    ".dll",
    ".so",
    ".bin",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
  ]);
  return !binaryExtensions.has(ext);
};

const normalizePositiveInteger = (
  value: unknown,
  fallback: number,
  fieldName: string,
) => {
  const numeric = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${fieldName} 必须是大于等于 1 的整数`);
  }
  return numeric;
};

const getAgentFileList = (
  root: string,
  folder: string,
  depth: number,
  maxDepth: number,
  entries: Array<{
    path: string;
    type: "file" | "directory";
    size: number;
    modifiedAt: string;
  }>,
) => {
  if (entries.length >= AGENT_FILE_MAX_LIST_ENTRIES) return;

  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entries.length >= AGENT_FILE_MAX_LIST_ENTRIES) return;

    const fullPath = path.join(folder, item.name);
    assertPathInside(root, fullPath);
    const stat = fs.statSync(fullPath);
    const type = item.isDirectory() ? "directory" : "file";

    entries.push({
      path: path.relative(root, fullPath).replace(/\\/g, "/"),
      type,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });

    if (item.isDirectory() && depth < maxDepth) {
      getAgentFileList(root, fullPath, depth + 1, maxDepth, entries);
    }
  }
};

const searchFilesWithinWorkspace = ({
  root,
  folder,
  query,
  mode,
  maxResults,
}: {
  root: string;
  folder: string;
  query: string;
  mode: "filename" | "content" | "both";
  maxResults: number;
}) => {
  const results: Array<{
    path: string;
    type: "filename" | "content";
    lineNumber?: number;
    preview: string;
  }> = [];
  const lowerQuery = query.toLowerCase();

  const walk = (currentFolder: string) => {
    if (results.length >= maxResults) return;

    for (const item of fs.readdirSync(currentFolder, { withFileTypes: true })) {
      if (results.length >= maxResults) return;

      const fullPath = path.join(currentFolder, item.name);
      assertPathInside(root, fullPath);

      if (item.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!item.isFile()) {
        continue;
      }

      const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
      if (mode !== "content" && item.name.toLowerCase().includes(lowerQuery)) {
        results.push({
          path: relativePath,
          type: "filename",
          preview: item.name,
        });
        if (results.length >= maxResults) return;
      }

      if (mode === "filename" || !isLikelyTextFile(fullPath)) {
        continue;
      }

      try {
        const lines = readTextLines(fullPath);
        for (let index = 0; index < lines.length; index += 1) {
          if (results.length >= maxResults) return;
          const line = lines[index];
          if (line.toLowerCase().includes(lowerQuery)) {
            results.push({
              path: relativePath,
              type: "content",
              lineNumber: index + 1,
              preview: line.trim().slice(0, 240),
            });
          }
        }
      } catch {
        continue;
      }
    }
  };

  walk(folder);
  return results;
};

const runGitClone = ({
  repoUrl,
  target,
  branch,
  depth,
}: {
  repoUrl: string;
  target: string;
  branch?: string;
  depth: number;
}) => {
  return new Promise<string>((resolve, reject) => {
    const args = ["clone", "--depth", String(depth)];
    if (branch) {
      args.push("--branch", branch);
    }
    args.push("--", repoUrl, target);

    const child = spawn("git", args, {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let output = "";
    const appendOutput = (data: Buffer) => {
      output += data.toString();
      if (output.length > 12000) {
        output = output.slice(-12000);
      }
    };

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("git clone 超时"));
    }, 120000);

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "未找到 git 命令，无法克隆仓库"
            : `git clone 启动失败: ${error.message}`,
        ),
      );
    });
    child.on("close", (code: number) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(output.trim());
        return;
      }
      reject(
        new Error(
          `git clone 失败，退出码 ${code}${output ? `\n${output}` : ""}`,
        ),
      );
    });
  });
};

const tokenizeCommand = (command: string) => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      if (quote === char) {
        quote = null;
      } else {
        quote = char;
      }
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("命令引号未闭合");
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const trimProjectCommandOutput = (output: string) =>
  output.length > PROJECT_COMMAND_MAX_OUTPUT
    ? `${output.slice(0, PROJECT_COMMAND_MAX_OUTPUT)}\n[output truncated]`
    : output;

const isUnsafePathToken = (token: string) => {
  if (!token) return false;
  if (token.includes("\0")) return true;
  if (token === ".." || token.startsWith("../") || token.startsWith("..\\")) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(token)) {
    return true;
  }
  return false;
};

const buildProjectCommandReview = (command: string) => {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["命令不能为空"],
      baseCommand: "",
      tokens: [] as string[],
    };
  }

  for (const item of BLOCKED_PROJECT_COMMAND_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      return {
        allowed: false,
        risk: "blocked" as const,
        reasons: [item.reason],
        baseCommand: "",
        tokens: [] as string[],
      };
    }
  }

  let tokens: string[];
  try {
    tokens = tokenizeCommand(trimmed);
  } catch (error) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: [error instanceof Error ? error.message : String(error)],
      baseCommand: "",
      tokens: [] as string[],
    };
  }

  if (!tokens.length) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["命令不能为空"],
      baseCommand: "",
      tokens,
    };
  }

  if (tokens.some(isUnsafePathToken)) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["命令参数中包含试图离开 public 工作目录的路径"],
      baseCommand: "",
      tokens,
    };
  }

  const baseCommand = tokens[0].toLowerCase();
  if (!ALLOWED_PROJECT_COMMAND_BASES.has(baseCommand)) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["仅允许受限的项目命令，当前基础命令不在允许列表中"],
      baseCommand,
      tokens,
    };
  }

  const reasons: string[] = [];
  let risk: "low" | "medium" | "high" | "blocked" = "low";

  if (["node", "node.exe"].includes(baseCommand)) {
    if (!["-v", "--version"].includes(tokens[1] || "")) {
      return {
        allowed: false,
        risk: "blocked" as const,
        reasons: ["node 仅允许用于版本检测"],
        baseCommand,
        tokens,
      };
    }
    reasons.push("版本检测命令");
    return {
      allowed: true,
      risk,
      reasons,
      baseCommand,
      tokens,
    };
  }

  if (["dotnet", "dotnet.exe"].includes(baseCommand)) {
    const subcommand = (tokens[1] || "").toLowerCase();
    if (!ALLOWED_DOTNET_PROJECT_SUBCOMMANDS.has(subcommand)) {
      return {
        allowed: false,
        risk: "blocked" as const,
        reasons: ["dotnet 仅允许受限的项目和环境检测子命令"],
        baseCommand,
        tokens,
      };
    }
    risk = [
      "new",
      "restore",
      "build",
      "run",
      "test",
      "publish",
      "clean",
    ].includes(subcommand)
      ? "medium"
      : "low";
    reasons.push(
      risk === "medium"
        ? ".NET 项目命令会创建、还原或编译工作目录内的项目"
        : ".NET 环境检测或受限项目查询命令",
    );
    return {
      allowed: true,
      risk,
      reasons,
      baseCommand,
      tokens,
    };
  }

  if (["where", "where.exe"].includes(baseCommand)) {
    reasons.push("环境探测命令");
    return {
      allowed: true,
      risk,
      reasons,
      baseCommand,
      tokens,
    };
  }

  if (baseCommand === "git") {
    const subcommand = (tokens[1] || "").toLowerCase();
    if (!ALLOWED_GIT_PROJECT_SUBCOMMANDS.has(subcommand)) {
      return {
        allowed: false,
        risk: "blocked" as const,
        reasons: ["git 仅允许受限的只读/初始化子命令"],
        baseCommand,
        tokens,
      };
    }
    risk = subcommand === "init" ? "medium" : "low";
    reasons.push(
      subcommand === "init" ? "git init 会创建仓库元数据" : "受限 git 查询命令",
    );
    return {
      allowed: true,
      risk,
      reasons,
      baseCommand,
      tokens,
    };
  }

  if (tokens.includes("-g") || tokens.includes("--global")) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["不允许全局安装或修改全局环境"],
      baseCommand,
      tokens,
    };
  }

  if (tokens.some((token) => /^https?:\/\//i.test(token))) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["项目命令中不允许直接传入外部 URL"],
      baseCommand,
      tokens,
    };
  }

  const subcommand = (tokens[1] || "").toLowerCase();
  const blockedPackageManagerSubcommands = new Set([
    "publish",
    "login",
    "logout",
    "config",
    "cache",
    "owner",
    "team",
  ]);
  if (blockedPackageManagerSubcommands.has(subcommand)) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["不允许执行账号、发布或全局配置相关命令"],
      baseCommand,
      tokens,
    };
  }

  if (
    ["create", "init", "dlx", "exec"].includes(subcommand) ||
    ["npx", "npx.cmd", "bunx"].includes(baseCommand)
  ) {
    risk = "medium";
    reasons.push("脚手架或外部执行命令会下载并运行第三方包");
  } else if (["install", "i", "add", "ci"].includes(subcommand)) {
    risk = "medium";
    reasons.push("依赖安装命令会写入项目依赖和锁文件");
  } else if (
    ["run", "test", "build"].includes(subcommand) ||
    subcommand === ""
  ) {
    risk = "low";
    reasons.push("项目内脚本或常规包管理命令");
  } else {
    risk = "medium";
    reasons.push("已通过基础命令检查，但属于较少见的包管理子命令");
  }

  return {
    allowed: true,
    risk,
    reasons,
    baseCommand,
    tokens,
  };
};

const buildServerCommandLocalReview = (command: string) => {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["命令不能为空"],
    };
  }

  if (
    /(?:^|[\s"'=])(?:[a-zA-Z]:[\\/]|\\\\|\/(?:[^/]|$)|~[\\/]|\.\.(?:[\\/]|$))/i.test(
      trimmed,
    ) ||
    /(^|[\s;&|])(cd|pushd|popd|set-location|sl)([\s]|$)/i.test(trimmed)
  ) {
    return {
      allowed: false,
      risk: "blocked" as const,
      reasons: ["服务器指令不得访问或切换到项目目录以外的路径"],
    };
  }

  for (const item of BLOCKED_SERVER_COMMAND_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      return {
        allowed: false,
        risk: "blocked" as const,
        reasons: [item.reason],
      };
    }
  }

  const highRiskPatterns = [
    /(^|[\s;&|])(sudo|su)([\s]|$)/i,
    /(^|[\s;&|])(systemctl|service|supervisorctl|pm2)([\s]|$)/i,
    /(^|[\s;&|])(docker|docker-compose|kubectl)([\s]|$)/i,
    /(^|[\s;&|])(apt|apt-get|yum|dnf|pacman|apk)([\s]|$)/i,
    /(^|[\s;&|])(iptables|ufw|firewall-cmd)([\s]|$)/i,
    /(^|[\s;&|])(rm|mv|cp|chmod|chown|kill|pkill)([\s]|$)/i,
  ];
  const mediumRiskPatterns = [
    /(^|[\s;&|])(curl|wget|git|tar|unzip|npm|pnpm|yarn|node)([\s]|$)/i,
    /[;&|<>`]|[$][(]/,
  ];

  if (highRiskPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      allowed: true,
      risk: "high" as const,
      reasons: ["服务器管理或文件/进程/网络配置相关命令，必须经过 AI 审核"],
    };
  }

  if (mediumRiskPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      allowed: true,
      risk: "medium" as const,
      reasons: [
        "可能修改服务状态、下载内容或使用 shell 控制符，必须经过 AI 审核",
      ],
    };
  }

  return {
    allowed: true,
    risk: "low" as const,
    reasons: ["常规服务器查询或低风险命令，仍需 AI 审核确认"],
  };
};

const getReviewAIConfig = async (reviewGuid?: string) => {
  const guid = reviewGuid?.trim();
  const config = await redisClient.getAIConfig(guid || undefined);
  const currentAI = guid ? await redisClient.getCurrentAI(guid) : "";
  if (!config.host.trim() || !config.key.trim() || !config.model.trim()) {
    return null;
  }
  return {
    guid: guid || "global",
    currentAI,
    config,
  };
};

const reviewProjectCommandWithAI = async ({
  command,
  localReview,
  reviewGuid,
}: {
  command: string;
  localReview: ReturnType<typeof buildProjectCommandReview>;
  reviewGuid?: string;
}) => {
  const aiConfig = await getReviewAIConfig(reviewGuid);
  if (!aiConfig) {
    return {
      status: "skipped" as const,
      reason: "未找到可用的当前 AI 配置，已仅使用本地规则审查",
    };
  }

  try {
    const openai = new OpenAi({
      baseURL: aiConfig.config.host,
      apiKey: aiConfig.config.key,
      timeout: 30000,
    });
    const response = await openai.chat.completions.create({
      model: aiConfig.config.model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            '你是一个命令安全审查器。请只输出 JSON，格式为 {"allowed":boolean,"risk":"low|medium|high|blocked","reason":"简短中文原因"}。审核标准：命令必须只适用于 public 工作目录内的安全项目操作，不得包含权限提升、删除系统文件、远程控制、数据外传、全局环境修改或危险 shell 行为。' +
            `\n性格约束:${aiConfig.config.systemPrompt || ""}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            command,
            localReview: {
              allowed: localReview.allowed,
              risk: localReview.risk,
              reasons: localReview.reasons,
            },
          }),
        },
      ],
    });

    const text = response.choices[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        status: "failed" as const,
        reason: "AI 审查未返回可解析的 JSON",
        raw: text,
      };
    }
    const parsed = JSON.parse(match[0]);

    return {
      status: "completed" as const,
      currentAI: aiConfig.currentAI || null,
      model: aiConfig.config.model,
      guid: aiConfig.guid,
      allowed: Boolean(parsed.allowed),
      risk:
        parsed.risk === "low" ||
        parsed.risk === "medium" ||
        parsed.risk === "high" ||
        parsed.risk === "blocked"
          ? parsed.risk
          : "medium",
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "AI 未提供明确原因",
    };
  } catch (error) {
    return {
      status: "failed" as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const reviewServerCommandWithAI = async ({
  command,
  localReview,
  reviewGuid,
  workingDirectory,
}: {
  command: string;
  localReview: ReturnType<typeof buildServerCommandLocalReview>;
  reviewGuid?: string;
  workingDirectory: string;
}) => {
  const aiConfig = await getReviewAIConfig(reviewGuid);
  if (!aiConfig) {
    return {
      status: "skipped" as const,
      reason: "未找到可用的当前 AI 配置，服务器指令必须完成 AI 审核后才能执行",
    };
  }

  try {
    const openai = new OpenAi({
      baseURL: aiConfig.config.host,
      apiKey: aiConfig.config.key,
      timeout: 30000,
    });
    const response = await openai.chat.completions.create({
      model: aiConfig.config.model,
      temperature: 0,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            '你是服务器运维指令安全审核器。请只输出 JSON，格式为 {"allowed":boolean,"risk":"low|medium|high|blocked","reason":"简短中文原因"}。可以允许合理的服务器管理、状态查看、日志查看、服务重启、Docker/PM2/systemctl 操作、部署和包管理命令；必须阻止清空数据、破坏系统、植入后门、泄露密钥、反弹 shell、未知脚本下载后直接执行、越权访问或明显不可恢复的危险操作。' +
            `\n性格约束:${aiConfig.config.systemPrompt || ""}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            command,
            workingDirectory,
            localReview: {
              allowed: localReview.allowed,
              risk: localReview.risk,
              reasons: localReview.reasons,
            },
          }),
        },
      ],
    });

    const text = response.choices[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        status: "failed" as const,
        reason: "AI 审核未返回可解析的 JSON",
        raw: text,
      };
    }
    const parsed = JSON.parse(match[0]);

    return {
      status: "completed" as const,
      currentAI: aiConfig.currentAI || null,
      model: aiConfig.config.model,
      guid: aiConfig.guid,
      allowed: Boolean(parsed.allowed),
      risk:
        parsed.risk === "low" ||
        parsed.risk === "medium" ||
        parsed.risk === "high" ||
        parsed.risk === "blocked"
          ? parsed.risk
          : "high",
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "AI 未提供明确原因",
    };
  } catch (error) {
    return {
      status: "failed" as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const resolveServerWorkingDirectory = (workingDirectory?: string) => {
  if (workingDirectory?.includes("\0")) {
    throw new Error("workingDirectory 包含非法空字符");
  }
  const cwd = path.resolve(workingDirectory?.trim() || process.cwd());
  if (!fs.existsSync(cwd)) {
    throw new Error("workingDirectory 不存在");
  }
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error("workingDirectory 不是目录");
  }
  assertRealPathInside(path.resolve(process.cwd()), cwd);
  return cwd;
};

const assertServerCommandPathsInsideProject = (command: string) => {
  let tokens: string[];
  try {
    tokens = tokenizeCommand(command);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const projectRoot = path.resolve(process.cwd());
  for (const token of tokens) {
    if (!token || token === "-") continue;
    if (token.includes("\0")) throw new Error("命令路径包含非法空字符");
    const segments = token.split(/[\\/]/);
    if (
      segments.includes("..") ||
      /[a-zA-Z]:[\\/]/.test(token) ||
      /(?:^|=|:)\/(?:[^/]|$)/.test(token) ||
      /(?:^|=|:)~[\\/]/.test(token)
    ) {
      throw new Error("服务器指令不得访问项目目录以外的路径");
    }
    if (token.includes("/") || token.includes("\\")) {
      const target = path.resolve(projectRoot, token);
      assertRealPathInside(projectRoot, target);
    }
  }
};

const normalizeServerCommandTimeoutMs = (timeoutSeconds?: number) => {
  const safeSeconds = Math.min(
    normalizePositiveInteger(
      timeoutSeconds,
      SERVER_COMMAND_DEFAULT_TIMEOUT_SECONDS,
      "timeoutSeconds",
    ),
    SERVER_COMMAND_MAX_TIMEOUT_SECONDS,
  );
  return safeSeconds * 1000;
};

const runServerShellCommand = ({
  command,
  cwd,
  timeoutMs,
}: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => {
  return new Promise<{ output: string; exitCode: number }>(
    (resolve, reject) => {
      const powershellCommand = [
        "chcp 65001 | Out-Null",
        "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
        "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
        command,
      ].join("; ");
      const shell =
        process.platform === "win32"
          ? {
              file: "powershell.exe",
              args: [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                powershellCommand,
              ],
            }
          : { file: "sh", args: ["-lc", command] };
      const child = spawn(shell.file, shell.args, { cwd });
      let output = "";
      const appendOutput = (data: Buffer) => {
        output += data.toString();
        if (output.length > PROJECT_COMMAND_MAX_OUTPUT) {
          output = output.slice(-PROJECT_COMMAND_MAX_OUTPUT);
        }
      };
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("服务器指令执行超时"));
      }, timeoutMs);

      child.stdout.on("data", appendOutput);
      child.stderr.on("data", appendOutput);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        reject(new Error(`服务器指令启动失败: ${error.message}`));
      });
      child.on("close", (exitCode: number | null) => {
        clearTimeout(timeout);
        resolve({
          output: trimProjectCommandOutput(output.trim()),
          exitCode: exitCode ?? -1,
        });
      });
    },
  );
};

const runSpawnCommand = ({
  file,
  args,
  cwd,
}: {
  file: string;
  args: string[];
  cwd: string;
}) => {
  return new Promise<{ output: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(file, args, { cwd });
      let output = "";
      const appendOutput = (data: Buffer) => {
        output += data.toString();
        if (output.length > PROJECT_COMMAND_MAX_OUTPUT) {
          output = output.slice(-PROJECT_COMMAND_MAX_OUTPUT);
        }
      };
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("命令执行超时"));
      }, PROJECT_COMMAND_TIMEOUT_MS);

      child.stdout.on("data", appendOutput);
      child.stderr.on("data", appendOutput);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        reject(new Error(`命令启动失败: ${error.message}`));
      });
      child.on("close", (exitCode: number | null) => {
        clearTimeout(timeout);
        resolve({
          output: trimProjectCommandOutput(output.trim()),
          exitCode: exitCode ?? -1,
        });
      });
    },
  );
};

const findExecutablePaths = async (name: string, cwd: string) => {
  try {
    if (process.platform === "win32") {
      const result = await runSpawnCommand({
        file: "where.exe",
        args: [name],
        cwd,
      });
      if (result.exitCode !== 0 || !result.output) {
        return [];
      }
      return result.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    const result = await runSpawnCommand({
      file: "which",
      args: [name],
      cwd,
    });
    if (result.exitCode !== 0 || !result.output) {
      return [];
    }
    return result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const inspectProjectEnvironment = async (cwd: string) => {
  const versionCommands = [
    {
      name: "dotnet",
      file: process.platform === "win32" ? "dotnet.exe" : "dotnet",
      args: ["--version"],
    },
    process.platform === "win32"
      ? { name: "npm", file: "npm.cmd", args: ["-v"] }
      : { name: "npm", file: "npm", args: ["-v"] },
    process.platform === "win32"
      ? { name: "npx", file: "npx.cmd", args: ["-v"] }
      : { name: "npx", file: "npx", args: ["-v"] },
    {
      name: "node",
      file: process.platform === "win32" ? "node.exe" : "node",
      args: ["-v"],
    },
    { name: "git", file: "git", args: ["--version"] },
  ];

  const versions: Record<string, string> = {};
  const paths: Record<string, string[]> = {};
  for (const command of versionCommands) {
    try {
      const result = await runSpawnCommand({
        file: command.file,
        args: command.args,
        cwd,
      });
      versions[command.name] =
        result.exitCode === 0
          ? result.output || "ok"
          : `exit ${result.exitCode}`;
    } catch (error) {
      versions[command.name] =
        error instanceof Error
          ? `unavailable: ${error.message}`
          : String(error);
    }
    paths[command.name] = await findExecutablePaths(command.name, cwd);
  }

  return {
    cwd,
    versions,
    paths,
    entries: fs
      .readdirSync(cwd, { withFileTypes: true })
      .slice(0, 50)
      .map((item) => ({
        name: item.name,
        type: item.isDirectory() ? "directory" : "file",
      })),
  };
};

const extractArchiveWithinWorkspace = async ({
  archive,
  destination,
}: {
  archive: string;
  destination: string;
}) => {
  ensureParentDirectory(destination);
  fs.mkdirSync(destination, { recursive: true });

  const lower = archive.toLowerCase();
  if (lower.endsWith(".zip")) {
    if (process.platform === "win32") {
      return runSpawnCommand({
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
        ],
        cwd: destination,
      });
    }
    return runSpawnCommand({
      file: "unzip",
      args: ["-o", archive, "-d", destination],
      cwd: destination,
    });
  }

  if (
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz")
  ) {
    return runSpawnCommand({
      file: "tar",
      args: ["-xf", archive, "-C", destination],
      cwd: destination,
    });
  }

  throw new Error("仅支持 zip、tar、tar.gz、tgz 压缩包");
};

const performProjectCommandReview = async ({
  command,
  reviewGuid,
  isMaster,
}: {
  command: string;
  reviewGuid?: string;
  isMaster?: boolean;
}) => {
  const localReview = buildProjectCommandReview(command);
  if (!localReview.allowed) {
    return {
      allowed: false,
      risk: localReview.risk,
      localReview,
      aiReview: {
        status: "skipped" as const,
        reason: "本地基础拦截未通过，主人权限也不能绕过",
      },
    };
  }

  // 主人权限仅跳过 AI 审核，不能绕过本地硬拦截。
  if (isMaster === true) {
    return {
      allowed: true,
      risk: localReview.risk,
      localReview,
      aiReview: {
        status: "skipped" as const,
        reason: "主人权限，仅跳过 AI 审核",
      },
    };
  }

  const aiReview = await reviewProjectCommandWithAI({
    command,
    localReview,
    reviewGuid,
  });

  const allowed =
    localReview.allowed &&
    (aiReview.status !== "completed" || aiReview.allowed === true);
  const risk =
    aiReview.status === "completed" && aiReview.risk
      ? aiReview.risk
      : localReview.risk;

  return {
    allowed,
    risk,
    localReview,
    aiReview,
  };
};

const performServerCommandReview = async ({
  command,
  reviewGuid,
  workingDirectory,
  isMaster,
}: {
  command: string;
  reviewGuid?: string;
  workingDirectory: string;
  isMaster?: boolean;
}) => {
  const localReview = buildServerCommandLocalReview(command);
  if (!localReview.allowed) {
    return {
      allowed: false,
      risk: localReview.risk,
      localReview,
      aiReview: {
        status: "skipped" as const,
        reason: "本地基础拦截未通过，主人权限也不能绕过",
      },
    };
  }

  // 主人权限仅跳过 AI 审核，不能绕过本地硬拦截。
  if (isMaster === true) {
    return {
      allowed: true,
      risk: localReview.risk,
      localReview,
      aiReview: {
        status: "skipped" as const,
        reason: "主人权限，仅跳过 AI 审核",
      },
    };
  }

  const aiReview = await reviewServerCommandWithAI({
    command,
    localReview,
    reviewGuid,
    workingDirectory,
  });
  const allowed = aiReview.status === "completed" && aiReview.allowed === true;
  const risk =
    aiReview.status === "completed" && aiReview.risk
      ? aiReview.risk
      : localReview.risk;

  return {
    allowed,
    risk,
    localReview,
    aiReview,
  };
};

export const availableTools = {
  getAlemonjsConfig: async ({ key, value }) => {
    if (key == "ailist") {
      // 获取当前配置
      return await redisClient.getAIList();
    }
  },

  SubscribeNextUserMessage: async ({
    guid,
    userID,
    platform,
    isGroup,
  }: {
    guid: string;
    userID: string;
    platform?: string;
    isGroup: boolean;
  }) => {
    if (!isGroup) {
      return {
        success: false,
        error: "该工具仅用于群聊，私聊消息不需要订阅。",
      };
    }
    if (!guid || !userID) {
      return {
        success: false,
        error: "缺少当前群聊或用户信息，无法订阅下一条消息。",
      };
    }
    await redisClient.subscribeNextUserMessage(guid, userID, platform);
    return {
      success: true,
      message: "已订阅当前用户的下一条群消息，触发一次后自动失效。",
    };
  },

  ScheduleAITask: async ({
    action,
    runAt,
    prompt,
    repeat = "once",
    taskID,
    guid,
    userID,
    platform,
    spaceId,
    isPrivate,
  }: {
    action: "create" | "list" | "cancel";
    runAt?: string;
    prompt?: string;
    repeat?: "once" | "daily";
    taskID?: string;
    guid: string;
    userID: string;
    platform: string;
    spaceId?: string;
    isPrivate: boolean;
  }) => {
    if (!guid || !userID || !platform) {
      return {
        success: false,
        error: "缺少当前用户ID或平台信息，无法创建主动消息任务",
      };
    }

    if (action === "list") {
      return {
        success: true,
        tasks: await redisClient.getScheduledAITasks(guid),
      };
    }

    if (action === "cancel") {
      if (!taskID) {
        return { success: false, error: "取消任务时必须提供 taskID" };
      }
      const deleted = await redisClient.deleteScheduledAITask(guid, taskID);
      return {
        success: deleted,
        taskID,
        message: deleted ? "定时任务已取消" : "未找到当前会话中的定时任务",
      };
    }

    if (!runAt || !prompt?.trim()) {
      return { success: false, error: "创建任务时必须提供 runAt 和 prompt" };
    }
    const runAtTimestamp = Date.parse(runAt);
    if (!Number.isFinite(runAtTimestamp) || runAtTimestamp <= Date.now()) {
      return { success: false, error: "runAt 必须是未来的有效 ISO 8601 时间" };
    }
    if (repeat !== "once" && repeat !== "daily") {
      return { success: false, error: "repeat 只能是 once 或 daily" };
    }
    if (!isPrivate && !spaceId) {
      return { success: false, error: "群聊定时任务缺少 SpaceId，无法主动发送" };
    }

    const task = await redisClient.createScheduledAITask({
      guid,
      userID,
      platform,
      spaceId: spaceId || "",
      isPrivate,
      prompt: prompt.trim(),
      runAt: runAtTimestamp,
      repeat,
    });
    return {
      success: true,
      task,
      message: `定时任务已创建，将在 ${new Date(runAtTimestamp).toLocaleString("zh-CN")} 触发`,
    };
  },

  MemoryOperation: async ({ userID, operation, dataType, data }) => {
    if (operation === "append") {
      if (dataType !== "user") {
        return "只有用户长期记忆支持追加写入";
      }
      const memory = String(data || "").trim();
      if (!memory) {
        return { success: false, error: "追加的记忆内容不能为空" };
      }
      const recordedAt = getMessageTimeString();
      await redisClient.appendUserData(userID, `[${recordedAt}] ${memory}`);
      return { success: true, recordedAt };
    }
    if (operation === "set") {
      if (dataType === "user") {
        // 存储用户数据到redis, key为user:${userID}:data, value为data
        await redisClient.setUserData(userID, data);
        return { success: true };
      }
      if (dataType === "chatHistory") {
        return "历史对话数据只能获取不能修改";
      }
    }
    if (operation === "get") {
      if (dataType === "user") {
        // 从redis获取用户数据, key为user:${userID}:data
        const userData = await redisClient.getUserData(userID);
        return { success: true, data: userData };
      }
      if (dataType === "chatHistory") {
        if (!data) {
          const summaryList = await redisClient.getSummaryList();
          return { success: true, data: summaryList };
        }

        if (data.startsWith("search:")) {
          const query = data.slice("search:".length).trim();
          const records = await redisClient.searchArchivedChatRecords(query, {
            limit: 10,
          });
          return { success: true, data: records };
        }

        const [guid, id] = data.split(":") || [];
        if (guid && id) {
          const record = await redisClient.getArchivedChatRecord(guid, id);
          if (record) {
            return { success: true, data: record };
          }
          const chatHistory = await redisClient.getSummaryDetail(guid, id);
          return { success: true, data: chatHistory };
        }

        return {
          success: false,
          error: "chatHistory 的 data 只能为空、guid:id 或 search:关键词",
        };
      }
    }
  },

  /**
   *  使用 Stable Diffusion 生成图片
   * @param {string} prompt - 正向提示词
   * @param {string} [bad_prompt] - 反向提示词
   * @param {string} [direction] - 方向: landscape, portrait, square
   * @param {boolean} [base64] - 是否返回base64格式的图片
   * @returns {Promise<{type: "image", url: string}[]>} 图片列表
   */
  StableDiffusionGenerateImage: async ({
    prompt,
    bad_prompt = "(easynegative:1.1), (verybadimagenegative_v1.3:1), (low quality:1.2), (worst quality:1.2)",
    direction = "portrait",
    base64 = false,
  }) => {
    const images: { type: "image"; url: string }[] = [];
    const sizeMap = {
      landscape: { width: 768, height: 512 },
      portrait: { width: 512, height: 768 },
      square: { width: 640, height: 640 },
    };
    const { width, height } = sizeMap[direction] || sizeMap["portrait"];
    // 检查是否有中文

    const body = {
      enable_hr: true,
      denoising_strength: 0.8,
      hr_scale: 2,
      hr_upscaler: "R-ESRGAN 4x+ Anime6B",
      hr_second_pass_steps: 10,
      prompt: await getPrompt(prompt),
      seed: -1,
      sampler_name: "DPM++ 2M",
      steps: 20,
      cfg_scale: 10,
      width: width,
      height: height,
      negative_prompt: bad_prompt,
    };

    try {
      const response = await fetch("http://datukuai.top:1450/ht2.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return images;
      }
      const data = await response.json();

      // 将图片保存到本地,然后返回本地路径
      const dir = "./public/image_out";
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const path = `${dir}/${Date.now()}.jpg`;
      const base64Data = data.images[0].replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(path, buffer);
      if (base64) {
        return data.images;
      }

      images.push({ type: "image", url: path });

      return images;
    } catch (error) {
      console.error("Error generating images:", error);
      return images;
    }
  },

  /** 使用 Stable Diffusion 将图片转换为提示词 */
  /**
   * 使用配置的识图 AI（支持 vision）描述图片
   * 配置指令：/设置识图ai <AI列表名称>
   */
  DescribeImage: async ({
    image_url,
    guid,
    question,
  }: {
    image_url: string;
    guid?: string;
    question?: string;
  }) => {
    const url = String(image_url || "").trim();
    if (!url) {
      return { ok: false, error: "image_url 不能为空" };
    }
    if (!/^https?:\/\//i.test(url) && !url.startsWith("data:image/")) {
      return {
        ok: false,
        error: "image_url 必须是 http(s) 图片链接或 data:image base64",
      };
    }

    const reviewGuid = String(guid || "").trim();
    const ocrConfig = reviewGuid
      ? await redisClient.getOCRAIConfig(reviewGuid)
      : null;

    if (!ocrConfig) {
      return {
        ok: false,
        error: reviewGuid
          ? `群 ${reviewGuid} 未配置识图 AI，或配置的 AI 不存在/不完整。请用户发送：/设置识图ai <AI列表名称>`
          : "缺少 guid（当前群号 reviewGuid），无法读取识图 AI 配置",
        hint: "/设置识图ai <名称>  |  /设置识图 查看  |  /设置识图 关闭",
      };
    }

    // 识图 AI 本身若在「无法看图」列表中，拒绝调用
    if (isNonVisionModel(ocrConfig.model)) {
      return {
        ok: false,
        error: `当前识图 AI「${ocrConfig.name}」模型为 ${ocrConfig.model}，不支持看图。请改用支持多模态的 AI（如 gpt-4o、qwen-vl、gemini 等）`,
      };
    }

    const ask =
      String(question || "").trim() ||
      "请详细描述这张图片的内容，包括主体、文字（如有 OCR）、场景、风格和关键细节。用中文回答。";

    try {
      const openai = new OpenAi({
        baseURL: ocrConfig.host,
        apiKey: ocrConfig.key,
        timeout: 120000,
      });

      const completion = await openai.chat.completions.create({
        model: ocrConfig.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url },
              },
              {
                type: "text",
                text: ask,
              },
            ],
          },
        ],
      });

      const description =
        completion.choices?.[0]?.message?.content?.trim() || "";

      if (!description) {
        return {
          ok: false,
          error: "识图 AI 未返回描述内容",
          ocrAI: ocrConfig.name,
          model: ocrConfig.model,
        };
      }

      return {
        ok: true,
        description,
        ocrAI: ocrConfig.name,
        model: ocrConfig.model,
      };
    } catch (error: any) {
      console.error("[DescribeImage] failed", error);
      return {
        ok: false,
        error: error?.message || String(error) || "识图调用失败",
        ocrAI: ocrConfig.name,
        model: ocrConfig.model,
      };
    }
  },

  StableDiffusionImageToPrompt: async ({ image_url }) => {
    // 先查看redis中是否有这张图的缓存
    const cacheKey = `image:caption:${image_url}`;
    const cachedCaption = await redis.get(cacheKey);
    let imgBase64 = "";
    if (cachedCaption) {
      // 如果有, 它是本地路径, 获取base64
      const data = fs.readFileSync(cachedCaption, { encoding: "base64" });
      imgBase64 = data;
    } else {
      // 如果没有, 下载图片并转换为base64
      const response = await fetch(image_url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      imgBase64 = buffer.toString("base64");
    }
    const api = "http://datukuai.top:1450//ckmf.php";
    const body = {
      fn_index: 280,
      data: [
        "data:image/png;base64," + imgBase64,
        "",
        false,
        "",
        "[name].[output_extension]",
        "ignore",
        false,
        "wd14-vit",
        0.35,
        "",
        "",
        false,
        false,
        true,
        "0_0, (o)_(o), +_+, +_-, ._., <o>_<o>, <|>_<|>, =_=, >_<, 3_3, 6_9, >_o, @_@, ^_^, o_o, u_u, x_x, |_|, ||_||",
        false,
        false,
      ],
      session_hash: "0yzsdmhe9br9",
    };
    const res = await fetch(api, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return "无法转为提示词";
    }
    const data = await res.json();
    const prompt = data.data[0];
    console.log("图片提示词:", prompt);
    return prompt;
  },

  /** 搜索survivalcraft(生存战争)论坛的帖子 */
  SearchScbbsPost: async ({ keyword }) => {
    const api = `https://m.suancaixianyu.cn/api/post/list?title=${encodeURIComponent(keyword)}`;
    try {
      const response = await fetch(api);
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      return data.data.list.map((item) => ({
        viewUrl: `https://test.suancaixianyu.cn/#/postDetails/${item.id}`,
        title: item.title,
        content: item.content,
        userName: item.creator.nickname,
        userPage: `https://test.suancaixianyu.cn/#/user/${item.creatorId}`,
        createdAt: item.createdAt,
        plate: item.plate.name,
        postVersions: item.postVersions.map((version) => ({
          version: version.version,
          versionName: version.title,
          createdAt: version.createdAt,
          files: version.files.map((file) => ({
            name: file.name,
            url: file.url,
          })),
        })),
      }));
    } catch (error) {
      console.error("Error searching posts:", error);
      return [];
    }
  },

  Photoshop: async ({ image_url, instruction }) => {
    // 从aiconfig中查询grok配置
    const aiConfigStr = await redis.get(`ai:list:grok`);
    if (!aiConfigStr) {
      return "未找到AI配置";
    }
    const aiConfig = JSON.parse(aiConfigStr);

    try {
      // 处理单个或多个图片
      const imageUrls = Array.isArray(image_url) ? image_url : [image_url];
      const imgBase64Array: string[] = [];

      for (const url of imageUrls) {
        let imgBase64 = "";
        if (url.startsWith("https://imgen.x.ai")) {
          imgBase64 = url;
        } else {
          imgBase64 = await uploadImageToR2(url);
        }
        imgBase64Array.push(imgBase64);
      }

      const requestBody = Array.isArray(image_url)
        ? {
            model: "grok-imagine-image",
            images: imgBase64Array.map((base64) => ({
              url: base64,
              type: "image_url",
            })),
            prompt: instruction,
            n: 1,
          }
        : {
            model: "grok-imagine-image",
            image: {
              url: imgBase64Array[0],
              type: "image_url",
            },
            prompt: instruction,
            n: 1,
          };

      console.log("最终请求体", requestBody);

      const res = await fetch(aiConfig.host + "/images/edits", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiConfig.key}`,
        },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const err = await res.text();
        console.log(err);
        return err;
      }
      const image = await res.json();
      console.log("画好了", image);

      return image.data;
    } catch (error) {
      console.error("Error calling AIPS:", error);
      return "调用接口失败" + error;
    }
  },

  GPTGenerateImage: async ({
    image_url,
    prompt,
    size = "1024x1536",
    quality = "low",
  }: {
    image_url?: string;
    prompt: string;
    size?: string;
    quality?: string;
  }) => {
    const gptImageConfig = await redisClient.getGPTImageConfig();
    if (!gptImageConfig || !gptImageConfig.host || !gptImageConfig.key) {
      return "未配置 GPT 画图接口，请使用命令：\n#gpt画图配置 <主机地址> <api_key> <模型>";
    }

    try {
      const openai = new OpenAi({
        baseURL: gptImageConfig.host,
        apiKey: gptImageConfig.key,
        timeout: 120000,
      });

      const model = gptImageConfig.model || "gpt-image-2";

      const sourceImageUrl = String(image_url || "").trim();
      const response = sourceImageUrl
        ? await openai.images.edit({
            model,
            image: await imageUrlToFile(sourceImageUrl),
            prompt,
            n: 1,
            size: size as any,
            quality: quality as any,
          })
        : await openai.images.generate({
            model,
            prompt,
            n: 1,
            size: size as any,
            quality: quality as any,
            moderation: "low",
          });

      console.log("GPT 画图完成", response.data?.[0]);

      // gpt-image-1 默认返回 b64_json，也可能返回 url
      let imageData: string | undefined;
      if (response.data?.[0]?.b64_json) {
        imageData = `data:image/png;base64,${response.data[0].b64_json}`;
      } else if (response.data?.[0]?.url) {
        imageData = response.data[0].url;
      }

      if (!imageData) {
        return "生成图片失败：未获取到图片数据";
      }

      // 将图片保存到本地,然后返回本地路径
      const dir = "./public/image_out";
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const savePath = `${dir}/${Date.now()}.png`;
      let buffer: Buffer;
      if (imageData.startsWith("data:image/")) {
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
        buffer = Buffer.from(base64Data, "base64");
      } else {
        const res = await fetch(imageData);
        if (!res.ok) {
          return "生成图片失败：下载图片失败";
        }
        const arrayBuffer = await res.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      }
      fs.writeFileSync(savePath, buffer);

      return [{ type: "image", url: savePath }];
    } catch (error: any) {
      console.error("Error calling GPT image API:", error);
      let errormsg: string = error?.message || error;
      if (errormsg.includes("sexual"))
        errormsg = "什么⭐🦆🐜，不给你画了，哼！";
      return "调用 GPT 画图接口失败: " + errormsg;
    }
  },

  AIVideos: async ({ image_url, instruction }) => {
    // 从aiconfig中查询grok配置
    const aiConfigStr = await redis.get(`ai:list:grok`);
    if (!aiConfigStr) {
      return "未找到AI配置";
    }
    const aiConfig = JSON.parse(aiConfigStr);

    // 处理单个或多个图片
    const imageUrls = Array.isArray(image_url) ? image_url : [image_url];
    const imgBase64Array: string[] = [];

    for (const url of imageUrls) {
      let imgBase64 = "";
      if (url) {
        if (url.startsWith("https://imgen.x.ai")) {
          imgBase64 = url;
        } else {
          imgBase64 = await uploadImageToR2(url);
        }
        imgBase64Array.push(imgBase64);
      }
    }

    try {
      const requestBody =
        imgBase64Array.length === 0
          ? {
              model: "grok-imagine-video",
              prompt: instruction,
              aspect_ratio: "16:9",
              resolution: "720p",
            }
          : Array.isArray(image_url)
            ? {
                model: "grok-imagine-video",
                images: imgBase64Array.map((base64) => ({
                  url: base64,
                  type: "image_url",
                })),
                prompt: instruction,
                resolution: "720p",
              }
            : {
                model: "grok-imagine-video",
                image: {
                  url: imgBase64Array[0],
                  type: "image_url",
                },
                prompt: instruction,
                resolution: "720p",
              };

      console.log("最终请求体", requestBody);

      const res = await fetch(aiConfig.host + "/videos/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiConfig.key}`,
        },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const err = await res.text();
        console.log(err);
        return err;
      }
      const video = await res.json();
      console.log("画好了", video);

      return {
        data: video,
        msg: "生成任务已提交,稍后会自动发送生成结果,无需继续等待~,将request_id提供给用户,方便查询生成状态",
      };
    } catch (error) {
      console.error("Error calling AIPS:", error);
      return "调用接口失败" + error;
    }
  },

  AIVideoResult: async ({ request_id }) => {
    // 从aiconfig中查询grok配置
    const aiConfigStr = await redis.get(`ai:list:grok`);
    if (!aiConfigStr) {
      return "未找到AI配置";
    }
    const aiConfig = JSON.parse(aiConfigStr);

    try {
      const res = await fetch(aiConfig.host + `/videos/${request_id}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aiConfig.key}`,
        },
      });
      if (!res.ok) {
        const err = await res.text();
        console.log(err);
        return err;
      }
      const video = await res.json();
      console.log("视频生成结果", video);

      return video;
    } catch (error) {
      console.error("Error calling AIVideoResult:", error);
      return "调用接口失败" + error;
    }
  },

  /**
   *  获取TTS模型列表
   * @returns  TTS模型列表
   */
  GetTTSModels: async () => {
    const ttsClient = new TTSClient();
    const models = await ttsClient.getModels("v4");
    return models;
  },

  AgentListWorkspaces: async ({
    guid,
    includeKnowledge = true,
    maxResults = 50,
  }: {
    guid: string;
    includeKnowledge?: boolean;
    maxResults?: number;
  }) => {
    try {
      const workspaces = listAgentWorkspaces(includeKnowledge, maxResults).filter(
        (workspace) => workspace.guid === guid,
      );
      return {
        success: true,
        count: workspaces.length,
        workspaces,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentCreateWorkspace: async ({ guid }: { guid: string }) => {
    try {
      const workspaceGuid = createAgentGuid(guid);
      return {
        success: true,
        guid: workspaceGuid,
        path: `public/${workspaceGuid}`,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentCloneRepository: async ({
    guid,
    repoUrl,
    targetPath,
    branch,
    depth = 1,
  }: {
    guid: string;
    repoUrl: string;
    targetPath?: string;
    branch?: string;
    depth?: number;
  }) => {
    try {
      await validateRepositoryUrl(repoUrl);

      if (branch) {
        validateGitRef(branch);
      }

      const safeDepth = normalizeCloneDepth(depth);
      const cloneTargetPath = resolveCloneTargetPath(repoUrl, targetPath);
      const { target, relativePath } = resolveAgentPath(guid, cloneTargetPath);

      if (fs.existsSync(target)) {
        throw new Error("目标目录已存在，为避免覆盖请换一个 targetPath");
      }

      ensureParentDirectory(target);
      const output = await runGitClone({
        repoUrl,
        target,
        branch,
        depth: safeDepth,
      });
      assertRealPathInside(resolveAgentRoot(guid), target);

      return {
        success: true,
        guid,
        repoUrl,
        path: relativePath,
        depth: safeDepth,
        branch: branch || null,
        output,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentReviewProjectCommand: async ({
    guid,
    command,
    workingDirectory = ".",
    reviewGuid,
    isMaster,
  }: {
    guid: string;
    command: string;
    workingDirectory?: string;
    reviewGuid?: string;
    isMaster?: boolean;
  }) => {
    try {
      const { relativePath } = resolveAgentPath(guid, workingDirectory);
      const review = await performProjectCommandReview({
        command,
        reviewGuid,
        isMaster,
      });

      return {
        success: true,
        guid,
        workingDirectory: relativePath,
        command,
        ...review,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  RunServerCommand: async ({
    command,
    workingDirectory,
    reviewGuid,
    isMaster,
    timeoutSeconds = SERVER_COMMAND_DEFAULT_TIMEOUT_SECONDS,
  }: {
    command: string;
    workingDirectory?: string;
    reviewGuid: string;
    isMaster?: boolean;
    timeoutSeconds?: number;
  }) => {
    try {
      await assertAgentEnabled(reviewGuid);
      if (!reviewGuid?.trim()) {
        throw new Error("reviewGuid 必填，请传入当前群号");
      }
      const cwd = resolveServerWorkingDirectory(workingDirectory);
      assertServerCommandPathsInsideProject(command);
      const timeoutMs = normalizeServerCommandTimeoutMs(timeoutSeconds);
      const review = await performServerCommandReview({
        command,
        reviewGuid,
        workingDirectory: cwd,
        isMaster,
      });
      if (!review.allowed) {
        const safeCommand =
          isMaster === true
            ? { text: command, redacted: false }
            : redactServerToolText(command);
        return {
          success: false,
          command: safeCommand.text,
          workingDirectory: cwd,
          error: "服务器指令未通过 AI 自动审核",
          outputRedacted: safeCommand.redacted,
          review,
        };
      }

      const result = await runServerShellCommand({
        command,
        cwd,
        timeoutMs,
      });
      const safeCommand =
        isMaster === true
          ? { text: command, redacted: false }
          : redactServerToolText(command);
      const safeOutput =
        isMaster === true
          ? { text: result.output, redacted: false }
          : redactServerToolText(result.output);
      return {
        success: result.exitCode === 0,
        command: safeCommand.text,
        workingDirectory: cwd,
        review,
        output: safeOutput.text,
        outputRedacted: safeCommand.redacted || safeOutput.redacted,
        exitCode: result.exitCode,
        error: result.exitCode === 0 ? undefined : "服务器指令执行失败",
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentGitOperation: async ({
    guid,
    action,
    workingDirectory = ".",
    branch,
    includeRemote = true,
  }: {
    guid: string;
    action: "currentBranch" | "listBranches" | "listRemotes" | "switchBranch";
    workingDirectory?: string;
    branch?: string;
    includeRemote?: boolean;
  }) => {
    try {
      const { target: cwd, relativePath } = resolveAgentPath(
        guid,
        workingDirectory,
      );
      await ensureGitRepository(cwd);

      if (action === "currentBranch") {
        const currentBranch = await getGitCurrentBranch(cwd);
        return {
          success: true,
          guid,
          action,
          workingDirectory: relativePath,
          branch: currentBranch || null,
        };
      }

      if (action === "listBranches") {
        const branches = await listGitBranches(cwd, includeRemote !== false);
        return {
          success: true,
          guid,
          action,
          workingDirectory: relativePath,
          branches,
        };
      }

      if (action === "listRemotes") {
        const remotes = await listGitRemotes(cwd);
        return {
          success: true,
          guid,
          action,
          workingDirectory: relativePath,
          remotes,
        };
      }

      if (action === "switchBranch") {
        if (!branch) {
          throw new Error("action=switchBranch 时必须提供 branch");
        }
        const switched = await switchGitBranch(cwd, branch);
        const currentBranch = await getGitCurrentBranch(cwd);
        return {
          success: true,
          guid,
          action,
          workingDirectory: relativePath,
          branch: currentBranch || branch,
          source: switched.source,
          output: switched.output,
        };
      }

      throw new Error("不支持的 Git action");
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentProjectCommand: async ({
    guid,
    action,
    workingDirectory = ".",
    command,
    reviewGuid,
    isMaster,
    archivePath,
    destinationPath,
    sourcePath,
    targetPath,
    directoryPath,
  }: {
    guid: string;
    action: "inspect" | "run" | "extract" | "rename" | "mkdir";
    workingDirectory?: string;
    command?: string;
    reviewGuid?: string;
    isMaster?: boolean;
    archivePath?: string;
    destinationPath?: string;
    sourcePath?: string;
    targetPath?: string;
    directoryPath?: string;
  }) => {
    try {
      const { target: cwd, relativePath } = resolveAgentPath(
        guid,
        workingDirectory,
      );

      if (action === "inspect") {
        const info = await inspectProjectEnvironment(cwd);
        return {
          success: true,
          guid,
          action,
          workingDirectory: relativePath,
          ...info,
        };
      }

      if (action === "mkdir") {
        if (!directoryPath) {
          throw new Error("action=mkdir 时必须提供 directoryPath");
        }
        const created = resolveAgentPath(guid, directoryPath);
        fs.mkdirSync(created.target, { recursive: true });
        return {
          success: true,
          guid,
          action,
          path: created.relativePath,
        };
      }

      if (action === "rename") {
        if (!sourcePath || !targetPath) {
          throw new Error("action=rename 时必须提供 sourcePath 和 targetPath");
        }
        const source = resolveAgentPath(guid, sourcePath);
        const target = resolveAgentPath(guid, targetPath);
        if (!fs.existsSync(source.target)) {
          throw new Error("源路径不存在");
        }
        if (fs.existsSync(target.target)) {
          throw new Error("目标路径已存在，为避免覆盖请更换 targetPath");
        }
        ensureParentDirectory(target.target);
        fs.renameSync(source.target, target.target);
        return {
          success: true,
          guid,
          action,
          sourcePath: source.relativePath,
          targetPath: target.relativePath,
        };
      }

      if (action === "extract") {
        if (!archivePath) {
          throw new Error("action=extract 时必须提供 archivePath");
        }
        const archive = resolveAgentPath(guid, archivePath);
        if (
          !fs.existsSync(archive.target) ||
          !fs.statSync(archive.target).isFile()
        ) {
          throw new Error("压缩包不存在或不是文件");
        }
        const destination = resolveAgentPath(
          guid,
          destinationPath || workingDirectory || ".",
        );
        const result = await extractArchiveWithinWorkspace({
          archive: archive.target,
          destination: destination.target,
        });
        return {
          success: result.exitCode === 0,
          guid,
          action,
          archivePath: archive.relativePath,
          destinationPath: destination.relativePath,
          output: result.output,
          exitCode: result.exitCode,
          error: result.exitCode === 0 ? undefined : "解压命令执行失败",
        };
      }

      if (action === "run") {
        if (!command) {
          throw new Error("action=run 时必须提供 command");
        }
        const review = await performProjectCommandReview({
          command,
          reviewGuid,
          isMaster,
        });
        if (!review.allowed) {
          return {
            success: false,
            guid,
            action,
            command,
            workingDirectory: relativePath,
            error: "命令未通过安全审查",
            review,
          };
        }

        const localReview = review.localReview;
        const result = await runSpawnCommand({
          file: localReview.tokens[0],
          args: localReview.tokens.slice(1),
          cwd,
        });
        return {
          success: result.exitCode === 0,
          guid,
          action,
          command,
          workingDirectory: relativePath,
          review,
          output: result.output,
          exitCode: result.exitCode,
          error: result.exitCode === 0 ? undefined : "项目命令执行失败",
        };
      }

      throw new Error("不支持的 action");
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentReadFileLines: async ({
    guid,
    filePath,
    startLine = 1,
    endLine,
  }: {
    guid: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      if (!fs.existsSync(target)) {
        throw new Error("文件不存在");
      }
      if (!fs.statSync(target).isFile()) {
        throw new Error("目标路径不是文件");
      }

      const lines = readTextLines(target);
      const safeStartLine = normalizePositiveInteger(startLine, 1, "startLine");
      const requestedEndLine = normalizePositiveInteger(
        endLine,
        Math.min(lines.length || 1, safeStartLine + 199),
        "endLine",
      );
      const safeEndLine = Math.min(
        requestedEndLine,
        safeStartLine + AGENT_FILE_MAX_READ_LINES - 1,
        lines.length,
      );

      if (requestedEndLine < safeStartLine) {
        throw new Error("endLine 不能小于 startLine");
      }

      const content = lines
        .slice(safeStartLine - 1, safeEndLine)
        .map((line, index) => `${safeStartLine + index}: ${line}`)
        .join("\n");

      return {
        success: true,
        path: relativePath,
        startLine: safeStartLine,
        endLine: safeEndLine,
        totalLines: lines.length,
        truncated: requestedEndLine > safeEndLine,
        content,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentWriteFile: async ({
    guid,
    filePath,
    content,
    mode = "overwrite",
  }: {
    guid: string;
    filePath: string;
    content: string;
    mode?: "overwrite" | "append";
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      ensureParentDirectory(target);

      if (mode === "append") {
        fs.appendFileSync(target, content, "utf-8");
      } else if (mode === "overwrite") {
        fs.writeFileSync(target, content, "utf-8");
      } else {
        throw new Error("mode 只能是 overwrite 或 append");
      }

      return {
        success: true,
        path: relativePath,
        mode,
        bytes: Buffer.byteLength(content, "utf-8"),
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentInsertFile: async ({
    guid,
    filePath,
    lineNumber,
    content,
  }: {
    guid: string;
    filePath: string;
    lineNumber: number;
    content: string;
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      if (!fs.existsSync(target)) {
        throw new Error("文件不存在");
      }
      if (!fs.statSync(target).isFile()) {
        throw new Error("目标路径不是文件");
      }

      const structured = readStructuredTextFile(target);
      const lines = [...structured.lines];
      const safeLineNumber = normalizePositiveInteger(
        lineNumber,
        1,
        "lineNumber",
      );

      if (safeLineNumber > lines.length + 1) {
        throw new Error("lineNumber 不能大于总行数 + 1");
      }

      lines.splice(safeLineNumber - 1, 0, ...content.split(/\r?\n/));
      writeStructuredTextFile({
        target,
        lines,
        eol: structured.eol,
        hasTrailingNewline: structured.hasTrailingNewline,
      });

      return {
        success: true,
        path: relativePath,
        lineNumber: safeLineNumber,
        insertedLines: content.split(/\r?\n/).length,
        totalLines: lines.length,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentReplaceFileRange: async ({
    guid,
    filePath,
    startLine,
    endLine,
    content,
  }: {
    guid: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      if (!fs.existsSync(target)) {
        throw new Error("文件不存在");
      }
      if (!fs.statSync(target).isFile()) {
        throw new Error("目标路径不是文件");
      }

      const structured = readStructuredTextFile(target);
      const lines = [...structured.lines];
      if (lines.length === 0) {
        throw new Error("文件为空，请改用 AgentWriteFile 或 AgentInsertFile");
      }

      const safeStartLine = normalizePositiveInteger(startLine, 1, "startLine");
      const safeEndLine = normalizePositiveInteger(
        endLine,
        safeStartLine,
        "endLine",
      );

      if (safeEndLine < safeStartLine) {
        throw new Error("endLine 不能小于 startLine");
      }
      if (safeStartLine > lines.length) {
        throw new Error("startLine 不能大于总行数");
      }
      if (safeEndLine > lines.length) {
        throw new Error("endLine 不能大于总行数");
      }

      const replacementLines = content.length ? content.split(/\r?\n/) : [];
      const replacedLines = safeEndLine - safeStartLine + 1;

      lines.splice(safeStartLine - 1, replacedLines, ...replacementLines);
      writeStructuredTextFile({
        target,
        lines,
        eol: structured.eol,
        hasTrailingNewline: structured.hasTrailingNewline,
      });

      return {
        success: true,
        path: relativePath,
        startLine: safeStartLine,
        endLine: safeEndLine,
        replacedLines,
        insertedLines: replacementLines.length,
        totalLines: lines.length,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentCreateFile: async ({
    guid,
    filePath,
    content = "",
    overwrite = false,
  }: {
    guid: string;
    filePath: string;
    content?: string;
    overwrite?: boolean;
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      const existed = fs.existsSync(target);
      if (existed && !overwrite) {
        throw new Error("文件已存在，如需覆盖请传 overwrite=true");
      }
      ensureParentDirectory(target);
      fs.writeFileSync(target, content, "utf-8");

      return {
        success: true,
        path: relativePath,
        overwritten: existed && overwrite,
        bytes: Buffer.byteLength(content, "utf-8"),
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentDeleteFile: async ({
    guid,
    filePath,
  }: {
    guid: string;
    filePath: string;
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      if (!fs.existsSync(target)) {
        throw new Error("文件不存在");
      }
      if (!fs.statSync(target).isFile()) {
        throw new Error("只能删除文件，不能删除文件夹");
      }

      fs.unlinkSync(target);

      return {
        success: true,
        path: relativePath,
        deleted: true,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentListFiles: async ({
    guid,
    folderPath = ".",
    recursive = false,
    maxDepth = 3,
  }: {
    guid: string;
    folderPath?: string;
    recursive?: boolean;
    maxDepth?: number;
  }) => {
    try {
      const { root, target, relativePath } = resolveAgentPath(guid, folderPath);
      if (!fs.existsSync(target)) {
        throw new Error("文件夹不存在");
      }
      if (!fs.statSync(target).isDirectory()) {
        throw new Error("目标路径不是文件夹");
      }

      const entries: Array<{
        path: string;
        type: "file" | "directory";
        size: number;
        modifiedAt: string;
      }> = [];

      getAgentFileList(
        root,
        target,
        1,
        recursive ? Math.max(1, Math.min(Number(maxDepth) || 3, 10)) : 1,
        entries,
      );

      return {
        success: true,
        path: relativePath,
        recursive,
        truncated: entries.length >= AGENT_FILE_MAX_LIST_ENTRIES,
        entries,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentSearchFiles: async ({
    guid,
    query,
    folderPath = ".",
    mode = "both",
    maxResults = 20,
  }: {
    guid: string;
    query: string;
    folderPath?: string;
    mode?: "filename" | "content" | "both";
    maxResults?: number;
  }) => {
    try {
      const { root, target, relativePath } = resolveAgentPath(guid, folderPath);
      if (!query?.trim()) {
        throw new Error("query 不能为空");
      }
      if (!fs.existsSync(target)) {
        throw new Error("搜索目录不存在");
      }
      if (!fs.statSync(target).isDirectory()) {
        throw new Error("搜索起点必须是文件夹");
      }

      const safeMaxResults = Math.max(
        1,
        Math.min(Number(maxResults) || 20, AGENT_FILE_MAX_SEARCH_RESULTS),
      );
      const results = searchFilesWithinWorkspace({
        root,
        folder: target,
        query: query.trim(),
        mode,
        maxResults: safeMaxResults,
      });

      return {
        success: true,
        path: relativePath,
        query: query.trim(),
        mode,
        maxResults: safeMaxResults,
        total: results.length,
        results,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentUploadFileToR2: async ({
    guid,
    filePath,
    fileName,
    uploadType = "file",
  }: {
    guid: string;
    filePath: string;
    fileName?: string;
    uploadType?: "file" | "image";
  }) => {
    try {
      const { target, relativePath } = resolveAgentPath(guid, filePath);
      if (!fs.existsSync(target)) {
        throw new Error("文件不存在");
      }
      if (!fs.statSync(target).isFile()) {
        throw new Error("只能上传文件，不能上传文件夹");
      }

      const url =
        uploadType === "image"
          ? await uploadImageToR2(target, fileName)
          : await uploadMediaToR2(target, fileName);

      return {
        success: true,
        path: relativePath,
        fileName: fileName || null,
        uploadType,
        url,
        sendText: uploadType === "image" ? `<img=${url}>` : `文件链接: ${url}`,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  // /**
  //  * 执行eval
  //  * @param code 代码字符串
  //  * @returns 执行结果
  //  */
  // EvalCode: async ({ code }) => {
  //   try {
  //     if (code.includes("exec") || code.includes("process")) {
  //       return "代码中包含敏感词,无法执行";
  //     }
  //     // eslint-disable-next-line no-eval
  //     const result = eval(code);
  //     return result;
  //   } catch (error) {
  //     console.error(`Error executing code: ${error}`);
  //     return `Error: ${error}`;
  //   }
  // },

  /**
   * 获取技能详情
   * @param skillName 技能名称
   * @returns 技能详情
   */
  getSKILLDetail: async ({ skillName }) => {
    const skill = loadSkillDetail(skillName);
    return skill;
  },

  /**
   * 获取Help命令列表
   * @returns Help命令列表
   * 命令列表格式: [{ command: "命令文本", description: "命令说明" }]
   */
  GetCommand: async () => {
    return help;
  },

  LocalBrowser: async ({
    action,
    query,
    url,
    engine = "bing",
    maxResults = 5,
    maxChars = 12000,
  }: {
    action: "search" | "visit";
    query?: string;
    url?: string;
    engine?: "bing" | "google" | "baidu";
    maxResults?: number;
    maxChars?: number;
  }) => {
    try {
      return await runLocalBrowser(
        { action, query, url, engine, maxResults, maxChars },
        value.localBrowser || {},
      );
    } catch (error) {
      return toToolError(error);
    }
  },

  ExecuteAlemonCommand: async ({
    command,
    commandQueue,
  }: {
    command: string;
    commandQueue?: string[];
  }) => {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand) {
      return { success: false, error: "框架指令不能为空" };
    }
    if (
      !normalizedCommand.startsWith("/") &&
      !normalizedCommand.startsWith("#")
    ) {
      return {
        success: false,
        error: "框架指令必须以 / 或 # 开头；可先调用 GetCommand 查询完整格式",
      };
    }
    if (/\r|\n/.test(normalizedCommand)) {
      return { success: false, error: "每次只能执行一条框架指令" };
    }
    if (!Array.isArray(commandQueue)) {
      return {
        success: false,
        error: "当前调用环境不支持执行框架指令",
      };
    }
    if (commandQueue.length > 0) {
      return {
        success: false,
        error: "本轮已经提交过一条框架指令，请等待执行结果后再执行下一条",
      };
    }

    commandQueue.push(normalizedCommand);
    return {
      success: true,
      command: normalizedCommand,
      status: "已提交给 AlemonJS 框架执行",
    };
  },

  http_request: async ({
    url,
    method = "GET",
    body,
  }: {
    url: string;
    method?: string;
    body?: string;
  }) => {
    await validateURL(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        method,
        body,
        signal: controller.signal,
        headers: {
          "User-Agent": "AI-Agent/1.0",
        },
      });

      const text = await res.text();

      if (text.length > 1024 * 1024) {
        return "Response too large";
      }

      return text;
    } catch (e: any) {
      return `Request failed: ${e.message}`;
    } finally {
      clearTimeout(timeout);
    }
  },

  ping: async ({ host }: { host: string }) => {
    // 禁止直接 IP
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return "IP address not allowed";
    }

    const ips = await dns.lookup(host, { all: true });

    for (const { address } of ips) {
      if (isPrivateIP(address)) {
        return "Target resolves to private IP";
      }
    }

    return new Promise((resolve) => {
      const child = spawn("ping", ["-c", "3", host]);

      let output = "";

      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));

      child.on("close", () => resolve(output));
    });
  },

  RunOpencode: async (args: any) => {
    try {
      return await runOpencode({
        action: args?.action,
        prompt: args?.prompt,
        sessionId: args?.sessionId,
        projectPath: args?.projectPath,
        model: args?.model,
        agent: args?.agent,
        autoApprove: args?.autoApprove,
        timeoutSeconds: args?.timeoutSeconds,
        guid: args?.guid,
      });
    } catch (error) {
      return toToolError(error);
    }
  },
};
