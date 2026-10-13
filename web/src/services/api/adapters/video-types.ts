import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const VIDEO_REQUEST_TIMEOUT_MS = 10 * 60_000;

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "ark" | "gemini" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };
export type VideoRequestOptions = { signal?: AbortSignal };
export type VideoMediaOptions = VideoRequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
export type VideoAdapterContext = {
    config: AiConfig;
    model: string;
    prompt: string;
    references: ReferenceImage[];
    options?: VideoMediaOptions;
};
