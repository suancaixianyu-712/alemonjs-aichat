/**
 * 子agent结果回传主对话：
 * - 完成：防抖合并后由主 AI 起一轮回复（系统消息注入报告），主对话忙时走 guidance 队列
 * - 失败/取消：notify 时只发一行短通知，并把记录写回主对话供后续参考
 * 空闲判断与开轮共用 CApiReply 内部的 acquireAIToolLoop（Redis NX 锁）：
 * 抢锁失败（用户消息同时到达）时改走 guidance，不会出现两轮并行或重复回复。
 */

export const SUB_AGENT_DELIVERY_DEBOUNCE_MS = 3000;
export const SUB_AGENT_REPORT_HISTORY_MAX = 2000;
const TRUNCATED_MARK = "\n…（报告过长已截断）";

export type SubAgentOrigin = {
  guid: string;
  platform?: string;
  spaceId?: string;
  userID: string;
  messageId?: string;
  isPrivate: boolean;
  isMaster: boolean;
};

export type DeliverableRecord = SubAgentOrigin & {
  id: string;
  task: string;
  status: "running" | "completed" | "failed" | "cancelled";
  notify: boolean;
  result?: string;
  error?: string;
};

/** 内部措辞：任务 ID、「整理给主对话即可」等，不能出现在给用户的回复里 */
const INTERNAL_PHRASES: RegExp[] = [
  /[（(]?\s*(task\s*id|taskID)?\s*[:：]?\s*sub_[a-z0-9]{4,}\s*[)）]?/gi,
  /(请|直接)?(整理|汇报|回传|转交|交给|反馈)(结果)?(给|到)?主(对话|AI|agent)(即可|就行|就好)?[。.!！]?/gi,
  /(后台)?子(任务|agent)报告/gi,
];

export const stripInternalPhrases = (text: string) => {
  let value = String(text || "");
  for (const pattern of INTERNAL_PHRASES) value = value.replace(pattern, "");
  return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

/** 写入历史前截断（≤ max 字符，含截断标记）；完整内容只保存在子agent记录里 */
export const truncateReport = (text: string, max = SUB_AGENT_REPORT_HISTORY_MAX) => {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - TRUNCATED_MARK.length)}${TRUNCATED_MARK}`;
};

const shortTask = (task: string, max = 40) => {
  const value = stripInternalPhrases(task).replace(/\s+/g, " ");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** 合并后的报告：系统消息，明确要求主 AI 总结后回复发起人 */
export const buildSubAgentReportMessage = (
  records: DeliverableRecord[],
  sanitize: (text: string, isMaster: boolean) => string = (t) => t,
) => {
  const sections = records.map((record, index) => {
    const body = sanitize(stripInternalPhrases(record.result || record.error || "（无内容）"), record.isMaster);
    return `${records.length > 1 ? `【结果${index + 1}】` : ""}任务：${shortTask(record.task, 200)}\n结果：\n${body}`;
  });
  const content = truncateReport(sections.join("\n\n"));
  return {
    role: "system" as const,
    content: [
      "[内部消息·后台任务结果] 以下是你之前派出的后台任务的执行结果，不是用户发言。",
      "请直接用简短自然的话把结果总结给发起这个任务的用户。",
      "回复里不要提及任务编号、子agent、内部报告或转交流程等内部措辞，只说结果本身。",
      "这是需要主动送达的完成结果，必须回复实际结论，不能输出 []、NO_ACTION 或只重复已派后台执行，也不能等待用户追问。",
      "",
      content,
    ].join("\n"),
  };
};

export const buildFailureNoticeText = (record: DeliverableRecord) =>
  `${record.status === "cancelled" ? "后台任务已取消" : "后台任务失败"}：${shortTask(record.task)}`;

/** 主 AI 回合使用的合成事件：严格绑定发起时的会话与用户 */
export const createSubAgentTurnEvent = (origin: SubAgentOrigin, systemMessage: { role: "system"; content: string }) => ({
  name: origin.isPrivate ? "private.message.create" : "message.create",
  guid: origin.guid,
  UserId: origin.userID,
  UserName: origin.userID,
  Platform: origin.platform,
  SpaceId: origin.spaceId,
  GroupName: origin.isPrivate ? "" : origin.spaceId,
  IsMaster: origin.isMaster,
  IsPrivate: origin.isPrivate,
  MessageId: origin.messageId,
  at: false,
  atBot: false,
  regexTriggered: true,
  subAgentReport: true,
  __allowedToolNames: [],
  __internalSystemMessage: systemMessage,
  msg: "后台任务结果",
  MessageText: "后台任务结果",
  raw_message: "",
  value: { raw_message: "", message: [] },
  bot: { nickname: "小咸鱼", user_id: "__sub_agent__" },
  botInfoFault: true,
});

export type DirectTarget = { isPrivate: boolean; userID: string; spaceId?: string; replyId?: string };

export type SubAgentDeliveryDeps = {
  /** 主 AI 回合（CApiReply），返回 busy 表示抢锁失败 */
  startTurn: (event: any, output: any) => Promise<{ busy?: boolean } | void | undefined>;
  getActiveTurn: (guid: string, platform?: string) => Promise<unknown>;
  addGuidance: (guid: string, data: any, platform?: string) => Promise<unknown>;
  addHistory: (guid: string, message: any) => Promise<unknown>;
  sendDirect: (target: DirectTarget, payload: any[]) => Promise<unknown>;
  text: (value: string) => any;
  mention: (userID: string) => any;
  sanitize?: (text: string, isMaster: boolean) => string;
  debounceMs?: number;
};

const originKey = (o: SubAgentOrigin) =>
  [o.platform || "default", o.guid, o.isPrivate ? "p" : o.spaceId || "", o.userID].join(":");

const outputText = (payload: any): string => {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return payload.map(outputText).join("\n");
  if (!payload || typeof payload !== "object") return "";
  return [payload.text, payload.value, payload.content, payload.format].map(outputText).filter(Boolean).join("\n");
};

/** 回到发起会话：群聊首条消息引用原消息并 @ 发起人，私聊直接发给发起人 */
export const createOriginOutput = (origin: SubAgentOrigin, deps: Pick<SubAgentDeliveryDeps, "sendDirect" | "mention" | "text">) => {
  let first = true;
  const send = async (data: any) => {
    const payload = Array.isArray(data) ? data : [data];
    if (origin.isPrivate) {
      return deps.sendDirect({ isPrivate: true, userID: origin.userID }, payload);
    }
    const target: DirectTarget = { isPrivate: false, userID: origin.userID, spaceId: origin.spaceId };
    if (first) {
      first = false;
      return deps.sendDirect(
        { ...target, replyId: origin.messageId },
        [deps.mention(origin.userID), ...payload],
      );
    }
    return deps.sendDirect(target, payload);
  };
  return {
    send,
    sendText: (value: string) => send([deps.text(value)]),
    sendToolResult: async () => undefined,
  };
};

export const createSubAgentDelivery = (deps: SubAgentDeliveryDeps) => {
  const debounceMs = deps.debounceMs ?? SUB_AGENT_DELIVERY_DEBOUNCE_MS;
  const pending = new Map<string, { records: DeliverableRecord[]; timer: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void }>();
  const chains = new Map<string, Promise<void>>();

  const flush = async (key: string) => {
    const batch = pending.get(key);
    if (!batch) return;
    pending.delete(key);
    const records = batch.records;
    const origin = records[0];
    const systemMessage = buildSubAgentReportMessage(records, deps.sanitize);
    const toGuidance = (alreadyDelivered = false) =>
      deps.addGuidance(
        origin.guid,
        { guidance: true, capiMessage: alreadyDelivered ? { ...systemMessage, content: `${systemMessage.content}\n这份结果已直接送达用户，本轮只在有新信息时补充，不要重复发送相同结果。` } : systemMessage, createdAt: Date.now(), previewText: "后台任务结果" },
        origin.platform,
      );
    const output = createOriginOutput(origin, deps);
    let sent = false;
    const send = async (payload: any) => {
      await output.send(payload);
      const text = outputText(payload).trim();
      if (text && !/^(?:\[\]|NO_ACTION)$/i.test(text) &&
          !/(?:已派|已交给|已转交|已安排|已提交).{0,12}(?:后台|子agent|子任务)/i.test(text)) sent = true;
    };
    const fallback = async () => {
      if (sent) return;
      const body = records.map((record) => (deps.sanitize ?? ((text: string) => text))(
        stripInternalPhrases(record.result || "任务已完成"), record.isMaster,
      )).join("\n\n");
      const content = truncateReport(body);
      await send([deps.text(content)]);
      sent = true;
      await deps.addHistory(origin.guid, { role: "assistant", content });
    };
    try {
      if (await deps.getActiveTurn(origin.guid, origin.platform)) {
        if (origin.isPrivate) await fallback();
        await toGuidance(origin.isPrivate);
        return;
      }
      const result = await deps.startTurn(
        createSubAgentTurnEvent(origin, systemMessage),
        { ...output, send, sendText: (text: string) => send([deps.text(text)]) },
      );
      // 空闲判断后、抢锁前有用户消息开了新回合：并入该回合，不另起一轮
      if (result && (result as any).busy) {
        if (origin.isPrivate) await fallback();
        await toGuidance(origin.isPrivate);
      }
      else await fallback();
    } catch {
      console.error("子agent结果回传主对话失败，尝试直接送达结果");
      await fallback().catch(() => console.error("子agent完成结果送达失败"));
    }
  };

  /** 同一发起会话串行执行，避免本进程两批结果同时抢锁 */
  const schedule = (key: string) => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => flush(key));
    chains.set(key, next);
    return next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  };

  const notifyFailure = async (record: DeliverableRecord) => {
    if (record.notify && (record.isPrivate ? record.userID : record.spaceId)) {
      await createOriginOutput(record, deps)
        .send([deps.text(buildFailureNoticeText(record))])
        .catch((error) => console.error("子agent失败通知发送失败：", error));
    }
    // 失败/取消只记一条系统记录，不触发主 AI 回复
    const note = buildSubAgentReportMessage([record], deps.sanitize);
    try {
      if (await deps.getActiveTurn(record.guid, record.platform)) {
        await deps.addGuidance(
          record.guid,
          { guidance: true, capiMessage: note, createdAt: Date.now(), previewText: buildFailureNoticeText(record) },
          record.platform,
        );
      } else {
        await deps.addHistory(record.guid, note);
      }
    } catch (error) {
      console.error("子agent失败记录写回失败：", error);
    }
  };

  return {
    /** 子agent结束时调用；返回的 Promise 在本批次处理完后 resolve（便于测试） */
    deliver: async (record: DeliverableRecord): Promise<void> => {
      if (record.status !== "completed") {
        await notifyFailure(record);
        return;
      }
      const key = originKey(record);
      let batch = pending.get(key);
      if (!batch) {
        let resolve!: () => void;
        const done = new Promise<void>((r) => (resolve = r));
        const timer = setTimeout(() => {
          void schedule(key).finally(() => resolve());
        }, debounceMs);
        batch = { records: [], timer, done, resolve };
        pending.set(key, batch);
      }
      batch.records.push(record);
      return batch.done;
    },
  };
};
