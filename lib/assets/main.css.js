const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('main.css-CPAjKP-V.css', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
