import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

// 沿用原图片请求十分钟超时。
export const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60_000;
export type ImageResult = { id: string; dataUrl: string };
export type ImageRequestOptions = { signal?: AbortSignal };
export type ImageAdapterHelpers = {
    apiUrl: (config: AiConfig, path: string) => string;
    headers: (config: AiConfig, contentType?: string) => Record<string, string>;
    systemPrompt: (config: AiConfig, prompt: string) => string;
    quality: (quality: string) => string | undefined;
    size: (size: string) => string | undefined;
    background: (background: string | undefined) => string | undefined;
    geminiUrl: (config: AiConfig, action: "generateContent") => string;
    geminiHeaders: (config: AiConfig) => Record<string, string>;
    geminiImageConfig: (config: AiConfig) => Record<string, unknown>;
    imageToDataUrl: (image: ReferenceImage) => Promise<string>;
    dataUrlToFile: (image: ReferenceImage) => File;
    apiText: (key: string, options?: Record<string, unknown>) => string;
    readError: (value: unknown) => string;
    id: () => string;
};
export type ImageAdapterContext = {
    config: AiConfig;
    prompt: string;
    references: ReferenceImage[];
    count: number;
    editing: boolean;
    options?: ImageRequestOptions;
    helpers: ImageAdapterHelpers;
};
