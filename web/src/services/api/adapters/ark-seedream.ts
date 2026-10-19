import axios from "axios";
import { parseImageResponse } from "./image-response";
import { IMAGE_REQUEST_TIMEOUT_MS, type ImageAdapterContext } from "./image-types";

export async function requestArkSeedreamImages({ config, prompt, references, count, editing, options, helpers }: ImageAdapterContext) {
    const size = helpers.size(config.size);
    const background = helpers.background(config.background);
    const images = editing ? await Promise.all(references.map((image) => helpers.imageToDataUrl(image))) : [];
    const response = await axios.post<unknown>(helpers.apiUrl(config, "/images/generations"), {
        model: config.model,
        prompt: helpers.systemPrompt(config, prompt),
        ...(editing ? { image: images.length === 1 ? images[0] : images } : {}),
        n: count,
        ...(size ? { size } : {}),
        ...(background ? { background } : {}),
        response_format: "b64_json",
        output_format: "png",
        // 方舟 Seedream 默认 watermark=true 会在图片右下角合成「AI生成」水印（服务端叠加，提示词无法去除）。
        // 2026-10-16 依用户决策强制关闭：API 已按量计费，成片不应带水印。
        watermark: false,
    }, {
        headers: helpers.headers(config, "application/json"),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
    return parseImageResponse(response.data, helpers);
}
