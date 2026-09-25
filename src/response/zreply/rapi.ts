import OpenAI from "openai";

type RapiRequestOptions = {
  client: OpenAI;
  params: any;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => Promise<void> | void;
};

const extractText = (content: any): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      return String(item?.text ?? item?.content ?? "");
    })
    .filter(Boolean)
    .join("\n");
};

const convertMessageContent = (content: any) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return extractText(content);

  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (item.type === "text" || item.type === "input_text") {
      return [{ type: "input_text", text: String(item.text || "") }];
    }
    if (item.type === "image_url" || item.type === "input_image") {
      const imageUrl = item.image_url?.url ?? item.image_url;
      if (!imageUrl) return [];
      return [
        {
          type: "input_image",
          detail: item.image_url?.detail ?? item.detail ?? "auto",
          image_url: String(imageUrl),
        },
      ];
    }
    return [];
  });
};

/** 把现有 CAPI 消息历史转换为 Responses API 的无状态 input。 */
export const convertCapiMessagesToRapiInput = (messages: any[]) => {
  const instructions: string[] = [];
  const input: any[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "");

    if (role === "system" || role === "developer") {
      const text = extractText(message.content);
      if (text) instructions.push(text);
      continue;
    }

    if (role === "tool") {
      const callId = String(message.tool_call_id || "").trim();
      if (!callId) continue;
      const convertedContent = convertMessageContent(message.content);
      input.push({
        type: "function_call_output",
        call_id: callId,
        output:
          typeof message.content === "string"
            ? message.content
            : "图片已转换，图片内容见下一条输入。",
      });
      if (Array.isArray(convertedContent) && convertedContent.length > 0) {
        input.push({ type: "message", role: "user", content: convertedContent });
      }
      continue;
    }

    if (role !== "user" && role !== "assistant") continue;

    // RAPI 返回的 reasoning/message/function_call 原始项必须在后续请求中原样带回，
    // 尤其是 reasoning 模型继续工具调用时，不能只保留兼容层生成的文本和 tool_calls。
    if (role === "assistant" && Array.isArray(message._rapiOutput)) {
      input.push(...message._rapiOutput);
      continue;
    }

    const convertedContent = convertMessageContent(message.content);
    const hasContent =
      typeof convertedContent === "string"
        ? convertedContent.trim() !== ""
        : convertedContent.length > 0;
    if (hasContent) {
      input.push({
        type: "message",
        role,
        content: convertedContent,
      });
    }

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const callId = String(toolCall?.id || "").trim();
        const name = String(toolCall?.function?.name || "").trim();
        if (!callId || !name) continue;
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments:
            typeof toolCall.function.arguments === "string"
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments ?? {}),
        });
      }
    }
  }

  return {
    instructions: instructions.join("\n\n"),
    input,
  };
};

const convertTools = (tools: any[] | undefined) =>
  Array.isArray(tools)
    ? tools.flatMap((tool) => {
        const definition = tool?.function;
        if (tool?.type !== "function" || !definition?.name) return [];
        return [
          {
            type: "function",
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters ?? {},
            strict: definition.strict ?? false,
          },
        ];
      })
    : undefined;

export const buildRapiRequest = (params: any) => {
  const converted = convertCapiMessagesToRapiInput(params.messages || []);
  const request: any = {
    model: params.model,
    instructions: converted.instructions || undefined,
    input: converted.input,
    include: [
      ...new Set([
        "reasoning.encrypted_content",
        ...(Array.isArray(params.builtinIncludes)
          ? params.builtinIncludes
          : []),
      ]),
    ],
    store: false,
  };

  const tools = [
    ...(convertTools(params.tools) ?? []),
    ...(Array.isArray(params.builtinTools) ? params.builtinTools : []),
  ];
  if (tools.length) {
    request.tools = tools;
    request.tool_choice = params.tool_choice ?? "auto";
  }
  if (typeof params.temperature === "number") {
    request.temperature = params.temperature;
  }
  if (typeof params.max_tokens === "number") {
    request.max_output_tokens = params.max_tokens;
  }
  if (params.reasoning && typeof params.reasoning === "object") {
    request.reasoning = params.reasoning;
  } else if (typeof params.reasoning_effort === "string") {
    request.reasoning = { effort: params.reasoning_effort };
  }
  if (params.thinking && typeof params.thinking === "object") {
    request.thinking = params.thinking;
  }

  return request;
};

/** 把 Responses API 输出归一化为现有 CAPI 工具循环使用的结构。 */
export const convertRapiResponseToCapi = (response: any) => {
  const output = Array.isArray(response?.output) ? response.output : [];
  const contentParts: string[] = [];
  const toolCalls: any[] = [];
  const sources = new Map<string, string>();

  const collectSource = (source: any) => {
    const url = String(source?.url || source?.uri || "").trim();
    if (!/^https?:\/\//i.test(url) || sources.has(url)) return;
    const title = String(source?.title || source?.name || url).trim();
    sources.set(url, title || url);
  };

  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && part.text) {
          contentParts.push(String(part.text));
          if (Array.isArray(part.annotations)) {
            for (const annotation of part.annotations) {
              collectSource(annotation?.url_citation ?? annotation);
            }
          }
        } else if (part?.type === "refusal" && part.refusal) {
          contentParts.push(String(part.refusal));
        }
      }
    } else if (item?.type === "web_search_call") {
      if (Array.isArray(item?.action?.sources)) {
        for (const source of item.action.sources) collectSource(source);
      }
    } else if (item?.type === "function_call" && item.name) {
      toolCalls.push({
        id: String(item.call_id || item.id || ""),
        type: "function",
        function: {
          name: String(item.name),
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }

  let content =
    contentParts.join("") ||
    (typeof response?.output_text === "string" ? response.output_text : "");
  const missingSources = [...sources.entries()]
    .filter(([url]) => !content.includes(url))
    .slice(0, 8);
  if (missingSources.length) {
    content += `\n\n参考来源：\n${missingSources
      .map(([url, title]) => `- ${title}: ${url}`)
      .join("\n")}`;
  }

  return {
    id: response?.id,
    usage: response?.usage,
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          _rapiOutput: output,
        },
      },
    ],
    rapiResponse: response,
  };
};

/** 独立的 Responses API 适配入口，对上层维持 CAPI 兼容返回值。 */
export const requestRapiCompletion = async ({
  client,
  params,
  signal,
  onTextDelta,
}: RapiRequestOptions) => {
  const request = buildRapiRequest(params);

  if (!onTextDelta) {
    const response = await client.responses.create(request, { signal });
    return convertRapiResponseToCapi(response);
  }

  const stream = (await client.responses.create(
    { ...request, stream: true },
    { signal },
  )) as any;
  let completedResponse: any = null;

  for await (const event of stream) {
    if (event?.type === "response.output_text.delta" && event.delta) {
      await onTextDelta(String(event.delta));
    } else if (event?.type === "response.completed") {
      completedResponse = event.response;
    } else if (event?.type === "response.failed") {
      const detail = event.response?.error?.message || "Responses API 请求失败";
      throw new Error(detail);
    }
  }

  if (!completedResponse) {
    throw new Error("Responses API 流结束时未返回完整响应");
  }
  return convertRapiResponseToCapi(completedResponse);
};
