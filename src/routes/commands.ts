import { defineRouter, lazy } from "alemonjs";
import { Regular } from "alemonjs/utils";

export const children = [
  // help
  {
    regular: /(\/|#)(ai)?(指令|帮助|菜单|功能)$/i,
    handler: lazy(() => import("../response/help/res")),
  },

  // tools (多条正则合并)
  {
    regular: Regular.or(
      /(\/|#)(ai)?(pt|p图|ps|修图)(.*)$/i,
      /(\/|#)(ai)?(画图)(.*)$/i,
      /(\/|#)(ai)?(生成视频)(.*)$/i,
      /(\/|#)(ai)?(查询)(.*)$/i,
      /(\/|#)(ai)?(开启|关闭)?画图提示词优化$/i,
      /^(\/|#)(.+)说([\s\S]*)$/i,
      /^(\/|#)安装语音(模型)?(.+)$/i,
      /^(\/|#)看魔法$/i,
    ),
    handler: lazy(() => import("../response/tools/res")),
  },

  // config
  {
    regular: Regular.or(
      /^(\/|#)(ai配置|当前提示词|查看提示词)$/i,
      /^(\/|#)ai列表$/i,
      /^(\/|#)提示词列表$/i,
      /^(\/|#)清空对话$/i,
      /^(\/|#)清空(所有|全部)对话$/i,
      /^(\/|#)get (.+)$/i,
      /(\/|#)(开启)?(new|新对话|新会话)$/i,
      /^(\/|#)ai状态$/,
    ),
    handler: lazy(() => import("../response/config/res")),
  },

  // setting (包含大量子命令)
  {
    regular: Regular.or(
      /(\/|#)添加ai$/i,
      /(\/|#)添加ai\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i,
      /(\/|#)(切换)(ai|配置) ?(.*)/i,
      /(\/|#)添加提示词$/i,
      /(\/|#)添加提示词 (\S+) ([\s\S]+)/i,
      /(\/|#)(删除)(提示词|提示词列表) ?(.*)/i,
      /(\/|#)(切换|设置)提示词 ?(.*)$/i,
      /(\/|#)清空提示词$/i,
      /(\/|#)删除ai\s(\S+)$/i,
      /(\/|#)(开启|启用|关闭|禁用)好感度$/i,
      /(\/|#)(开启|关闭)(全部)?聊天$/i,
      /(\/|#)(开启|关闭)语音回复$/i,
      /(\/|#)切换图床(.*)$/i,
      /(\/|#)修改 ?(.+) ?模型 ?(.+)$/i,
      /(\/|#)(关闭|开启)复杂(输出|回复)$/i,
      /(\/|#)(关闭|禁止|不可以|不允许|开启|可以|允许)(涩涩|色色)$/i,
      /(\/|#)切换模型(.*)$/i,
      /(\/|#)(关闭|开启)主动(搭话|回复)$/i,
      /(\/|#)(开启|关闭)深度思考$/i,
      /(\/|#)(设置|修改)(ai)?(.*)rapi模式(开启|关闭)$/i,
      /(\/|#)(开启|关闭)仅艾特触发$/i,
      /(\/|#)添加正则规则 (.+)$/i,
      /(\/|#)(删除|移除)正则规则 (.+)$/i,
      /(\/|#)正则规则列表$/i,
      /(\/|#)清空正则规则$/i,
      /(\/|#)切换群容器$/i,
      /(\/|#)切换用户容器$/i,
      /(\/|#)切换系统环境$/i,
      /(\/|#)工具列表$/i,
      /(\/|#)(开启|关闭)(MCP)?工具$/i,
      /(\/|#)(开启|关闭)工具(.*)$/i,
      /(\/|#)(开启|关闭)工具提示$/i,
      /(\/|#)(开启|关闭)工具(调用)?提示撤回$/i,
      /(\/|#)(开启|关闭)工具(调用)?提示详情$/i,
      /(\/|#)测试$/i,
      /(\/|#)设置渲染精度\s*(中|高|超高)$/i,
    ),
    handler: lazy(() => import("../response/setting/res")),
  },

  // affection
  {
    regular: Regular.or(
      /(\/|#)(查看)?好感度?$/i,
      /(\/|#)(重置|清空)(全部|所有)?好感度?$/i,
    ),
    handler: lazy(() => import("../response/affection/res")),
  },
  // fallback: zreply - 最低优先级，处理普通对话
  // {
  //   regular: /.*/,
  //   handler: lazy(() => import("../response/zreply/res")),
  // },
];

// 路由优先级：exact -> prefix -> regular
export default defineRouter([
  {
    selects: ["message.create", "private.message.create"],
    handler: lazy(() => import("../response/mw")),
    children: children,
  },
]);
