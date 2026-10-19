import path from 'node:path';
import { readArchive } from './archive-reader.js';

const MAX_DOCUMENT_CHARS = 2_000_000;
const isDocumentFile = (name) => /\.(pdf|docx|xlsx|doc|xls)$/i.test(name);
/** 提取静态内容，不运行宏、公式、脚本，也不读取文档中的外部资源。 */
const extractDocumentText = async (buffer, name) => {
    const extension = path.extname(name).toLowerCase();
    if ([".doc", ".xls"].includes(extension))
        throw new Error("旧版 DOC/XLS 暂不支持，请另存为 DOCX/XLSX 后发送");
    if (buffer.length > 50 * 1024 * 1024)
        throw new Error("文档超过 50 MB 上限");
    let text = "";
    let truncated = false;
    if (extension === ".pdf") {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false });
        try {
            const result = await parser.getText({ first: 200 });
            text = result.text;
            truncated = result.total > 200;
            // PDF 库会给空页加页码分隔符，不能把分隔符冒充文档正文。
            if (!result.pages.some((page) => page.text.trim()))
                throw new Error("PDF 没有可提取文字，可能是扫描件；请发送页面图片以便识图");
        }
        finally {
            await parser.destroy();
        }
    }
    else if ([".docx", ".xlsx"].includes(extension)) {
        // 在交给解析器前检查 ZIP 总展开大小、路径及条目数量。
        const entries = readArchive(buffer, name);
        if (!entries || entries.reduce((size, entry) => size + entry.size, 0) > 100 * 1024 * 1024) {
            throw new Error("Office 文件损坏或解压后超过 100 MB");
        }
        if (extension === ".docx") {
            const mammoth = await import('mammoth');
            text = (await mammoth.extractRawText({ buffer })).value;
        }
        else {
            const { default: ExcelJS } = await import('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(buffer);
            const lines = [];
            let length = 0;
            for (const sheet of workbook.worksheets) {
                const heading = `[工作表] ${sheet.name}`;
                lines.push(heading);
                length += heading.length + 1;
                // 只遍历已存在的行/单元格，防止稀疏表触发巨量空行扫描。
                sheet.eachRow((row, rowNumber) => {
                    if (length >= MAX_DOCUMENT_CHARS) {
                        truncated = true;
                        return;
                    }
                    const cells = [];
                    row.eachCell((cell, column) => {
                        if (length >= MAX_DOCUMENT_CHARS) {
                            truncated = true;
                            return;
                        }
                        // cell.text 使用公式的缓存结果，不计算公式、不访问超链接。
                        const value = `${column}: ${cell.text}`;
                        cells.push(value.slice(0, MAX_DOCUMENT_CHARS - length));
                        length += value.length + 2;
                    });
                    lines.push(`${rowNumber}\t${cells.join("\t")}`);
                });
            }
            text = lines.join("\n");
        }
    }
    else
        throw new Error("不支持的文档类型");
    if (!text.trim())
        throw new Error("文档中没有可提取的文字内容");
    return { text: text.slice(0, MAX_DOCUMENT_CHARS), truncated: truncated || text.length > MAX_DOCUMENT_CHARS };
};

export { extractDocumentText, isDocumentFile };
