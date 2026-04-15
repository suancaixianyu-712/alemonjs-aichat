import { Events, Format, useMessage } from "alemonjs";
import OpenAi from "openai";
import { getChatConfig, shouldSkipAIReply } from "./getChatConfig";

const Session = {};

export const RApiReply = async (
  e: Events["message.create"] | Events["private.message.create"],
) => {
  const cfg = await getChatConfig(e);
  if (await shouldSkipAIReply(e)) {
    return {
      next: true,
    };
  }

  const [message] = useMessage();
  const format = Format.create();

  try {
    const openai = new OpenAi({
      baseURL: cfg.config.host,
      apiKey: cfg.config.key,
      timeout: 300000,
    });
    const response = await openai.responses.create({
      model: cfg.config.model,
      input: e.msg,
      stream: true,
    });

    let fullText = "";
    for await (const event of response) {
      if (event.type === "response.output_text.delta") {
        fullText += event.delta;
        format.addText(event.delta);
      }
    }

    console.log("fullText", fullText);
    message.send({ format });
  } catch (error) {
    console.error("Error occurred:", error);
  }
};
