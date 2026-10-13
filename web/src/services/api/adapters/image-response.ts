import type { ImageAdapterHelpers, ImageResult } from "./image-types";

type ResponseHelpers = Pick<ImageAdapterHelpers, "apiText" | "readError" | "id">;

export function imageRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function validateImageResponse(payload: Record<string, unknown>, helpers: ResponseHelpers) {
    if (payload.error || (typeof payload.code === "number" && payload.code !== 0)) {
        throw new Error(helpers.readError(payload) || helpers.apiText("requestFailed"));
    }
}

// 返回值没有 MIME 时从常见图片签名识别，避免把 JPEG 标成 PNG。
export function imageBase64Url(data: string, mime?: string) {
    if (/^data:image\/[^;,]+;base64,/i.test(data)) return data;
    const value = data.trim();
    const detected = value.startsWith("/9j/") ? "image/jpeg"
        : value.startsWith("R0lGOD") ? "image/gif"
        : value.startsWith("UklGR") ? "image/webp"
        : "image/png";
    return `data:${mime || detected};base64,${value}`;
}

export function parseImageResponse(payload: unknown, helpers: ResponseHelpers): ImageResult[] {
    if (!imageRecord(payload)) throw new Error(helpers.apiText("noImageReturned"));
    validateImageResponse(payload, helpers);
    const list = [payload.data, payload.images, payload.results].find(Array.isArray);
    const images: ImageResult[] = [];
    for (const item of list || []) {
        if (!imageRecord(item)) continue;
        validateImageResponse(item, helpers);
        const base64 = typeof item.b64_json === "string" ? item.b64_json.trim() : "";
        const url = typeof item.url === "string" ? item.url.trim() : "";
        const dataUrl = base64 ? imageBase64Url(base64) : url;
        if (dataUrl) images.push({ id: helpers.id(), dataUrl });
    }
    if (!images.length) {
        const keys = Object.keys(payload).filter((key) => !["code", "msg", "error"].includes(key));
        throw new Error(keys.length && !list
            ? helpers.apiText("unknownImageResponse", { fields: keys.join(", ") })
            : helpers.apiText("noImageReturned"));
    }
    return images;
}

export function parseGeminiImageResponse(payload: unknown, helpers: ResponseHelpers): ImageResult[] {
    if (!imageRecord(payload)) throw new Error(helpers.apiText("geminiNoImage"));
    validateImageResponse(payload, helpers);
    if (imageRecord(payload.promptFeedback) && payload.promptFeedback.blockReason) {
        throw new Error(helpers.apiText("geminiRejected", { reason: payload.promptFeedback.blockReason }));
    }
    const images: ImageResult[] = [];
    for (const candidate of Array.isArray(payload.candidates) ? payload.candidates : []) {
        if (!imageRecord(candidate)) continue;
        validateImageResponse(candidate, helpers);
        const content = imageRecord(candidate.content) ? candidate.content : {};
        for (const part of Array.isArray(content.parts) ? content.parts : []) {
            if (!imageRecord(part)) continue;
            validateImageResponse(part, helpers);
            const inline = imageRecord(part.inlineData) ? part.inlineData : imageRecord(part.inline_data) ? part.inline_data : {};
            const base64 = typeof inline.data === "string" ? inline.data.trim() : "";
            const mime = typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : undefined;
            const file = imageRecord(part.fileData) ? part.fileData : {};
            const url = typeof file.fileUri === "string" ? file.fileUri.trim() : "";
            const dataUrl = base64 ? imageBase64Url(base64, mime) : url;
            if (dataUrl) images.push({ id: helpers.id(), dataUrl });
        }
    }
    if (!images.length) throw new Error(helpers.apiText("geminiNoImage"));
    return images;
}
