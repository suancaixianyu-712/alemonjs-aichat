module.exports = {
  apps: [
    {
      name: "alemon-aichat",
      cwd: __dirname,
      script: "index.js",
      interpreter: process.execPath,
      env: { NODE_ENV: "production" },
    },
  ],
};
