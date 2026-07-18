import { defineConfig } from "lvyjs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const includes = (value: string) => process.argv.includes(value);
const cbpPort = process.env.ALEMON_PORT || process.env.port;
const alemonjs = () =>
  import("alemonjs").then((res) => {
    const options = {
      input: "src/index.ts",
      ...(cbpPort ? { port: Number(cbpPort) } : {}),
    };
    res.start(options);
  });
const jsxp = () =>
  import("./src/panel/server").then((res) => res.createPanelServer());
const jsxpPreview = () =>
  import("jsxp").then(({ createServer }) => createServer());
export default defineConfig({
  plugins: [
    () =>
      includes("--jsxp") ? jsxpPreview : includes("--view") ? jsxp : alemonjs,
  ],
  alias: {
    entries: [{ find: "@src", replacement: join(__dirname, "src") }],
  },
});
