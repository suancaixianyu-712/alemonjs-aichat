---
name: send-build-artifact
description: 将 public/{guid}/ 内生成的构建产物、图片、音视频或其他文件上传到 R2 获取公网链接，并把链接发送给用户
---

# Send Build Artifact

这个技能用于把 AI agent 在项目工作目录里生成的文件发给用户。上传底层使用 `src/s3.ts` 中的 R2 能力；工具只允许读取 `public/{guid}/` 内的文件。

## Tools

- `AgentListFiles`: 查找构建产物所在目录。
- `AgentUploadFileToR2`: 上传 `public/{guid}/` 内的文件并返回公网链接。

## Workflow

1. 确认本次任务使用的 `guid`。
2. 构建或生成文件后，调用 `AgentListFiles` 查看产物目录，例如 `dist`、`build`、`out`、`exports`。
3. 选择要发送给用户的最终文件，不要上传中间缓存、临时文件或无关源码。
4. 调用 `AgentUploadFileToR2`：
   - 普通文件、压缩包、音频、视频、HTML、JSON 等使用 `uploadType: "file"`。
   - 图片预览或图片结果使用 `uploadType: "image"`。
   - 如果用户关心下载名或展示名，传入 `fileName`，例如 `report.zip`、`preview.png`。
5. 上传成功后，使用工具返回的 `sendText` 回复用户；如果需要解释，可同时附上 `url`。

## Rules

- `filePath` 必须是相对 `public/{guid}/` 的路径，不要传绝对路径或 `../`。
- 只能调用 `AgentListFiles` 和 `AgentUploadFileToR2` 查找并上传文件；不要调用 `exec`、终端命令、Docker、容器或远程节点。
- 发送图片时优先使用返回的 `<img=链接>` 格式。
- 发送普通文件时直接发送返回的链接文本。
- 如果上传失败，先检查文件是否存在、路径是否写对、是否在 `public/{guid}/` 内。
