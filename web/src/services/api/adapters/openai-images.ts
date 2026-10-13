import axios from "axios";
import { parseImageResponse } from "./image-response";
import { IMAGE_REQUEST_TIMEOUT_MS, type ImageAdapterContext } from "./image-types";

export async function requestOpenAiImages({ config, prompt, references, count, editing, options, helpers }: ImageAdapterContext) {
    const quality = helpers.quality(config.quality);
    const size = helpers.size(config.size);
    const background = helpers.background(config.background);
    const params = {
        model: config.model,
        prompt: helpers.systemPrompt(config, prompt),
        n: count,
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(background ? { background } : {}),
        // gpt-image 固定返回 base64，不接受 response_format。
        ...(/gpt-image/.test(config.model) ? {} : { response_format: "b64_json" }),
        output_format: "png",
    };
    let body: Record<string, unknown> | FormData = params;
    if (editing) {
        const form = new FormData();
        Object.entries(params).forEach(([key, value]) => form.set(key, String(value)));
        const files = await Promise.all(references.map(async (image) => helpers.dataUrlToFile({ ...image, dataUrl: await helpers.imageToDataUrl(image) })));
        const field = files.length > 1 ? "image[]" : "image";
        files.forEach((file) => form.append(field, file));
        body = form;
    }
    const response = await axios.post<unknown>(helpers.apiUrl(config, editing ? "/images/edits" : "/images/generations"), body, {
        headers: helpers.headers(config, editing ? undefined : "application/json"),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
    return parseImageResponse(response.data, helpers);
}
