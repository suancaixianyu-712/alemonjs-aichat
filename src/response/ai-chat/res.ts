import { Mention, Text, useMessage } from "alemonjs";
import redisClient from "@src/config";
import { CApiReply } from "@src/response/zreply/capi";
import {
  buildUserMessage,
  getChatConfig,
} from "@src/response/zreply/getChatConfig";
import { toolSessionController } from "@src/api/tool-session-controller";

const selects = onSelects(["message.create", "private.message.create"]);

type QueuedAITurnChain = {
  tail: Promise<void>;
  count: number;
};

const queuedAITurnChains = new Map<string, QueuedAITurnChain>();
const waitForQueueRetry = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 300));

const getAITurnQueueKey = (event: any) =>
  `${event.guid}:${event.Platform || "default"}`;

const enqueueIndependentAITurn = (
  event: any,
  outputMessage: any,
): { position: number; completed: Promise<void> } => {
  const key = getAITurnQueueKey(event);
  let chain = queuedAITurnChains.get(key);
  if (!chain) {
    chain = { tail: Promise.resolve(), count: 0 };
    queuedAITurnChains.set(key, chain);
  }

  chain.count += 1;
  const position = chain.count;
  const run = chain.tail
    .catch(() => undefined)
    .then(async () => {
      while (true) {
        const active = await redisClient.getAIToolLoopState(
          event.guid,
          event.Platform,
        );
        if (active) {
          await waitForQueueRetry();
          continue;
        }

        const result = await CApiReply(event, outputMessage);
        if (!result?.busy) {
          if (result) event["Xianyu"] = result.next;
          return;
        }
        await waitForQueueRetry();
      }
    });

  const completed = run.finally(() => {
    chain!.count -= 1;
    if (chain!.count === 0 && queuedAITurnChains.get(key) === chain) {
      queuedAITurnChains.delete(key);
    }
  });
  chain.tail = completed;
  return { position, completed };
};

const prependGuidancePrefix = (message: any) => ({
  ...message,
  guidance: true,
  content: Array.isArray(message?.content)
    ? message.content.map((item: any) => {
        if (item?.type === "text") {
          return {
            ...item,
            text:
              "[补充引导] 工具调用期间用户追加了新的消息，请结合这条消息调整后续工具调用和最终回复。\n" +
              item.text,
          };
        }
        return item;
      })
    : message?.content,
});

const buildGuidanceMessage = async (event: any) => {
  const cfg = await getChatConfig(event);
  const capiMessage = prependGuidancePrefix(await buildUserMessage(event, cfg));

  return {
    guidance: true,
    capiMessage,
    createdAt: Date.now(),
    previewText: event.msg || "",
  };
};

const canPassReplyTriggerGate = async (event: any) => {
  if (
    event.UserId == event.bot?.user_id ||
    !event.msg ||
    event.msg.startsWith("/") ||
    event.msg.startsWith("#")
  ) {
    return false;
  }

  // 聊天频率限制（每分钟最多 N 条，主人除外）
  if (event.IsMaster !== true) {
    const chatRateLimit = await redisClient.getChatRateLimit(event.guid);
    const allowed = await redisClient.checkChatRateLimit(
      event.guid,
      String(event.UserId || ""),
      chatRateLimit,
    );
    if (!allowed) {
      event["rateLimited"] = true;
      return false;
    }
  }

  if (event["nextUserMessageSubscriptionTriggered"]) {
    return true;
  }

  const aiConfig = await redisClient.getAIConfig(event.guid);
  if (
    !aiConfig ||
    aiConfig.host.trim() === "" ||
    aiConfig.key.trim() === "" ||
    aiConfig.model.trim() === ""
  ) {
    return false;
  }

  if (event.name !== "private.message.create") {
    const subscriptionTriggered =
      await redisClient.consumeNextUserMessageSubscription(
        event.guid,
        String(event.UserId || ""),
        event.Platform,
      );
    if (subscriptionTriggered) {
      event["nextUserMessageSubscriptionTriggered"] = true;
      return true;
    }
  }

  const atTriggerSwitch = await redisClient.getAtTriggerSwitch(
    event.ChannelId ?? event.UserId,
  );
  if (atTriggerSwitch === "1" && event.Platform !== "testone") {
    if (!event["atBot"] && event.name !== "private.message.create") {
      const regexMatched = await redisClient.matchRegexRule(
        event.ChannelId ?? event.UserId,
        event.msg || "",
      );
      if (regexMatched) {
        event["regexTriggered"] = true;
        return true;
      }
      return false;
    }
  }

  return true;
};

export default onResponse(selects, async (event, next) => {
  const [toolMessage] = useMessage(event);
  try {
    const handledByThirdPartyTool = await toolSessionController.handleMessage(
      event,
      (text) => toolMessage.send(format(Text(text))),
    );
    if (handledByThirdPartyTool) {
      event["Xianyu"] = false;
      return next();
    }
  } catch (error) {
    await toolMessage.send(
      format(
        Text(
          `第三方工具处理失败：${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    );
    event["Xianyu"] = false;
    return next();
  }

  const toolLoopState = await redisClient.getAIToolLoopState(
    event.guid,
    event.Platform,
  );
  const currentUserID = String(event.UserId || "");
  const shouldReply = await canPassReplyTriggerGate(event);
  const queueKey = getAITurnQueueKey(event);
  const hasQueuedTurns = queuedAITurnChains.has(queueKey);

  const belongsToActiveTurn =
    toolLoopState?.userID && toolLoopState.userID === currentUserID;
  if (
    shouldReply &&
    ((toolLoopState && !belongsToActiveTurn) ||
      (!toolLoopState && hasQueuedTurns))
  ) {
    const [message] = useMessage(event);
    const queued = enqueueIndependentAITurn(event, message);
    await message.send(
      format(
        Mention(event.UserId),
        Text(
          `当前任务正在执行，你的消息已加入队列（第 ${queued.position} 位）。`,
        ),
      ),
    );
    event["Xianyu"] = false;
    await queued.completed;
    return next();
  }

  const toolLoopProcessing = Boolean(toolLoopState);

  if (toolLoopProcessing && shouldReply) {
    const guidanceMessage = await buildGuidanceMessage(event);
    const queue = await redisClient.addAIGuidanceMessage(
      event.guid,
      guidanceMessage,
      event.Platform,
    );
    if (queue.length === 1) {
      const [message] = useMessage(event);
      await message.send(
        format(Text("已收到新的补充消息，等当前工具调用完成后会一并处理。")),
      );
    }
    event["Xianyu"] = false;
    return next();
  }

  if (!shouldReply) {
    event["Xianyu"] = false;
    return next();
  }

  const aiconfig = await redisClient.getAIConfig(event.guid);
  if (aiconfig?.model && aiconfig.key) {
    const replyResult = await CApiReply(event);
    console.log("res", replyResult);
    if (replyResult) {
      event["Xianyu"] = replyResult.next;
    }
  }

  return next();
});
