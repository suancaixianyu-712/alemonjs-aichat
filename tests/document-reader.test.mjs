import assert from "node:assert/strict";
import { test, mock } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { makeZip } from "./helpers/archive-fixtures.mjs";

mock.module(new URL("../lib/api/fileMessage.js", import.meta.url).href, { namedExports: {
  fetchFileBuffer: async () => null,
  isImageFile: (name) => /\.(png|jpe?g)$/i.test(name),
  isTextLikeFile: (name) => /\.(txt|md|json)$/i.test(name),
} });
const { extractDocumentText } = await import("../lib/api/document-reader.js");
const { parseChatFileContent } = await import("../lib/api/chat-file.js");

const makePdf = (text) => {
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
};

test("PDF 提取真实文字并分页，空白/扫描 PDF 不冒充已读取", async () => {
  const result = await parseChatFileContent(makePdf("Hello PDF attachment"), "report.pdf", { action: "read", offset: 6, maxChars: 3 });
  assert.equal(result.kind, "document"); assert.equal(result.fileName, "report.pdf");
  assert.equal(result.content, "PDF"); assert.equal(result.truncated, true);
  await assert.rejects(extractDocumentText(makePdf(""), "scan.pdf"), /扫描件/);
});

test("DOCX 提取中文正文，直接发送或位于压缩包内都能阅读", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文件正文：中文合同内容</w:t></w:r></w:p></w:body></w:document>');
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const result = await parseChatFileContent(bytes, "合同.docx", { action: "inspect" });
  assert.equal(result.kind, "document"); assert.match(result.content, /中文合同内容/);
  const archived = await parseChatFileContent(makeZip("合同.docx", bytes), "documents.zip", { action: "read", entryPath: "合同.docx" });
  assert.match(archived.content, /中文合同内容/);
});

test("XLSX 提取工作表、行列位置、中文和公式缓存结果，不计算公式", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("预算");
  sheet.addRow(["项目", "金额"]); sheet.addRow(["收入", 123]);
  sheet.getCell("C2").value = { formula: "1+1", result: 2 };
  workbook.addWorksheet("说明").getCell("A1").value = "实际数据";
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await parseChatFileContent(bytes, "预算.xlsx", { action: "read" });
  assert.equal(result.kind, "document");
  assert.match(result.content, /工作表.*预算/); assert.match(result.content, /2\t1: 收入\t2: 123\t3: 2/);
  assert.match(result.content, /实际数据/);
});

test("旧格式、损坏文档及展开超限明确失败", async () => {
  for (const name of ["a.doc", "a.xls"]) await assert.rejects(extractDocumentText(Buffer.from("file"), name), /另存为/);
  await assert.rejects(extractDocumentText(Buffer.from("broken"), "broken.docx"), /损坏/);
  await assert.rejects(extractDocumentText(makeZip("large.xml", Buffer.from("a"), { size: 101 * 1024 * 1024 }), "large.docx"), /上限|超过|超限/);
});
