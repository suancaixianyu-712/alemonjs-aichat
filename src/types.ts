import { type PublicEventMessageCreate } from "alemonjs";
export interface EventMessageCreate extends PublicEventMessageCreate {
  msg: string;
  user_id: string;
}

export interface AIChatConfig {
  searchApiKey: string;
  localBrowser?: {
    channel?: "chrome" | "msedge";
    executablePath?: string;
    headless?: boolean;
  };
  xaiImgProxy?: string;
  /** OpenAI 等 HTTPS 请求使用的本地 HTTP(S) 代理地址。 */
  httpProxy?: string;
  opencodeServer?: {
    port?: number;
    hostname?: string;
    binary?: string;
  };
  codexTool?: {
    binary?: string;
  };
  ttsServer: {
    host: string;
    defaultModel: string;
  };
}

export interface AIConfig {
  provider?: "deepseek" | "openai" | "grok" | "other";
  apiMode?: "capi" | "rapi";
  /** 该 AI 配置是否走 aichat.httpProxy。未配置时默认直连。 */
  useProxy?: boolean;
  builtinTools?: {
    /** 未配置时按 true 处理，以兼容旧配置。 */
    enabled?: boolean;
    /** 单项开关覆盖；键使用内置工具的规范名称。 */
    overrides?: Record<string, boolean>;
  };
  host: string;
  key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  systemPrompt: string;
}
