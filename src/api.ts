import { redis } from "./redis";
import { getConfigValue } from "alemonjs";
import fs from "fs";
import { uploadImageToR2 } from "./s3";
import ttsmodels from "@src/data/ttsmodels.json";
const value = getConfigValue();

export const getTimeString = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
};

type modelInfoType =
  | string
  | null
  | {
      version: "v4";
      model_name: string;
      prompt_text_lang: string;
      emotion: string;
      text_lang: string;
    };

export class TTSClient {
  host: string;
  constructor() {
    this.host = value.ttsServer?.host || "http://localhost:8000";
  }

  async getModels(version = "v4") {
    const res = await fetch(`${this.host}/models/${version}`);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return data.models;
  }

  async installModel(modelname: string) {
    // 遍历ttsmodels,查找model对应的下载链接,模糊匹配
    const matchedModel = ttsmodels.find((m) => {
      return m.models.find((md) => md.modelname.includes(modelname));
    });
    if (!matchedModel) {
      return { success: false, message: "未找到对应的模型" };
    }
    const modelInfo = matchedModel.models.find((md) =>
      md.modelname.includes(modelname),
    );
    if (!modelInfo) {
      return { success: false, message: "未找到对应的模型" };
    }

    // console.log("matchedModel", matchedModel);
    console.log("modelInfo", modelInfo);

    // 在这里实现模型安装逻辑

    const res = await fetch(`${this.host}/install_model`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: matchedModel.category,
        dl_url: modelInfo.dl_link,
        language: matchedModel.lang,
        model_name: modelInfo.modelname,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = await res.text();
      console.log(err);
      return { success: false, message: "模型安装失败: " + err };
    }
    return { success: true, message: data.msg };
  }

  async setModel(model: string, emotion?: string) {
    const models = await this.getModels("v4");
    if (!models) {
      return null;
    }
    let modelInfo: modelInfoType = await redis.get("chat:tts:modelInfo");
    if (!modelInfo) {
      modelInfo = {
        version: "v4",
        model_name: "",
        prompt_text_lang: "中文",
        emotion: emotion ?? "默认",
        text_lang: "中文",
      };
    } else {
      modelInfo = JSON.parse(modelInfo);
    }

    // model可能只包含模型名称的一部分,需要模糊匹配
    const matchedModel = Object.keys(models).find((m) => m.includes(model));
    if (!matchedModel) {
      return null;
    }
    if (!modelInfo || typeof modelInfo === "string") {
      return null;
    }
    modelInfo.model_name = matchedModel as string;
    modelInfo.prompt_text_lang = Object.keys(models[matchedModel as string])[0];
    modelInfo.emotion =
      emotion || models[matchedModel as string][modelInfo.prompt_text_lang][0];
    modelInfo.text_lang = modelInfo.prompt_text_lang;
    await redis.set("chat:tts:modelInfo", JSON.stringify(modelInfo));
    return matchedModel;
  }

  async getAudio(text) {
    let modelInfo: modelInfoType = await redis.get("chat:tts:modelInfo");
    if (!modelInfo) {
      modelInfo = {
        version: "v4",
        model_name: "原神-中文-芙宁娜_ZH",
        prompt_text_lang: "中文",
        emotion: "默认",
        text_lang: "中文",
      };
    } else {
      modelInfo = JSON.parse(modelInfo);
    }

    if (!modelInfo || typeof modelInfo === "string") {
      return null;
    }
    console.log("modelInfo", modelInfo);

    const res = await fetch(`${this.host}/infer_single`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dl_url: this.host,
        version: modelInfo.version,
        model_name: modelInfo.model_name,
        prompt_text_lang: modelInfo.prompt_text_lang,
        emotion: modelInfo.emotion,
        text: text,
        text_lang: modelInfo.text_lang,
        top_k: 10,
        top_p: 1,
        temperature: 1,
        text_split_method: "按标点符号切",
        batch_size: 1,
        batch_threshold: 0.75,
        split_bucket: true,
        speed_facter: 1,
        fragment_interval: 0.3,
        media_type: "wav",
        parallel_infer: true,
        repetition_penalty: 1.35,
        seed: -1,
        sample_steps: 16,
        if_sr: false,
      }),
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return data;
  }
}

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
};
