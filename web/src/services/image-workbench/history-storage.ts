import localforage from "localforage";
import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { ensureImagePreview, resolveImageUrl } from "@/services/image-storage";
import type { HistoryStorage } from "./repository";
import type { GenerationLog, GenerationLogConfig } from "./types";

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export function historyConfig(config: GenerationLogConfig): GenerationLogConfig {
    return { model: config.model, imageModel: config.imageModel, quality: config.quality, size: config.size, count: config.count };
}

export function serializeLog(log: GenerationLog): GenerationLog {
    // 无本地键时仅持久化图片内嵌数据；URL 整体留在会话，不猜测或删除认证参数。
    const persistentData = (storageKey: string | undefined, dataUrl: string) => !storageKey && /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl) ? dataUrl : "";
    const safeError = (text?: string) => text?.replace(/(?:https?:\/\/|blob:|\/\/)[^\s<>"']+/gi, "[已隐藏地址]");
    const serializeImage = (image: GenerationLog["images"][number]) => ({
        id: image.id, storageKey: image.storageKey, dataUrl: persistentData(image.storageKey, image.dataUrl),
        durationMs: image.durationMs, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType,
        mediaStorageError: safeError(image.mediaStorageError) || (!image.storageKey && !persistentData(image.storageKey, image.dataUrl) ? "图片已生成但媒体未保存，仅原会话可用；请勿重新生成以免重复计费。" : undefined),
    });
    // 白名单阻止请求配置中的凭据、渠道和脚本进入历史持久化。
    return {
        id: log.id, createdAt: log.createdAt, title: log.title, prompt: log.prompt, time: log.time, model: log.model,
        config: historyConfig(log.config), references: log.references.map((item) => ({ id: item.id, name: item.name, type: item.type, storageKey: item.storageKey, dataUrl: persistentData(item.storageKey, item.dataUrl) })),
        durationMs: log.durationMs, successCount: log.successCount, failCount: log.failCount, imageCount: log.imageCount,
        size: log.size, quality: log.quality, status: log.status, images: log.images.map(serializeImage),
        slots: log.slots.map((slot) => ({ id: slot.id, status: slot.status, error: safeError(slot.error), image: slot.image ? serializeImage(slot.image) : undefined })),
        retryOf: log.retryOf, persistenceError: safeError(log.persistenceError),
    };
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const hydrate = async <T extends { storageKey?: string; dataUrl: string }>(item: T): Promise<T> => {
        void ensureImagePreview(item.storageKey);
        return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
    };
    const references = await Promise.all((log.references || []).map(hydrate));
    const images = await Promise.all((log.images || []).map(hydrate));
    const config = historyConfig({ model: log.config?.model || log.model || "", imageModel: log.config?.imageModel || log.model || "", quality: log.config?.quality || log.quality || "", size: log.config?.size || log.size || "", count: log.config?.count || String(log.imageCount || log.successCount || 1) });
    const slots = log.slots ? await Promise.all(log.slots.map(async (slot) => ({ ...slot, image: slot.image ? await hydrate(slot.image) : undefined }))) : [
        ...images.map((image) => ({ id: image.id, status: "success" as const, image })),
        ...Array.from({ length: log.failCount || 0 }, () => ({ id: nanoid(), status: "failed" as const, error: i18n.t("workbench.generationFailed") })),
        ...Array.from({ length: log.status === "pending" ? Math.max(0, Number(config.count) - images.length - (log.failCount || 0)) : 0 }, () => ({ id: nanoid(), status: "pending" as const })),
    ];
    return {
        ...log, id: log.id || nanoid(), createdAt: log.createdAt || Date.now(), title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "", time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel, config, references, images, slots,
        durationMs: log.durationMs || 0, successCount: log.successCount ?? log.imageCount ?? 0, failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0, size: log.size || config.size, quality: log.quality || config.quality, status: log.status || "success",
    };
}

export const imageHistoryStorage: HistoryStorage = {
    read: async () => {
        const values: GenerationLog[] = [];
        await store.iterate<GenerationLog, void>((value) => { values.push(value); });
        return Promise.all(values.map(normalizeLog));
    },
    write: (log) => store.setItem(log.id, serializeLog(log)),
    remove: (id) => store.removeItem(id),
};
