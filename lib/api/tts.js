import { redis } from '../redis.js';
import ttsmodels from '../data/ttsmodels.json.js';
import { getAiChatConfigValue } from '../config/app.js';

const value = getAiChatConfigValue();
class TTSClient {
    host;
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
    async installModel(modelname) {
        // 遍历ttsmodels,查找model对应的下载链接,模糊匹配
        const matchedModel = ttsmodels.find((m) => {
            return m.models.find((md) => md.modelname.includes(modelname));
        });
        if (!matchedModel) {
            return { success: false, message: "未找到对应的模型" };
        }
        const modelInfo = matchedModel.models.find((md) => md.modelname.includes(modelname));
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
    async setModel(model, emotion) {
        const models = await this.getModels("v4");
        if (!models) {
            return null;
        }
        let modelInfo = await redis.get("chat:tts:modelInfo");
        if (!modelInfo) {
            modelInfo = {
                version: "v4",
                model_name: "",
                prompt_text_lang: "中文",
                emotion: emotion ?? "默认",
                text_lang: "中文",
            };
        }
        else {
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
        modelInfo.model_name = matchedModel;
        modelInfo.prompt_text_lang = Object.keys(models[matchedModel])[0];
        modelInfo.emotion =
            emotion || models[matchedModel][modelInfo.prompt_text_lang][0];
        modelInfo.text_lang = modelInfo.prompt_text_lang;
        await redis.set("chat:tts:modelInfo", JSON.stringify(modelInfo));
        return matchedModel;
    }
    async getAudio(text) {
        let modelInfo = await redis.get("chat:tts:modelInfo");
        if (!modelInfo) {
            modelInfo = {
                version: "v4",
                model_name: "原神-中文-芙宁娜_ZH",
                prompt_text_lang: "中文",
                emotion: "默认",
                text_lang: "中文",
            };
        }
        else {
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

export { TTSClient };
