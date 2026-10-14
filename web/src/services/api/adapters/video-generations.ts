import axios from "axios";

import { inferVideoRatio } from "@/lib/media-size";
import { modelOptionName, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { aiHeaders, apiText, isFailedTaskStatus, readApiErrorMessage, readAxiosError, taskFailure, unwrapEnvelope } from "./video-shared";
import { VIDEO_REQUEST_TIMEOUT_MS, type VideoAdapterContext, type VideoGenerationResult, type VideoGenerationTask, type VideoGenerationTaskState, type VideoRequestOptions } from "./video-types";

// sub.callai.one 风格的 JSON 视频任务接口：创建 /v1/videos/generations，查询 /v1/videos/{id}，下载 /v1/videos/{id}/content。
type GenerationsVideoPayload = {
    status?: string;
    error?: unknown;
    request_id?: unknown;
    id?: unknown;
    video?: { url?: unknown } | null;
    video_url?: unknown;
    url?: unknown;
};

/** 根/Base URL/完整 create 端点统一归一化到版本根（不含 /videos/generations）。 */
function normalizeVersionBase(baseUrl: string) {
    let base = baseUrl.trim().replace(/\/+$/, "");
    base = base.replace(/\/videos\/generations$/i, "");
    if (!/(\/api)?\/v\d+$/i.test(base)) base = `${base}/v1`;
    return base;
}

function createUrl(config: Pick<AiConfig, "baseUrl">) {
    return withLocalProxy(`${normalizeVersionBase(config.baseUrl)}/videos/generations`);
}

function pollUrl(config: Pick<AiConfig, "baseUrl">, taskId: string) {
    return withLocalProxy(`${normalizeVersionBase(config.baseUrl)}/videos/${encodeURIComponent(taskId)}`);
}

export async function createVideoGenerationsTask({ config, model, prompt, references, options }: VideoAdapterContext): Promise<VideoGenerationTask> {
    // 该接口族为纯文生视频，参考图/视频/音频没有已核实的字段；请求前明确拦截而不是伪造 multipart 能力。
    if (references.length || options?.videos?.length || options?.audios?.length) throw new Error(apiText("videoGenerationsReferencesUnsupported"));
    const seconds = Number(config.videoSeconds);
    if (!config.videoSeconds.trim() || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error(apiText("videoGenerationsDurationInvalid"));
    const ratio = inferVideoRatio(config.size || "16:9");
    const resolution = ({ low: "480p", medium: "720p", high: "720p" } as Record<string, string>)[config.vquality] || (config.vquality === "auto" ? "720p" : `${config.vquality.replace(/p$/i, "")}p`);
    const body = { model: modelOptionName(model), prompt, duration: seconds, resolution, aspect_ratio: ratio === "auto" ? "16:9" : ratio };
    try {
        const { data } = await axios.post<GenerationsVideoPayload>(createUrl(config), body, {
            headers: aiHeaders(config, "application/json"), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
        });
        const created = unwrapEnvelope<GenerationsVideoPayload>(data, apiText("noVideoTaskId"));
        const taskId = [created.request_id, created.id].find((value): value is string => typeof value === "string" && !!value.trim());
        if (!taskId) throw new Error(apiText("noVideoTaskId"));
        return { id: taskId.trim(), provider: "video-generations", model };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollVideoGenerationsTask(config: AiConfig, task: VideoGenerationTask, options?: VideoRequestOptions): Promise<VideoGenerationTaskState> {
    // 查询/下载的临时网络错误原样抛出，由上层区分终态与临时失败，取消保持原对象。
    const { data } = await axios.get<GenerationsVideoPayload>(pollUrl(config, task.id), {
        headers: aiHeaders(config), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
    });
    const payload = unwrapEnvelope<GenerationsVideoPayload>(data, apiText("noPlayableVideo"));
    if (payload.error || isFailedTaskStatus(payload.status)) return taskFailure(payload.error);
    if (payload.status !== "done" && payload.status !== "completed") return { status: "pending" };
    const rawUrl = [payload.video?.url, payload.video_url, payload.url].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    const versionBase = normalizeVersionBase(config.baseUrl);
    // 先在上游侧解析出绝对 URL 并校验，再决定是否携带 Bearer，最后统一经同源代理发出，避免浏览器直连上游触发 CORS。
    const upstreamUrl = rawUrl ? resolveUpstreamUrl(rawUrl, versionBase) : `${versionBase}/videos/${encodeURIComponent(task.id)}/content`;
    const sameOrigin = new URL(upstreamUrl).origin === new URL(versionBase).origin;
    const { data: blob } = await axios.get<Blob>(withLocalProxy(upstreamUrl), {
        responseType: "blob", headers: sameOrigin ? aiHeaders(config) : {}, signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
    });
    return { status: "completed", result: await toVideoResult(blob) };
}

function resolveUpstreamUrl(raw: string, base: string) {
    const url = new URL(raw, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(apiText("videoDownloadFailed"));
    return url.toString();
}

async function toVideoResult(blob: Blob): Promise<VideoGenerationResult> {
    if (!blob.size) throw new Error(apiText("videoDownloadFailed"));
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const text = String.fromCharCode(...head);
    // JSON/HTML 错误响应即使伪装 video MIME 也不能当作视频完成。
    if (text.startsWith("{") || text.startsWith("<")) throw new Error(apiText("videoDownloadFailed"));
    if (blob.type.startsWith("video/")) return { blob, mimeType: blob.type };
    const isMp4 = head.length > 7 && String.fromCharCode(head[4], head[5], head[6], head[7]) === "ftyp";
    if (isMp4) return { blob: new Blob([blob], { type: "video/mp4" }), mimeType: "video/mp4" };
    throw new Error(apiText("videoDownloadFailed"));
}
