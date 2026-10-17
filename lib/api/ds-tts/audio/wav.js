/** DS 朗读 PCM 的采样率。 */
const DS_PCM_SAMPLE_RATE = 24000;
/** DS 朗读 PCM 的声道数。 */
const DS_PCM_CHANNELS = 1;
/** DS 朗读 PCM 的位深。 */
const DS_PCM_BITS = 16;
/**
 * 把裸 PCM (s16le) 包成标准 44 字节头的 WAV。
 * @param pcm - 裸 PCM 字节。
 * @param sampleRate - 采样率，默认 24000。
 * @param channels - 声道数，默认 1。
 * @param bitsPerSample - 位深，默认 16。
 * @returns 完整 WAV 字节。
 */
function pcmToWav(pcm, sampleRate = DS_PCM_SAMPLE_RATE, channels = DS_PCM_CHANNELS, bitsPerSample = DS_PCM_BITS) {
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const writeAscii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1)
            header[offset + i] = text.charCodeAt(i);
    };
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeAscii(36, 'data');
    view.setUint32(40, pcm.length, true);
    const out = new Uint8Array(header.length + pcm.length);
    out.set(header, 0);
    out.set(pcm, header.length);
    return out;
}
/**
 * 按 PCM 字节数估算时长（秒）。
 * @param pcmBytes - 裸 PCM 字节数。
 * @param sampleRate - 采样率。
 * @param channels - 声道数。
 * @param bitsPerSample - 位深。
 * @returns 时长秒数；参数非法时为 0。
 */
function pcmDurationSeconds(pcmBytes, sampleRate = DS_PCM_SAMPLE_RATE, channels = DS_PCM_CHANNELS, bitsPerSample = DS_PCM_BITS) {
    const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
    if (bytesPerSecond <= 0 || pcmBytes <= 0)
        return 0;
    return pcmBytes / bytesPerSecond;
}
/**
 * 从 WAV 头读时长（用于缓存元数据校验）。
 * @param wav - WAV 字节。
 * @returns 时长秒数；头不合法时回退到按 PCM 估算。
 */
function wavDurationSeconds(wav) {
    if (wav.length < 44)
        return 0;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const sampleRate = view.getUint32(24, true);
    const byteRate = view.getUint32(28, true);
    const dataBytes = view.getUint32(40, true);
    if (byteRate <= 0 || sampleRate <= 0)
        return pcmDurationSeconds(Math.max(0, wav.length - 44));
    return dataBytes / byteRate;
}
/**
 * 依据魔数探测音频格式。
 * @param buf - 文件头若干字节。
 * @returns 识别到的扩展名，无法识别时为 'unknown'。
 */
function probeAudioMagic(buf) {
    if (buf.length >= 12 && String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...buf.subarray(8, 12)) === 'WAVE') {
        return 'wav';
    }
    // MP3：ID3 标签，或 MPEG 帧同步 0xFFEx/0xFFFx
    if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
        return 'mp3';
    if (buf.length >= 2 && buf[0] === 0xff && (buf[1] ?? 0) >= 0xe0)
        return 'mp3';
    // Ogg 封装（Opus 常见落地形态）
    if (buf.length >= 4 && String.fromCharCode(...buf.subarray(0, 4)) === 'OggS')
        return 'opus';
    return 'unknown';
}
/**
 * 扩展名 → HTTP Content-Type。
 * @param ext - 扩展名。
 * @returns MIME 字符串。
 */
function contentTypeOf(ext) {
    switch (ext) {
        case 'wav':
            return 'audio/wav';
        case 'mp3':
            return 'audio/mpeg';
        case 'opus':
            return 'audio/ogg';
        default:
            return 'application/octet-stream';
    }
}

export { DS_PCM_BITS, DS_PCM_CHANNELS, DS_PCM_SAMPLE_RATE, contentTypeOf, pcmDurationSeconds, pcmToWav, probeAudioMagic, wavDurationSeconds };
