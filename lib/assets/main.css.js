const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('main.css-Ca9AXT93.css', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
