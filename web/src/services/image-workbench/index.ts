import { message } from "antd";
import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { createImageHistoryRepository } from "./repository";
import { createImageWorkbenchExecutor, installCompletionSubscriber } from "./executor";
import { historyConfig, imageHistoryStorage } from "./history-storage";
import type { GenerationLog, RequestSnapshot } from "./types";

export type { GeneratedImage, GenerationLog, GenerationResult } from "./types";
export const imageHistory = createImageHistoryRepository(imageHistoryStorage);
export const imageWorkbench = createImageWorkbenchExecutor(imageHistory);
const agentTasks = new Map<string, string>();
let initialization: Promise<void> | undefined;

export function initializeImageWorkbench() {
    return initialization ??= imageHistory.initialize().finally(() => {
        if (!imageWorkbench.getSnapshot().selectedId) imageWorkbench.select(imageHistory.getSnapshot()[0]?.id);
    }).catch((error) => {
        initialization = undefined;
        throw error;
    });
}

const installNotifications = installCompletionSubscriber(imageWorkbench, (log) => {
    const agentTaskId = agentTasks.get(log.id);
    const mediaStorageError = log.images.find((image) => image.mediaStorageError)?.mediaStorageError;
    const error = log.persistenceError || mediaStorageError || log.slots.find((slot) => slot.error)?.error;
    if (agentTaskId) {
        useWorkbenchAgentStore.getState().updateTask(agentTaskId, { status: log.successCount ? "succeeded" : "failed", successCount: log.successCount, failCount: log.failCount, error: log.successCount ? log.persistenceError || mediaStorageError : error });
        agentTasks.delete(log.id);
    }
    if (log.persistenceError || mediaStorageError) void message.error(log.persistenceError || mediaStorageError);
    else if (log.successCount) void message.success(i18n.t(log.retryOf ? "workbench.retrySuccess" : "imageWorkbench.generated"));
    else void message.error(error || i18n.t("workbench.generationFailed"));
});
// 模块生命周期仅注册一次，路由卸载、返回和 StrictMode 不重复订阅。
installNotifications();

export async function submitImageTask(snapshot: RequestSnapshot, count: number, options: { agentTaskId?: string; retryOf?: GenerationLog["retryOf"] } = {}) {
    if (imageWorkbench.getSnapshot().activeId) throw new Error(i18n.t("imageWorkbench.busy"));
    const requestConfig = structuredClone(snapshot.config);
    const prompt = snapshot.text;
    const references = snapshot.references.map((reference) => ({ ...reference }));
    await initializeImageWorkbench();
    const id = nanoid();
    const config = historyConfig({ ...requestConfig, count: String(count) });
    const log: GenerationLog = {
        id, createdAt: Date.now(), title: prompt.slice(0, 12) || i18n.t("workbench.untitled"), prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }), model: requestConfig.model, config,
        references, durationMs: 0, successCount: 0, failCount: 0,
        imageCount: count, size: config.size, quality: config.quality, status: "pending", images: [],
        slots: Array.from({ length: count }, () => ({ id: nanoid(), status: "pending" })), retryOf: options.retryOf,
    };
    if (options.agentTaskId) agentTasks.set(id, options.agentTaskId);
    // 请求配置（包含 Key）只存在于执行闭包中，绝不传入历史仓库。
    const secrets = [requestConfig.apiKey, ...requestConfig.channels.map((channel) => channel.apiKey)].filter(Boolean);
    try {
        const task = await imageWorkbench.submit(log, async () => {
            const startedAt = performance.now();
            try {
                const result = references.length ? await requestEdit(requestConfig, prompt, log.references) : await requestGeneration(requestConfig, prompt);
                const image = result[0];
                if (!image) throw new Error(i18n.t("imageWorkbench.missingResult"));
                const mediaStorageError = "图片已生成，但媒体保存失败，结果可能仅在当前会话可用；请手动下载或保存，勿重新生成以免重复计费。";
                try {
                    const stored = await uploadImage(image.dataUrl);
                    return { id: image.id, dataUrl: stored.url, storageKey: stored.storageKey, durationMs: performance.now() - startedAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType, mediaStorageError: stored.storageKey ? undefined : mediaStorageError };
                } catch {
                    // 已计费成功与媒体保存分开；原始 URL 只留会话，不改写、不重发请求。
                    return { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - startedAt, width: 0, height: 0, bytes: 0, mediaStorageError };
                }
            } catch (error) {
                let text = error instanceof Error ? error.message : i18n.t("workbench.generationFailed");
                for (const secret of secrets) {
                    text = text.split(secret).join("[已隐藏凭据]").split(encodeURIComponent(secret)).join("[已隐藏凭据]");
                }
                text = text.replace(/(?:https?:\/\/|blob:|\/\/)[^\s<>"']+/gi, "[已隐藏地址]");
                throw new Error(text);
            }
        });
        if (options.agentTaskId && imageWorkbench.getSnapshot().activeId === id) useWorkbenchAgentStore.getState().updateTask(options.agentTaskId, { status: "running", error: undefined });
        return task;
    } catch (error) {
        agentTasks.delete(id);
        throw error;
    }
}
