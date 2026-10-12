import { App, Button, Drawer, Empty, Switch, Tag } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { GithubOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchPromptSourceStatuses, refreshAllSources, refreshSource } from "@/services/api/prompts";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { cn } from "@/lib/utils";

const STATUS_QUERY_KEY = ["prompt-source-statuses"];

/** Prominent panel listing third-party (GitHub-hosted) prompt sources with enable/refresh controls. */
export function ThirdPartySourcesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const sources = usePromptSourceStore((state) => state.sources);
    const toggleSource = usePromptSourceStore((state) => state.toggleSource);
    const statusQuery = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: fetchPromptSourceStatuses, enabled: open });
    const [refreshingAll, setRefreshingAll] = useState(false);
    const [refreshingId, setRefreshingId] = useState("");

    const invalidatePrompts = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["prompts"] }),
            queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
            queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY }),
        ]);
    };

    const handleRefreshOne = async (sourceId: string, sourceName: string) => {
        setRefreshingId(sourceId);
        try {
            const result = await refreshSource(sourceId);
            await invalidatePrompts();
            if (result.success) message.success(t("prompts.thirdPartyRefreshed", { name: sourceName, count: result.count }));
            else message.warning(t("prompts.thirdPartyRefreshFailed"));
        } catch {
            message.error(t("prompts.thirdPartyRefreshFailed"));
        } finally {
            setRefreshingId("");
        }
    };

    const handleRefreshAll = async () => {
        setRefreshingAll(true);
        try {
            const summary = await refreshAllSources();
            await invalidatePrompts();
            message.success(t("prompts.thirdPartyRefreshed", { name: t("prompts.thirdPartyLibrary"), count: summary.total }));
        } catch {
            message.error(t("prompts.thirdPartyRefreshFailed"));
        } finally {
            setRefreshingAll(false);
        }
    };

    const statusOf = (sourceId: string) => statusQuery.data?.[sourceId];

    return (
        <Drawer open={open} width={560} title={t("prompts.thirdPartyLibrary")} onClose={onClose} styles={{ body: { paddingTop: 16 } }}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-stone-500 dark:text-stone-400">{t("prompts.thirdPartyDescription")}</div>
                <Button icon={<RefreshCw className={cn("size-4", refreshingAll && "animate-spin")} />} loading={refreshingAll} onClick={() => void handleRefreshAll()}>
                    {t("prompts.thirdPartyRefreshAll")}
                </Button>
            </div>
            {sources.length ? (
                <div className="space-y-2">
                    {sources.map((source) => {
                        const status = statusOf(source.id);
                        return (
                            <div key={source.id} className={cn("flex items-center gap-3 rounded-lg border border-stone-200 px-4 py-3 transition-colors dark:border-stone-800", !source.enabled && "opacity-55")}>
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900">
                                    <GithubOutlined style={{ fontSize: 18 }} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-semibold">{source.name || source.id}</span>
                                        {status ? <Tag className="mr-0 shrink-0">{t("prompts.thirdPartyCount", { count: status.count })}</Tag> : null}
                                    </div>
                                    <div className="mt-0.5 truncate text-xs text-stone-500">
                                        {source.homepage ? (
                                            <a href={source.homepage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-stone-800 dark:hover:text-stone-200" onClick={(event) => event.stopPropagation()}>
                                                <ExternalLink className="size-3" />
                                                {t("prompts.thirdPartyVisit")}
                                            </a>
                                        ) : (
                                            source.url
                                        )}
                                    </div>
                                </div>
                                <Button size="small" icon={<RefreshCw className={cn("size-3.5", refreshingId === source.id && "animate-spin")} />} disabled={!source.enabled || refreshingId === source.id || refreshingAll} onClick={() => void handleRefreshOne(source.id, source.name)} />
                                <Switch checked={source.enabled} onChange={(checked) => toggleSource(source.id, checked)} />
                            </div>
                        );
                    })}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.thirdPartyEmpty")} className="py-16" />
            )}
        </Drawer>
    );
}
