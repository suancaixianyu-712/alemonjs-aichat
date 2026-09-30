import { useMessage as useMessage$1 } from 'alemonjs';
import { uploadImageToR2 } from '../s3.js';

const COMMAND_OUTPUT_CAPTURE = "__alemonCommandOutputCapture";
const getFormatItems = (payload) => {
    if (Array.isArray(payload))
        return payload;
    if (Array.isArray(payload?.format))
        return payload.format;
    if (Array.isArray(payload?.format?.value))
        return payload.format.value;
    if (Array.isArray(payload?.value))
        return payload.value;
    return payload ? [payload] : [];
};
/**
 * 指令通过 AI 工具调用时，捕获处理器发送的消息。默认不向用户发送；
 * sendToUser=true 时在捕获的同时保留原发送行为。
 */
const useMessage = (event) => {
    const [message] = useMessage$1(event);
    const capture = event?.[COMMAND_OUTPUT_CAPTURE];
    if (!capture)
        return [message];
    return [
        {
            ...message,
            send: async (payload) => {
                capture.payloads.push(...getFormatItems(payload));
                if (capture.sendToUser)
                    return message.send(payload);
                return [
                    {
                        code: 2000,
                        message: "Captured command output",
                        data: { message_id: `command-capture-${Date.now()}` },
                    },
                ];
            },
            delete: async (params) => {
                if (String(params?.messageId || "").startsWith("command-capture-")) {
                    return { code: 2000, message: "Captured message deleted", data: null };
                }
                return message.delete(params);
            },
        },
    ];
};
const isProbablyBase64 = (value) => value.length >= 128 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const resolveImageUrl = async (value, uploadImage) => {
    if (Buffer.isBuffer(value)) {
        return uploadImage(value.toString("base64"));
    }
    const source = String(value || "").trim();
    if (!source)
        throw new Error("图片内容为空");
    if (/^https?:\/\//i.test(source))
        return source;
    if (source.startsWith("base64://")) {
        return uploadImage(source.slice("base64://".length));
    }
    if (/^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(source)) {
        return uploadImage(source);
    }
    if (isProbablyBase64(source))
        return uploadImage(source);
    // 本地图片同样转成 AI 可以读取的公网链接。
    return uploadImage(source);
};
const resolveCommandOutput = async (capture, uploadImage = uploadImageToR2) => {
    const output = {
        text: [],
        images: [],
        other: [],
        conversionErrors: [],
    };
    const visit = async (item) => {
        if (!item)
            return;
        if (Array.isArray(item)) {
            for (const child of item)
                await visit(child);
            return;
        }
        const type = String(item.type || "unknown");
        const normalizedType = type.toLowerCase();
        if (normalizedType === "text" ||
            normalizedType === "md.text" ||
            normalizedType === "md.content" ||
            normalizedType === "md.title" ||
            normalizedType === "md.subtitle" ||
            normalizedType === "md.bold" ||
            normalizedType === "md.italic" ||
            normalizedType === "md.italicstar" ||
            normalizedType === "md.strikethrough" ||
            normalizedType === "md.blockquote" ||
            normalizedType === "md.code") {
            const text = String(item.value ?? "").trim();
            if (text)
                output.text.push(text);
            return;
        }
        if (normalizedType === "image" ||
            normalizedType === "imageurl" ||
            normalizedType === "imagefile" ||
            normalizedType === "md.image") {
            try {
                output.images.push(await resolveImageUrl(item.value, uploadImage));
            }
            catch (error) {
                output.conversionErrors.push(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        if (normalizedType === "markdown" ||
            normalizedType === "bt.group" ||
            normalizedType === "bt.row") {
            await visit(item.value);
            return;
        }
        output.other.push({ type, value: item.value ?? null });
    };
    for (const payload of capture.payloads)
        await visit(payload);
    output.text = [...new Set(output.text)];
    output.images = [...new Set(output.images)];
    return output;
};

export { COMMAND_OUTPUT_CAPTURE, resolveCommandOutput, useMessage };
