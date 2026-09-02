// 获取skills/下的文件夹,读取文件夹中的SKILL.md文件,并将其内容解析成对象返回
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAiChatConfigValue } from "../config/app";
const value = getAiChatConfigValue();
const currentDir = path.dirname(fileURLToPath(import.meta.url));

// 通用函数: 根据路径获取技能列表
export const loadSkillsFromPath = (skillsDir: string) => {
  if (!fs.existsSync(skillsDir)) {
    console.warn(`技能目录 ${skillsDir} 不存在`);
    return [];
  }

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

  return skills;
};

// 获取技能列表的简介和名称
// 技能列表缓存
let skillsCache: Array<{ name: string; description: string }> | null = null;

// 可选: 手动清理缓存
export const clearSkillsCache = () => {
  skillsCache = null;
};

export const loadSkills = (forceReload = false) => {
  // 命中缓存时直接返回,避免重复读取目录
  if (!forceReload && skillsCache) {
    return skillsCache;
  }

  const skillsDir = path.join(currentDir, "../../skills");
  const skills = loadSkillsFromPath(skillsDir);
  const externalSkills = loadExternalSkills();
  const allSkills = [...skills, ...externalSkills];

  // 根据name和description去重
  const uniqueSkills = allSkills.filter(
    (skill, index, self) =>
      index ===
      self.findIndex(
        (s) => s.name === skill.name && s.description === skill.description,
      ),
  );

  skillsCache = uniqueSkills;
  return uniqueSkills;
};

// 获取某个技能的详情, 通过技能名称匹配对应文件夹下的所有md文件,将内容一并返回
export const loadSkillDetail = (skillName: string) => {
  // 首先检查本地skills目录
  const localSkillsDir = path.join(currentDir, "../../skills");
  let result = loadSkillDetailFromPath(localSkillsDir, skillName);

  // 如果本地没有找到,检查外部skills目录
  if (!result && value.skills_dir) {
    const externalDirs = Array.isArray(value.skills_dir)
      ? value.skills_dir
      : [value.skills_dir];

    for (const dir of externalDirs) {
      result = loadSkillDetailFromPath(dir, skillName);
      if (result) break;
    }
  }

  return result;
};

// 从指定路径加载技能详情
const loadSkillDetailFromPath = (skillsDir: string, skillName: string) => {
  if (!fs.existsSync(skillsDir)) {
    return null;
  }

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

// 加载外部skills, 通过配置文件中的skills_dir字段指定技能目录,读取该目录下的技能文件夹,并将其内容解析成对象返回
export const loadExternalSkills = () => {
  if (Array.isArray(value.skills_dir)) {
    // 如果是数组,加载所有目录下的技能
    const allSkills = value.skills_dir.flatMap((dir: string) => {
      return loadSkillsFromPath(dir);
    });
    // console.log(`加载外部技能: ${allSkills.length}个`);
    return allSkills;
  }

  const skillsDir = value.skills_dir || path.join(currentDir, "../../skills");
  const skills = loadSkillsFromPath(skillsDir);
  // console.log(`加载外部技能: ${skills.length}个`);
  return skills;
};
