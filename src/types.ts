import { type PublicEventMessageCreate } from "alemonjs";
export interface EventMessageCreate extends PublicEventMessageCreate {
  msg: string;
  user_id: string;
}

export interface AIChatConfig {
  searchApiKey: string;
  xaiImgProxy?: string;
  ttsServer: {
    host: string;
    defaultModel: string;
  };
  redis?: {
    host: string;
    port: number;
    password: string;
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
