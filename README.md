
## 安装

### 前置条件
- nodejs 20+
- yarn 1.22+
- redis 5+

安装依赖时更推荐使用yarn, 也可以使用npm, 但需要将命令中的`yarn`替换为`npm install`

或者安装`yarn`:
``` bash
npm install -g yarn
```

### 克隆仓库安装
适合在没有部署alemonjs的环境中安装
``` bash
# 克隆release分支
git clone -b release https://gitee.com/suancaixianyu/alemonjs-aichat.git
cd alemonjs-aichat
yarn
```

### npm安装
适合在已经部署alemonjs的环境中安装, 在alemonjs项目根目录下执行
``` bash
yarn add alemonjs-aichat
```

## 配置 `alemon.config.yaml`

1. 将`alemon.config.example.yaml`复制重命名为`alemon.config.yaml`
``` bash
cp alemon.config.example.yaml alemon.config.yaml
```
如果你的目中已经有`alemon.config.yaml`请略过此步骤

2. 启用`alemonjs-aichat`
``` yaml
app: 
  - 'alemonjs-aichat'
```

3. 配置redis
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

- onebot平台
  
在使用onebot平台时, 还需要安装onebot服务端, 例如[napcat](https://napneko.github.io/),使用napcat创建ws服务端, 并且在`alemon.config.yaml`中配置napcat的ws地址
```yaml
onebot:
  url: 'ws://127.0.0.1:3001' # 正向url
  token: '' # token
  reverse_enable: false # 启用后正向连接配置失效，地址：ws://127.0.0.1:17158
  reverse_port: 17158 # 返向连接服务端口，启用反向连接后生效
  master_id: ['3501869534'] # 主人QQ号列表
```

- 其他平台
详情请参考[Alemonjs连接平台](https://alemonjs.com/docs/environment)文档

## 使用
指令`/ai帮助`查看使用方法
