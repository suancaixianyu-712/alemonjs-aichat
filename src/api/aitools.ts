import { redis } from "../redis";
import { getConfigValue } from "alemonjs";
import fs from "fs";
import { uploadImageToR2, uploadMediaToR2 } from "../s3";
import { TTSClient } from "./tts";
import { ChatCompletionTool } from "openai/resources";
import OpenAi from "openai";
import { loadSkillDetail } from "./loadSkill";
import help from "@src/data/help.json";
import redisClient from "../config";
import { isPrivateIP, validateURL } from "./security";
import { spawn } from "child_process";
import * as dns from "node:dns/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkspace } from "./workspace";
import { getExecCommandEnv } from "../userEnv";
import { remoteNodeManager } from "../remoteNodes";

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
      name: "SearchWeb",
      description:
        "使用搜索引擎搜索网页内容, 你可以使用这个工具来获取最新的资讯或数据, 但请注意不要搜索敏感或违法的内容, 否则可能会得到不相关的结果, 此外,不推荐使用该工具搜索与sc这个游戏相关的内容, 因为搜索引擎的结果可能不如专门的游戏论坛或社区来的准确和有用, 在搜索时请尽量提供精确的关键词, 关键词最好只有一个. 如果你想搜索与游戏相关的内容, 建议使用SearchScbbsPost工具来搜索survivalcraft(生存战争)论坛的帖子",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "搜索关键词",
          },
          engine: {
            type: "string",
            description: "选择搜索引擎",
            enum: ["bing", "google", "baidu"],
            default: "baidu",
          },
          cc: {
            type: "string",
            description:
              "搜索国家/地区代码, 例如搜索美国就填us, 搜索中国就填cn, 搜索日本就填jp, 这个参数会影响搜索结果的地域性",
            default: "CN",
          },
          type: {
            type: "string",
            description:
              "选择结果类型, 搜索后获取对应结果, 建议使用自然结果organic_results, 其他选项可能不存在",
            enum: ["organic_results", "related_questions", "related_searches"],
            default: "organic_results",
          },
        },
        required: ["keyword"],
      },
    },
  },
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
        "使用 GPT 图像模型生成图片，适合各种风格的图像生成需求。支持中文提示词。",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "图片描述，支持中英文。描述越详细，生成效果越好。例如：'一只穿着宇航服的柯基犬在月球表面奔跑，电影感光影' 或 'a cute cat sitting on a windowsill, watercolor style'",
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
      name: "exec",
      description:
        "执行终端命令. 禁止用于 AI agent 编程文件操作；public/{guid}/ 内的文件增查改删只能使用 Agent* 文件工具，不能通过 exec、Docker 或容器完成. 你可以使用这个工具来执行一些简单的命令, 例如查看当前目录下的文件ls, 查看系统状态top等. 当你想要执行一个命令时, 请提供具体的命令文本, 例如'ls -la'或'top -n 1'. 执行结果将会返回给你, 但请注意, 由于安全限制, 某些命令可能无法执行或返回受限的结果",
      parameters: {
        type: "object",
        properties: {
          userId: {
            type: "string",
            description: "执行命令的用户ID",
          },
          groupId: {
            type: "string",
            description: "当前群聊ID，私聊时传'private'",
          },
          command: {
            type: "string",
            description: "要执行的终端命令",
          },
        },
        required: ["userId", "groupId", "command"],
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
        "列出 public/ 下已有的 AI agent 工作目录 guid，适合在不知道之前项目 guid 时先做发现。找到 guid 后再配合 AgentListFiles 或 AgentSearchFiles 查看 knowledge/ 和项目内容。",
      parameters: {
        type: "object",
        properties: {
          includeKnowledge: {
            type: "boolean",
            description:
              "是否附带每个工作目录下 knowledge/ 的一级仓库目录名摘要",
            default: true,
          },
          maxResults: {
            type: "number",
            description: "最多返回多少个工作目录，默认 50，最大 200",
            default: 50,
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AgentCreateWorkspace",
      description:
        "在项目 public/ 下创建一个新的 AI agent 工作目录，并返回可用于后续文件工具的 guid。需要新项目目录时使用它，不要用 exec 调用 uuidgen。",
      parameters: {
        type: "object",
        properties: {
          guid: {
            type: "string",
            description: "可选。指定工作目录ID；不传则自动生成一个安全的随机ID",
          },
        },
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
        "直接在服务器上执行运维指令，可用于查看状态、管理服务、Docker、PM2、日志和部署流程。执行前必须通过本地基础拦截和 AI 自动审核；审核不可用或未通过时不会执行。不要用它操作 public/{guid} 项目文件，AI agent 项目文件操作仍使用 Agent* 工具。",
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
      name: "MemoryOperation",
      description:
        "这个工具用于获取或修改对于用户的记忆数据, 包括用户形象, 用户偏好, 历史对话等. 你可以使用这个工具来存储一些需要长期记忆的信息, 例如用户的兴趣爱好, 重要事件等, 在不认识对方时可以尝试一下获取. 当你想要获取或修改这些信息时, 可以调用这个工具并提供具体的操作指令和数据. 例如, 在聊天过程中他对你的态度,以及他喜欢的东西等,可以通过这个工具及时记录下来, 也可以通过这个工具获取之前的对话记录,便于继续之前的话题",
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
              "要执行的操作类型，例如'get'表示获取数据，'set'表示修改数据",
            enum: ["get", "set"],
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
              "要获取或修改的数据内容, 例如当operation为'set'时,dataType为'user'时, data应该是要存储的数据内容, 例如用户喜欢的颜色是蓝色, 则data可以是'favoriteColor:blue', 当operation为'get'时,dataType为'user'时,data可以留空; 当operation为'get'且dataType为'chatHistory'时,data留空会返回摘要列表, 传入'guid:id'获取该归档详情, 传入'search:关键词'可搜索相关历史归档",
          },
        },
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
];

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

const commandTargetsAgentWorkspace = (command: string) => {
  const normalized = command.replace(/["']/g, "").toLowerCase();
  return (
    normalized.includes("public/") ||
    normalized.includes("public\\") ||
    normalized.includes("knowledge/") ||
    normalized.includes("knowledge\\")
  );
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
  return cwd;
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
}: {
  command: string;
  reviewGuid?: string;
}) => {
  const localReview = buildProjectCommandReview(command);
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
}: {
  command: string;
  reviewGuid?: string;
  workingDirectory: string;
}) => {
  const localReview = buildServerCommandLocalReview(command);
  if (!localReview.allowed) {
    return {
      allowed: false,
      risk: localReview.risk,
      localReview,
      aiReview: {
        status: "skipped" as const,
        reason: "本地基础拦截未通过，未继续调用 AI 审核",
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

/**
 * 确保 Docker 容器已创建并运行
 */
async function ensureContainerRunning(
  config: Record<string, any>,
): Promise<void> {
  const {
    containerName,
    image,
    memory,
    cpus,
    pidsLimit,
    networkMode,
    workspacePath,
  } = config;
  if (!containerName) return;

  return new Promise((resolve, reject) => {
    const check = spawn("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      containerName,
    ]);
    let stdout = "";
    check.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    check.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Docker 不可用：未找到 docker 命令"
            : `Docker 检查失败：${error.message}`,
        ),
      );
    });
    check.on("close", (code: number) => {
      if (code === 0 && stdout.trim() === "true") {
        resolve();
        return;
      }

      if (code === 0 && stdout.trim() === "false") {
        const start = spawn("docker", ["start", containerName]);
        start.on("error", (error: NodeJS.ErrnoException) => {
          reject(new Error(`Docker 启动容器失败：${error.message}`));
        });
        start.on("close", (startCode: number) => {
          if (startCode === 0) {
            resolve();
          } else {
            reject(new Error(`Docker 启动容器失败，退出码: ${startCode}`));
          }
        });
        return;
      }

      const args = [
        "run",
        "-d",
        "--name",
        containerName,
        "--memory",
        memory || "256m",
        "--cpus",
        cpus || "0.5",
        "--pids-limit",
        String(pidsLimit || 64),
        "--network",
        networkMode || "none",
      ];

      if (workspacePath && fs.existsSync(workspacePath)) {
        args.push("-v", `${workspacePath}:/workspace`, "-w", "/workspace");
      }

      args.push(image || "ubuntu:latest", "sleep", "infinity");

      const create = spawn("docker", args);
      let createStderr = "";
      create.stderr.on("data", (d: Buffer) => (createStderr += d.toString()));
      create.on("error", (error: NodeJS.ErrnoException) => {
        reject(new Error(`Docker 创建容器失败：${error.message}`));
      });
      create.on("close", (code: number) => {
        if (code !== 0) {
          reject(
            new Error(
              `Docker 创建容器失败: ${containerName}${createStderr ? `\n${createStderr}` : ""}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  });
}

export const availableTools = {
  getAlemonjsConfig: async ({ key, value }) => {
    if (key == "ailist") {
      // 获取当前配置
      return await redisClient.getAIList();
    }
  },

  MemoryOperation: async ({ userID, operation, dataType, data }) => {
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

  /** 使用搜索引擎搜索网页 */
  SearchWeb: async ({
    keyword,
    engine = "baidu",
    cc = "CN",
    type = "organic_results",
  }) => {
    const apikey =
      value.searchApiKey ||
      "63706fc3e6827a90e8219913297b510ff053d5238b24f64251a066e4ecea7408";
    const api = `https://serpapi.com/search.json?engine=${engine}&q=${encodeURIComponent(keyword)}&cc=${cc}&api_key=${apikey}`;
    try {
      const response = await fetch(api);
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      console.log("搜索结果", data);

      const results = data[type] || [];
      return type === "organic_results" ? results.slice(0, 7) : results;
    } catch (error) {
      console.error("Error searching web:", error);
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
    prompt,
    size = "1024x1536",
    quality = "low",
  }: {
    prompt: string;
    size?: string;
    quality?: string;
  }) => {
    // 从 ai:list:* 中查找 gpt|chatgpt|openai 配置
    const keys = await redis.keys("ai:list:*");
    const gptKey = keys.find((key) =>
      /gpt|chatgpt|openai/i.test(key.replace("ai:list:", "")),
    );
    if (!gptKey) {
      return "未找到 GPT/OpenAI 相关的 AI 配置，请先添加一个包含 gpt/chatgpt/openai 关键词的 AI 配置";
    }
    const aiConfigStr = await redis.get(gptKey);
    if (!aiConfigStr) {
      return "读取 AI 配置失败";
    }
    const aiConfig = JSON.parse(aiConfigStr);

    try {
      const openai = new OpenAi({
        baseURL: aiConfig.host,
        apiKey: aiConfig.key,
        timeout: 120000,
      });

      const response = await openai.images.generate({
        model: "gpt-image-2",
        prompt,
        n: 1,
        size: size as any,
        quality: quality as any,
        moderation: "low",
      });

      console.log("GPT 画图完成", response.data?.[0]);

      // gpt-image-1 默认返回 b64_json
      if (response.data?.[0]?.b64_json) {
        const base64 = response.data[0].b64_json;
        const imgUrl = `data:image/png;base64,${base64}`;
        return [{ url: imgUrl }];
      }

      // 如果返回的是 url
      if (response.data?.[0]?.url) {
        return [{ url: response.data[0].url }];
      }

      return "生成图片失败：未获取到图片数据";
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

  /**
   * 运行cmd命令
   * @param userId 用户ID
   * @param groupId 群聊ID，私聊时为"private"
   * @param command 命令字符串
   * @returns 命令执行结果
   */
  exec: async ({
    userId,
    groupId,
    command,
  }: {
    userId: string;
    groupId: string;
    command: string;
  }) => {
    const workspace = getWorkspace(userId);

    if (commandTargetsAgentWorkspace(command || "")) {
      return [
        "exec 当前工作目录不是 public/{guid}/，不能可靠查找 AI agent 工作区里的项目。",
        `exec 当前默认工作目录: ${workspace}`,
        "如果要查找之前克隆到 public/{guid}/knowledge/ 的仓库，请改用 AgentListWorkspaces 先找 guid，再用 AgentListFiles 或 AgentSearchFiles。",
      ].join("\n");
    }

    // 使用新的环境管理获取执行环境
    const envInfo = await getExecCommandEnv(groupId || "private", userId);

    // 远程节点环境：通过 SSH 执行
    if (envInfo.type === "remote" && envInfo.nodeName) {
      try {
        const result = await remoteNodeManager.execute(
          envInfo.nodeName,
          command,
        );
        return result || "命令执行完成，无输出";
      } catch (err: any) {
        return `远程执行失败: ${err.message}`;
      }
    }

    // Singularity 容器环境：通过远程节点的 Singularity 执行
    if (envInfo.type === "singularity" && envInfo.nodeName) {
      try {
        const node = remoteNodeManager.getNode(envInfo.nodeName);
        if (!node) {
          return `未找到远程节点: ${envInfo.nodeName}`;
        }
        const image = envInfo.singularityImage || node.defaultImage;
        if (!image) {
          return "未指定 Singularity 镜像，请在切换环境时指定或配置 defaultImage";
        }
        // 构建 singularity exec 命令
        const singularityCmd = `singularity exec ${image} sh -c '${command.replace(/'/g, "'\''")}'`;
        const result = await remoteNodeManager.execute(
          envInfo.nodeName,
          singularityCmd,
        );
        return result || "命令执行完成，无输出";
      } catch (err: any) {
        return `Singularity 执行失败: ${err.message}`;
      }
    }

    // 系统环境：直接在宿主机执行
    if (envInfo.type === "system") {
      return new Promise((resolve) => {
        let output = "";
        const child = spawn("sh", ["-c", command], { cwd: workspace });
        child.stdout.on("data", (d: Buffer) => (output += d.toString()));
        child.stderr.on("data", (d: Buffer) => (output += d.toString()));
        child.on("error", (error: NodeJS.ErrnoException) => {
          resolve(`系统执行失败: ${error.message}`);
        });
        child.on("close", () => resolve(output));
      });
    }

    // 容器环境（group/user）：确保容器存在并启动，然后 docker exec
    const envConfig = await redisClient.getExecEnv(
      groupId || "private",
      userId,
    );
    const containerName = envConfig?.containerName;
    if (!containerName) {
      return "错误：未找到执行环境配置，请先切换执行环境";
    }

    try {
      await ensureContainerRunning(envConfig);
    } catch (err: any) {
      return `容器执行环境不可用: ${err.message}`;
    }

    return new Promise((resolve) => {
      let output = "";
      const args = ["exec"];
      if (envConfig.workspacePath) {
        args.push("-w", "/workspace");
      }
      args.push(containerName, "sh", "-c", command);
      const child = spawn("docker", args);
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      child.on("error", (error: NodeJS.ErrnoException) => {
        resolve(`Docker 执行失败: ${error.message}`);
      });
      child.on("close", () => resolve(output));
    });
  },

  AgentListWorkspaces: async ({
    includeKnowledge = true,
    maxResults = 50,
  }: {
    includeKnowledge?: boolean;
    maxResults?: number;
  }) => {
    try {
      const workspaces = listAgentWorkspaces(includeKnowledge, maxResults);
      return {
        success: true,
        count: workspaces.length,
        workspaces,
      };
    } catch (error) {
      return toToolError(error);
    }
  },

  AgentCreateWorkspace: async ({ guid }: { guid?: string }) => {
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
  }: {
    guid: string;
    command: string;
    workingDirectory?: string;
    reviewGuid?: string;
  }) => {
    try {
      const { relativePath } = resolveAgentPath(guid, workingDirectory);
      const review = await performProjectCommandReview({
        command,
        reviewGuid,
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
    timeoutSeconds = SERVER_COMMAND_DEFAULT_TIMEOUT_SECONDS,
  }: {
    command: string;
    workingDirectory?: string;
    reviewGuid: string;
    timeoutSeconds?: number;
  }) => {
    try {
      if (!reviewGuid?.trim()) {
        throw new Error("reviewGuid 必填，请传入当前群号");
      }
      const cwd = resolveServerWorkingDirectory(workingDirectory);
      const timeoutMs = normalizeServerCommandTimeoutMs(timeoutSeconds);
      const review = await performServerCommandReview({
        command,
        reviewGuid,
        workingDirectory: cwd,
      });
      if (!review.allowed) {
        return {
          success: false,
          command,
          workingDirectory: cwd,
          error: "服务器指令未通过 AI 自动审核",
          review,
        };
      }

      const result = await runServerShellCommand({
        command,
        cwd,
        timeoutMs,
      });
      return {
        success: result.exitCode === 0,
        command,
        workingDirectory: cwd,
        review,
        output: result.output,
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
};
