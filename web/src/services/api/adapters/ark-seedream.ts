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
    }, {
        headers: helpers.headers(config, "application/json"),
        signal: options?.signal,
        timeout: IMAGE_REQUEST_TIMEOUT_MS,
    });
    return parseImageResponse(response.data, helpers);
}
