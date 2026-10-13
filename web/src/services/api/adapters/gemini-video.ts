import axios from "axios";

import { readFileAsDataUrl } from "@/lib/image-utils";
import { clampVideoSeconds, inferVideoRatio } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";
import { apiText, geminiOperationUrl, geminiVideoHeaders, geminiVideoUrl, readAxiosError, referenceMediaToFile, taskFailure, unwrapEnvelope, videoResultFromUrl } from "./video-shared";
import { VIDEO_REQUEST_TIMEOUT_MS, type VideoAdapterContext, type VideoGenerationTask, type VideoGenerationTaskState, type VideoRequestOptions } from "./video-types";

type GeminiInlineData = { bytesBase64Encoded: string; mimeType: string };
type GeminiVideoOperation = {
    name?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };

export async function createGeminiVideoTask({ config, model, prompt, references, options }: VideoAdapterContext): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = config.videoMode === "reference" || images.length > 2 ? "reference" : "frames";
    const instance: Record<string, unknown> = { prompt };
    if (mode === "frames") {
        if (images[0]) instance.image = parseDataUrlInline(images[0]);
        if (images[1]) instance.lastFrame = parseDataUrlInline(images[1]);
    } else {
        instance.referenceImages = images.map((dataUrl) => ({ image: parseDataUrlInline(dataUrl), referenceType: "asset" }));
    }
    if (videos[0]) instance.video = await fileToGeminiInline(videos[0]);
    if (audios[0]) instance.audio = await fileToGeminiInline(audios[0]);
    try {
        const ratio = inferVideoRatio(config.size);
        const created = unwrapEnvelope<GeminiVideoOperation>((await axios.post<ApiEnvelope<GeminiVideoOperation>>(geminiVideoUrl(config, model, "predictLongRunning"), {
            instances: [instance],
            parameters: {
                aspectRatio: ratio === "auto" ? "16:9" : ratio,
                durationSeconds: Number(clampVideoSeconds(config.videoSeconds)) || 8,
                resolution: normalizeVideoResolution(config.vquality),
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                addWatermark: boolConfig(config.videoWatermark, false),
            },
        }, { headers: geminiVideoHeaders(config), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS })).data, apiText("noVideoTask"));
        if (!created.name) throw new Error(apiText("noVideoTaskId"));
        return { id: created.name, provider: "gemini", model };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollGeminiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: VideoRequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapEnvelope<GeminiVideoOperation>((await axios.get<ApiEnvelope<GeminiVideoOperation>>(geminiOperationUrl(config, task.id), {
            headers: geminiVideoHeaders(config), signal: options?.signal, timeout: VIDEO_REQUEST_TIMEOUT_MS,
        })).data, apiText("videoTaskQueryFailed"));
        if (state.error) return taskFailure(state.error);
        if (state.done !== true) return { status: "pending" };
        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) return taskFailure(apiText("noPlayableVideo"));
        const url = uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(config.apiKey)}`;
        return { status: "completed", result: await videoResultFromUrl(url, options) };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function parseDataUrlInline(dataUrl: string, fallbackType = "image/png"): GeminiInlineData {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return { bytesBase64Encoded: match?.[2] || "", mimeType: match?.[1] || fallbackType };
}

async function fileToGeminiInline(file: File): Promise<GeminiInlineData> {
    return parseDataUrlInline(await readFileAsDataUrl(file), file.type || "application/octet-stream");
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    return `${value.replace(/p$/i, "") || "720"}p`;
}
