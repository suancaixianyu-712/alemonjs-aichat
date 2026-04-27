import React from "react";
import { defineConfig } from "jsxp";
import Help from "@src/image/conponent/help";
export default defineConfig({
  routes: {
    "/": {
      component: <Help />,
    },
  },
});
