import React from "react";
import type { AIConfig } from "@src/types";
import type { PanelChatMessage } from "@src/panel/chat";
import {
  panelGroupSwitchDefinitions,
  type PanelGroupConfigDraft,
} from "@src/panel/groupConfig";

type PanelPage = "config" | "chat";
type AIConfigDraft = Pick<AIConfig, "host" | "key" | "model" | "rapi"> & {
  name: string;
};

type PromptOption = {
  name: string;
  content: string;
};

type PanelPreviewProps = {
  page?: PanelPage;
  aiConfigs?: AIConfigDraft[];
  groupConfigs?: PanelGroupConfigDraft[];
  currentAI?: string;
  currentGuid?: string;
  redisError?: string;
  panelStatus?: string;
  panelMessage?: string;
  restoreGroupListOpen?: boolean;
  restoreOpenGroups?: string[];
  restoreAiListOpen?: boolean;
  restoreOpenRows?: string[];
  restoreScrollY?: number;
  chatGuid?: string;
  chatUserId?: string;
  chatNickname?: string;
  chatBotId?: string;
  chatMode?: "capi" | "rapi";
  chatModel?: string;
  groupGuidOptions?: string[];
  workspaceNames?: string[];
  promptOptions?: PromptOption[];
  currentPrompt?: string;
  chatMessages?: PanelChatMessage[];
  currentGroupConfig?: PanelGroupConfigDraft | null;
  chatConfigOpen?: boolean;
};

const configValue = `app:
  - alemonjs-aichat

master_id:
  - "3501869534"

ai:
  current: OpenAI
  capiContextLimit: 256k

features:
  chat: true
  tools: true
  onlyAt: false
  toolCallContent: false
  affection: true
  tts: false
`;

const countEnabledGroupSwitches = (group: PanelGroupConfigDraft) =>
  panelGroupSwitchDefinitions.filter((item) => group.switches[item.key]).length;

const createRedisPreview = (
  items: AIConfigDraft[],
  currentAI?: string,
  redisError?: string,
) => {
  if (redisError) {
    return `# AI列表来自 Redis, 但当前读取失败
# ${redisError}
keys ai:list:*

ai:currentAI:{guid} = 当前会话选中的 AI 名称
ai:config:{guid} = 当前会话实际使用的 AIConfig
`;
  }

  const listPreview = items.length
    ? items
        .map(
          (item) => `ai:list:${item.name} = {
  "host": "${item.host}",
  "key": "${item.key}",
  "model": "${item.model}",
  "temperature": 0.7,
  "max_tokens": 4096,
  "systemPrompt": "",
  "rapi": ${item.rapi}
}`,
        )
        .join("\n\n")
    : "# 当前 Redis 中没有 ai:list:*";

  return `# AI列表来自 Redis, 不是配置文件
keys ai:list:*

${listPreview}

ai:currentAI:{guid} = "${currentAI || "按会话记录"}"
ai:config:{guid} = 当前会话实际使用的 AIConfig
`;
};

const renderNav = (page: PanelPage) => (
  <nav className="nav" aria-label="面板导航">
    <a
      className={`nav-link ${page === "config" ? "active" : ""}`}
      href="/panel/config"
    >
      配置
    </a>
    <a
      className={`nav-link ${page === "chat" ? "active" : ""}`}
      href="/panel/chat"
    >
      聊天
    </a>
  </nav>
);

const ChatConfigPanel = ({
  aiConfigs,
  currentAI,
  chatGuid,
  chatUserId,
  chatNickname,
  chatMode,
  chatModel,
  groupGuidOptions,
  workspaceNames,
  promptOptions,
  currentPrompt,
  currentGroupConfig,
  chatHref,
  idPrefix,
  className,
  defaultOpen = false,
}: {
  aiConfigs: AIConfigDraft[];
  currentAI: string;
  chatGuid: string;
  chatUserId: string;
  chatNickname: string;
  chatMode: "capi" | "rapi";
  chatModel: string;
  groupGuidOptions: string[];
  workspaceNames: string[];
  promptOptions: PromptOption[];
  currentPrompt: string;
  currentGroupConfig?: PanelGroupConfigDraft | null;
  chatHref: string;
  idPrefix: string;
  className: string;
  defaultOpen?: boolean;
}) => {
  const currentAILabel = currentAI || "未选择";
  const currentNicknameLabel = chatNickname || chatUserId;
  const groupOptions = [...new Set([...groupGuidOptions, chatGuid])];

  return (
    <details className={className} open={defaultOpen}>
      <summary className="chat-config-summary">
        <span className="chat-menu-icon" aria-hidden="true">
          <span />
          <span />
        </span>
        <span className="chat-config-summary-main">
          <span className="chat-config-summary-title">聊天配置</span>
          <span className="chat-config-summary-desc">
            {currentAILabel} / {chatMode.toUpperCase()}
          </span>
        </span>
        <span className="chat-config-summary-toggle" aria-hidden="true">
          收起
        </span>
      </summary>

      <div className="chat-config-body">
        <nav className="chat-side-nav" aria-label="聊天面板导航">
          <a className="active" href={chatHref}>
            聊天
          </a>
          <a href="/panel/config">配置</a>
        </nav>

        <section className="chat-config-block">
          <div className="chat-config-block-title">当前会话</div>
          <a className="conversation active" href={chatHref}>
            <div className="conversation-name">群号 {chatGuid}</div>
            <div className="conversation-last">
              账号 {chatUserId} / 昵称 {currentNicknameLabel}
            </div>
          </a>
          <form action="/panel/chat" className="chat-sidebar-form" method="get">
            <input type="hidden" name="guid" value={chatGuid} />
            <div className="chat-info-grid">
              <label className="chat-info-item">
                <span>设置账号</span>
                <input
                  name="userId"
                  defaultValue={chatUserId}
                  autoComplete="off"
                />
              </label>
              <label className="chat-info-item">
                <span>设置昵称</span>
                <input
                  name="nickname"
                  defaultValue={currentNicknameLabel}
                  autoComplete="off"
                />
              </label>
            </div>
            <button className="subtle chat-inline-action" type="submit">
              应用
            </button>
          </form>
        </section>

        <section className="chat-config-block">
          <div className="chat-config-block-title">当前群配置</div>
          {currentGroupConfig ? (
            <>
              <div className="chat-info-grid">
                <form
                  action="/panel/chat"
                  className="chat-info-form"
                  data-auto-submit="change"
                  method="get"
                >
                  <input type="hidden" name="userId" value={chatUserId} />
                  <input type="hidden" name="nickname" value={currentNicknameLabel} />
                  <label className="chat-info-item">
                    <span>群号</span>
                    <select name="guid" defaultValue={currentGroupConfig.guid}>
                      {groupOptions.map((item) => (
                        <option key={`${idPrefix}-group-guid-${item}`} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                </form>
                <form
                  action="/panel/action/chat/use-ai"
                  className="chat-info-form"
                  data-auto-submit="change"
                  method="post"
                >
                  <input type="hidden" name="guid" value={chatGuid} />
                  <input type="hidden" name="userId" value={chatUserId} />
                  <input type="hidden" name="nickname" value={currentNicknameLabel} />
                  <label className="chat-info-item">
                    <span>当前AI</span>
                    <select name="name" defaultValue={currentGroupConfig.currentAI}>
                      {aiConfigs.length ? (
                        aiConfigs.map((item) => (
                          <option key={`${idPrefix}-group-ai-${item.name}`} value={item.name}>
                            {item.name}
                          </option>
                        ))
                      ) : (
                        <option value="">暂无AI配置</option>
                      )}
                    </select>
                  </label>
                </form>
                <form
                  action="/panel/action/chat/switch-model"
                  className="chat-info-form"
                  data-auto-submit="blur"
                  method="post"
                >
                  <input type="hidden" name="guid" value={chatGuid} />
                  <input type="hidden" name="userId" value={chatUserId} />
                  <input type="hidden" name="nickname" value={currentNicknameLabel} />
                  <label className="chat-info-item full">
                    <span>当前模型</span>
                    <input
                      name="model"
                      defaultValue={currentGroupConfig.model || chatModel}
                      autoComplete="off"
                    />
                  </label>
                </form>
                <form
                  action="/panel/action/chat/switch-context-limit"
                  className="chat-info-form"
                  data-auto-submit="blur"
                  method="post"
                >
                  <input type="hidden" name="guid" value={chatGuid} />
                  <input type="hidden" name="userId" value={chatUserId} />
                  <input type="hidden" name="nickname" value={currentNicknameLabel} />
                  <label className="chat-info-item full">
                    <span>CAPI上下文长度</span>
                    <input
                      name="capiContextLimit"
                      type="number"
                      inputMode="numeric"
                      defaultValue={String(currentGroupConfig.capiContextLimit)}
                    />
                  </label>
                </form>
                <form
                  action="/panel/action/chat/switch-prompt"
                  className="chat-info-form"
                  data-auto-submit="change"
                  method="post"
                >
                  <input type="hidden" name="guid" value={chatGuid} />
                  <input type="hidden" name="userId" value={chatUserId} />
                  <input type="hidden" name="nickname" value={currentNicknameLabel} />
                  <label className="chat-info-item full">
                    <span>提示词</span>
                    <select name="prompt" defaultValue={currentPrompt}>
                      <option value="">默认提示词</option>
                      {promptOptions.map((item) => (
                        <option
                          key={`${idPrefix}-group-prompt-${item.name}`}
                          value={item.name}
                        >
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </form>
              </div>
              <div className="chat-switch-status-list">
                {panelGroupSwitchDefinitions.map((item) => {
                  const enabled = currentGroupConfig.switches[item.key];
                  return (
                    <form
                      action="/panel/action/update-group-config"
                      key={`${idPrefix}-group-switch-${item.key}`}
                      method="post"
                    >
                      <input type="hidden" name="source" value="chat" />
                      <input type="hidden" name="guid" value={chatGuid} />
                      <input type="hidden" name="userId" value={chatUserId} />
                      <input
                        type="hidden"
                        name="nickname"
                        value={currentNicknameLabel}
                      />
                      <input
                        type="hidden"
                        name="currentAI"
                        value={currentGroupConfig.currentAI}
                      />
                      <input
                        type="hidden"
                        name="capiContextLimit"
                        value={String(currentGroupConfig.capiContextLimit)}
                      />
                      {panelGroupSwitchDefinitions.map((stateItem) => {
                        const nextEnabled =
                          stateItem.key === item.key
                            ? !enabled
                            : currentGroupConfig.switches[stateItem.key];
                        return nextEnabled ? (
                          <input
                            key={`${idPrefix}-${item.key}-${stateItem.key}`}
                            type="hidden"
                            name={stateItem.key}
                            value="1"
                          />
                        ) : null;
                      })}
                      <button
                        className={`chat-switch-status ${enabled ? "enabled" : ""}`}
                        type="submit"
                      >
                        <span>{item.label}</span>
                        <strong>{enabled ? "开" : "关"}</strong>
                      </button>
                    </form>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="empty-state">当前 guid 暂无群配置。</div>
          )}
        </section>

        <section className="chat-config-block">
          <div className="chat-config-block-title">工作区目录</div>
          {workspaceNames.length ? (
            <div className="chat-directory-list">
              {workspaceNames.map((item) => (
                <div className="chat-directory-item" key={`${idPrefix}-workspace-${item}`}>
                  <div className="conversation-name">{item}</div>
                  <div className="conversation-last">public/{item}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">当前还没有创建过工作区目录。</div>
          )}
        </section>
      </div>
    </details>
  );
};

const AppStyle = () => (
  <style>{`
    * {
      box-sizing: border-box;
    }

    :root {
      color-scheme: light;
      --bg: #eef3f8;
      --surface: #ffffff;
      --surface-soft: #f8fafc;
      --border: #dbe3eb;
      --text: #17202a;
      --muted: #667485;
      --strong: #0f172a;
      --blue: #2563eb;
      --green: #059669;
      --amber: #b45309;
      --violet: #6d28d9;
      --shadow: 0 14px 38px rgba(15, 23, 42, 0.08);
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, "Microsoft YaHei", Arial, sans-serif;
      color: var(--text);
      background: linear-gradient(180deg, #f6f9fc 0%, var(--bg) 100%);
    }

    button,
    input,
    textarea,
    select {
      font: inherit;
    }

    button {
      height: 34px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0 12px;
      color: var(--strong);
      background: var(--surface);
      font-weight: 650;
    }

    button.primary {
      border-color: var(--blue);
      color: #ffffff;
      background: var(--blue);
    }

    button.subtle {
      background: var(--surface-soft);
    }

    button.danger {
      color: #b91c1c;
      background: #fff5f5;
      border-color: #fecaca;
    }

    .notice {
      margin: 0 18px 14px;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 10px 12px;
      color: #166534;
      background: #f0fdf4;
      font-size: 13px;
      font-weight: 700;
      transition:
        opacity 0.18s ease,
        transform 0.18s ease;
    }

    .notice.is-hiding {
      opacity: 0;
      pointer-events: none;
    }

    .notice.error {
      border-color: #fecaca;
      color: #b91c1c;
      background: #fff5f5;
    }

    .shell {
      width: min(1180px, calc(100vw - 28px));
      margin: 0 auto;
      padding: 22px 0 28px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .logo {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: #ffffff;
      background: #111827;
      font-weight: 800;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .meta {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
    }

    .nav {
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px;
      background: rgba(255, 255, 255, 0.72);
    }

    .nav-link {
      min-width: 78px;
      border-radius: 6px;
      padding: 8px 14px;
      color: var(--muted);
      text-align: center;
      text-decoration: none;
      font-size: 14px;
      font-weight: 700;
    }

    .nav-link.active {
      color: #ffffff;
      background: #111827;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }

    .stat {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface);
      box-shadow: 0 8px 22px rgba(15, 23, 42, 0.04);
    }

    .stat-label {
      color: var(--muted);
      font-size: 12px;
    }

    .stat-value {
      margin-top: 5px;
      font-size: 16px;
      font-weight: 800;
    }

    .tone-green {
      color: var(--green);
    }

    .tone-blue {
      color: var(--blue);
    }

    .tone-amber {
      color: var(--amber);
    }

    .tone-violet {
      color: var(--violet);
    }

    .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 52px;
      border-bottom: 1px solid var(--border);
      padding: 0 16px;
      background: var(--surface-soft);
    }

    .panel-title {
      font-size: 15px;
      font-weight: 800;
      white-space: nowrap;
    }

    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .config-layout {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(0, 1.1fr);
      gap: 0;
    }

    .section {
      padding: 16px;
    }

    .section + .section {
      border-left: 1px solid var(--border);
    }

    .section-title {
      margin: 0 0 10px;
      color: var(--strong);
      font-size: 14px;
      font-weight: 800;
    }

    .switch-list {
      display: grid;
      gap: 8px;
    }

    .group-list {
      display: grid;
      gap: 10px;
    }

    .group-add-card {
      display: grid;
      gap: 12px;
      margin: 12px 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface-soft);
    }

    .group-add-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .group-add-toggle {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .group-row {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
    }

    .group-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px;
      cursor: pointer;
      list-style: none;
      background: var(--surface-soft);
    }

    .group-summary::-webkit-details-marker {
      display: none;
    }

    .group-body {
      display: grid;
      gap: 12px;
      padding: 0 12px 12px;
    }

    details.group-row:not([open]) > .group-body {
      display: none;
    }

    .group-fields {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .group-form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .switch-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface);
    }

    .switch-label {
      font-weight: 750;
    }

    .switch-desc {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }

    .switch {
      position: relative;
      width: 42px;
      height: 24px;
      flex: 0 0 auto;
    }

    .switch input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }

    .track {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: #cbd5e1;
      transition: background 0.18s ease;
    }

    .track::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      background: #ffffff;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.18);
      transition: transform 0.18s ease;
    }

    .switch input:checked + .track {
      background: var(--blue);
    }

    .switch input:checked + .track::after {
      transform: translateX(18px);
    }

    .field-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }

    .field {
      display: grid;
      gap: 5px;
    }

    .field label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .field input,
    .field select {
      width: 100%;
      height: 34px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0 10px;
      color: var(--strong);
      background: #ffffff;
    }

    .group-manager,
    .ai-manager {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }

    .group-manager-summary,
    .ai-manager-summary,
    .ai-row-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      list-style: none;
    }

    .group-manager-summary::-webkit-details-marker,
    .ai-manager-summary::-webkit-details-marker,
    .ai-row-summary::-webkit-details-marker {
      display: none;
    }

    .group-manager-summary,
    .ai-manager-summary {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface-soft);
    }

    details.group-manager:not([open]) > .source-note,
    details.group-manager:not([open]) > .group-add-card,
    details.group-manager:not([open]) > .group-list,
    details.ai-manager:not([open]) > .source-note,
    details.ai-manager:not([open]) > .error-note,
    details.ai-manager:not([open]) > .ai-manager-actions,
    details.ai-manager:not([open]) > .ai-list {
      display: none;
    }

    .summary-title {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    .summary-main {
      color: var(--strong);
      font-weight: 850;
    }

    .summary-meta {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .summary-caret {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--muted);
      background: #ffffff;
      transition: transform 0.16s ease;
    }

    details[open] > .group-manager-summary .summary-caret,
    details[open] > .ai-manager-summary .summary-caret,
    details[open] > .ai-row-summary .summary-caret {
      transform: rotate(90deg);
    }

    .source-note {
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 10px 12px;
      color: #1e40af;
      background: #eff6ff;
      font-size: 13px;
      line-height: 1.6;
    }

    .error-note,
    .empty-state {
      border: 1px solid #fed7aa;
      border-radius: 8px;
      padding: 12px;
      color: #9a3412;
      background: #fff7ed;
      font-size: 13px;
      line-height: 1.6;
    }

    .ai-list {
      display: grid;
      gap: 8px;
    }

    .ai-row {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
      overflow: hidden;
    }

    .ai-row-summary {
      padding: 12px;
      background: #ffffff;
    }

    .ai-row-body {
      display: grid;
      gap: 10px;
      padding: 0 12px 12px;
    }

    details.ai-row:not([open]) > .ai-row-body {
      display: none;
    }

    .ai-row-title {
      font-weight: 850;
    }

    .ai-row-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .ai-row-actions form {
      margin: 0;
    }

    .ai-fields {
      display: grid;
      grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.4fr) minmax(140px, 1fr) minmax(150px, 1fr) minmax(92px, 0.5fr);
      gap: 10px;
    }

    .editor {
      width: 100%;
      min-height: 220px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      color: #dbeafe;
      background: #0f172a;
      line-height: 1.55;
      resize: vertical;
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 13px;
    }

    .chat-shell {
      width: 100%;
      min-height: 100vh;
      padding: 0;
    }

    .chat-page-header {
      display: none;
    }

    .chat-panel {
      min-height: 100vh;
      border: 0;
      border-radius: 0;
      background: #ffffff;
      box-shadow: none;
      overflow: hidden;
    }

    .chat-panel .notice {
      position: fixed;
      top: 14px;
      left: 50%;
      z-index: 50;
      width: min(520px, calc(100vw - 28px));
      margin: 0;
      transform: translateX(-50%);
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.12);
    }

    .chat-panel .notice.is-hiding {
      transform: translate(-50%, -8px);
    }

    .chat-layout {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      height: 100vh;
      min-height: 0;
      background: #ffffff;
    }

    .chat-config-panel {
      width: 336px;
      min-height: 0;
      height: 100vh;
      border-right: 1px solid #ececf1;
      background: #f7f7f8;
      overflow: hidden;
      transition: width 0.18s ease;
    }

    .chat-config-panel:not([open]) {
      width: 64px;
    }

    .chat-config-panel-mobile {
      display: none;
    }

    .chat-config-summary {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 10px 14px;
      cursor: pointer;
      list-style: none;
      color: #202123;
      background: #f7f7f8;
      user-select: none;
    }

    .chat-config-summary::-webkit-details-marker {
      display: none;
    }

    .chat-menu-icon {
      display: inline-grid;
      align-content: center;
      justify-items: center;
      gap: 5px;
      flex: 0 0 auto;
      width: 38px;
      height: 38px;
      border-radius: 999px;
      background: #ffffff;
      box-shadow: 0 1px 8px rgba(15, 23, 42, 0.05);
    }

    .chat-menu-icon span {
      display: block;
      width: 16px;
      height: 2px;
      border-radius: 999px;
      background: #202123;
    }

    .chat-menu-icon span + span {
      margin-top: 0;
    }

    .chat-config-summary-main {
      display: grid;
      min-width: 0;
      gap: 3px;
    }

    .chat-config-summary-title {
      font-weight: 850;
    }

    .chat-config-summary-desc {
      overflow: hidden;
      color: var(--muted);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-config-summary-toggle {
      flex: 0 0 auto;
      margin-left: auto;
      border: 1px solid #e5e5e5;
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--muted);
      background: #ffffff;
      font-size: 12px;
      font-weight: 800;
    }

    .chat-config-panel:not([open]) .chat-config-summary {
      justify-content: center;
      padding: 13px 0;
    }

    .chat-config-panel:not([open]) .chat-config-summary-main {
      display: none;
    }

    .chat-config-panel:not([open]) .chat-config-summary-toggle,
    .chat-config-panel:not([open]) .chat-config-body {
      display: none;
    }

    .chat-config-body {
      display: grid;
      gap: 10px;
      max-height: calc(100vh - 64px);
      overflow-y: auto;
      padding: 10px 12px 16px;
    }

    .chat-config-block {
      display: grid;
      gap: 10px;
      border: 1px solid #ececf1;
      border-radius: 12px;
      padding: 12px;
      background: #ffffff;
    }

    .chat-config-block-title {
      color: var(--strong);
      font-size: 13px;
      font-weight: 850;
    }

    .chat-side-nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }

    .chat-side-nav a {
      border-radius: 10px;
      padding: 9px 10px;
      color: #5f6368;
      background: #ffffff;
      text-align: center;
      text-decoration: none;
      font-size: 13px;
      font-weight: 780;
    }

    .chat-side-nav a.active {
      color: #202123;
      background: #ededed;
    }

    .chat-info-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .chat-info-form {
      display: block;
      margin: 0;
      min-width: 0;
    }

    .chat-info-item {
      display: grid;
      gap: 3px;
      min-width: 0;
      border: 1px solid #ececf1;
      border-radius: 10px;
      padding: 8px;
      background: #f9f9f9;
    }

    .chat-info-item.full {
      grid-column: 1 / -1;
    }

    .chat-info-item span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
    }

    .chat-info-item strong {
      overflow: hidden;
      color: var(--strong);
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-info-item input,
    .chat-info-item select {
      width: 100%;
      min-width: 0;
      border: 0;
      padding: 0;
      color: var(--strong);
      background: transparent;
      font-size: 13px;
      font-weight: 800;
      outline: none;
      appearance: none;
    }

    .chat-info-item select {
      cursor: pointer;
    }

    .chat-inline-action {
      width: 100%;
    }

    .chat-switch-status-list {
      display: grid;
      gap: 7px;
    }

    .chat-switch-status-list form {
      margin: 0;
    }

    .chat-switch-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      height: auto;
      border: 1px solid #ececf1;
      border-radius: 10px;
      padding: 8px 10px;
      color: #6b7280;
      background: #f9f9f9;
      font-size: 12px;
      font-weight: 780;
      text-align: left;
      cursor: pointer;
    }

    .chat-switch-status strong {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 2px 7px;
      color: #8e8ea0;
      background: #ffffff;
      font-size: 12px;
    }

    .chat-switch-status.enabled {
      color: #202123;
      border-color: #d7f2e8;
      background: #f0fbf7;
    }

    .chat-switch-status.enabled strong {
      color: #08785f;
      background: #dff7ee;
    }

    .chat-sidebar-form {
      display: grid;
      gap: 9px;
      margin: 0;
    }

    .conversation {
      display: block;
      border: 1px solid #ececf1;
      border-radius: 12px;
      padding: 13px 14px;
      color: inherit;
      text-decoration: none;
    }

    .conversation.active {
      background: #f2f2f2;
      box-shadow: none;
    }

    .conversation-name {
      font-weight: 800;
    }

    .conversation-last {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-directory-list {
      display: grid;
      gap: 8px;
    }

    .chat-directory-item {
      border: 1px solid #ececf1;
      border-radius: 12px;
      padding: 10px 12px;
      background: #f9f9f9;
    }

    .chat-main {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-width: 0;
      height: 100vh;
      background: #ffffff;
    }

    .chat-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 64px;
      padding: 10px 20px;
    }

    .chat-model-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      max-width: min(420px, 48vw);
      border: 1px solid #ececf1;
      border-radius: 999px;
      padding: 9px 14px;
      color: #202123;
      background: #ffffff;
      box-shadow: 0 4px 18px rgba(15, 23, 42, 0.06);
      font-size: 16px;
      font-weight: 760;
    }

    .chat-model-pill span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-mode-dot {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 3px 7px;
      color: #10a37f;
      background: #e7f8f2;
      font-size: 12px;
      font-weight: 850;
    }

    .clear-chat-form {
      margin: 0;
    }

    .chat-top-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }

    .chat-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      height: 42px;
      border: 1px solid #ececf1;
      border-radius: 999px;
      padding: 0 13px;
      color: #202123;
      background: #ffffff;
      text-decoration: none;
      font-size: 13px;
      font-weight: 760;
      box-shadow: 0 4px 18px rgba(15, 23, 42, 0.05);
    }

    .messages {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      min-height: 0;
      overflow-y: auto;
      padding: 28px max(24px, calc((100% - 820px) / 2)) 18px;
      background: #ffffff;
    }

    .messages.empty {
      justify-content: center;
      padding-bottom: 120px;
    }

    .chat-empty-state {
      display: grid;
      justify-items: center;
      gap: 10px;
      color: #202123;
      text-align: center;
    }

    .chat-empty-state h2 {
      margin: 0;
      font-size: clamp(30px, 4vw, 46px);
      font-weight: 780;
      letter-spacing: 0;
      line-height: 1.16;
    }

    .chat-empty-meta {
      color: #8e8ea0;
      font-size: 13px;
      font-weight: 680;
    }

    .message {
      align-self: center;
      width: min(100%, 820px);
      border: 0;
      border-radius: 0;
      padding: 0;
      color: #202123;
      background: transparent;
      box-shadow: none;
    }

    .message.user {
      align-self: flex-end;
      width: auto;
      max-width: min(76%, 720px);
      border-radius: 24px;
      padding: 12px 16px;
      color: #202123;
      background: #f4f4f4;
    }

    .message.system {
      align-self: center;
      width: min(92%, 720px);
      border-radius: 18px;
      padding: 11px 14px;
      color: #6b7280;
      background: #f7f7f8;
      box-shadow: none;
    }

    .message-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 5px;
      font-size: 12px;
      font-weight: 800;
      color: #8e8ea0;
    }

    .message-text {
      line-height: 1.65;
      font-size: 15px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .message.user .message-meta {
      display: none;
    }

    .message-images {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .message-images img {
      width: min(180px, 100%);
      max-height: 180px;
      border: 1px solid #ececf1;
      border-radius: 12px;
      object-fit: cover;
    }

    .composer {
      border: 0;
      padding: 12px max(20px, calc((100% - 820px) / 2)) 22px;
      background: #ffffff;
    }

    .composer-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      border: 1px solid #e5e5e5;
      border-radius: 28px;
      padding: 8px 8px 8px 16px;
      background: #ffffff;
      box-shadow: 0 12px 36px rgba(15, 23, 42, 0.1);
    }

    .composer textarea {
      width: 100%;
      min-height: 24px;
      max-height: 150px;
      border: 0;
      border-radius: 0;
      padding: 9px 0;
      resize: none;
      color: var(--strong);
      background: transparent;
      line-height: 1.55;
      outline: none;
    }

    .send-stack {
      display: grid;
      gap: 8px;
    }

    .chat-form-actions {
      display: grid;
      gap: 8px;
    }

    .send-button {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 0;
      border-radius: 999px;
      padding: 0;
      color: #ffffff;
      background: #000000;
      font-size: 25px;
      font-weight: 800;
      line-height: 1;
    }

    @media (max-width: 860px) {
      .header {
        align-items: flex-start;
        flex-direction: column;
      }

      .nav {
        width: 100%;
      }

      .nav-link {
        flex: 1;
      }

      .stats,
      .config-layout,
      .ai-fields {
        grid-template-columns: 1fr;
      }

      .section + .section {
        border-left: 0;
        border-right: 0;
        border-top: 1px solid var(--border);
      }

      .chat-layout {
        grid-template-columns: 1fr;
        height: 100vh;
        min-height: 0;
      }

      .chat-config-panel-desktop {
        display: none;
      }

      .chat-config-panel-mobile {
        display: block;
        width: auto;
        height: auto;
        min-height: 0;
        border: 0;
        background: transparent;
        overflow: visible;
      }

      .chat-config-panel-mobile:not([open]) {
        width: auto;
      }

      .chat-config-panel-mobile .chat-config-summary,
      .chat-config-panel-mobile:not([open]) .chat-config-summary {
        justify-content: center;
        width: 48px;
        min-height: 48px;
        height: 48px;
        border: 0;
        border-radius: 999px;
        padding: 0;
        background: #f7f7f7;
        box-shadow: none;
      }

      .chat-config-panel-mobile .chat-config-summary-main,
      .chat-config-panel-mobile .chat-config-summary-toggle,
      .chat-config-panel-mobile:not([open]) .chat-config-summary-main,
      .chat-config-panel-mobile:not([open]) .chat-config-summary-toggle {
        display: none;
      }

      .chat-config-panel-mobile .chat-menu-icon {
        width: 48px;
        height: 48px;
        background: transparent;
        box-shadow: none;
      }

      .chat-config-panel-mobile[open]::after {
        content: "";
        position: fixed;
        inset: 0;
        z-index: 20;
        background: rgba(15, 23, 42, 0.34);
      }

      .chat-config-panel-mobile[open] .chat-config-summary {
        position: fixed;
        top: 12px;
        left: 12px;
        z-index: 32;
        width: 48px;
        border: 0;
        border-radius: 999px;
        box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
      }

      .chat-config-panel-mobile[open] .chat-config-body {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 31;
        width: min(86vw, 360px);
        max-height: none;
        padding: 78px 12px 16px;
        border-right: 1px solid #ececf1;
        background: #f7f7f8;
        box-shadow: 18px 0 40px rgba(15, 23, 42, 0.2);
      }

      .chat-main {
        height: 100vh;
        min-height: 0;
      }

      .chat-head {
        min-height: 70px;
        padding: 12px;
      }

      .chat-model-pill {
        max-width: calc(100vw - 176px);
        padding: 9px 14px;
        font-size: 16px;
      }

      .chat-top-actions {
        gap: 6px;
      }

      .chat-top-actions .clear-chat-form {
        display: none;
      }

      .chat-icon-button {
        width: 48px;
        min-width: 48px;
        height: 48px;
        padding: 0;
        font-size: 12px;
        box-shadow: none;
      }

      .messages {
        padding: 18px 16px 12px;
      }

      .messages.empty {
        padding-bottom: 92px;
      }

      .chat-empty-state h2 {
        font-size: 30px;
      }

      .message {
        width: 100%;
      }

      .message.user {
        max-width: 86%;
      }

      .composer {
        padding: 10px 12px 14px;
      }
    }

    @media (max-width: 620px) {
      .shell {
        width: min(100vw - 20px, 1180px);
        padding-top: 14px;
      }

      .chat-shell {
        width: 100%;
        padding: 0;
      }

      .stats,
      .field-grid,
      .group-fields,
      .ai-fields {
        grid-template-columns: 1fr;
      }

      .message-meta {
        display: grid;
        gap: 3px;
      }

      .message.user .message-meta {
        display: none;
      }

      .toolbar {
        width: 100%;
      }

      .toolbar button {
        flex: 1;
      }
    }
  `}</style>
);

const ConfigPage = ({
  aiConfigs = [],
  groupConfigs = [],
  currentAI = "",
  currentGuid = "global",
  redisError = "",
  panelStatus = "",
  panelMessage = "",
  restoreGroupListOpen = true,
  restoreOpenGroups = [],
  restoreAiListOpen = false,
  restoreOpenRows = [],
}: Required<
  Pick<
    PanelPreviewProps,
    | "aiConfigs"
    | "groupConfigs"
    | "currentAI"
    | "currentGuid"
    | "redisError"
    | "panelStatus"
    | "panelMessage"
    | "restoreGroupListOpen"
    | "restoreOpenGroups"
    | "restoreAiListOpen"
    | "restoreOpenRows"
  >
>) => {
  const selectedAI = currentAI || aiConfigs[0]?.name || "";
  const selectedModel =
    aiConfigs.find((item) => item.name === selectedAI)?.model ||
    aiConfigs[0]?.model ||
    "";
  const runtimeStats = [
    { label: "服务状态", value: "在线", tone: "green" },
    {
      label: "群配置",
      value: `${groupConfigs.length} 个guid`,
      tone: "blue",
    },
    { label: "AI列表", value: `${aiConfigs.length} 个`, tone: "amber" },
    {
      label: "当前预览",
      value: currentGuid || "global",
      tone: "violet",
    },
  ];

  return (
    <>
      <div className="stats">
        {runtimeStats.map((item) => (
          <div className="stat" key={item.label}>
            <div className="stat-label">{item.label}</div>
            <div className={`stat-value tone-${item.tone}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">配置管理</div>
          <div className="toolbar">
            <button className="subtle">重载</button>
            <button className="subtle">校验</button>
            <button className="primary">保存</button>
          </div>
        </div>
        {panelMessage ? (
          <div
            className={`notice ${panelStatus === "error" ? "error" : "success"}`}
          >
            {panelMessage}
          </div>
        ) : null}
        <div className="config-layout">
          <div className="section">
            <details
              className="group-manager"
              open={restoreGroupListOpen || groupConfigs.length <= 3}
            >
              <summary className="group-manager-summary">
                <div className="summary-title">
                  <span className="summary-main">群配置</span>
                  <span className="summary-meta">
                    Redis 群配置视图，共 {groupConfigs.length} 个 guid
                  </span>
                </div>
                <span className="summary-caret" aria-hidden="true">
                  ›
                </span>
              </summary>
              <div className="source-note">
                先按 <strong>guid</strong>{" "}
                查看群配置。展开后修改当前AI、上下文长度和各个开关，
                保存时写回这个 guid 对应的 Redis 配置。
              </div>
              <form
                action="/panel/action/add-group-config"
                className="panel-action-form group-add-card"
                method="post"
              >
                <div className="group-fields">
                  <div className="field">
                    <label htmlFor="new-group-guid">新增群号 guid</label>
                    <input
                      id="new-group-guid"
                      name="guid"
                      placeholder="例如 123456789"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="new-group-ai">默认AI</label>
                    <select id="new-group-ai" name="currentAI" defaultValue="">
                      <option value="">先不指定</option>
                      {aiConfigs.map((item) => (
                        <option
                          key={`new-group-${item.name}`}
                          value={item.name}
                        >
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="new-group-chat-switch">聊天总开关</label>
                    <select
                      id="new-group-chat-switch"
                      name="chatSwitch"
                      defaultValue="0"
                    >
                      <option value="0">先关闭</option>
                      <option value="1">创建时开启</option>
                    </select>
                  </div>
                </div>
                <div className="group-add-actions">
                  <div className="group-add-toggle">
                    创建后会自动出现在下面的群配置列表里。
                  </div>
                  <button className="primary" type="submit">
                    添加群
                  </button>
                </div>
              </form>
              <div className="group-list">
                {groupConfigs.length ? (
                  groupConfigs.map((group) => (
                    <details
                      className="group-row"
                      data-guid={group.guid}
                      key={group.guid}
                      open={restoreOpenGroups.includes(group.guid)}
                    >
                      <summary className="group-summary">
                        <div className="summary-title">
                          <span className="summary-main">
                            群号 {group.guid}
                          </span>
                          <span className="summary-meta">
                            {group.currentAI || "未切换AI"} /{" "}
                            {group.model || "未设置模型"} / 已开
                            {countEnabledGroupSwitches(group)} 项
                          </span>
                        </div>
                        <span className="summary-caret" aria-hidden="true">
                          ›
                        </span>
                      </summary>
                      <div className="group-body">
                        <form
                          action="/panel/action/update-group-config"
                          className="panel-action-form"
                          method="post"
                        >
                          <input type="hidden" name="guid" value={group.guid} />
                          <div className="group-fields">
                            <div className="field">
                              <label htmlFor={`group-ai-${group.guid}`}>
                                当前AI
                              </label>
                              <select
                                id={`group-ai-${group.guid}`}
                                name="currentAI"
                                defaultValue={group.currentAI}
                              >
                                <option value="">保持当前</option>
                                {aiConfigs.map((item) => (
                                  <option
                                    key={`${group.guid}-${item.name}`}
                                    value={item.name}
                                  >
                                    {item.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field">
                              <label htmlFor={`group-model-${group.guid}`}>
                                当前模型
                              </label>
                              <input
                                id={`group-model-${group.guid}`}
                                value={group.model || "未设置"}
                                readOnly
                              />
                            </div>
                            <div className="field">
                              <label htmlFor={`group-context-${group.guid}`}>
                                CAPI上下文长度
                              </label>
                              <input
                                id={`group-context-${group.guid}`}
                                name="capiContextLimit"
                                defaultValue={String(group.capiContextLimit)}
                              />
                            </div>
                          </div>

                          <div className="switch-list">
                            {panelGroupSwitchDefinitions.map((item) => (
                              <div
                                className="switch-row"
                                key={`${group.guid}-${item.key}`}
                              >
                                <div>
                                  <div className="switch-label">
                                    {item.label}
                                  </div>
                                  <div className="switch-desc">{item.desc}</div>
                                </div>
                                <label
                                  className="switch"
                                  aria-label={`${group.guid}-${item.label}`}
                                >
                                  <input
                                    defaultChecked={group.switches[item.key]}
                                    name={item.key}
                                    type="checkbox"
                                  />
                                  <span className="track"></span>
                                </label>
                              </div>
                            ))}
                          </div>

                          <div className="group-form-actions">
                            <button className="primary" type="submit">
                              保存本群配置
                            </button>
                          </div>
                        </form>
                      </div>
                    </details>
                  ))
                ) : (
                  <div className="empty-state">
                    还没有发现任何 guid 配置。等群聊里产生 AI
                    配置或开关数据后，这里就会列出来。
                  </div>
                )}
              </div>
            </details>
          </div>

          <div className="section">
            <h2 className="section-title">当前预览</h2>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="current-ai">当前AI</label>
                <select id="current-ai" defaultValue={selectedAI}>
                  {aiConfigs.length ? (
                    aiConfigs.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))
                  ) : (
                    <option value="">暂无Redis AI配置</option>
                  )}
                </select>
              </div>
              <div className="field">
                <label htmlFor="model">模型</label>
                <input id="model" defaultValue={selectedModel} />
              </div>
              <div className="field">
                <label htmlFor="context">上下文长度</label>
                <input id="context" defaultValue="256k" />
              </div>
              <div className="field">
                <label htmlFor="master">管理员</label>
                <input id="master" defaultValue="3501869534" />
              </div>
            </div>

            <details
              className="ai-manager"
              open={restoreAiListOpen || aiConfigs.length <= 3}
            >
              <summary className="ai-manager-summary">
                <div className="summary-title">
                  <span className="summary-main">AI列表</span>
                  <span className="summary-meta">
                    Redis ai:list:*，共 {aiConfigs.length} 个配置
                  </span>
                </div>
                <span className="summary-caret" aria-hidden="true">
                  ›
                </span>
              </summary>
              <div className="source-note">
                数据来源：Redis 的 <strong>ai:list:*</strong>。添加/编辑后应写入
                <strong> ai:list:&lt;名称&gt;</strong>，切换当前会话时写入
                <strong> ai:currentAI:&lt;guid&gt;</strong> 并同步
                <strong> ai:config:&lt;guid&gt;</strong>。当前操作目标：
                <strong> {currentGuid}</strong>。
              </div>
              {redisError ? (
                <div className="error-note">Redis读取失败：{redisError}</div>
              ) : null}
              <div className="ai-manager-actions">
                <button className="subtle">添加AI</button>
              </div>
              <div className="ai-list">
                {aiConfigs.length ? (
                  aiConfigs.map((item) => (
                    <details
                      className="ai-row"
                      data-ai-name={item.name}
                      key={item.name}
                      open={restoreOpenRows.includes(item.name)}
                    >
                      <summary className="ai-row-summary">
                        <div className="summary-title">
                          <span className="summary-main">{item.name}</span>
                          <span className="summary-meta">
                            {item.model || "未设置模型"} /{" "}
                            {item.host || "未设置host"}
                          </span>
                        </div>
                        <span className="summary-caret" aria-hidden="true">
                          ›
                        </span>
                      </summary>
                      <div className="ai-row-body">
                        <div className="ai-row-actions">
                          <form
                            action="/panel/action/use-ai"
                            className="panel-action-form"
                            method="post"
                          >
                            <input
                              type="hidden"
                              name="name"
                              value={item.name}
                            />
                            <input
                              type="hidden"
                              name="guid"
                              value={currentGuid}
                            />
                            <button className="primary" type="submit">
                              使用这个AI
                            </button>
                          </form>
                          <form
                            action="/panel/action/delete-ai"
                            className="panel-action-form"
                            method="post"
                          >
                            <input
                              type="hidden"
                              name="name"
                              value={item.name}
                            />
                            <button className="subtle danger" type="submit">
                              删除AI
                            </button>
                          </form>
                        </div>
                        <div className="ai-fields">
                          <div className="field">
                            <label htmlFor={`ai-name-${item.name}`}>
                              AI名称
                            </label>
                            <input
                              id={`ai-name-${item.name}`}
                              defaultValue={item.name}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`ai-host-${item.name}`}>
                              主机地址 host
                            </label>
                            <input
                              id={`ai-host-${item.name}`}
                              defaultValue={item.host}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`ai-key-${item.name}`}>
                              api_key
                            </label>
                            <input
                              id={`ai-key-${item.name}`}
                              type="password"
                              defaultValue={item.key}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`ai-model-${item.name}`}>
                              模型
                            </label>
                            <input
                              id={`ai-model-${item.name}`}
                              defaultValue={item.model}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`ai-rapi-${item.name}`}>RAPI</label>
                            <select
                              id={`ai-rapi-${item.name}`}
                              defaultValue={item.rapi ? "1" : "0"}
                            >
                              <option value="0">关闭</option>
                              <option value="1">开启</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </details>
                  ))
                ) : (
                  <div className="empty-state">
                    Redis 中还没有 ai:list:*，可通过 /添加ai
                    或后续面板表单创建。
                  </div>
                )}
              </div>
            </details>

            <h2 className="section-title">Redis数据预览</h2>
            <textarea
              className="editor"
              spellCheck={false}
              defaultValue={createRedisPreview(
                aiConfigs,
                currentAI,
                redisError,
              )}
            />

            <h2 className="section-title">配置文件</h2>
            <textarea
              className="editor"
              spellCheck={false}
              defaultValue={configValue}
            />
          </div>
        </div>
      </section>
    </>
  );
};

const ChatPage = ({
  aiConfigs = [],
  currentAI = "",
  chatGuid = "global",
  chatUserId = "webuser",
  chatNickname = chatUserId,
  chatMode = "capi",
  chatModel = "",
  groupGuidOptions = [],
  workspaceNames = [],
  promptOptions = [],
  currentPrompt = "",
  chatMessages = [],
  currentGroupConfig = null,
  panelStatus = "",
  panelMessage = "",
  chatConfigOpen = false,
}: {
  aiConfigs?: AIConfigDraft[];
  currentAI?: string;
  chatGuid?: string;
  chatUserId?: string;
  chatNickname?: string;
  chatMode?: "capi" | "rapi";
  chatModel?: string;
  groupGuidOptions?: string[];
  workspaceNames?: string[];
  promptOptions?: PromptOption[];
  currentPrompt?: string;
  chatMessages?: PanelChatMessage[];
  currentGroupConfig?: PanelGroupConfigDraft | null;
  panelStatus?: string;
  panelMessage?: string;
  chatConfigOpen?: boolean;
}) => {
  const chatHref = `/panel/chat?guid=${encodeURIComponent(
    chatGuid,
  )}&userId=${encodeURIComponent(chatUserId)}&nickname=${encodeURIComponent(
    chatNickname,
  )}`;
  const modelLabel = chatModel || currentAI || "AI Chat";
  const hasMessages = chatMessages.length > 0;

  return (
    <section className="panel chat-panel">
      {panelMessage ? (
        <div
          className={`notice ${panelStatus === "error" ? "error" : "success"}`}
        >
          {panelMessage}
        </div>
      ) : null}
      <div className="chat-layout">
        <ChatConfigPanel
          aiConfigs={aiConfigs}
          currentAI={currentAI}
          chatGuid={chatGuid}
          chatUserId={chatUserId}
          chatNickname={chatNickname}
          chatMode={chatMode}
          chatModel={chatModel}
          groupGuidOptions={groupGuidOptions}
          workspaceNames={workspaceNames}
          promptOptions={promptOptions}
          currentPrompt={currentPrompt}
          currentGroupConfig={currentGroupConfig}
          chatHref={chatHref}
          idPrefix="desktop"
          className="chat-config-panel chat-config-panel-desktop"
          defaultOpen
        />

        <div className="chat-main">
          <div className="chat-head">
            <ChatConfigPanel
              aiConfigs={aiConfigs}
              currentAI={currentAI}
              chatGuid={chatGuid}
              chatUserId={chatUserId}
              chatNickname={chatNickname}
              chatMode={chatMode}
              chatModel={chatModel}
              groupGuidOptions={groupGuidOptions}
              workspaceNames={workspaceNames}
              promptOptions={promptOptions}
              currentPrompt={currentPrompt}
              currentGroupConfig={currentGroupConfig}
              chatHref={chatHref}
              idPrefix="mobile"
              className="chat-config-panel chat-config-panel-mobile"
              defaultOpen={chatConfigOpen}
            />
            <div className="chat-model-pill">
              <span>{modelLabel}</span>
              <span className="chat-mode-dot">{chatMode.toUpperCase()}</span>
            </div>
            <div className="chat-top-actions">
              <a className="chat-icon-button" href={chatHref} aria-label="刷新">
                刷新
              </a>
              <form
                action="/panel/action/clear-chat"
                className="clear-chat-form"
                method="post"
              >
                <input type="hidden" name="guid" value={chatGuid} />
                <input type="hidden" name="userId" value={chatUserId} />
                <input type="hidden" name="nickname" value={chatNickname} />
                <button
                  className="chat-icon-button"
                  type="submit"
                  aria-label="清空聊天"
                >
                  清空
                </button>
              </form>
            </div>
          </div>

          <div className={`messages ${hasMessages ? "" : "empty"}`}>
            {hasMessages ? (
              chatMessages.map((item, index) => (
                <div
                  className={`message ${item.from}`}
                  key={`${item.from}-${index}-${item.time}`}
                >
                  <div className="message-meta">
                    <span>{item.name}</span>
                    <span>{item.time}</span>
                  </div>
                  {item.text ? (
                    <div className="message-text">{item.text}</div>
                  ) : null}
                  {item.images?.length ? (
                    <div className="message-images">
                      {item.images.map((image, imageIndex) => (
                        <img
                          alt="AI回复图片"
                          key={`${image}-${imageIndex}`}
                          src={image}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="chat-empty-state">
                <h2>有什么可以帮忙的？</h2>
                <div className="chat-empty-meta">
                  群号 {chatGuid} / {chatNickname}({chatUserId})
                </div>
              </div>
            )}
          </div>

          <div className="composer">
            <form
              action="/panel/action/chat"
              className="chat-composer-form"
              method="post"
            >
              <input type="hidden" name="guid" value={chatGuid} />
              <input type="hidden" name="userId" value={chatUserId} />
              <input type="hidden" name="nickname" value={chatNickname} />
              <div className="composer-row">
                <textarea
                  aria-label="聊天输入"
                  name="message"
                  placeholder="输入消息..."
                  required
                  defaultValue=""
                />
                <div className="chat-form-actions">
                  <button className="send-button" type="submit" aria-label="发送">
                    ↑
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
};

const PanelStateScript = ({ restoreScrollY }: { restoreScrollY?: number }) => (
  <script
    dangerouslySetInnerHTML={{
      __html: `
(function () {
  var restoreScrollY = ${Number.isFinite(restoreScrollY) ? restoreScrollY : "null"};

  function upsertHidden(form, name, value) {
    var input = form.querySelector('input[name="' + name + '"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  function capturePanelState(event) {
    var form = event.target;
    if (!form || !form.matches) {
      return;
    }

    var mobileChatPanel = document.querySelector(".chat-config-panel-mobile");
    if (mobileChatPanel && form.closest && form.closest(".chat-panel")) {
      upsertHidden(
        form,
        "chatConfigOpen",
        mobileChatPanel.open ? "1" : "0",
      );
    }

    if (!form.matches("form.panel-action-form")) {
      return;
    }

    var groupManager = document.querySelector("details.group-manager");
    var manager = document.querySelector("details.ai-manager");
    var openGroups = Array.prototype.slice
      .call(document.querySelectorAll("details.group-row[open]"))
      .map(function (row) {
        return row.getAttribute("data-guid") || "";
      })
      .filter(Boolean);
    var openRows = Array.prototype.slice
      .call(document.querySelectorAll("details.ai-row[open]"))
      .map(function (row) {
        return row.getAttribute("data-ai-name") || "";
      })
      .filter(Boolean);

    upsertHidden(form, "panelOpenGroups", JSON.stringify(openGroups));
    upsertHidden(
      form,
      "panelGroupListOpen",
      groupManager && groupManager.open ? "1" : "0",
    );
    upsertHidden(form, "panelAiListOpen", manager && manager.open ? "1" : "0");
    upsertHidden(form, "panelOpenRows", JSON.stringify(openRows));
    upsertHidden(
      form,
      "panelScrollY",
      String(
        window.scrollY ||
          document.documentElement.scrollTop ||
          document.body.scrollTop ||
          0,
      ),
    );
  }

  function restorePanelScroll() {
    if (!Number.isFinite(restoreScrollY)) return;
    requestAnimationFrame(function () {
      setTimeout(function () {
        window.scrollTo(0, restoreScrollY);
      }, 0);
    });
  }

  document.addEventListener("change", function (event) {
    var target = event.target;
    if (!target || !target.form) return;
    if (target.form.getAttribute("data-auto-submit") !== "change") return;
    if (typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
    } else {
      target.form.submit();
    }
  });

  document.addEventListener(
    "focusout",
    function (event) {
      var target = event.target;
      if (!target || !target.form) return;
      if (target.form.getAttribute("data-auto-submit") !== "blur") return;
      if (
        target.tagName !== "INPUT" ||
        target.type === "hidden" ||
        target.value === target.defaultValue
      ) {
        return;
      }
      if (typeof target.form.requestSubmit === "function") {
        target.form.requestSubmit();
      } else {
        target.form.submit();
      }
    },
    true,
  );

  document.addEventListener("keydown", function (event) {
    var target = event.target;
    if (!target || !target.form) return;
    if (target.form.getAttribute("data-auto-submit") !== "blur") return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (target.tagName !== "INPUT") return;
    event.preventDefault();
    if (typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
    } else {
      target.form.submit();
    }
  });

  document.addEventListener("submit", capturePanelState, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", restorePanelScroll);
  } else {
    restorePanelScroll();
  }
})();
`,
    }}
  />
);

const PanelNoticeScript = () => (
  <script
    dangerouslySetInnerHTML={{
      __html: `
(function () {
  var notices = Array.prototype.slice.call(document.querySelectorAll(".notice"));
  if (!notices.length) return;

  function cleanNoticeParams() {
    try {
      var url = new URL(window.location.href);
      var changed = false;
      ["panelStatus", "panelMessage"].forEach(function (key) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      });
      if (!changed || !window.history || !window.history.replaceState) return;
      var query = url.searchParams.toString();
      window.history.replaceState(null, "", url.pathname + (query ? "?" + query : "") + url.hash);
    } catch {}
  }

  setTimeout(function () {
    notices.forEach(function (notice) {
      notice.classList.add("is-hiding");
      setTimeout(function () {
        if (notice.parentNode) notice.parentNode.removeChild(notice);
      }, 220);
    });
    cleanNoticeParams();
  }, 2600);
})();
`,
    }}
  />
);

const PanelChatScript = () => (
  <script
    dangerouslySetInnerHTML={{
      __html: `
(function () {
  var form = document.querySelector(".chat-composer-form");
  var messages = document.querySelector(".messages");
  if (!form || !messages || !window.fetch || !window.ReadableStream) return;

  var textarea = form.querySelector('textarea[name="message"]');
  var sendButton = form.querySelector(".send-button");
  var streamMessage = null;

  function getTime() {
    var now = new Date();
    return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  }

  function activateMessages() {
    messages.classList.remove("empty");
    var empty = messages.querySelector(".chat-empty-state");
    if (empty) empty.remove();
  }

  function scrollMessages() {
    messages.scrollTop = messages.scrollHeight;
  }

  function appendText(parent, className, text) {
    var node = document.createElement("div");
    node.className = className;
    node.textContent = text || "";
    parent.appendChild(node);
    return node;
  }

  function renderImages(parent, images) {
    if (!images || !images.length) return;
    var wrap = document.createElement("div");
    wrap.className = "message-images";
    images.forEach(function (src) {
      if (!src) return;
      var img = document.createElement("img");
      img.alt = "AI回复图片";
      img.src = src;
      wrap.appendChild(img);
    });
    if (wrap.childNodes.length) parent.appendChild(wrap);
  }

  function createMessage(message) {
    activateMessages();
    var item = document.createElement("div");
    item.className = "message " + (message.from || "system");
    var meta = document.createElement("div");
    meta.className = "message-meta";
    appendText(meta, "", message.name || "");
    appendText(meta, "", message.time || getTime());
    item.appendChild(meta);
    appendText(item, "message-text", message.text || "");
    renderImages(item, message.images || []);
    messages.appendChild(item);
    scrollMessages();
    return item;
  }

  function ensureStreamMessage() {
    if (streamMessage && streamMessage.isConnected) return streamMessage;
    streamMessage = createMessage({
      from: "bot",
      name: "aichatbot",
      text: "",
      time: getTime(),
    });
    streamMessage.setAttribute("data-streaming", "1");
    return streamMessage;
  }

  function appendDelta(text) {
    if (!text) return;
    var item = ensureStreamMessage();
    var textNode = item.querySelector(".message-text");
    if (!textNode) textNode = appendText(item, "message-text", "");
    textNode.textContent += text;
    scrollMessages();
  }

  function replaceStreamMessage(message) {
    if (!streamMessage || !streamMessage.isConnected) {
      createMessage(message);
      return;
    }
    var next = createMessage(message);
    messages.insertBefore(next, streamMessage);
    streamMessage.remove();
    streamMessage = null;
    scrollMessages();
  }

  function clearStreamMessage() {
    if (streamMessage && streamMessage.isConnected) {
      streamMessage.remove();
    }
    streamMessage = null;
    scrollMessages();
  }

  function handleStreamEvent(event) {
    if (!event || !event.type) return;
    if (event.type === "delta") {
      appendDelta(event.text || "");
      return;
    }
    if (event.type === "replace") {
      replaceStreamMessage(event.message || {});
      return;
    }
    if (event.type === "clear") {
      clearStreamMessage();
      return;
    }
    if (event.type === "message") {
      createMessage(event.message || {});
      return;
    }
    if (event.type === "error") {
      createMessage({
        from: "system",
        name: "系统",
        text: event.message || "发送失败",
        time: getTime(),
      });
    }
  }

  async function readEventStream(response) {
    if (!response.body) return;
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try {
          handleStreamEvent(JSON.parse(line));
        } catch {}
      });
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      try {
        handleStreamEvent(JSON.parse(buffer));
      } catch {}
    }
  }

  function resizeTextarea() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
  }

  if (textarea) {
    textarea.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
    textarea.addEventListener("input", resizeTextarea);
    resizeTextarea();
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!textarea) return;
    var text = textarea.value.trim();
    if (!text) return;

    var formData = new FormData(form);
    var body = new URLSearchParams();
    body.set("guid", String(formData.get("guid") || ""));
    body.set("userId", String(formData.get("userId") || ""));
    body.set("nickname", String(formData.get("nickname") || ""));
    body.set("message", text);
    createMessage({
      from: "user",
      name: String(formData.get("nickname") || formData.get("userId") || "webuser"),
      text: text,
      time: getTime(),
    });
    textarea.value = "";
    resizeTextarea();
    if (sendButton) sendButton.disabled = true;

    try {
      var response = await fetch("/panel/action/chat/stream", {
        method: "POST",
        body: body,
        headers: {
          Accept: "application/x-ndjson",
        },
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      await readEventStream(response);
    } catch (error) {
      createMessage({
        from: "system",
        name: "系统",
        text: "发送失败：" + (error && error.message ? error.message : String(error)),
        time: getTime(),
      });
    } finally {
      if (sendButton) sendButton.disabled = false;
      if (textarea) textarea.focus();
    }
  });
})();
`,
    }}
  />
);

export default function PanelPreview({
  page = "config",
  aiConfigs = [],
  groupConfigs = [],
  currentAI = "",
  currentGuid = "global",
  redisError = "",
  panelStatus = "",
  panelMessage = "",
  restoreGroupListOpen = true,
  restoreOpenGroups = [],
  restoreAiListOpen = false,
  restoreOpenRows = [],
  restoreScrollY,
  chatGuid = currentGuid,
  chatUserId = "webuser",
  chatNickname = chatUserId,
  chatMode = "capi",
  chatModel = "",
  groupGuidOptions = [],
  workspaceNames = [],
  promptOptions = [],
  currentPrompt = "",
  chatMessages = [],
  currentGroupConfig = null,
  chatConfigOpen = false,
}: PanelPreviewProps) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>AlemonJS AI 面板</title>
        <AppStyle />
      </head>
      <body>
        <main className={`shell ${page === "chat" ? "chat-shell" : ""}`}>
          <header className={`header ${page === "chat" ? "chat-page-header" : ""}`}>
            <div className="brand">
              <div className="logo">AI</div>
              <div>
                <h1>AlemonJS Aichat</h1>
                <div className="meta">网页控制台</div>
              </div>
            </div>
            {renderNav(page)}
          </header>

          {page === "chat" ? (
            <ChatPage
              aiConfigs={aiConfigs}
              currentAI={currentAI}
              chatGuid={chatGuid}
              chatUserId={chatUserId}
              chatNickname={chatNickname}
              chatMode={chatMode}
              chatModel={chatModel}
              groupGuidOptions={groupGuidOptions}
              workspaceNames={workspaceNames}
              promptOptions={promptOptions}
              currentPrompt={currentPrompt}
              chatMessages={chatMessages}
              currentGroupConfig={currentGroupConfig}
              panelStatus={panelStatus}
              panelMessage={panelMessage}
              chatConfigOpen={chatConfigOpen}
            />
          ) : (
            <ConfigPage
              aiConfigs={aiConfigs}
              groupConfigs={groupConfigs}
              currentAI={currentAI}
              currentGuid={currentGuid}
              redisError={redisError}
              panelStatus={panelStatus}
              panelMessage={panelMessage}
              restoreGroupListOpen={restoreGroupListOpen}
              restoreOpenGroups={restoreOpenGroups}
              restoreAiListOpen={restoreAiListOpen}
              restoreOpenRows={restoreOpenRows}
            />
          )}
        </main>
        <PanelStateScript restoreScrollY={restoreScrollY} />
        <PanelNoticeScript />
        {page === "chat" ? <PanelChatScript /> : null}
      </body>
    </html>
  );
}
