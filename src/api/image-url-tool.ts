import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mime from "mime-types";
import { validateURL } from "./security";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageUrlToolResult = Array<{
  type: "image_url";
  image_url: { url: string };
}>;

const isWithinRoot = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const resolveLocalImage = async (input: string) => {
  if (path.isAbsolute(input)) {
    throw new Error("本地图片必须使用相对于 alémonjs 主工程的相对路径");
  }

  const root = await fs.realpath(PROJECT_ROOT);
  const candidate = path.resolve(root, input);
  if (!isWithinRoot(root, candidate)) {
    throw new Error("图片路径超出 alémonjs 主工程范围");
  }

  const target = await fs.realpath(candidate);
  if (!isWithinRoot(root, target)) {
    throw new Error("图片路径通过符号链接指向了主工程外部");
  }

  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("图片路径不是文件");
  if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error("本地图片不能超过 20MB");
  }

  const mimeType = mime.lookup(target);
  if (!mimeType || !String(mimeType).startsWith("image/")) {
    throw new Error("相对路径必须指向受支持的图片文件");
  }

  const content = await fs.readFile(target);
  return `data:${mimeType};base64,${content.toString("base64")}`;
};

export const convertToImageUrlContent = async (
  address: string,
): Promise<ImageUrlToolResult> => {
  const input = String(address || "").trim();
  if (!input) throw new Error("图片地址不能为空");

  let url: string;
  if (/^https?:\/\//i.test(input)) {
    await validateURL(input);
    url = input;
  } else {
    url = await resolveLocalImage(input);
  }

  return [{ type: "image_url", image_url: { url } }];
};

export const isImageUrlToolContent = (value: unknown): value is ImageUrlToolResult =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item) =>
      item?.type === "image_url" &&
      typeof item?.image_url?.url === "string" &&
      item.image_url.url.length > 0,
  );
