import { redis } from "../redis";
import { getConfigValue } from "alemonjs";
import fs from "fs";
import { uploadImageToR2 } from "../s3";
import { TTSClient } from "./tts";
import { ChatCompletionTool } from "openai/resources";
import { loadSkillDetail } from "./loadSkill";
import help from "@src/data/help.json";
import { redis as redisClient } from "../redis";
import { isPrivateIP, validateURL } from "./security";
import { spawn } from "child_process";
import * as dns from "node:dns/promises";
import path from "node:path";
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
      description: "AI修图工具",
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "需要修改的图片URL地址，必须是你所收到的图片地址",
          },
          instruction: {
            type: "string",
            description:
              "修改需求的文本描述，尽量详细和具体，例如：'请将图片中的人物换成一个穿着宇航服的宇航员，背景改成月球表面，保持其他元素不变'",
          },
        },
        required: ["instruction"],
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
        "执行终端命令. 你可以使用这个工具来执行一些简单的命令, 例如查看当前目录下的文件ls, 查看系统状态top等. 当你想要执行一个命令时, 请提供具体的命令文本, 例如'ls -la'或'top -n 1'. 执行结果将会返回给你, 但请注意, 由于安全限制, 某些命令可能无法执行或返回受限的结果",
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
              "要获取或修改的数据类型，例如'user'表示用户相关,获取或修改用户数据，'chatHistory'表示历史对话,历史对话只能获取不能修改",
            enum: ["user", "chatHistory"],
          },
          data: {
            type: "string",
            description:
              "要获取或修改的数据内容, 例如当operation为'set'时,dataType为'user'时, data应该是要存储的数据内容, 例如用户喜欢的颜色是蓝色, 则data可以是'favoriteColor:blue', 当operation为'get'时, dataType为'user'时, data就不需要传入值, 它会返回之前存储的数据, 当operation为'get'时, dataType为'chatHistory'时, data不传入值获取摘要列表, 传入id获取对应的摘要详情",
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

/**
 * 确保 Docker 容器已创建并运行
 */
async function ensureContainerRunning(config: Record<string, any>): Promise<void> {
  const { containerName, image, memory, cpus, pidsLimit, networkMode } = config;
  if (!containerName) return;

  return new Promise((resolve) => {
    // 检查容器是否存在
    const check = spawn("docker", ["inspect", "-f", "{{.State.Running}}", containerName]);
    let stdout = "";
    let stderr = "";
    check.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    check.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    check.on("close", (code: number) => {
      if (code === 0 && stdout.trim() === "true") {
        // 容器已在运行
        resolve();
        return;
      }

      if (code === 0 && stdout.trim() === "false") {
        // 容器存在但未运行，启动它
        const start = spawn("docker", ["start", containerName]);
        start.on("close", () => resolve());
        return;
      }

      // 容器不存在，创建并启动
      const args = [
        "run", "-d",
        "--name", containerName,
        "--memory", memory || "256m",
        "--cpus", cpus || "0.5",
        "--pids-limit", String(pidsLimit || 64),
        "--network", networkMode || "none",
        image || "ubuntu:latest",
        "sleep", "infinity",
      ];
      const create = spawn("docker", args);
      create.on("close", () => resolve());
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
        // 从redis获取聊天历史, key为chatHistory:${userID}
        const [guid, id] = data?.split(":") || [];
        if (guid && id) {
          const chatHistory = await redisClient.getSummaryDetail(guid, id);
          return { success: true, data: chatHistory };
        } else {
          const summaryList = await redisClient.getSummaryList();
          return { success: true, data: summaryList };
        }
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
  exec: async ({ userId, groupId, command }: { userId: string; groupId: string; command: string }) => {
    const workspace = getWorkspace(userId);
    
    // 使用新的环境管理获取执行环境
    const envInfo = await getExecCommandEnv(groupId || "private", userId);
    
    // 远程节点环境：通过 SSH 执行
    if (envInfo.type === "remote" && envInfo.nodeName) {
      try {
        const result = await remoteNodeManager.execute(envInfo.nodeName, command);
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
        const result = await remoteNodeManager.execute(envInfo.nodeName, singularityCmd);
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
        child.on("close", () => resolve(output));
      });
    }

    // 容器环境（group/user）：确保容器存在并启动，然后 docker exec
    const envConfig = await redisClient.getExecEnv(groupId || "private", userId);
    const containerName = envConfig?.containerName;
    if (!containerName) {
      return "错误：未找到执行环境配置，请先切换执行环境";
    }

    // 确保容器已创建并启动
    await ensureContainerRunning(envConfig);

    return new Promise((resolve) => {
      let output = "";
      const child = spawn("docker", [
        "exec",
        containerName,
        "sh",
        "-c",
        command,
      ]);
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      child.on("close", () => resolve(output));
    });
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
