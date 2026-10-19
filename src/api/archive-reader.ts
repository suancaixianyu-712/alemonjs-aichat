import { gunzipSync, inflateRawSync } from "node:zlib";

// 不依赖新版本 Node.js 才提供的 zlib.crc32。
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (buffer: Buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const MAX_EXPANDED = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
export type ArchiveEntry = { path: string; size: number; kind: "file" | "directory" | "link"; read: () => Buffer };
const safeName = (name: string) => {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new Error("压缩包含不安全路径，拒绝解析");
  }
  return normalized.replace(/^(\.\/)+/, "");
};
const checkedEntries = (entries: ArchiveEntry[]) => {
  if (entries.length > MAX_ENTRIES || entries.reduce((n, item) => n + item.size, 0) > MAX_EXPANDED) {
    throw new Error("压缩包超过 5000 项或 100 MB 展开上限");
  }
  return entries;
};
const zipEntries = (buffer: Buffer): ArchiveEntry[] => {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0) throw new Error("ZIP 目录损坏");
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error("暂不支持分卷 ZIP");
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let pos = buffer.readUInt32LE(end + 16);
  if (count === 65535 || pos === 0xffffffff || centralSize === 0xffffffff) throw new Error("暂不支持 ZIP64");
  if (count > MAX_ENTRIES || pos + centralSize > end) throw new Error("ZIP 目录超限或损坏");
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("ZIP 文件头损坏");
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const checksum = buffer.readUInt32LE(pos + 16);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const attrs = buffer.readUInt32LE(pos + 38);
    const offset = buffer.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > end || size === 0xffffffff || offset === 0xffffffff) throw new Error("ZIP 项损坏或使用 ZIP64");
    const name = safeName(buffer.subarray(pos + 46, pos + 46 + nameLength).toString("utf8"));
    const kind = name.endsWith("/") ? "directory" : ((attrs >>> 16) & 0xf000) === 0xa000 ? "link" : "file";
    entries.push({ path: name, size, kind, read: () => {
      if (kind !== "file") throw new Error("只允许读取普通文件，不跟随链接");
      if (flags & 1) throw new Error("暂不支持加密 ZIP");
      if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏");
      const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
      if (start + compressed > buffer.length || size > MAX_EXPANDED) throw new Error("ZIP 文件大小无效");
      const source = buffer.subarray(start, start + compressed);
      const data = method === 0 ? source : method === 8 ? inflateRawSync(source, { maxOutputLength: MAX_EXPANDED }) : null;
      if (!data) throw new Error("暂不支持该 ZIP 压缩算法");
      if (data.length !== size) throw new Error("ZIP 文件大小校验失败");
      if (crc32(data) !== checksum) throw new Error("ZIP 文件 CRC 校验失败");
      return data;
    } });
    pos = next;
  }
  return checkedEntries(entries);
};
const tarString = (buffer: Buffer, start: number, length: number) => buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
const tarNumber = (buffer: Buffer, start: number, length: number) => {
  if (buffer[start] & 0x80) throw new Error("暂不支持 TAR base-256 数字");
  const value = parseInt(tarString(buffer, start, length).trim() || "0", 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("TAR 数字字段损坏");
  return value;
};
const paxFields = (data: Buffer) => {
  const result: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(32, pos);
    const size = Number(data.subarray(pos, space).toString());
    if (space < pos || !Number.isSafeInteger(size) || size <= space - pos + 1 || pos + size > data.length) throw new Error("PAX 记录损坏");
    const record = data.subarray(space + 1, pos + size - 1).toString("utf8");
    const equal = record.indexOf("=");
    if (equal > 0) result[record.slice(0, equal)] = record.slice(equal + 1);
    pos += size;
  }
  return result;
};
const tarEntries = (buffer: Buffer): ArchiveEntry[] => {
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  let longName = "";
  let pax: Record<string, string> = {};
  while (pos + 512 <= buffer.length) {
    const header = buffer.subarray(pos, pos + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = tarNumber(header, 148, 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) throw new Error("TAR 文件头校验失败");
    const size = tarNumber(header, 124, 12);
    const start = pos + 512;
    if (start + size > buffer.length) throw new Error("TAR 文件内容不完整");
    const data = buffer.subarray(start, start + size);
    const type = String.fromCharCode(header[156]);
    pos = start + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = tarString(data, 0, data.length).replace(/\n$/, ""); continue; }
    if (type === "x") { pax = paxFields(data); continue; }
    if (type === "g") { continue; }
    const prefix = tarString(header, 345, 155);
    const name = safeName(pax.path || longName || (prefix ? prefix + "/" : "") + tarString(header, 0, 100));
    if (pax.size && Number(pax.size) !== size) throw new Error("暂不支持 PAX 覆盖文件大小");
    longName = ""; pax = {};
    const kind = type === "5" ? "directory" : type === "0" || type === "\0" ? "file" : "link";
    entries.push({ path: name, size, kind, read: () => {
      if (kind !== "file") throw new Error("只允许读取普通文件，不跟随链接");
      return data;
    } });
    if (entries.length > MAX_ENTRIES) throw new Error("TAR 超过 5000 项上限");
  }
  if (!entries.length) throw new Error("不是可识别的 TAR 压缩包，或内容为空");
  return checkedEntries(entries);
};

export const readArchive = (buffer: Buffer, name: string): ArchiveEntry[] | null => {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return zipEntries(buffer);
  if (/\.zip$/i.test(name)) return zipEntries(buffer);
  // 按魔数识别 gzip，兼容 QQ 重命名为 .tar(1).gz 的文件。
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return tarEntries(gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED }));
  if (/\.tar$/i.test(name) || tarString(buffer, 257, 5) === "ustar") return tarEntries(buffer);
  return null;
};
