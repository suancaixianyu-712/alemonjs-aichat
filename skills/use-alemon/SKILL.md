---
name: use-alemon
description: 调用alemonjs框架的工具, 需要配合`EvalCode`工具使用, 来执行alemonjs框架的代码, 达到调用alemonjs框架的工具的目的.
---

# Use Alemon Skill

此处的技能都依赖`EvalCode`工具, 执行alemonjs框架的代码, 来达到调用alemonjs框架的工具的目的.

## 1. 将本地文件上传到s3, 获取文件链接

```javascript
import { uploadImageToR2 } from "@src/s3";
const filePath = "本地文件路径, 相对或绝对路径均可";
const fileUrl = await uploadImageToR2(filePath);
```
