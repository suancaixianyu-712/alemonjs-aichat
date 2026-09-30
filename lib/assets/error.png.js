const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('error-DJzYQZ11.png', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
