import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
    mediaStorageError?: string;
};

export type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "interrupted";
    image?: GeneratedImage;
    error?: string;
};

export type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;
export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "pending" | "success" | "failed" | "interrupted";
    images: GeneratedImage[];
    slots: GenerationResult[];
    retryOf?: { taskId: string; slotId: string };
    persistenceError?: string;
};

export type RequestSnapshot = { text: string; config: AiConfig; references: ReferenceImage[] };
export const INTERRUPTED_ERROR = "图片任务已中断，刷新后无法恢复；请确认后手动重试，重试可能产生新的费用。";
export const PERSISTENCE_ERROR = "图片任务历史保存失败，结果可能仅在当前会话可见；请勿自动重试生成。";
