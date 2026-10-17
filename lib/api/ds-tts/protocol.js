/**
 * ds-tts 双面共享的线上契约（纯类型 + 常量，浏览器半与宿主半都 import）。
 *
 * 这里刻意不 import config.ts / schemastery：浏览器半只需要这些类型，
 * 让它可以完全静态擦除，不把宿主依赖带进 client bundle。
 */
/* ───────────────────────────── 路由：audio ───────────────────────────── */
/** audio 路由的 id 形态校验（内容寻址 id）。 */
const AUDIO_ID_PATTERN = /^[0-9a-f]{16}$/;
/** audio 路由允许的扩展名。 */
const AUDIO_EXTS = ['wav', 'mp3', 'opus'];
/* ───────────────────────────── 常量 ──────────────────────────────────── */
/** DS 网页侧账号级"朗读音色"接口可用的官方 voice_id（用于前端兜底展示）。 */
const KNOWN_DS_VOICES = [
    { id: 'mira', name: '贝壳', gender: 'female', description: '百变活泼' },
    { id: 'echo', name: '白浪', gender: 'male', description: '明朗坚定' },
    { id: 'stella', name: '海星', gender: 'female', description: '俏皮甜美' },
    { id: 'tide', name: '暗潮', gender: 'male', description: '低沉浑厚' },
];

export { AUDIO_EXTS, AUDIO_ID_PATTERN, KNOWN_DS_VOICES };
