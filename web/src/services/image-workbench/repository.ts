import { INTERRUPTED_ERROR, PERSISTENCE_ERROR } from "./types";
import type { GenerationLog, GenerationResult } from "./types";

export type HistoryStorage = {
    read: () => Promise<GenerationLog[]>;
    write: (log: GenerationLog) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
};

export function summarizeLog(log: GenerationLog): GenerationLog {
    const images = log.slots.flatMap((slot) => slot.status === "success" && slot.image ? [slot.image] : []);
    return { ...log, images, successCount: images.length, failCount: log.slots.filter((slot) => slot.status === "failed" || slot.status === "interrupted").length };
}

export function createImageHistoryRepository(storage: HistoryStorage) {
    let logs: GenerationLog[] = [];
    let initialized: Promise<void> | undefined;
    let loaded = false;
    const recoveryWrites = new Set<string>();
    let queue: Promise<unknown> = Promise.resolve();
    const listeners = new Set<() => void>();
    const publish = (log: GenerationLog) => {
        logs = [log, ...logs.filter((item) => item.id !== log.id)].sort((a, b) => b.createdAt - a.createdAt);
        listeners.forEach((listener) => listener());
    };
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = queue.then(operation);
        queue = next.catch(() => undefined);
        return next;
    };
    const write = async (log: GenerationLog) => {
        try {
            await storage.write(log);
            publish(log);
        } catch (error) {
            publish({ ...log, persistenceError: PERSISTENCE_ERROR });
            throw error;
        }
    };
    const initialize = () => initialized ??= enqueue(async () => {
        if (!loaded) {
            const stored = await storage.read();
            logs = stored.map((log) => {
                if (log.status !== "pending" && !log.slots.some((slot) => slot.status === "pending")) return log;
                recoveryWrites.add(log.id);
                const slots = log.slots.map((slot): GenerationResult => slot.status === "pending" ? { ...slot, status: "interrupted", error: INTERRUPTED_ERROR } : slot);
                return summarizeLog({ ...log, status: "interrupted", slots });
            }).sort((a, b) => b.createdAt - a.createdAt);
            loaded = true;
        }
        // 读取已成功时只重试中断标记写入，不能用旧磁盘记录覆盖会话，也不恢复生成。
        for (const id of recoveryWrites) {
            const log = logs.find((item) => item.id === id);
            if (!log) { recoveryWrites.delete(id); continue; }
            try {
                await write({ ...log, persistenceError: undefined });
                recoveryWrites.delete(id);
            } catch { /* 保留该标记，等待显式重新初始化。 */ }
        }
        listeners.forEach((listener) => listener());
        if (recoveryWrites.size) throw new Error(PERSISTENCE_ERROR);
    }).catch((error) => {
        initialized = undefined;
        throw error;
    });
    return {
        initialize,
        getSnapshot: () => logs,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        find: (id: string) => logs.find((log) => log.id === id),
        create: (log: GenerationLog) => enqueue(async () => {
            try {
                await write(log);
            } catch (error) {
                publish(summarizeLog({ ...log, status: "interrupted", persistenceError: PERSISTENCE_ERROR, slots: log.slots.map((slot) => ({ ...slot, status: "interrupted", error: "提交前历史保存失败，未发起图片请求。" })) }));
                throw error;
            }
        }),
        patch: (id: string, update: (log: GenerationLog) => GenerationLog) => enqueue(async () => {
            const current = logs.find((log) => log.id === id);
            if (!current) throw new Error("图片任务历史不存在");
            await write(summarizeLog(update(current)));
        }),
        remove: (ids: string[]) => enqueue(async () => {
            if (logs.some((log) => ids.includes(log.id) && log.status === "pending")) throw new Error("生成中的图片任务不能删除历史");
            for (const id of ids) {
                await storage.remove(id);
                logs = logs.filter((log) => log.id !== id);
                listeners.forEach((listener) => listener());
            }
        }),
    };
}

export type ImageHistoryRepository = ReturnType<typeof createImageHistoryRepository>;
