import { chromium } from 'playwright-core';
import { validateURL } from './security.js';

let browserPromise = null;
const normalizeInteger = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(Math.trunc(parsed), max));
};
const normalizePublicUrl = (value) => {
    const input = String(value || "").trim();
    if (!input)
        throw new Error("url 不能为空");
    return /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
};
const buildSearchUrl = (query, engine) => {
    const encoded = encodeURIComponent(query);
    if (engine === "google")
        return `https://www.google.com/search?q=${encoded}`;
    if (engine === "baidu")
        return `https://www.baidu.com/s?wd=${encoded}`;
    return `https://www.bing.com/search?q=${encoded}`;
};
const launchBrowser = async (config) => {
    const headless = config.headless !== false;
    if (config.executablePath?.trim()) {
        return await chromium.launch({
            executablePath: config.executablePath.trim(),
            headless,
            timeout: 15000,
        });
    }
    const preferredChannel = config.channel?.trim();
    const channels = preferredChannel
        ? [preferredChannel]
        : process.platform === "win32"
            ? ["msedge", "chrome"]
            : ["chrome", "msedge"];
    const errors = [];
    for (const channel of channels) {
        try {
            return await chromium.launch({ channel, headless, timeout: 15000 });
        }
        catch (error) {
            errors.push(`${channel}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
    }
    throw new Error(`未找到可控制的本地浏览器，请安装 Chrome/Edge，或配置 aiChat.localBrowser.channel / executablePath。${errors.length ? ` 尝试结果：${errors.join("；")}` : ""}`);
};
const getBrowser = async (config) => {
    if (browserPromise) {
        try {
            const browser = await browserPromise;
            if (browser.isConnected())
                return browser;
        }
        catch {
            // 上一次启动失败，下面重新尝试。
        }
        browserPromise = null;
    }
    browserPromise = launchBrowser(config);
    try {
        const browser = await browserPromise;
        browser.once("disconnected", () => {
            browserPromise = null;
        });
        return browser;
    }
    catch (error) {
        browserPromise = null;
        throw error;
    }
};
const protectBrowserContext = async (context) => {
    const validationCache = new Map();
    await context.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        let parsed;
        try {
            parsed = new URL(requestUrl);
        }
        catch {
            await route.abort("blockedbyclient");
            return;
        }
        if (["data:", "blob:", "about:"].includes(parsed.protocol)) {
            await route.continue();
            return;
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
            await route.abort("blockedbyclient");
            return;
        }
        const cacheKey = `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
        let validation = validationCache.get(cacheKey);
        if (!validation) {
            validation = validateURL(requestUrl).then(() => true);
            validationCache.set(cacheKey, validation);
        }
        try {
            await validation;
            await route.continue();
        }
        catch {
            validationCache.delete(cacheKey);
            await route.abort("blockedbyclient");
        }
    });
};
const extractSearchResults = async (page, engine, maxResults) => {
    return await page.evaluate(({ selectedEngine, limit }) => {
        const selectors = {
            bing: "li.b_algo",
            google: "a:has(h3)",
            baidu: "#content_left .result, #content_left .c-container",
        };
        const nodes = Array.from(document.querySelectorAll(selectors[selectedEngine] || "a"));
        const results = [];
        const seen = new Set();
        for (const node of nodes) {
            const anchor = node.tagName === "A" ? node : node.querySelector("h2 a, h3 a, a");
            const titleNode = node.querySelector("h2, h3") || anchor;
            const snippetNode = node.querySelector(".b_caption p, .VwiC3b, .c-abstract, [class*=content-right]");
            const url = anchor && "href" in anchor ? String(anchor.href) : "";
            const title = titleNode?.textContent?.replace(/\s+/g, " ").trim() || "";
            const snippet = snippetNode?.textContent?.replace(/\s+/g, " ").trim() || "";
            if (!title || !/^https?:\/\//i.test(url) || seen.has(url))
                continue;
            seen.add(url);
            results.push({ title, url, snippet });
            if (results.length >= limit)
                break;
        }
        return results;
    }, { selectedEngine: engine, limit: maxResults });
};
const extractPage = async (page, maxChars) => {
    return await page.evaluate((limit) => {
        const root = document.querySelector("main, article, [role=main]") || document.body;
        const content = (root?.innerText || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        const links = [];
        const seen = new Set();
        for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
            const url = "href" in anchor ? String(anchor.href) : "";
            const text = anchor.textContent?.replace(/\s+/g, " ").trim() || "";
            if (!text || !/^https?:\/\//i.test(url) || seen.has(url))
                continue;
            seen.add(url);
            links.push({ text: text.slice(0, 200), url });
            if (links.length >= 30)
                break;
        }
        return {
            title: document.title,
            content: content.slice(0, limit),
            truncated: content.length > limit,
            links,
        };
    }, maxChars);
};
const runLocalBrowser = async (options, config = {}) => {
    const action = options.action;
    if (action !== "search" && action !== "visit") {
        throw new Error("action 只支持 search 或 visit");
    }
    const engine = options.engine || "bing";
    const maxResults = normalizeInteger(options.maxResults, 5, 1, 10);
    const maxChars = normalizeInteger(options.maxChars, 12000, 1000, 30000);
    const targetUrl = action === "search"
        ? buildSearchUrl(String(options.query || "").trim(), engine)
        : normalizePublicUrl(String(options.url || ""));
    if (action === "search" && !String(options.query || "").trim()) {
        throw new Error("action=search 时 query 不能为空");
    }
    await validateURL(targetUrl);
    const browser = await getBrowser(config);
    const context = await browser.newContext({
        acceptDownloads: false,
        locale: "zh-CN",
        serviceWorkers: "block",
    });
    try {
        await protectBrowserContext(context);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const response = await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });
        await validateURL(page.url());
        if (action === "search") {
            const results = await extractSearchResults(page, engine, maxResults);
            return {
                success: true,
                action,
                engine,
                query: String(options.query).trim(),
                pageTitle: await page.title(),
                finalUrl: page.url(),
                status: response?.status() ?? null,
                results,
            };
        }
        const extracted = await extractPage(page, maxChars);
        return {
            success: true,
            action,
            requestedUrl: targetUrl,
            finalUrl: page.url(),
            status: response?.status() ?? null,
            ...extracted,
        };
    }
    finally {
        await context.close().catch(() => undefined);
    }
};

export { runLocalBrowser };
