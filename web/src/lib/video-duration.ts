import { VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, clampVideoSeconds } from "./media-size";

/** 解析每模型"最大生成秒数"配置：空/非法表示不限；合法值收敛到 1..VIDEO_SECONDS_MAX。 */
export function normalizeModelMaxSeconds(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    const seconds = Math.floor(Number(value));
    if (!Number.isFinite(seconds) || seconds < 1) return undefined;
    return Math.min(seconds, VIDEO_SECONDS_MAX);
}

/** 按模型上限收敛请求时长；"-1" 智能时长与全局下限语义与 clampVideoSeconds 保持一致。 */
export function clampVideoSecondsForModel(value: string, maxSeconds?: number) {
    if (String(value).trim() === "-1") return "-1";
    const globalClamped = clampVideoSeconds(value);
    if (maxSeconds === undefined) return globalClamped;
    const seconds = Number(globalClamped);
    return String(Math.max(VIDEO_SECONDS_MIN, Math.min(seconds, maxSeconds)));
}

/** 识别上游"时长超限/不支持"类报错文本（中英文）。纯判断，不组装文案。 */
export function isDurationUnsupportedError(text: string) {
    const message = String(text || "");
    if (!message) return false;
    const failWord = /(exceed|maximum|\bmax\b|too long|not support|unsupported|invalid|must be|between|不支持|超过|超出|过长|最长|上限|无法生成)/i;
    // 主锚点：报错提到 duration/时长。宽词组合容易误伤限流类文案，需同时出现失败词。
    if (/(duration|时长)/i.test(message) && failWord.test(message)) return true;
    // 次锚点：seconds/秒 必须伴随具体数字与明确的限制表述，避免"…exceeded. Try again in 60 seconds"这类限流误报。
    return /(seconds|秒)/i.test(message) && /\d/.test(message) && /(must be|between|不超过|不能超过|上限|不支持|无法生成)/i.test(message);
}
