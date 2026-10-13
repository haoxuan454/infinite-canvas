import axios from "axios";
import { parseGeminiImageResponse } from "./image-response";
import { IMAGE_REQUEST_TIMEOUT_MS, type ImageAdapterContext } from "./image-types";

async function requestGeminiImageOnce({ config, prompt, references, options, helpers }: ImageAdapterContext) {
    const parts: Record<string, unknown>[] = [{ text: prompt }];
    for (const image of references) {
        const url = await helpers.imageToDataUrl(image);
        const match = url.match(/^data:([^;,]+);base64,(.+)$/);
        parts.push(match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: url, mimeType: "image/png" } });
    }
    const systemPrompt = config.systemPrompt.trim();
    const response = await axios.post<unknown>(helpers.geminiUrl(config, "generateContent"), {
        contents: [{ role: "user", parts }],
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...helpers.geminiImageConfig(config) },
    }, { headers: helpers.geminiHeaders(config), signal: options?.signal, timeout: IMAGE_REQUEST_TIMEOUT_MS });
    return parseGeminiImageResponse(response.data, helpers);
}

export async function requestGeminiImages(context: ImageAdapterContext) {
    const requests = Array.from({ length: context.count }, () => requestGeminiImageOnce(context));
    return (await Promise.all(requests)).flat();
}
