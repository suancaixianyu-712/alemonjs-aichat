import { redis } from "../redis";
import { getConfigValue } from "alemonjs";
import fs from "fs";
import { uploadImageToR2 } from "../s3";
import { TTSClient } from "./tts";
import { ChatCompletionTool } from "openai/resources";
import { loadSkillDetail } from "./loadSkill";

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
      name: "RunCommand",
      description:
        "执行终端命令, 请勿执行高危险性指令, 例如rm -rf /等, 否则可能会导致服务器数据丢失或系统崩溃. 你可以使用这个工具来执行一些简单的命令, 例如查看当前目录下的文件ls, 查看系统状态top等. 当你想要执行一个命令时, 请提供具体的命令文本, 例如'ls -la'或'top -n 1'. 执行结果将会返回给你, 但请注意, 由于安全限制, 某些命令可能无法执行或返回受限的结果",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的终端命令",
          },
        },
        required: ["command"],
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
];

export const availableTools = {
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
   * 获取 ollama 模型列表
   * @returns ollama 模型列表
   */
  OllamaListModels: async () => {
    const res = await fetch("http://localhost:11434/v1/models");
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return data.data;
  },

  /**
   * 安装 ollama 模型
   * @param modelName 模型名称
   * @returns 安装结果
   */
  OllamaInstallModel: async (modelName: string) => {
    try {
      const res = await fetch("http://localhost:11434/v1/models", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.log(err);
        return { success: false, error: err };
      }
      const data = await res.json();
      console.log("安装结果", data);
      return { success: true };
    } catch (error) {
      console.error("Error installing Ollama model:", error);
      return { success: false, error: error };
    }
  },

  /**
   * 运行cmd命令
   * @param command 命令字符串
   * @returns 命令执行结果
   */
  RunCommand: async ({ command }) => {
    const { exec } = await import("child_process");
    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error executing command: ${error}`);
          resolve(`Error: ${error.message}`);
          return;
        }
        if (stderr) {
          console.error(`Command stderr: ${stderr}`);
          resolve(`Error: ${stderr}`);
          return;
        }
        console.log(`Command stdout: ${stdout}`);
        resolve(stdout);
      });
    });
  },

  getSKILLDetail: async ({ skillName }) => {
    const skill = loadSkillDetail(skillName);
    return skill;
  },
};
