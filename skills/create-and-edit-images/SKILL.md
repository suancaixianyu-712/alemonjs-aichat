---
name: create-and-edit-images
description: 创建和编辑图片, 例如根据文本描述生成图片, 或者对现有图片进行编辑
---

# Create and Edit Images Skill

创建和编辑图片的技能。

## Workflow

**Workflow 1: 根据文本描述生成图片**

1. 接收用户提供的文本描述
2. 判断用户的提示词是tag还是还自然语言
   - 如果是tag, 优先效用StableDiffusionGenerateImage工具函数画图
   - 如果是自然语言, 尝试将自然语言转换为tag, 使用StableDiffusionGenerateImage工具函数画图, 如果用户不满意, 则使用Photoshop工具函数画图. 如果用户没有提到修改之前的图片, 可选不传入图片链接
3. 将生成的图片链接返回给用户

**Workflow 2: 根据文本描述编辑图片**

1. 接收用户提供的图片链接和文本描述
2. 调用Photoshop工具函数进行图片编辑
3. 将编辑后的图片链接返回给用户

## Output Format

```text
<img=图片链接>
```
