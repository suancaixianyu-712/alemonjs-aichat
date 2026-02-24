
## 1.安装

### yarn安装方式(推荐)

```
yarn add alemonjs-aichat
```

### alemongo安装方式

地址
```
https://gitee.com/suancaixianyu/alemonjs-aichat.git 
```

分支
```
release
```

## 2.配置`alemon.config.yaml`
在配置中添加该插件, 使用`ALemonDesk`只需要启用插件即可
``` yaml
app: 
  - 'alemonjs-aichat'
```

## 3.配置redis
`alemon.config.yaml`
``` yaml
redis:
  host: '127.0.0.1'
  port: 6379
  password: ''

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
