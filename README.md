
## 1.安装

安装中遇到问题可访问alemonjs官网查询[https://alemonjs.com/docs](https://alemonjs.com/docs)

### yarn安装方式(推荐)
前置条件:
安装alemonjs: [alemonjs官网](https://alemonjs.com)

``` sh
yarn add alemonjs-aichat
```

```sh
## 运行
yarn start
```

### git拉取项目安装

```sh
git clone git@gitee.com:suancaixianyu/alemonjs-aichat.git
cd alemonjs-aichat
yarn
```

```sh
## 运行
yarn dev

## 打包
yarn build
```

## 2.配置

#### 配置app
在配置中添加该插件, 才能正常触发指令

如果使用的是git拉取项目的方式, 就不需要配置这个
``` yaml
app: 
  - 'alemonjs-aichat'
```

#### 配置redis 
`alemon.config.yaml`
``` yaml
redis:
  # host默认 127.0.0.1
  host: '127.0.0.1' 
  # 端口号默认 6379
  port: 6379
  # 无密码则留空或者不写, 默认无密码
  password: ''
```

#### 配置AI修图 
修图基于xai的grok接口实现, 该接口返回的图片也是xai的, 在特定平台中可能无法发送此图片,这时候可以用自己写个代理将图片转为可访问状态

已知无需转换的平台: `QQ`,`Bubble`
`alemon.config.yaml`
``` yaml
# 代理默认可不填
xaiImgProxy: 'http://127.0.0.1:3002/ximgen'
```

ai修图依赖于xai, 需要使用该功能必须添加一个grok模型, 在启动机器人后, 使用以下指令添加
```
#添加ai grok https://api.x.ai/v1 <你的apiKey> grok-4-1-fast-non-reasoning
```
通常情况下nodejs不会使用本地的代理, 因此你可能需要自己解决一下无法访问ai的问题, 例如另写一个脚本, 脚本已经预备好了, 下载项目中的`daili.js`然后运行它即可(Clash的默认端口一般是7890, 可能需要修改一下daili.js中的端口)
``` sh
node daili
```

如果你使用的是`daili.js`, 那么地址需要改为`http://127.0.0.1:3002/x/v1`

#### 配置搜索工具
网页搜索功能基于[https://serpapi.com](https://serpapi.com)的接口制作
需要前往他们的官网获取key
`alemon.config.yaml`
``` yaml
# 默认无, 可能无法使用网页搜索
searchApiKey: ''
```

#### 配置管理员
`alemon.config.yaml`
``` yaml
# 默认无, 小部分功能需要管理员权限才能使用
master_id: ['3501869534']
```

## 4.使用

需要先使用`#添加ai`,配置一个ai后才能使用对话功能

|指令|作用|
|---|---|
|#添加ai|添加一个ai, 重名时更新|
|#切换ai|切换一个ai配置并保留当前对话|
|#开启对话|在当前位置启用ai聊天|
|#ai配置|显示当前使用的配置|
|#添加提示词|添加一个提示词|
|#提示词列表|查看当前配置的所有提示词|
|#切换提示词|切换一个提示词并保留当前对话|
|#清空对话|清空当前对话并保留好感度|
|#开启好感度|好感度会影响回复时的语气|
|#好感度|查看自己的好感度|
|#ai帮助|查看更多指令|
