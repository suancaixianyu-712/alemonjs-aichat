import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readArchive } from "../lib/api/archive-reader.js";

import { makeZip, makeTar } from "./helpers/archive-fixtures.mjs";

test("ZIP 支持 stored/deflate，只读目录和指定文件", () => {
  for (const method of [0, 8]) {
    const entries = readArchive(makeZip("src/说明.md", Buffer.from("中文说明"), { method }), "code.zip");
    assert.equal(entries[0].path, "src/说明.md");
    assert.equal(entries[0].read().toString(), "中文说明");
  }
});
test("tar.gz 按魔数读取，兼容 QQ .tar(1).gz 文件名", () => {
  const entries = readArchive(gzipSync(makeTar([{ name: "sss-tools/package.json", data: Buffer.from('{"name":"sss-tools"}') }])), "sss-tools.tar(1).gz");
  assert.equal(entries[0].path, "sss-tools/package.json");
  assert.match(entries[0].read().toString(), /sss-tools/);
});
test("TAR 支持 GNU 长文件名和 PAX UTF-8 路径", () => {
  const long = "目录/" + "a".repeat(120) + ".txt";
  const gnu = readArchive(makeTar([{ name: "././@LongLink", type: "L", data: Buffer.from(long + "\0") }, { name: "short.txt", data: Buffer.from("内容") }]), "a.tar");
  assert.equal(gnu[0].path, long);
  const value = "path=目录/说明.txt\n";
  let size = Buffer.byteLength(value) + 3;
  while (Buffer.byteLength(`${size} ${value}`) !== size) size = Buffer.byteLength(`${size} ${value}`);
  const pax = readArchive(makeTar([{ name: "PaxHeaders/a", type: "x", data: Buffer.from(`${size} ${value}`) }, { name: "short", data: Buffer.from("中文") }]), "a.tar");
  assert.equal(pax[0].path, "目录/说明.txt");
});
test("拒绝路径穿越、绝对路径、链接内容和加密 ZIP", () => {
  for (const name of ["../secret", "a/../../secret", "/etc/passwd", "C:\\secret"]) {
    assert.throws(() => readArchive(makeZip(name, Buffer.from("secret")), "a.zip"), /不安全路径/);
    assert.throws(() => readArchive(makeTar([{ name }]), "a.tar"), /不安全路径/);
  }
  assert.throws(() => readArchive(makeZip("link", Buffer.from("target"), { attrs: 0xa000 << 16 }), "a.zip")[0].read(), /不跟随链接/);
  assert.throws(() => readArchive(makeZip("a", Buffer.from("a"), { flags: 1 }), "a.zip")[0].read(), /加密/);
  assert.throws(() => readArchive(makeTar([{ name: "link", type: "2" }]), "a.tar")[0].read(), /不跟随链接/);
});
test("损坏、CRC 不符、超大声明及 gzip 解压炸弹明确失败", () => {
  assert.throws(() => readArchive(Buffer.from("broken"), "a.zip"), /损坏/);
  const zip = makeZip("a", Buffer.from("abc"), { method: 0 });
  zip[31] ^= 1;
  assert.throws(() => readArchive(zip, "a.zip")[0].read(), /CRC/);
  assert.throws(() => readArchive(makeZip("a", Buffer.from("x"), { size: 101 * 1024 * 1024 }), "a.zip"), /上限/);
  const bomb = gzipSync(Buffer.alloc(101 * 1024 * 1024));
  assert.throws(() => readArchive(bomb, "a.tar.gz"), /larger|length|size/i);
});
