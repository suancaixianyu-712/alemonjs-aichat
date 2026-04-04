---
name: get-scbbs
description: 从scbbs获取信息, scbbs是一个为游戏"生存战争(简称sc)"的沙盒游戏提供的社区论坛, 可以从这里获取最新游戏咨询和玩家上传的资源
---

# Get SCBBS Skill

从scbbs获取信息, scbbs是一个为游戏"生存战争(简称sc)"的沙盒游戏提供的社区论坛, 可以从这里获取最新游戏咨询和玩家上传的资源
支持获取帖子和资源信息, 以及根据关键词搜索相关内容

## Workflow 1: 搜索帖子

1. 接收用户需要搜索的帖子关键词
2. 访问scbbs的搜索接口, 获取相关帖子列表
   - 搜索接口 `curl -s https://m.suancaixianyu.cn/api/post/list?type=1&orderType=3&page=1&limit=10&title={关键词}`

3. 从帖子列表中提取标题、链接和摘要等信息
4. 将提取的信息整理成易读的格式返回给用户

## Workflow 2: 获取资源信息

1. 接收用户需要搜索的资源关键词
2. 访问scbbs的资源搜索接口, 获取相关资源列表
   - 搜索接口 `curl -s https://m.suancaixianyu.cn/api/post/list?type=2&orderType=3&page=1&limit=10&title={关键词}`

3. 从资源列表中提取资源名称、下载链接和简介等信息
4. 将提取的信息整理成易读的格式返回给用户

## Workflow 3: 获取最新公告

1. 访问scbbs的公告接口, 获取最新公告列表
   - 公告接口 `curl -s https://m.suancaixianyu.cn/api/post/top?type=1,2,3`

2. 从公告列表中提取公告标题、链接和摘要等信息
3. 将提取的信息整理成易读的格式返回给用户

## Workflow 4: 获取指定帖子详情

1. 接收用户提供的帖子ID
2. 访问scbbs的帖子详情接口, 获取该帖子的详细信息
   - 帖子详情接口 `curl -s https://m.suancaixianyu.cn/api/post/detail?id={帖子ID}`

3. 从帖子详情中提取标题、内容、作者和发布时间等信息
4. 将提取的信息整理成易读的格式返回给用户

## Workflow 4: 获取最近更新的资源

1. 访问scbbs的帖子详情接口, 获取该帖子的详细信息
   - 帖子详情接口 `curl -s https://m.suancaixianyu.cn/api/post/list?type=2&orderType=3&page=1&limit=5`

2. 整理最新的资源信息, 包括资源名称、下载链接和简介等信息
3. 将提取的信息整理成易读的格式返回给用户

## Output Format

网页访问域名为https://www.scbbs.top
访问帖子为https://www.scbbs.top/#/postDetails/{帖子ID}
资源帖列表为https://www.scbbs.top/#/modList
交流帖列表为https://www.scbbs.top/#/postList
帖子资源类型(fileType)对应:1.存档 2.家具 3.材质 4.皮肤 5.模组 7.软件 8.联机模组

1. 如果是获取帖子或资源详情, 输出格式如下:

```text
标题: <帖子或资源标题>
链接: <帖子或资源链接>
摘要: <帖子或资源摘要>
作者: <帖子作者>
发布时间: <帖子发布时间>
点赞数: <帖子点赞数>
观看数: <帖子观看数>
资源列表:
- 资源名称: <资源名称>
  下载链接: <资源下载链接>
```

2. 如果是获取列表信息, 输出格式如下:

```text
标题: <帖子或资源标题>
链接: <帖子或资源链接>
作者: <帖子作者>
```
