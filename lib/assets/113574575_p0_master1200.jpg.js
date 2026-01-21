const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('113574575_p0_master1200-BncvWC99.jpg', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
