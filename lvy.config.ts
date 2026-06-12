import { defineConfig } from "lvyjs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const includes = (value: string) => process.argv.includes(value);
const alemonjs = () =>
  import("alemonjs").then((res) => res.start("src/index.ts"));
const jsxp = () => import("./src/panel/server").then((res) => res.createPanelServer());
export default defineConfig({
  plugins: [() => (includes("--view") ? jsxp : alemonjs)],
  alias: {
    entries: [{ find: "@src", replacement: join(__dirname, "src") }],
  },
});
