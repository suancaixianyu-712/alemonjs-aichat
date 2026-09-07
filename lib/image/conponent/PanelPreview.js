import React from 'react';
import { panelGroupSwitchDefinitions } from '../../panel/groupConfig.js';

const configValue = `app:
  - alemonjs-aichat

master_id:
  - "3501869534"

ai:
  current: OpenAI
  capiContextLimit: 512k

features:
  chat: true
  tools: true
  onlyAt: false
  toolCallContent: false
  affection: true
  tts: false
`;
const countEnabledGroupSwitches = (group) => panelGroupSwitchDefinitions.filter((item) => group.switches[item.key]).length;
const createRedisPreview = (items, currentAI, redisError) => {
    if (redisError) {
        return `# AI列表来自 Redis, 但当前读取失败
# ${redisError}
keys ai:model:*

ai:currentAI:{guid} = 当前会话选中的 AI 名称
ai:config:{guid} = 当前会话实际使用的 AIConfig
`;
    }
    const listPreview = items.length
        ? items
            .map((item) => {
            const storageKey = item.provider
                ? `ai:model:${item.provider}:${encodeURIComponent(item.name)}`
                : `ai:list:${item.name}`;
            return `${storageKey} = {
  "provider": "${item.provider || "legacy"}",
  "host": "${item.host}",
  "key": "${item.key}",
  "model": "${item.model}",
  "temperature": 0.7,
  "max_tokens": 4096,
  "systemPrompt": ""
}`;
        })
            .join("\n\n")
        : "# 当前 Redis 中没有 AI 模型配置";
    return `# AI列表来自 Redis, 不是配置文件
keys ai:model:*

${listPreview}

ai:currentAI:{guid} = "${currentAI || "按会话记录"}"
ai:config:{guid} = 当前会话实际使用的 AIConfig
`;
};
const renderNav = (page) => (React.createElement("nav", { className: "nav", "aria-label": "\u9762\u677F\u5BFC\u822A" },
    React.createElement("a", { className: `nav-link ${page === "config" ? "active" : ""}`, href: "/panel/config" }, "\u914D\u7F6E"),
    React.createElement("a", { className: `nav-link ${page === "chat" ? "active" : ""}`, href: "/panel/chat" }, "\u804A\u5929")));
const ChatConfigPanel = ({ aiConfigs, currentAI, chatGuid, chatUserId, chatNickname, chatModel, groupGuidOptions, workspaceNames, promptOptions, currentPrompt, currentGroupConfig, chatHref, idPrefix, className, defaultOpen = false, }) => {
    const currentAILabel = currentAI || "未选择";
    const currentNicknameLabel = chatNickname || chatUserId;
    const groupOptions = [...new Set([...groupGuidOptions, chatGuid])];
    return (React.createElement("details", { className: className, open: defaultOpen },
        React.createElement("summary", { className: "chat-config-summary" },
            React.createElement("span", { className: "chat-menu-icon", "aria-hidden": "true" },
                React.createElement("span", null),
                React.createElement("span", null)),
            React.createElement("span", { className: "chat-config-summary-main" },
                React.createElement("span", { className: "chat-config-summary-title" }, "\u804A\u5929\u914D\u7F6E"),
                React.createElement("span", { className: "chat-config-summary-desc" }, currentAILabel)),
            React.createElement("span", { className: "chat-config-summary-toggle", "aria-hidden": "true" }, "\u6536\u8D77")),
        React.createElement("div", { className: "chat-config-body" },
            React.createElement("nav", { className: "chat-side-nav", "aria-label": "\u804A\u5929\u9762\u677F\u5BFC\u822A" },
                React.createElement("a", { className: "active", href: chatHref }, "\u804A\u5929"),
                React.createElement("a", { href: "/panel/config" }, "\u914D\u7F6E")),
            React.createElement("section", { className: "chat-config-block" },
                React.createElement("div", { className: "chat-config-block-title" }, "\u5F53\u524D\u4F1A\u8BDD"),
                React.createElement("a", { className: "conversation active", href: chatHref },
                    React.createElement("div", { className: "conversation-name" },
                        "\u7FA4\u53F7 ",
                        chatGuid),
                    React.createElement("div", { className: "conversation-last" },
                        "\u8D26\u53F7 ",
                        chatUserId,
                        " / \u6635\u79F0 ",
                        currentNicknameLabel)),
                React.createElement("form", { action: "/panel/chat", className: "chat-sidebar-form", method: "get" },
                    React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                    React.createElement("div", { className: "chat-info-grid" },
                        React.createElement("label", { className: "chat-info-item" },
                            React.createElement("span", null, "\u8BBE\u7F6E\u8D26\u53F7"),
                            React.createElement("input", { name: "userId", defaultValue: chatUserId, autoComplete: "off" })),
                        React.createElement("label", { className: "chat-info-item" },
                            React.createElement("span", null, "\u8BBE\u7F6E\u6635\u79F0"),
                            React.createElement("input", { name: "nickname", defaultValue: currentNicknameLabel, autoComplete: "off" }))),
                    React.createElement("button", { className: "subtle chat-inline-action", type: "submit" }, "\u5E94\u7528"))),
            React.createElement("section", { className: "chat-config-block" },
                React.createElement("div", { className: "chat-config-block-title" }, "\u5F53\u524D\u7FA4\u914D\u7F6E"),
                currentGroupConfig ? (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "chat-info-grid" },
                        React.createElement("form", { action: "/panel/chat", className: "chat-info-form", "data-auto-submit": "change", method: "get" },
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: currentNicknameLabel }),
                            React.createElement("label", { className: "chat-info-item" },
                                React.createElement("span", null, "\u7FA4\u53F7"),
                                React.createElement("select", { name: "guid", defaultValue: currentGroupConfig.guid }, groupOptions.map((item) => (React.createElement("option", { key: `${idPrefix}-group-guid-${item}`, value: item }, item)))))),
                        React.createElement("form", { action: "/panel/action/chat/use-ai", className: "chat-info-form", "data-auto-submit": "change", method: "post" },
                            React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: currentNicknameLabel }),
                            React.createElement("label", { className: "chat-info-item" },
                                React.createElement("span", null, "\u5F53\u524DAI"),
                                React.createElement("select", { name: "name", defaultValue: currentGroupConfig.currentAI }, aiConfigs.length ? (aiConfigs.map((item) => (React.createElement("option", { key: `${idPrefix}-group-ai-${item.name}`, value: item.name }, item.name)))) : (React.createElement("option", { value: "" }, "\u6682\u65E0AI\u914D\u7F6E"))))),
                        React.createElement("form", { action: "/panel/action/chat/switch-model", className: "chat-info-form", "data-auto-submit": "blur", method: "post" },
                            React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: currentNicknameLabel }),
                            React.createElement("label", { className: "chat-info-item full" },
                                React.createElement("span", null, "\u5F53\u524D\u6A21\u578B"),
                                React.createElement("input", { name: "model", defaultValue: currentGroupConfig.model || chatModel, autoComplete: "off" }))),
                        React.createElement("form", { action: "/panel/action/chat/switch-context-limit", className: "chat-info-form", "data-auto-submit": "blur", method: "post" },
                            React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: currentNicknameLabel }),
                            React.createElement("label", { className: "chat-info-item full" },
                                React.createElement("span", null, "CAPI\u4E0A\u4E0B\u6587\u957F\u5EA6"),
                                React.createElement("input", { name: "capiContextLimit", type: "number", inputMode: "numeric", defaultValue: String(currentGroupConfig.capiContextLimit) }))),
                        React.createElement("form", { action: "/panel/action/chat/switch-prompt", className: "chat-info-form", "data-auto-submit": "change", method: "post" },
                            React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: currentNicknameLabel }),
                            React.createElement("label", { className: "chat-info-item full" },
                                React.createElement("span", null, "\u63D0\u793A\u8BCD"),
                                React.createElement("select", { name: "prompt", defaultValue: currentPrompt },
                                    React.createElement("option", { value: "" }, "\u9ED8\u8BA4\u63D0\u793A\u8BCD"),
                                    promptOptions.map((item) => (React.createElement("option", { key: `${idPrefix}-group-prompt-${item.name}`, value: item.name }, item.name))))))),
                    React.createElement("div", { className: "chat-switch-status-list" }, panelGroupSwitchDefinitions.map((item) => {
                        const enabled = currentGroupConfig.switches[item.key];
                        return (React.createElement("form", { action: "/panel/action/update-group-config", key: `${idPrefix}-group-switch-${item.key}`, method: "post" },
                            React.createElement("input", { type: "hidden", name: "source", value: "chat" }),
                            React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: currentNicknameLabel }),
                            React.createElement("input", { type: "hidden", name: "currentAI", value: currentGroupConfig.currentAI }),
                            React.createElement("input", { type: "hidden", name: "capiContextLimit", value: String(currentGroupConfig.capiContextLimit) }),
                            panelGroupSwitchDefinitions.map((stateItem) => {
                                const nextEnabled = stateItem.key === item.key
                                    ? !enabled
                                    : currentGroupConfig.switches[stateItem.key];
                                return nextEnabled ? (React.createElement("input", { key: `${idPrefix}-${item.key}-${stateItem.key}`, type: "hidden", name: stateItem.key, value: "1" })) : null;
                            }),
                            React.createElement("button", { className: `chat-switch-status ${enabled ? "enabled" : ""}`, type: "submit" },
                                React.createElement("span", null, item.label),
                                React.createElement("strong", null, enabled ? "开" : "关"))));
                    })))) : (React.createElement("div", { className: "empty-state" }, "\u5F53\u524D guid \u6682\u65E0\u7FA4\u914D\u7F6E\u3002"))),
            React.createElement("section", { className: "chat-config-block" },
                React.createElement("div", { className: "chat-config-block-title" }, "\u5DE5\u4F5C\u533A\u76EE\u5F55"),
                workspaceNames.length ? (React.createElement("div", { className: "chat-directory-list" }, workspaceNames.map((item) => (React.createElement("div", { className: "chat-directory-item", key: `${idPrefix}-workspace-${item}` },
                    React.createElement("div", { className: "conversation-name" }, item),
                    React.createElement("div", { className: "conversation-last" },
                        "public/",
                        item)))))) : (React.createElement("div", { className: "empty-state" }, "\u5F53\u524D\u8FD8\u6CA1\u6709\u521B\u5EFA\u8FC7\u5DE5\u4F5C\u533A\u76EE\u5F55\u3002"))))));
};
const AppStyle = () => (React.createElement("style", null, `
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
  `));
const ConfigPage = ({ aiConfigs = [], groupConfigs = [], currentAI = "", currentGuid = "global", redisError = "", panelStatus = "", panelMessage = "", restoreGroupListOpen = true, restoreOpenGroups = [], restoreAiListOpen = false, restoreOpenRows = [], }) => {
    const selectedAI = currentAI || aiConfigs[0]?.name || "";
    const selectedModel = aiConfigs.find((item) => item.name === selectedAI)?.model ||
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
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "stats" }, runtimeStats.map((item) => (React.createElement("div", { className: "stat", key: item.label },
            React.createElement("div", { className: "stat-label" }, item.label),
            React.createElement("div", { className: `stat-value tone-${item.tone}` }, item.value))))),
        React.createElement("section", { className: "panel" },
            React.createElement("div", { className: "panel-head" },
                React.createElement("div", { className: "panel-title" }, "\u914D\u7F6E\u7BA1\u7406"),
                React.createElement("div", { className: "toolbar" },
                    React.createElement("button", { className: "subtle" }, "\u91CD\u8F7D"),
                    React.createElement("button", { className: "subtle" }, "\u6821\u9A8C"),
                    React.createElement("button", { className: "primary" }, "\u4FDD\u5B58"))),
            panelMessage ? (React.createElement("div", { className: `notice ${panelStatus === "error" ? "error" : "success"}` }, panelMessage)) : null,
            React.createElement("div", { className: "config-layout" },
                React.createElement("div", { className: "section" },
                    React.createElement("details", { className: "group-manager", open: restoreGroupListOpen || groupConfigs.length <= 3 },
                        React.createElement("summary", { className: "group-manager-summary" },
                            React.createElement("div", { className: "summary-title" },
                                React.createElement("span", { className: "summary-main" }, "\u7FA4\u914D\u7F6E"),
                                React.createElement("span", { className: "summary-meta" },
                                    "Redis \u7FA4\u914D\u7F6E\u89C6\u56FE\uFF0C\u5171 ",
                                    groupConfigs.length,
                                    " \u4E2A guid")),
                            React.createElement("span", { className: "summary-caret", "aria-hidden": "true" }, "\u203A")),
                        React.createElement("div", { className: "source-note" },
                            "\u5148\u6309 ",
                            React.createElement("strong", null, "guid"),
                            " ",
                            "\u67E5\u770B\u7FA4\u914D\u7F6E\u3002\u5C55\u5F00\u540E\u4FEE\u6539\u5F53\u524DAI\u3001\u4E0A\u4E0B\u6587\u957F\u5EA6\u548C\u5404\u4E2A\u5F00\u5173\uFF0C \u4FDD\u5B58\u65F6\u5199\u56DE\u8FD9\u4E2A guid \u5BF9\u5E94\u7684 Redis \u914D\u7F6E\u3002"),
                        React.createElement("form", { action: "/panel/action/add-group-config", className: "panel-action-form group-add-card", method: "post" },
                            React.createElement("div", { className: "group-fields" },
                                React.createElement("div", { className: "field" },
                                    React.createElement("label", { htmlFor: "new-group-guid" }, "\u65B0\u589E\u7FA4\u53F7 guid"),
                                    React.createElement("input", { id: "new-group-guid", name: "guid", placeholder: "\u4F8B\u5982 123456789" })),
                                React.createElement("div", { className: "field" },
                                    React.createElement("label", { htmlFor: "new-group-ai" }, "\u9ED8\u8BA4AI"),
                                    React.createElement("select", { id: "new-group-ai", name: "currentAI", defaultValue: "" },
                                        React.createElement("option", { value: "" }, "\u5148\u4E0D\u6307\u5B9A"),
                                        aiConfigs.map((item) => (React.createElement("option", { key: `new-group-${item.name}`, value: item.name }, item.name))))),
                                React.createElement("div", { className: "field" },
                                    React.createElement("label", { htmlFor: "new-group-chat-switch" }, "\u804A\u5929\u603B\u5F00\u5173"),
                                    React.createElement("select", { id: "new-group-chat-switch", name: "chatSwitch", defaultValue: "0" },
                                        React.createElement("option", { value: "0" }, "\u5148\u5173\u95ED"),
                                        React.createElement("option", { value: "1" }, "\u521B\u5EFA\u65F6\u5F00\u542F")))),
                            React.createElement("div", { className: "group-add-actions" },
                                React.createElement("div", { className: "group-add-toggle" }, "\u521B\u5EFA\u540E\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u4E0B\u9762\u7684\u7FA4\u914D\u7F6E\u5217\u8868\u91CC\u3002"),
                                React.createElement("button", { className: "primary", type: "submit" }, "\u6DFB\u52A0\u7FA4"))),
                        React.createElement("div", { className: "group-list" }, groupConfigs.length ? (groupConfigs.map((group) => (React.createElement("details", { className: "group-row", "data-guid": group.guid, key: group.guid, open: restoreOpenGroups.includes(group.guid) },
                            React.createElement("summary", { className: "group-summary" },
                                React.createElement("div", { className: "summary-title" },
                                    React.createElement("span", { className: "summary-main" },
                                        "\u7FA4\u53F7 ",
                                        group.guid),
                                    React.createElement("span", { className: "summary-meta" },
                                        group.currentAI || "未切换AI",
                                        " /",
                                        " ",
                                        group.model || "未设置模型",
                                        " / \u5DF2\u5F00",
                                        countEnabledGroupSwitches(group),
                                        " \u9879")),
                                React.createElement("span", { className: "summary-caret", "aria-hidden": "true" }, "\u203A")),
                            React.createElement("div", { className: "group-body" },
                                React.createElement("form", { action: "/panel/action/update-group-config", className: "panel-action-form", method: "post" },
                                    React.createElement("input", { type: "hidden", name: "guid", value: group.guid }),
                                    React.createElement("div", { className: "group-fields" },
                                        React.createElement("div", { className: "field" },
                                            React.createElement("label", { htmlFor: `group-ai-${group.guid}` }, "\u5F53\u524DAI"),
                                            React.createElement("select", { id: `group-ai-${group.guid}`, name: "currentAI", defaultValue: group.currentAI },
                                                React.createElement("option", { value: "" }, "\u4FDD\u6301\u5F53\u524D"),
                                                aiConfigs.map((item) => (React.createElement("option", { key: `${group.guid}-${item.name}`, value: item.name }, item.name))))),
                                        React.createElement("div", { className: "field" },
                                            React.createElement("label", { htmlFor: `group-model-${group.guid}` }, "\u5F53\u524D\u6A21\u578B"),
                                            React.createElement("input", { id: `group-model-${group.guid}`, value: group.model || "未设置", readOnly: true })),
                                        React.createElement("div", { className: "field" },
                                            React.createElement("label", { htmlFor: `group-context-${group.guid}` }, "CAPI\u4E0A\u4E0B\u6587\u957F\u5EA6"),
                                            React.createElement("input", { id: `group-context-${group.guid}`, name: "capiContextLimit", defaultValue: String(group.capiContextLimit) }))),
                                    React.createElement("div", { className: "switch-list" }, panelGroupSwitchDefinitions.map((item) => (React.createElement("div", { className: "switch-row", key: `${group.guid}-${item.key}` },
                                        React.createElement("div", null,
                                            React.createElement("div", { className: "switch-label" }, item.label),
                                            React.createElement("div", { className: "switch-desc" }, item.desc)),
                                        React.createElement("label", { className: "switch", "aria-label": `${group.guid}-${item.label}` },
                                            React.createElement("input", { defaultChecked: group.switches[item.key], name: item.key, type: "checkbox" }),
                                            React.createElement("span", { className: "track" })))))),
                                    React.createElement("div", { className: "group-form-actions" },
                                        React.createElement("button", { className: "primary", type: "submit" }, "\u4FDD\u5B58\u672C\u7FA4\u914D\u7F6E")))))))) : (React.createElement("div", { className: "empty-state" }, "\u8FD8\u6CA1\u6709\u53D1\u73B0\u4EFB\u4F55 guid \u914D\u7F6E\u3002\u7B49\u7FA4\u804A\u91CC\u4EA7\u751F AI \u914D\u7F6E\u6216\u5F00\u5173\u6570\u636E\u540E\uFF0C\u8FD9\u91CC\u5C31\u4F1A\u5217\u51FA\u6765\u3002"))))),
                React.createElement("div", { className: "section" },
                    React.createElement("h2", { className: "section-title" }, "\u5F53\u524D\u9884\u89C8"),
                    React.createElement("div", { className: "field-grid" },
                        React.createElement("div", { className: "field" },
                            React.createElement("label", { htmlFor: "current-ai" }, "\u5F53\u524DAI"),
                            React.createElement("select", { id: "current-ai", defaultValue: selectedAI }, aiConfigs.length ? (aiConfigs.map((item) => (React.createElement("option", { key: item.name, value: item.name }, item.name)))) : (React.createElement("option", { value: "" }, "\u6682\u65E0Redis AI\u914D\u7F6E")))),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", { htmlFor: "model" }, "\u6A21\u578B"),
                            React.createElement("input", { id: "model", defaultValue: selectedModel })),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", { htmlFor: "context" }, "\u4E0A\u4E0B\u6587\u957F\u5EA6"),
                            React.createElement("input", { id: "context", defaultValue: "512k" })),
                        React.createElement("div", { className: "field" },
                            React.createElement("label", { htmlFor: "master" }, "\u7BA1\u7406\u5458"),
                            React.createElement("input", { id: "master", defaultValue: "3501869534" }))),
                    React.createElement("details", { className: "ai-manager", open: restoreAiListOpen || aiConfigs.length <= 3 },
                        React.createElement("summary", { className: "ai-manager-summary" },
                            React.createElement("div", { className: "summary-title" },
                                React.createElement("span", { className: "summary-main" }, "AI\u5217\u8868"),
                                React.createElement("span", { className: "summary-meta" },
                                    "Redis ai:model:*\uFF0C\u5171 ",
                                    aiConfigs.length,
                                    " \u4E2A\u914D\u7F6E")),
                            React.createElement("span", { className: "summary-caret", "aria-hidden": "true" }, "\u203A")),
                        React.createElement("div", { className: "source-note" },
                            "\u6570\u636E\u6765\u6E90\uFF1ARedis \u7684 ",
                            React.createElement("strong", null, "ai:model:*"),
                            "\u3002\u65E7\u7248",
                            React.createElement("strong", null, " ai:list:*"),
                            " \u4F1A\u81EA\u52A8\u5F52\u7C7B\u4E3A other \u5E76\u8FC1\u79FB\uFF1B\u6DFB\u52A0\u540E\u5199\u5165\u5E26\u5382\u5546 ID \u7684\u6A21\u578B\u952E\uFF0C\u5207\u6362\u5F53\u524D\u4F1A\u8BDD\u65F6\u5199\u5165",
                            React.createElement("strong", null, " ai:currentAI:<guid>"),
                            " \u5E76\u540C\u6B65",
                            React.createElement("strong", null, " ai:config:<guid>"),
                            "\u3002\u5F53\u524D\u64CD\u4F5C\u76EE\u6807\uFF1A",
                            React.createElement("strong", null,
                                " ",
                                currentGuid),
                            "\u3002"),
                        redisError ? (React.createElement("div", { className: "error-note" },
                            "Redis\u8BFB\u53D6\u5931\u8D25\uFF1A",
                            redisError)) : null,
                        React.createElement("div", { className: "ai-manager-actions" },
                            React.createElement("button", { className: "subtle" }, "\u6DFB\u52A0AI")),
                        React.createElement("div", { className: "ai-list" }, aiConfigs.length ? (aiConfigs.map((item) => (React.createElement("details", { className: "ai-row", "data-ai-name": item.name, key: item.name, open: restoreOpenRows.includes(item.name) },
                            React.createElement("summary", { className: "ai-row-summary" },
                                React.createElement("div", { className: "summary-title" },
                                    React.createElement("span", { className: "summary-main" }, item.name),
                                    React.createElement("span", { className: "summary-meta" },
                                        item.model || "未设置模型",
                                        " /",
                                        " ",
                                        item.host || "未设置host")),
                                React.createElement("span", { className: "summary-caret", "aria-hidden": "true" }, "\u203A")),
                            React.createElement("div", { className: "ai-row-body" },
                                React.createElement("div", { className: "ai-row-actions" },
                                    React.createElement("form", { action: "/panel/action/use-ai", className: "panel-action-form", method: "post" },
                                        React.createElement("input", { type: "hidden", name: "name", value: item.name }),
                                        React.createElement("input", { type: "hidden", name: "guid", value: currentGuid }),
                                        React.createElement("button", { className: "primary", type: "submit" }, "\u4F7F\u7528\u8FD9\u4E2AAI")),
                                    React.createElement("form", { action: "/panel/action/delete-ai", className: "panel-action-form", method: "post" },
                                        React.createElement("input", { type: "hidden", name: "name", value: item.name }),
                                        React.createElement("button", { className: "subtle danger", type: "submit" }, "\u5220\u9664AI"))),
                                React.createElement("div", { className: "ai-fields" },
                                    React.createElement("div", { className: "field" },
                                        React.createElement("label", { htmlFor: `ai-name-${item.name}` }, "AI\u540D\u79F0"),
                                        React.createElement("input", { id: `ai-name-${item.name}`, defaultValue: item.name })),
                                    React.createElement("div", { className: "field" },
                                        React.createElement("label", { htmlFor: `ai-host-${item.name}` }, "\u4E3B\u673A\u5730\u5740 host"),
                                        React.createElement("input", { id: `ai-host-${item.name}`, defaultValue: item.host })),
                                    React.createElement("div", { className: "field" },
                                        React.createElement("label", { htmlFor: `ai-key-${item.name}` }, "api_key"),
                                        React.createElement("input", { id: `ai-key-${item.name}`, type: "password", defaultValue: item.key })),
                                    React.createElement("div", { className: "field" },
                                        React.createElement("label", { htmlFor: `ai-model-${item.name}` }, "\u6A21\u578B"),
                                        React.createElement("input", { id: `ai-model-${item.name}`, defaultValue: item.model })))))))) : (React.createElement("div", { className: "empty-state" }, "Redis \u4E2D\u8FD8\u6CA1\u6709 AI \u6A21\u578B\u914D\u7F6E\uFF0C\u53EF\u901A\u8FC7 #\u6DFB\u52A0ai \u6216\u540E\u7EED\u9762\u677F\u8868\u5355\u521B\u5EFA\u3002")))),
                    React.createElement("h2", { className: "section-title" }, "Redis\u6570\u636E\u9884\u89C8"),
                    React.createElement("textarea", { className: "editor", spellCheck: false, defaultValue: createRedisPreview(aiConfigs, currentAI, redisError) }),
                    React.createElement("h2", { className: "section-title" }, "\u914D\u7F6E\u6587\u4EF6"),
                    React.createElement("textarea", { className: "editor", spellCheck: false, defaultValue: configValue }))))));
};
const ChatPage = ({ aiConfigs = [], currentAI = "", chatGuid = "global", chatUserId = "webuser", chatNickname = chatUserId, chatModel = "", groupGuidOptions = [], workspaceNames = [], promptOptions = [], currentPrompt = "", chatMessages = [], currentGroupConfig = null, panelStatus = "", panelMessage = "", chatConfigOpen = false, }) => {
    const chatHref = `/panel/chat?guid=${encodeURIComponent(chatGuid)}&userId=${encodeURIComponent(chatUserId)}&nickname=${encodeURIComponent(chatNickname)}`;
    const modelLabel = chatModel || currentAI || "AI Chat";
    const hasMessages = chatMessages.length > 0;
    return (React.createElement("section", { className: "panel chat-panel" },
        panelMessage ? (React.createElement("div", { className: `notice ${panelStatus === "error" ? "error" : "success"}` }, panelMessage)) : null,
        React.createElement("div", { className: "chat-layout" },
            React.createElement(ChatConfigPanel, { aiConfigs: aiConfigs, currentAI: currentAI, chatGuid: chatGuid, chatUserId: chatUserId, chatNickname: chatNickname, chatModel: chatModel, groupGuidOptions: groupGuidOptions, workspaceNames: workspaceNames, promptOptions: promptOptions, currentPrompt: currentPrompt, currentGroupConfig: currentGroupConfig, chatHref: chatHref, idPrefix: "desktop", className: "chat-config-panel chat-config-panel-desktop", defaultOpen: true }),
            React.createElement("div", { className: "chat-main" },
                React.createElement("div", { className: "chat-head" },
                    React.createElement(ChatConfigPanel, { aiConfigs: aiConfigs, currentAI: currentAI, chatGuid: chatGuid, chatUserId: chatUserId, chatNickname: chatNickname, chatModel: chatModel, groupGuidOptions: groupGuidOptions, workspaceNames: workspaceNames, promptOptions: promptOptions, currentPrompt: currentPrompt, currentGroupConfig: currentGroupConfig, chatHref: chatHref, idPrefix: "mobile", className: "chat-config-panel chat-config-panel-mobile", defaultOpen: chatConfigOpen }),
                    React.createElement("div", { className: "chat-model-pill" },
                        React.createElement("span", null, modelLabel)),
                    React.createElement("div", { className: "chat-top-actions" },
                        React.createElement("a", { className: "chat-icon-button", href: chatHref, "aria-label": "\u5237\u65B0" }, "\u5237\u65B0"),
                        React.createElement("form", { action: "/panel/action/clear-chat", className: "clear-chat-form", method: "post" },
                            React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                            React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                            React.createElement("input", { type: "hidden", name: "nickname", value: chatNickname }),
                            React.createElement("button", { className: "chat-icon-button", type: "submit", "aria-label": "\u6E05\u7A7A\u804A\u5929" }, "\u6E05\u7A7A")))),
                React.createElement("div", { className: `messages ${hasMessages ? "" : "empty"}` }, hasMessages ? (chatMessages.map((item, index) => (React.createElement("div", { className: `message ${item.from}`, key: `${item.from}-${index}-${item.time}` },
                    React.createElement("div", { className: "message-meta" },
                        React.createElement("span", null, item.name),
                        React.createElement("span", null, item.time)),
                    item.text ? (React.createElement("div", { className: "message-text" }, item.text)) : null,
                    item.images?.length ? (React.createElement("div", { className: "message-images" }, item.images.map((image, imageIndex) => (React.createElement("img", { alt: "AI\u56DE\u590D\u56FE\u7247", key: `${image}-${imageIndex}`, src: image }))))) : null)))) : (React.createElement("div", { className: "chat-empty-state" },
                    React.createElement("h2", null, "\u6709\u4EC0\u4E48\u53EF\u4EE5\u5E2E\u5FD9\u7684\uFF1F"),
                    React.createElement("div", { className: "chat-empty-meta" },
                        "\u7FA4\u53F7 ",
                        chatGuid,
                        " / ",
                        chatNickname,
                        "(",
                        chatUserId,
                        ")")))),
                React.createElement("div", { className: "composer" },
                    React.createElement("form", { action: "/panel/action/chat", className: "chat-composer-form", method: "post" },
                        React.createElement("input", { type: "hidden", name: "guid", value: chatGuid }),
                        React.createElement("input", { type: "hidden", name: "userId", value: chatUserId }),
                        React.createElement("input", { type: "hidden", name: "nickname", value: chatNickname }),
                        React.createElement("div", { className: "composer-row" },
                            React.createElement("textarea", { "aria-label": "\u804A\u5929\u8F93\u5165", name: "message", placeholder: "\u8F93\u5165\u6D88\u606F...", required: true, defaultValue: "" }),
                            React.createElement("div", { className: "chat-form-actions" },
                                React.createElement("button", { className: "send-button", type: "submit", "aria-label": "\u53D1\u9001" }, "\u2191")))))))));
};
const PanelStateScript = ({ restoreScrollY }) => (React.createElement("script", { dangerouslySetInnerHTML: {
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
    } }));
const PanelNoticeScript = () => (React.createElement("script", { dangerouslySetInnerHTML: {
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
    } }));
const PanelChatScript = () => (React.createElement("script", { dangerouslySetInnerHTML: {
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
    } }));
function PanelPreview({ page = "config", aiConfigs = [], groupConfigs = [], currentAI = "", currentGuid = "global", redisError = "", panelStatus = "", panelMessage = "", restoreGroupListOpen = true, restoreOpenGroups = [], restoreAiListOpen = false, restoreOpenRows = [], restoreScrollY, chatGuid = currentGuid, chatUserId = "webuser", chatNickname = chatUserId, chatModel = "", groupGuidOptions = [], workspaceNames = [], promptOptions = [], currentPrompt = "", chatMessages = [], currentGroupConfig = null, chatConfigOpen = false, }) {
    return (React.createElement("html", null,
        React.createElement("head", null,
            React.createElement("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
            React.createElement("title", null, "AlemonJS AI \u9762\u677F"),
            React.createElement(AppStyle, null)),
        React.createElement("body", null,
            React.createElement("main", { className: `shell ${page === "chat" ? "chat-shell" : ""}` },
                React.createElement("header", { className: `header ${page === "chat" ? "chat-page-header" : ""}` },
                    React.createElement("div", { className: "brand" },
                        React.createElement("div", { className: "logo" }, "AI"),
                        React.createElement("div", null,
                            React.createElement("h1", null, "AlemonJS Aichat"),
                            React.createElement("div", { className: "meta" }, "\u7F51\u9875\u63A7\u5236\u53F0"))),
                    renderNav(page)),
                page === "chat" ? (React.createElement(ChatPage, { aiConfigs: aiConfigs, currentAI: currentAI, chatGuid: chatGuid, chatUserId: chatUserId, chatNickname: chatNickname, chatModel: chatModel, groupGuidOptions: groupGuidOptions, workspaceNames: workspaceNames, promptOptions: promptOptions, currentPrompt: currentPrompt, chatMessages: chatMessages, currentGroupConfig: currentGroupConfig, panelStatus: panelStatus, panelMessage: panelMessage, chatConfigOpen: chatConfigOpen })) : (React.createElement(ConfigPage, { aiConfigs: aiConfigs, groupConfigs: groupConfigs, currentAI: currentAI, currentGuid: currentGuid, redisError: redisError, panelStatus: panelStatus, panelMessage: panelMessage, restoreGroupListOpen: restoreGroupListOpen, restoreOpenGroups: restoreOpenGroups, restoreAiListOpen: restoreAiListOpen, restoreOpenRows: restoreOpenRows }))),
            React.createElement(PanelStateScript, { restoreScrollY: restoreScrollY }),
            React.createElement(PanelNoticeScript, null),
            page === "chat" ? React.createElement(PanelChatScript, null) : null)));
}

export { PanelPreview as default };
