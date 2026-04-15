import { TTSClient } from "@src/api/tts";
import { uploadMediaToR2 } from "@src/s3";

export async function createTTSMessage(
  message: any,
  ttsClient: TTSClient,
  modelAndEmotion: string,
): Promise<string> {
  const [model, emotion] = modelAndEmotion.split("-");
  await ttsClient.setModel(model || "派蒙", emotion || "默认");
  // 发送TTS语音
  return ttsClient.getAudio(message).then(async (audio) => {
    console.log("audio", audio);
    if (audio) {
      // 先判断是否为网络地址（包含协议如 http://, https://, ws:// 等）
      if (audio.audio_url.includes("://")) {
        // 检查是否为本地IP或局域网地址
        const isLocalIP =
          /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|localhost|0\.0\.0\.0)/i.test(
            audio.audio_url,
          );
        if (isLocalIP) {
          const url = await uploadMediaToR2(audio.audio_url);
          return url;
        }
        return audio.audio_url;
      }
      // 非网络地址，上传到R2
      const url = await uploadMediaToR2(audio.audio_url);
      return url;
    }
    return "";
  });
}
