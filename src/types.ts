import { type PublicEventMessageCreate } from "alemonjs";
export interface EventMessageCreate extends PublicEventMessageCreate {
  msg: string;
  user_id: string;
}

export interface ContainerConfig {
  image: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  networkMode?: string;
  [key: string]: any;
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
  superAdmin?: string[];
  groupContainer?: ContainerConfig;
  userContainer?: ContainerConfig;
}

export interface AIConfig {
  host: string;
  key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  systemPrompt: string;
  rapi: boolean;
}
