
## 安装

### 克隆仓库安装
适合在没有部署alemonjs的环境中安装
``` bash
# 克隆release分支
git clone -b release https://gitee.com/suancaixianyu/alemonjs-aichat.git
cd alemongjs-aichat
yarn
```

### npm安装
适合在已经部署alemonjs的环境中安装, 在alemonjs项目根目录下执行
``` bash
yarn add alemonjs-aichat
```

## 配置 `alemon.config.yaml`

1. 将`alemon.config.example.yaml`重命名为`alemon.config.yaml`
``` bash
mv alemon.config.example.yaml alemon.config.yaml
```
如果你的目中已经有`alemon.config.yaml`请略过此步骤

1. 启用`alemonjs-aichat`
``` yaml
app: 
  - 'alemonjs-aichat'
```

1. 配置redis
`alemon.config.yaml`
``` yaml
redis:
  host: '127.0.0.1'
  port: 6379
  password: ''
```
你也可以选择为插件单独配置redis
``` yaml
aiChat:
  redis:
    host: '127.0.0.1'
    port: 6379
    password: ''
```
aiChat.redis优先级高于全局redis配置
插件使用的存储key为`ai:*`

## 其他功能配置
- 语音回复
该功能依赖于B站up主的开发的GPT-Sovits整合包:
[【GPT-Sovits V4推理特化一键包，完全免费开源，内含大量模型（原神，崩铁等），亦可训练】](https://www.bilibili.com/video/BV1j7TszYE27/?share_source=copy_web&vd_source=545e30adee8fc4af7b2d9c4d7c3ad713)

此外, 你还需要在`alemon.config.yaml`中配置TTS服务器地址, 并且确保该地址能够从外网访问
```yaml
aiChat:
  ttsServer:
    host: "http://127.0.0.1:8005"
```

- 图片审核
  
该功能依赖于百度云的内容安全审核服务, 你需要在`alemon.config.yaml`中配置百度云的AK/SK和审核策略ID, 具体配置项如下:
```yaml
aiChat:
  baidu:
    ak: ''
    sk: ''
```
使用指令`/不可以色色``/可以色色`开启或关闭图片审核功能, 默认开启, 但如果没有配置AK/SK, 则无法使用图片审核功能

## 使用
指令`/ai帮助`查看使用方法
