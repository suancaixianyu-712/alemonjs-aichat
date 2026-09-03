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
  opencodeServer?: {
    port?: number;
    hostname?: string;
    binary?: string;
  };
  ttsServer: {
    host: string;
    defaultModel: string;
  };
}

export interface AIConfig {
  host: string;
  key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  systemPrompt: string;
}
