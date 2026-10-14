export type ApiCallFormat = "openai" | "openai-chat" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";

export const MODEL_PROTOCOLS = ["auto", "openai-chat", "openai-responses", "openai-images", "gemini-image", "ark-seedream", "openai-video", "video-generations", "ark-video", "gemini-video", "custom-script"] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];
export const MODEL_PROTOCOLS_BY_CAPABILITY: Record<ModelCapability, readonly ModelProtocol[]> = {
    text: ["auto", "openai-chat", "openai-responses"],
    image: ["auto", "openai-images", "gemini-image", "ark-seedream", "custom-script"],
    video: ["auto", "openai-video", "video-generations", "ark-video", "gemini-video", "custom-script"],
    audio: ["auto", "custom-script"],
};

const PROTOCOL_API_FORMATS: Record<Exclude<ModelProtocol, "auto" | "custom-script">, ApiCallFormat> = {
    "openai-chat": "openai-chat",
    "openai-responses": "openai",
    "openai-images": "openai",
    "gemini-image": "gemini",
    "ark-seedream": "openai",
    "openai-video": "openai",
    "video-generations": "openai",
    "ark-video": "openai",
    "gemini-video": "gemini",
};

type ProtocolModel = { capability: ModelCapability; protocol?: unknown; script?: string };

export function normalizeModelProtocol(protocol: unknown, capability: ModelCapability): ModelProtocol {
    return MODEL_PROTOCOLS_BY_CAPABILITY[capability].includes(protocol as ModelProtocol) ? protocol as ModelProtocol : "auto";
}

export function modelProtocolError(model: ProtocolModel) {
    return normalizeModelProtocol(model.protocol, model.capability) === "custom-script" && !model.script?.trim() ? "customScriptRequired" as const : undefined;
}

export function resolveModelProtocolExecution(model: ProtocolModel, apiFormat: ApiCallFormat) {
    const protocol = normalizeModelProtocol(model.protocol, model.capability);
    // auto 保留旧脚本行为；显式内置协议只使用对应适配器。
    const script = protocol === "auto" || protocol === "custom-script" ? model.script?.trim() || "" : "";
    return {
        protocol,
        apiFormat: protocol === "auto" || protocol === "custom-script" ? apiFormat : PROTOCOL_API_FORMATS[protocol],
        script,
        error: modelProtocolError(model),
    };
}
