var title = "IA聊天插件";
var name = "aichat";
var version = "v1.0.3";
var by = "AlemonJS";
var list = [
	{
		group: {
			title: "配置操作",
			items: [
				{
					cmd: "/添加ai",
					desc: "添加新的AI聊天配置。"
				},
				{
					cmd: "/删除ai [名称]",
					desc: "删除已有的AI聊天配置。"
				},
				{
					cmd: "/ai配置",
					desc: "查看当前的ai配置"
				},
				{
					cmd: "/ai列表",
					desc: "查看当前可用的ai配置列表"
				},
				{
					cmd: "/切换ai [名称]",
					desc: "切换到指定名称的ai配置。"
				}
			]
		}
	},
	{
		group: {
			title: "提示词操作",
			items: [
				{
					cmd: "/添加提示词 [名称] [内容]",
					desc: "添加新的AI聊天配置。"
				},
				{
					cmd: "/删除提示词 [名称]",
					desc: "删除已有的AI聊天配置。"
				},
				{
					cmd: "/提示词列表",
					desc: "查看当前可用的提示词列表"
				},
				{
					cmd: "/清空提示词",
					desc: "清空当前的提示词设置"
				}
			]
		}
	},
	{
		group: {
			title: "聊天",
			items: [
				{
					cmd: "/[开启|关闭]好感度",
					desc: "开启或关闭好感度功能。"
				},
				{
					cmd: "/好感度",
					desc: "查看当前好感度状态。"
				},
				{
					cmd: "/清空好感度",
					desc: "清空当前用户的好感度数据。"
				},
				{
					cmd: "/清空对话",
					desc: "清空当前用户的对话记录。"
				}
			]
		}
	}
];
var help = {
	title: title,
	name: name,
	version: version,
	by: by,
	list: list
};

export { by, help as default, list, name, title, version };
