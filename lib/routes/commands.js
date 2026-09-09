import { lazy, defineRouter } from 'alemonjs';
import { Regular } from 'alemonjs/utils';
import { resolveCommandOutput, COMMAND_OUTPUT_CAPTURE } from '../utils/command-message.js';

const commandChildren = [
    {
        regular: /^(\/|#)(开启网页(?:\s+.*)?|关闭网页|网页状态)$/,
        handler: lazy(() => import('../response/panel/res.js')),
    },
    // help
    {
        regular: /(\/|#)(ai)?(指令|帮助|菜单|功能)$/i,
        handler: lazy(() => import('../response/help/res.js')),
    },
    // system status
    {
        regular: /^(\/|#)系统状态$/i,
        handler: lazy(() => import('../response/system-status/res.js')),
    },
    // revoke
    {
        regular: /^(\/|#)撤回$/i,
        handler: lazy(() => import('../response/revoke/res.js')),
    },
    // restart
    {
        regular: /^(\/|#)重启$/i,
        handler: lazy(() => import('../response/restart/res.js')),
    },
    // aichat update
    {
        regular: /^(\/|#)aichat更新$/i,
        handler: lazy(() => import('../response/update/res.js')),
    },
    // stop task
    {
        regular: /^(\/|#)(终止|停止)任务$/i,
        handler: lazy(() => import('../response/stop/res.js')),
    },
    // tools (多条正则合并)
    {
        regular: Regular.or(/^(\/|#)grok画图(?:\s+[\s\S]*)?$/i, /(\/|#)(ai)?(画图)(.*)$/i, /(\/|#)(ai)?(生成视频)(.*)$/i, /(\/|#)(ai)?(查询)(.*)$/i, /(\/|#)(ai)?(开启|关闭)?画图提示词优化$/i, /^(\/|#)(.+)说([\s\S]*)$/i, /^(\/|#)安装语音(模型)?(.+)$/i, /^(\/|#)看魔法$/i, /^(\/|#)转图片$/i, /^(\/|#)grok画图配置(?:\s+[\s\S]*)?$/i, /^(\/|#)gpt画图配置(?:\s+[\s\S]*)?$/i, /^(\/|#)gpt画图(?:\s+[\s\S]*)?$/i),
        handler: lazy(() => import('../response/tools/res.js')),
    },
    // config
    {
        regular: Regular.or(/^(\/|#)(ai配置|当前提示词|查看提示词)$/i, /^(\/|#)ai列表$/i, /^(\/|#)提示词列表$/i, /^(\/|#)清空对话$/i, /^(\/|#)删除对话$/i, /^(\/|#)清空(所有|全部)对话$/i, /^(\/|#)get (.+)$/i, /^(\/|#)ai状态$/i),
        handler: lazy(() => import('../response/config/res.js')),
    },
    // switch AI
    {
        regular: /^(#|\/)切换(?:ai|配置)(?:\s+.+)?$/i,
        handler: lazy(() => import('../response/switch-ai/res.js')),
    },
    // switch API protocol
    {
        regular: /^(#|\/)切换接口(?:\s+(?:capi|rapi))?$/i,
        handler: lazy(() => import('../response/switch-api/res.js')),
    },
    // third-party tool sessions
    {
        regular: Regular.or(/^(#|\/)切换工具(?:\s*(?:opencode|默认))?$/i, /^(#|\/)(?:修改|设置)权限(?:\s*(?:只读|手动确认|自动审核|完全访问))?$/i, /^(#|\/)new$/i, /^(#|\/)会话列表$/i, /^(#|\/)models$/i, /^(#|\/)model(?:\s+.+)?$/i, /^(#|\/)切换会话(?:\s+.+)?$/i),
        handler: lazy(() => import('../response/tool-session/res.js')),
    },
    // provider built-in tools
    {
        regular: /^(#|\/)(关闭|开启)(ai)?内置工具 ?(.*)$/i,
        handler: lazy(() => import('../response/builtin-tools/res.js')),
    },
    // setting (包含大量子命令)
    {
        regular: Regular.or(/(\/|#)添加提示词$/i, /(\/|#)添加提示词 (\S+) ([\s\S]+)/i, /(\/|#)(删除)(提示词|提示词列表) ?(.*)/i, /(\/|#)(切换|设置)提示词 ?(.*)$/i, /(\/|#)清空提示词$/i, /(\/|#)删除ai\s(\S+)$/i, /(\/|#)(开启|启用|关闭|禁用)好感度$/i, /(\/|#)(开启|关闭)(全部)?聊天$/i, /(\/|#)(开启|关闭)语音回复$/i, /(\/|#)(开启|关闭)图床$/i, /^(\/|#)(开启|关闭)代理$/i, /(\/|#)切换图床(.*)$/i, /(\/|#)修改 ?(.+) ?模型 ?(.+)$/i, /(\/|#)(关闭|开启)复杂(输出|回复)$/i, /(\/|#)(关闭|禁止|不可以|不允许|开启|可以|允许)(涩涩|色色)$/i, /(\/|#)切换模型(.*)$/i, /(\/|#)(关闭|开启)主动(搭话|回复)$/i, /(\/|#)(开启|关闭)深度思考$/i, /(#|\/)设置(AI)?上下文(长度)? ?([0-9]+)(k|m)/i, /^(#|\/)(配|配置|设置)(ocr|识图)(ai)?\s*(.*)$/i, /(\/|#)(开启|关闭)仅艾特触发$/i, /(\/|#)(开启|关闭)bot信息$/i, /(\/|#)添加正则规则 (.+)$/i, /(\/|#)(删除|移除)正则规则 (.+)$/i, /(\/|#)正则规则列表$/i, /(\/|#)清空正则规则$/i, /(\/|#)工具列表$/i, /(\/|#)(开启|关闭)(MCP)?工具$/i, /(\/|#)(开启|关闭)工具(.*)$/i, /(\/|#)(开启|关闭)限制([0-9]+)?$/i, /(\/|#)(开启|关闭)工具提示$/i, /(\/|#)(开启|关闭)工具(调用)?提示撤回$/i, /(\/|#)(开启|关闭)工具(调用)?提示详情$/i, /(\/|#)(开启|关闭)工具调用内容$/i, /(\/|#)测试$/i, /(\/|#)设置渲染精度\s*(中|高|超高)$/i, /(\/|#)(开启|关闭)agent$/i, /(\/|#)设置心跳\s+(.+)$/i, /(\/|#)关闭心跳$/i),
        handler: lazy(() => import('../response/setting/res.js')),
    },
    // affection
    {
        regular: Regular.or(/(\/|#)(查看)?好感度?$/i, /(\/|#)(重置|清空)(全部|所有)?好感度?$/i),
        handler: lazy(() => import('../response/affection/res.js')),
    },
];
const children = [
    ...commandChildren,
    // 普通 AI 对话放在响应路由末尾，不参与全局中间件处理。
    {
        regular: /.*/,
        handler: lazy(() => import('../response/ai-chat/res.js')),
    },
];
/**
 * 使用当前消息事件直接执行一条本插件框架指令。
 *
 * 旧式 defineRouter 会在进入中间件前完成子路由匹配，因此中间件结束后再改
 * MessageText 并调用 next() 不会重新匹配命令。AI 工具需要显式找到同一份路由
 * 定义并调用对应处理器，才能真正执行指令，同时保留原用户、会话和权限字段。
 */
const executeAlemonCommand = async (event, command, options = {}) => {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand) {
        return { matched: false, command: normalizedCommand };
    }
    for (const route of commandChildren) {
        if (!route.regular || !route.handler)
            continue;
        route.regular.lastIndex = 0;
        if (!route.regular.test(normalizedCommand))
            continue;
        const capture = {
            sendToUser: options.sendToUser === true,
            payloads: [],
        };
        const commandEvent = {
            ...event,
            MessageText: normalizedCommand,
            msg: normalizedCommand,
            raw_message: normalizedCommand,
            Xianyu: false,
            [COMMAND_OUTPUT_CAPTURE]: capture,
        };
        delete commandEvent.__route;
        const loadedHandler = await route.handler();
        const selectedEvents = Array.isArray(loadedHandler?.select)
            ? loadedHandler.select
            : [loadedHandler?.select].filter(Boolean);
        if (selectedEvents.length > 0 &&
            !selectedEvents.includes(commandEvent.name)) {
            continue;
        }
        const executables = typeof loadedHandler === "function"
            ? [loadedHandler]
            : Array.isArray(loadedHandler?.current)
                ? loadedHandler.current
                : [loadedHandler?.current].filter((current) => typeof current === "function");
        if (executables.length === 0) {
            throw new Error(`指令处理器不可执行: ${normalizedCommand}`);
        }
        for (const executable of executables) {
            const result = await executable(commandEvent, () => undefined);
            if (result !== true)
                break;
        }
        return {
            matched: true,
            command: normalizedCommand,
            sentToUser: capture.sendToUser,
            output: await resolveCommandOutput(capture),
        };
    }
    return { matched: false, command: normalizedCommand };
};
// 路由优先级：exact -> prefix -> regular
var commands = defineRouter([
    {
        selects: ["message.create", "private.message.create"],
        handler: lazy(() => import('../response/mw.js')),
        children: children,
    },
]);

export { children, commandChildren, commands as default, executeAlemonCommand };
