/** 判断字符串是否应按本地文件路径读取，而不是按纯 Base64 解码。 */
const isLikelyLocalImagePath = (source) => source.length < 4096 &&
    /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(source);

export { isLikelyLocalImagePath };
