const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('bg-top-Bb9gOIXN.png', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
