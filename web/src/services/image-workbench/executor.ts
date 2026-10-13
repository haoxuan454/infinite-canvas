import type { ImageHistoryRepository } from "./repository";
import type { GeneratedImage, GenerationLog, GenerationResult } from "./types";
import { PERSISTENCE_ERROR } from "./types";

export function createImageWorkbenchExecutor(repository: ImageHistoryRepository) {
    let state: { activeId?: string; selectedId?: string; startedAt: number } = { startedAt: 0 };
    const listeners = new Set<() => void>();
    const completions = new Set<(log: GenerationLog) => void>();
    const publish = (patch: Partial<typeof state>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const execute = async (id: string, runSlot: (index: number) => Promise<GeneratedImage>) => {
        let persistenceFailed = false;
        try {
            const log = repository.find(id)!;
            await Promise.all(log.slots.map(async (_, index) => {
                let result: Partial<GenerationResult>;
                try {
                    result = { status: "success", image: await runSlot(index), error: undefined };
                } catch (error) {
                    result = { status: "failed", error: error instanceof Error ? error.message : "图片生成失败" };
                }
                try {
                    await repository.patch(id, (current) => ({ ...current, durationMs: performance.now() - state.startedAt, slots: current.slots.map((slot, i) => i === index ? { ...slot, ...result } : slot) }));
                } catch {
                    persistenceFailed = true;
                }
            }));
            await repository.patch(id, (current) => ({
                ...current,
                status: current.successCount ? "success" : "failed",
                durationMs: performance.now() - state.startedAt,
                persistenceError: persistenceFailed ? PERSISTENCE_ERROR : undefined,
            }));
        } catch {
            persistenceFailed = true;
        } finally {
            publish({ activeId: undefined });
            const finished = repository.find(id);
            if (finished) completions.forEach((listener) => listener(persistenceFailed ? { ...finished, persistenceError: PERSISTENCE_ERROR } : finished));
        }
    };
    return {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeCompletion: (listener: (log: GenerationLog) => void) => { completions.add(listener); return () => { completions.delete(listener); }; },
        select: (selectedId?: string) => publish({ selectedId }),
        submit: async (log: GenerationLog, runSlot: (index: number) => Promise<GeneratedImage>) => {
            if (state.activeId) throw new Error("图片工作台正在生成，请等待当前任务完成");
            publish({ activeId: log.id, selectedId: log.id, startedAt: performance.now() });
            try {
                await repository.initialize();
                await repository.create(log);
            } catch (error) {
                publish({ activeId: undefined });
                throw error;
            }
            // pending 已持久化才允许发起请求；执行不依赖任何组件生命周期。
            return { id: log.id, done: execute(log.id, runSlot) };
        },
    };
}

export function installCompletionSubscriber(executor: ReturnType<typeof createImageWorkbenchExecutor>, notify: (log: GenerationLog) => void) {
    let installed = false;
    return () => {
        if (installed) return;
        installed = true;
        executor.subscribeCompletion(notify);
    };
}
