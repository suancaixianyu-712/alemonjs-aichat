import React from "react";
import { defineConfig } from "jsxp";
import Help from "@src/image/conponent/help";
import AiConfig from "@src/image/conponent/AiConfig";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  statics: join(__dirname, "src", "assets"),
  routes: {
    "/": {
      component: <Help />,
    },
    "/ai-config": {
      component: (
        <AiConfig
          switch={true}
          tools={true}
          complex={true}
          affection={true}
          tts={true}
          deep={false}
          model="gpt-4"
          prompt="你是一个友好的AI助手"
          atTrigger={false}
          currentAI="OpenAI"
          aiList={["OpenAI", "Claude", "Gemini"]}
          skillList={[
            { name: "use-alemon", description: "控制AI配置和框架开关" },
            { name: "send-media", description: "发送图片、音频和视频等媒体" },
          ]}
          toolList={{ 搜索工具: "0", 翻译工具: "1" }}
          toolPromptSwitch={true}
          toolPromptRevokeSwitch={false}
          toolPromptArgsSwitch={true}
          toolCallContentSwitch={false}
        />
      ),
    },
  },
});
