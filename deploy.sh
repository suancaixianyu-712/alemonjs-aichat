#!/bin/bash

# 设置项目路径（根据你的项目路径进行修改）
PROJECT_PATH="./"

# 切换到项目目录
cd "$PROJECT_PATH" || { echo "项目路径不存在，请检查路径！"; exit 1; }

# 检查是否在Git仓库中
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "当前目录不是一个Git仓库，请确保你在Git仓库中运行此脚本！"
  exit 1
fi

# 检查release分支是否存在，不存在则创建
if ! git show-ref --verify --quiet refs/heads/release; then
  echo "release分支不存在，正在创建..."
  git checkout -b release
else
  echo "切换到release分支..."
  git checkout release
fi

# 添加指定文件和文件夹到暂存区
git add README.md package.json lib/

# 提交更改
echo "提交更改到release分支..."
git commit -m "Update README.md, package.json and lib folder"

# 推送到远程release分支
echo "推送到远程release分支..."
git push origin release
git checkout master

echo "操作完成！"