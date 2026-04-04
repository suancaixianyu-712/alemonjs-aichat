// 获取skills/下的文件夹,读取文件夹中的SKILL.md文件,并将其内容解析成对象返回
import fs from "fs";
import path from "path";
import { getConfigValue } from "alemonjs";
const value = getConfigValue().aiChat || {};

// 获取技能列表的简介和名称
export const loadSkills = () => {
  const skillsDir = path.join(process.cwd(), "src/skills");
  const skillFolders = fs.readdirSync(skillsDir).filter((file) => {
    const skillPath = path.join(skillsDir, file);
    return fs.statSync(skillPath).isDirectory();
  });

  const skills = skillFolders.map((folder) => {
    const skillPath = path.join(skillsDir, folder);
    const skillFile = path.join(skillPath, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      const content = fs.readFileSync(skillFile, "utf-8");
      const lines = content.split("\n").map((line) => line.trim());
      const nameLine = lines.find((line) => line.startsWith("name:"));
      const descLine = lines.find((line) => line.startsWith("description:"));
      const name = nameLine ? nameLine.replace("name:", "").trim() : folder;
      const description = descLine
        ? descLine.replace("description:", "").trim()
        : "";
      return {
        name,
        description,
      };
    } else {
      return {
        name: folder,
        description: "",
      };
    }
  });

  console.log(`加载技能: ${skills.length}个`);

  return skills;
};

// 获取某个技能的详情, 通过技能名称匹配对应文件夹下的所有md文件,将内容一并返回
export const loadSkillDetail = (skillName: string) => {
  const skillsDir = path.join(process.cwd(), "src/skills");
  const skillFolders = fs.readdirSync(skillsDir).filter((file) => {
    const skillPath = path.join(skillsDir, file);
    return fs.statSync(skillPath).isDirectory();
  });

  const skillFolder = skillFolders.find((folder) => folder === skillName);
  if (!skillFolder) {
    return null;
  }

  const skillPath = path.join(skillsDir, skillFolder);
  const files = fs
    .readdirSync(skillPath)
    .filter((file) => file.endsWith(".md"));
  const details = files.map((file) => {
    const filePath = path.join(skillPath, file);
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      file,
      content,
    };
  });

  return {
    name: skillName,
    details,
  };
};
