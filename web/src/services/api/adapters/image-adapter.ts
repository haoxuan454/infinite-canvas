import { requestArkSeedreamImages } from "./ark-seedream";
import { requestGeminiImages } from "./gemini-image";
import { requestOpenAiImages } from "./openai-images";
import type { ImageAdapterContext } from "./image-types";

export function requestImageAdapter(context: ImageAdapterContext) {
    const { config } = context;
    if (config.modelProtocol === "ark-seedream") return requestArkSeedreamImages(context);
    if (config.modelProtocol === "gemini-image") return requestGeminiImages(context);
    if (config.modelProtocol === "openai-images") return requestOpenAiImages(context);
    // auto 沿用渠道格式，并保留原生 Ark 的自动识别。
    if (config.apiFormat === "gemini") return requestGeminiImages(context);
    let isArkSeedream = false;
    try {
        isArkSeedream = /^doubao-seedream-/i.test(config.model) && /(^|\.)volces\.com$/i.test(new URL(config.baseUrl).hostname);
    } catch {
        // URL 错误仍由实际请求处理。
    }
    return isArkSeedream && context.editing ? requestArkSeedreamImages(context) : requestOpenAiImages(context);
}
