const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('main.css-8e9_v8Ap.css', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
