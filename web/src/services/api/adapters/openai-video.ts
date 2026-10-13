import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { aiApiUrl, aiHeaders, apiText, assertVideoBlob, isFailedTaskStatus, readAxiosError, referenceMediaToFile, taskFailure, unwrapEnvelope, videoResultFromUrl } from "./video-shared";
import { VIDEO_REQUEST_TIMEOUT_MS, type VideoAdapterContext, type VideoGenerationTask, type VideoGenerationTaskState, type VideoRequestOptions } from "./video-types";

type VideoResponse = { id?: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };

export async function createOpenAIVideoTask(context: VideoAdapterContext): Promise<VideoGenerationTask> {
    const { config, model, prompt, references, options } = context;
    const images = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const ratio = inferVideoRatio(config.size || "16:9");
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", clampVideoSeconds(config.videoSeconds));
    body.append("size", normalizeVideoSize(config.size, config.vquality) || "1280x720");
    if (ratio && ratio !== "auto") body.append("ratio", ratio);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("generate_audio", String(boolConfig(config.videoGenerateAudio, true)));
    body.append("watermark", String(boolConfig(config.videoWatermark, false)));
    body.append("mode", mode);
    if (mode === "frames") {
        if (images[0]) {
            body.append("first_frame", images[0], "first.png");
            body.append("images", images[0], "first.png");
        }
        if (images[1]) {
            body.append("last_frame", images[1], "last.png");
            body.append("images", images[1], "last.png");
        }
    } else {
        images.forEach((file, index) => {
            body.append("image[]", file, `ref_${index + 1}.png`);
            body.append("images", file, `ref_${index + 1}.png`);
        });
    }
    videos.forEach((file) => body.append("video[]", file));
    audios.forEach((file) => body.append("audio[]", file));
    try {
        const created = unwrapEnvelope((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, {
            headers: aiHeaders(config),
            signal: options?.signal,
            timeout: VIDEO_REQUEST_TIMEOUT_MS,
        })).data, apiText("noVideoTask"));
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: VideoRequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapEnvelope((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), {
            headers: aiHeaders(config),
            signal: options?.signal,
            timeout: VIDEO_REQUEST_TIMEOUT_MS,
        })).data, apiText("videoTaskQueryFailed"));
        if (isFailedTaskStatus(video.status) || video.error) return taskFailure(video.error);
        if (video.status !== "completed") return { status: "pending" };
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`), {
                headers: aiHeaders(config),
                responseType: "blob",
                signal: options?.signal,
                timeout: VIDEO_REQUEST_TIMEOUT_MS,
            });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        return { status: "pending" };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function normalizeVideoSize(value: string, resolution?: string) {
    if (value === "auto") return null;
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value || "16:9");
    if (ratio === "auto") return null;
    return computeVideoSize(resolution || "720", ratio);
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}
