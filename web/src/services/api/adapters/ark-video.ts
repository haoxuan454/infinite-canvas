import axios from "axios";

import { readFileAsDataUrl } from "@/lib/image-utils";
import { inferVideoRatio } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";
import { aiApiUrl, aiHeaders, apiText, isFailedTaskStatus, readApiErrorMessage, readAxiosError, referenceMediaToFile, taskFailure } from "./video-shared";
import { VIDEO_REQUEST_TIMEOUT_MS, type VideoAdapterContext, type VideoGenerationTask, type VideoGenerationTaskState, type VideoRequestOptions } from "./video-types";

// 能力依据：火山方舟 /docs/ark/create-video-generation-task-api 官方原文。
const profiles: Record<string, { images: number; media: number; seconds: number; resolutions: string[]; audioOnly: boolean }> = {
    "doubao-seedance-2-5-260628": { images: 30, media: 10, seconds: 30, resolutions: ["480p", "720p", "1080p"], audioOnly: true },
    "doubao-seedance-2-0-260128": { images: 9, media: 3, seconds: 15, resolutions: ["480p", "720p", "1080p", "4k"], audioOnly: false },
    "doubao-seedance-2-0-fast-260128": { images: 9, media: 3, seconds: 15, resolutions: ["480p", "720p"], audioOnly: false },
    "doubao-seedance-2-0-mini-260615": { images: 9, media: 3, seconds: 15, resolutions: ["480p", "720p"], audioOnly: false },
};
type ArkContent = { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" | "reference_image" }
    | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
    | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };
type ArkResponse = { id?: string; status?: string; content?: { video_url?: string }; error?: unknown };

export async function createArkVideoTask({ config, model, prompt, references, options }: VideoAdapterContext): Promise<VideoGenerationTask> {
    const profile = profiles[config.model];
    if (!profile) throw new Error(`Ark 视频模型 ${config.model} 的能力尚未核实；请使用已核实的 Model ID，Endpoint ID/别名暂不支持。`);
    const videos = options?.videos || [];
    const audios = options?.audios || [];
    const frames = config.videoMode === "frames" && references.length > 0;
    if (config.videoMode !== "frames" && config.videoMode !== "reference") throw new Error("Ark 视频模式必须为 frames 或 reference。");
    if (references.length > (frames ? 2 : profile.images)) throw new Error(`Ark ${frames ? "首尾帧最多 2" : `参考图最多 ${profile.images}`} 张图片。`);
    if (frames && (videos.length || audios.length)) throw new Error("Ark 首尾帧与全模态参考视频/音频不能混用，请选择 reference 模式。");
    if (videos.length > profile.media || audios.length > profile.media) throw new Error(`Ark 参考视频和音频分别最多 ${profile.media} 个。`);
    if (audios.length && !profile.audioOnly && !references.length && !videos.length) throw new Error("Seedance 2.0 音频参考必须搭配图片或视频，不能仅输入音频。");
    if (!prompt.trim() && !references.length && !videos.length && !audios.length) throw new Error("Ark 视频至少需要文本或参考素材。");
    validateDurations(videos, profile.seconds, "视频");
    validateDurations(audios, profile.seconds, "音频");
    const duration = config.videoSeconds === "auto" ? -1 : Number(config.videoSeconds);
    if (!config.videoSeconds.trim() || !Number.isInteger(duration) || (duration !== -1 && (duration < 4 || duration > profile.seconds))) throw new Error(`Ark 输出时长必须为 4–${profile.seconds} 秒的整数或 -1/auto。`);
    const resolution = config.vquality === "auto" ? undefined : ({ low: "480p", medium: "720p", high: "720p" }[config.vquality] || config.vquality.replace(/^(480|720|1080)$/, "$1p"));
    if (resolution !== undefined && !profile.resolutions.includes(resolution)) throw new Error(`Ark ${config.model} 不支持分辨率 ${config.vquality}。`);
    const ratio = config.size === "auto" || config.size === "adaptive" ? "adaptive" : inferVideoRatio(config.size);
    if (!/^(auto|adaptive|16:9|4:3|1:1|3:4|9:16|21:9|\d+x\d+)$/.test(config.size)) throw new Error("Ark 视频宽高比不受支持。");
    if (profile.audioOnly && frames && ratio !== "adaptive") throw new Error("Seedance 2.5 首帧/首尾帧只能使用 auto/adaptive 宽高比。");
    const content: ArkContent[] = prompt.trim() ? [{ type: "text", text: prompt }] : [];
    for (const [index, image] of references.entries()) {
        const url = image.url && isArkUrl(image.url) ? image.url : await imageToDataUrl(image);
        validateSource(url, "image", image.type);
        content.push({ type: "image_url", image_url: { url }, role: frames ? (index === 0 ? "first_frame" : "last_frame") : "reference_image" });
    }
    for (const video of videos) {
        if (!isArkUrl(video.url)) throw new Error("Ark 视频参考仅支持公网 URL 或 asset://；本地/blob/data URL 无法直接提交，请先提供可访问素材地址。");
        validateSource(video.url, "video", video.type);
        if (video.bytes !== undefined && (!Number.isFinite(video.bytes) || video.bytes < 0 || video.bytes > 200 * 1024 * 1024)) throw new Error("Ark 单个参考视频不能超过 200 MB。");
        if (video.width !== undefined || video.height !== undefined) validateVideoDimensions(video.width, video.height);
        content.push({ type: "video_url", video_url: { url: video.url }, role: "reference_video" });
    }
    for (const audio of audios) {
        let url = audio.url;
        if (!isArkUrl(url) && !url.startsWith("data:")) {
            const file = await referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options);
            if (file.size > 15 * 1024 * 1024) throw new Error("Ark 单个参考音频不能超过 15 MB。");
            url = await readFileAsDataUrl(file);
        }
        // 官方 Base64 子类型为 mp3/wav，而浏览器常用 MPEG/WAVE MIME。
        url = url.replace(/^data:audio\/(mpeg|x-wav|wave);/, (_match, type: string) => `data:audio/${type === "mpeg" ? "mp3" : "wav"};`);
        validateSource(url, "audio", audio.type);
        content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    }
    const body = {
        model: config.model, content, duration, ratio,
        ...(resolution ? { resolution } : {}),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
        // 当前入口仅提供参考生视频；编辑和延长需要独立任务类型配置。
        ...(profile.audioOnly && !frames && (references.length || videos.length || audios.length) ? { omni_reference_task_type: "reference" } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024 * 1024) throw new Error("Ark 请求体不能超过 64 MB。");
    try {
        const { data } = await axios.post<ArkResponse>(aiApiUrl(config, "/contents/generations/tasks"), body, {
            headers: aiHeaders(config, "application/json"), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
        });
        if (data?.error) throw new Error(readApiErrorMessage(data.error) || apiText("videoTaskCreateFailed"));
        if (typeof data?.id !== "string" || !data.id.trim()) throw new Error(apiText("noVideoTaskId"));
        return { id: data.id, provider: "ark", model };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollArkVideoTask(config: AiConfig, task: VideoGenerationTask, options?: VideoRequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const { data } = await axios.get<ArkResponse>(aiApiUrl(config, `/contents/generations/tasks/${encodeURIComponent(task.id)}`), {
            headers: aiHeaders(config), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
        });
        if (data?.error || isFailedTaskStatus(data?.status)) return taskFailure(data?.error);
        if (data?.status !== "succeeded") return { status: "pending" };
        const url = data.content?.video_url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return taskFailure(apiText("noPlayableVideo"));
        return { status: "completed", result: { url, mimeType: "video/mp4" } };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function readArkError(error: unknown) {
    const state = taskFailure(error);
    return state.status === "failed" ? state.error : apiText("videoGenerationFailed");
}

function isArkUrl(value: string) {
    if (/^asset:\/\/[^\s]+$/.test(value)) return true;
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url.hostname);
    } catch {
        return false;
    }
}

function validateSource(url: string, kind: "image" | "video" | "audio", mime: string) {
    const formats = { image: ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"], video: ["mp4", "quicktime"], audio: ["wav", "mp3", "mpeg", "x-wav", "wave"] };
    if (mime && !formats[kind].some((format) => mime.toLowerCase() === `${kind}/${format}`)) throw new Error(`Ark ${kind} 素材格式不受支持：${mime}`);
    if (isArkUrl(url)) return;
    const match = url.match(/^data:(image|audio)\/([a-z0-9-]+);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[1] !== kind || !formats[kind].includes(match[2]) || match[3].length % 4 !== 0) throw new Error(`Ark ${kind} 素材地址或 Base64 格式无效。`);
    const bytes = match[3].length * 3 / 4 - (match[3].endsWith("==") ? 2 : match[3].endsWith("=") ? 1 : 0);
    if (kind === "image" && bytes >= 30 * 1024 * 1024) throw new Error("Ark 单张图片必须小于 30 MB。");
    if (kind === "audio" && bytes > 15 * 1024 * 1024) throw new Error("Ark 单个音频不能超过 15 MB。");
}

function validateDurations(items: Array<{ durationMs?: number }>, maximum: number, label: string) {
    let total = 0;
    for (const item of items) {
        if (item.durationMs === undefined) throw new Error(`Ark 参考${label}缺少时长元数据，无法核实官方时长限制。`);
        if (!Number.isFinite(item.durationMs) || item.durationMs < 2000 || item.durationMs > maximum * 1000) throw new Error(`Ark 参考${label}单段时长必须为 2–${maximum} 秒。`);
        total += item.durationMs;
    }
    if (total > maximum * 1000) throw new Error(`Ark 参考${label}总时长不能超过 ${maximum} 秒。`);
}

function validateVideoDimensions(width?: number, height?: number) {
    if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5 || width * height < 407696 || width * height > 8295044) throw new Error("Ark 参考视频尺寸不符合官方边长、宽高比或总像素限制。");
}
