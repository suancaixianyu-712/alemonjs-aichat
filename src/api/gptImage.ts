import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type GPTImageRequestMode = "image" | "responses";

type GPTImageResponsesRequestOptions = {
  chatModel: string;
  imageModel: string;
  prompt: string;
  sourceImageUrl?: string;
  size: string;
  quality: string;
};

type Base64ImageFormat = "png" | "jpg";

/** 将图片接口返回的无前缀 Base64 保存到统一的图片输出目录。 */
export const saveBase64Image = (
  base64: string,
  format: Base64ImageFormat = "png",
  outputDir = "./public/image_out",
) => {
  fs.mkdirSync(outputDir, { recursive: true });
  const savePath = path.join(
    outputDir,
    `${Date.now()}-${randomUUID()}.${format}`,
  );
  fs.writeFileSync(savePath, Buffer.from(base64, "base64"));
  return savePath;
};

/** 兼容 Grok 图片接口的 URL 旧格式与 b64_json 新格式。 */
export const normalizeGrokImageData = (
  data: unknown,
  outputDir = "./public/image_out",
) => {
  if (!Array.isArray(data)) return data;

  return data.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.b64_json !== "string" ||
      !item.b64_json.trim()
    ) {
      return item;
    }

    const { b64_json, ...rest } = item;
    return {
      ...rest,
      type: "image",
      url: saveBase64Image(b64_json, "jpg", outputDir),
    };
  });
};

/** 构造 Responses API 的内置画图工具请求。 */
export const buildGPTImageResponsesRequest = ({
  chatModel,
  imageModel,
  prompt,
  sourceImageUrl,
  size,
  quality,
}: GPTImageResponsesRequestOptions) => ({
  model: chatModel,
  input: sourceImageUrl
    ? [
        {
          role: "user" as const,
          content: [
            { type: "input_text" as const, text: prompt },
            {
              type: "input_image" as const,
              image_url: sourceImageUrl,
              detail: "high" as const,
            },
          ],
        },
      ]
    : prompt,
  tools: [
    {
      type: "image_generation" as const,
      model: imageModel,
      action: sourceImageUrl ? ("edit" as const) : ("generate" as const),
      size,
      quality,
      moderation: "low" as const,
    },
  ],
  tool_choice: { type: "image_generation" as const },
});

/** 提取 Responses API image_generation_call 返回的 Base64 图片。 */
export const extractGPTImageResponseBase64 = (response: any) => {
  const output = Array.isArray(response?.output) ? response.output : [];
  const imageCall = output.find(
    (item: any) =>
      item?.type === "image_generation_call" &&
      typeof item.result === "string" &&
      item.result.length > 0,
  );
  return imageCall?.result as string | undefined;
};

const getErrorMessage = (error: any) =>
  String(error?.error?.message || error?.message || error || "未知错误");

/** 仅在当前协议端点/能力确实不可用时，才尝试另一种画图协议。 */
export const shouldFallbackGPTImageMode = (error: any) => {
  const message = getErrorMessage(error).toLowerCase();
  if (/model.+(does not exist|not found|unknown)/i.test(message)) return false;
  if (/organization.+verif|verify.+organization/i.test(message)) return false;

  const status = Number(error?.status || error?.response?.status || 0);
  if ([404, 405, 501].includes(status)) return true;

  return (
    /unsupported endpoint|unknown endpoint|endpoint.+not (found|supported)/i.test(
      message,
    ) ||
    /(image_generation|image generation).+(not supported|unsupported|unavailable)/i.test(
      message,
    )
  );
};

/** 将常见权限和模型错误转换为聊天里可直接操作的提示。 */
export const formatGPTImageError = (error: any, model: string) => {
  const message = getErrorMessage(error);
  if (/organization.+verif|verify.+organization/i.test(message)) {
    return (
      `模型 ${model} 已被接口识别，但当前 API Key 所属组织尚未通过图片模型验证。` +
      "请在 https://platform.openai.com/settings/organization/general 完成 Verify Organization，" +
      "或改用已有 GPT 图片权限的 AI 配置；验证后通常需要等待一段时间生效。"
    );
  }
  if (/model.+(does not exist|not found|unknown)/i.test(message)) {
    return (
      `当前接口不提供画图模型 ${model}。` +
      "请用 #gpt画图配置 <AI配置编号> <该接口实际支持的图片模型> 重新配置。"
    );
  }
  return message;
};
