import axios from "axios";

import { inferVideoRatio, VIDEO_SECONDS_MAX } from "@/lib/media-size";
import { modelOptionName, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { aiHeaders, apiText, isFailedTaskStatus, readApiErrorMessage, readAxiosError, taskFailure, unwrapEnvelope } from "./video-shared";
import { VIDEO_REQUEST_TIMEOUT_MS, type VideoAdapterContext, type VideoGenerationResult, type VideoGenerationTask, type VideoGenerationTaskState, type VideoRequestOptions } from "./video-types";
import type { ReferenceVideo } from "@/types/media";

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

// 2026-10-16 服务器实测（3s/480p 最低配置）：该接口族支持图生视频（image_url）与参考视频（video_url），
// 均接受 data URL；参考音频字段未核实，仍然明确拦截。多张参考图走 images 数组字段（未单测，创建失败自动回退单图）。
// 时长实测（480p）：3/6/10/15 秒创建并出片成功；30 秒（含 grok-imagine-video-1.5）上游返回 400「xAI upstream returned status 400」。
const GENERATIONS_DURATION_MAX = 15;

/** 根/Base URL/完整 create 端点统一归一化到版本根（不含 /videos/generations）。 */
function normalizeVersionBase(baseUrl: string) {
    let base = baseUrl.trim().replace(/\/+$/, "");
    base = base.replace(/\/videos\/generations$/i, "");
    if (!/(\/api)?\/v\d+$/i.test(base)) base = `${base}/v1`;
    return base;
}

/** 平台渠道内部地址不是绝对 URL；宽松取 origin，取不到返回空串（视为不同源，鉴权交给代理注入）。 */
function safeOriginOf(value: string) {
    try {
        return new URL(value).origin;
    } catch {
        return "";
    }
}

function createUrl(config: Pick<AiConfig, "baseUrl">) {
    return withLocalProxy(`${normalizeVersionBase(config.baseUrl)}/videos/generations`);
}

function pollUrl(config: Pick<AiConfig, "baseUrl">, taskId: string) {
    return withLocalProxy(`${normalizeVersionBase(config.baseUrl)}/videos/${encodeURIComponent(taskId)}`);
}

export async function createVideoGenerationsTask({ config, model, prompt, references, options }: VideoAdapterContext): Promise<VideoGenerationTask> {
    // 参考音频没有已核实的字段，明确拦截而不是伪造能力；参考图/参考视频按实测字段组装。
    if (options?.audios?.length && !references.length && !options?.videos?.length) throw new Error(apiText("videoGenerationsReferencesUnsupported"));
    const seconds = Number(config.videoSeconds);
    if (!config.videoSeconds.trim() || !Number.isInteger(seconds) || seconds < 1 || seconds > VIDEO_SECONDS_MAX) throw new Error(apiText("videoGenerationsDurationInvalid"));
    if (seconds > GENERATIONS_DURATION_MAX) throw new Error(apiText("videoGenerationsDurationLimit"));
    const ratio = inferVideoRatio(config.size || "16:9");
    const resolution = ({ low: "480p", medium: "720p", high: "720p" } as Record<string, string>)[config.vquality] || (config.vquality === "auto" ? "720p" : `${config.vquality.replace(/p$/i, "")}p`);
    const base = { model: modelOptionName(model), prompt, duration: seconds, resolution, aspect_ratio: ratio === "auto" ? "16:9" : ratio };
    const imageRef = references[0];
    const videoRef = options?.videos?.[0];
    const videoDataUrl = videoRef ? await referenceVideoToDataUrl(videoRef) : "";
    // 多张参考图：先带 images 数组尝试（上游官方上限 7 张），被拒则回退仅第一张的 image_url。
    const buildBody = (withImages: boolean) => {
        const body: Record<string, unknown> = { ...base };
        if (withImages && imageRef && references.length > 1) body.images = references.map((r) => r.dataUrl);
        if (imageRef) body.image_url = imageRef.dataUrl;
        if (videoDataUrl) body.video_url = videoDataUrl;
        return body;
    };
    const withImages = Boolean(imageRef && references.length > 1);
    try {
        const { data } = await axios.post<GenerationsVideoPayload>(createUrl(config), buildBody(withImages), {
            headers: aiHeaders(config, "application/json"), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
        });
        const taskId = readCreatedTaskId(unwrapEnvelope<GenerationsVideoPayload>(data, apiText("noVideoTaskId")));
        if (taskId) return { id: taskId, provider: "video-generations", model };
        throw new Error(apiText("noVideoTaskId"));
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        // images 数组字段未核实：上游拒绝时回退为已核实的单图 image_url 重新创建一次（400 类错误不产生计费任务）。
        if (withImages && isClientError(error)) {
            try {
                const { data } = await axios.post<GenerationsVideoPayload>(createUrl(config), buildBody(false), {
                    headers: aiHeaders(config, "application/json"), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
                });
                const taskId = readCreatedTaskId(unwrapEnvelope<GenerationsVideoPayload>(data, apiText("noVideoTaskId")));
                if (taskId) return { id: taskId, provider: "video-generations", model };
            } catch (retryError) {
                if (axios.isCancel(retryError) || options?.signal?.aborted) throw retryError;
                throw new Error(readAxiosError(retryError, apiText("videoTaskCreateFailed")));
            }
        }
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

function readCreatedTaskId(payload: GenerationsVideoPayload) {
    return [payload.request_id, payload.id].find((value): value is string => typeof value === "string" && !!value.trim())?.trim();
}

function isClientError(error: unknown) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    return status !== undefined && status >= 400 && status < 500;
}

async function referenceVideoToDataUrl(video: ReferenceVideo): Promise<string> {
    const { data: blob } = await axios.get<Blob>(withLocalProxy(video.url), { responseType: "blob", timeout: VIDEO_REQUEST_TIMEOUT_MS });
    if (!blob.size) throw new Error(apiText("invalidReferenceVideo"));
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(apiText("invalidReferenceVideo")));
        reader.readAsDataURL(blob);
    });
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
    const upstreamUrl = resolveContentUrl(rawUrl?.trim(), versionBase, task.id);
    const upstreamOrigin = safeOriginOf(upstreamUrl);
    const sameOrigin = upstreamOrigin !== "" && upstreamOrigin === safeOriginOf(versionBase);
    const { data: blob } = await axios.get<Blob>(withLocalProxy(upstreamUrl), {
        responseType: "blob", headers: sameOrigin ? aiHeaders(config) : {}, signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
    });
    return { status: "completed", result: await toVideoResult(blob) };
}

/**
 * 解析成片下载地址。
 * - 绝对 URL（上游/CDN 直链）原样使用；
 * - 相对路径按渠道版本根解析：绝对渠道走 URL 语义；托管渠道（内部路径 /canvas-api/__managed/<id>[/vN]）必须字符串拼回内部路径，
 *   绝不能落到当前页面 origin（否则会请求应用自身导致 502），版本段保留交给服务端按真实 baseUrl 归一。
 */
function resolveContentUrl(raw: string | undefined, versionBase: string, taskId: string) {
    if (!raw) return `${versionBase}/videos/${encodeURIComponent(taskId)}/content`;
    if (/^https?:\/\//i.test(raw)) return assertSafeHttpUrl(raw);
    if (/^https?:\/\//i.test(versionBase)) return assertSafeHttpUrl(new URL(raw, `${versionBase}/`).toString());
    const managedRoot = versionBase.replace(/\/v\d+(?:beta\d*)?$/i, "");
    return `${managedRoot}/${raw.replace(/^\/+/, "")}`;
}

function assertSafeHttpUrl(value: string) {
    const url = new URL(value);
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
