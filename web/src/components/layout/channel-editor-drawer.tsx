import { Alert, Button, Drawer, Input, InputNumber, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { reportChannelUsage } from "@/lib/access-control";
import { maskApiKey } from "@/lib/secret-mask";
import { VIDEO_SECONDS_MAX } from "@/lib/media-size";
import { MODEL_PROTOCOLS_BY_CAPABILITY, modelProtocolError, normalizeModelProtocol, type ModelProtocol } from "@/lib/model-protocol";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [apiKeyDraft, setApiKeyDraft] = useState("");
    const [selectOpen, setSelectOpen] = useState(false);
    const [manualName, setManualName] = useState("");
    const [manualCapability, setManualCapability] = useState<ModelCapability>("text");
    const [manualProtocol, setManualProtocol] = useState<ModelProtocol>("auto");
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: t("config.channelEditor.protocols.responses"), value: "openai" },
        { label: t("config.channelEditor.protocols.chat"), value: "openai-chat" },
        { label: t("config.channelEditor.protocols.gemini"), value: "gemini" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    const protocolOptions = (capability: ModelCapability) => MODEL_PROTOCOLS_BY_CAPABILITY[capability].map((value) => ({ label: t(`config.channelEditor.modelProtocols.${value}`), value }));
    const protocolHint = (capability: ModelCapability, protocol: ModelProtocol) => {
        if (protocol === "custom-script") return t("config.channelEditor.customScriptHint");
        if (protocol === "auto") return t("config.channelEditor.autoProtocolHint");
        const endpoint = t(`config.channelEditor.endpoints.${protocol}`);
        return `${t("config.channelEditor.endpointHint", { endpoint })}${capability === "video" ? ` ${t("config.channelEditor.videoProtocolHint")}` : ""}`;
    };

    useEffect(() => {
        if (open && channel) {
            setDraft({ ...channel, models: normalizeChannelModels(channel.models) });
            setApiKeyDraft("");
            setManualName("");
            setManualCapability("text");
            setManualProtocol("auto");
        }
    }, [open, channel]);

    if (!draft) return null;

    // 平台渠道（管理员托管分发）：只读展示，真实 baseUrl / 模型清单由服务端同步，用户不可改。
    const isManaged = Boolean(draft.managed);

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name && model.capability !== capability ? { ...model, capability, protocol: "auto" } : model)));
    const setProtocol = (name: string, protocol: ModelProtocol) => setModels(draft.models.map((model) => (model.name === name ? { ...model, protocol } : model)));
    const missingCustomScript = draft.models.some((model) => Boolean(modelProtocolError(model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const setMaxSeconds = (name: string, value: number | null) => setModels(draft.models.map((model) => (model.name === name ? { ...model, maxSeconds: value || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        if (missingCustomScript) return;
        const apiKey = apiKeyDraft.trim() || draft.apiKey;
        onSave({ ...draft, apiKey, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        // 自定义渠道使用了自备 Key 时上报管理台账（不可变记录，仅管理员可删）；托管渠道（Key 留空）不上报。
        if (apiKeyDraft.trim() && apiKeyDraft.trim() !== draft.apiKey) {
            reportChannelUsage({ baseUrl: draft.baseUrl, apiKey: apiKeyDraft.trim(), model: draft.models.map((m) => m.name).join(",") });
        }
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" disabled={missingCustomScript} onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            {isManaged ? <Alert className="!mb-4" type="info" showIcon message={t("config.channelEditor.managedNotice")} /> : null}
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} disabled={isManaged} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} disabled={isManaged} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={isManaged ? "••••••••••••••••" : draft.baseUrl} disabled={isManaged} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input type="password" autoComplete="new-password" disabled={isManaged} value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder={draft.apiKey ? t("config.channelEditor.apiKeyMasked", { masked: maskApiKey(draft.apiKey) }) : "sk-..."} />
                    <span className="mt-1 block text-xs text-stone-500">{isManaged ? t("config.channelEditor.managedKeyHint") : draft.apiKey ? t("config.channelEditor.apiKeyNoPeek") : t("config.channelEditor.hostedKeyHint")}</span>
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                {isManaged ? null : (
                    <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                        {t("config.channelEditor.selectModels")}
                    </Button>
                )}
            </div>

            {isManaged ? null : (
                <>
                    <p className="mb-3 text-xs text-stone-500">{t("config.channelEditor.capabilityProtocolHint")}</p>
                    <div className="mb-3 flex flex-wrap gap-2">
                        <Input className="min-w-40 flex-1" placeholder={t("config.modelSelect.modelName")} value={manualName} onChange={(event) => setManualName(event.target.value)} />
                        <Select aria-label={t("config.channelEditor.capability")} value={manualCapability} options={capabilityOptions} onChange={(capability) => { setManualCapability(capability); setManualProtocol("auto"); }} style={{ width: 100 }} />
                        <Select aria-label={t("config.channelEditor.modelProtocol")} value={manualProtocol} options={protocolOptions(manualCapability)} onChange={setManualProtocol} style={{ width: 200 }} />
                        <Button disabled={!manualName.trim() || draft.models.some((model) => model.name === manualName.trim())} onClick={() => { setModels([...draft.models, { name: manualName.trim(), capability: manualCapability, protocol: manualProtocol }]); setManualName(""); }}>
                            {t("config.modelSelect.add")}
                        </Button>
                    </div>
                    {protocolHint(manualCapability, manualProtocol) && <p className="mb-3 text-xs text-stone-500">{protocolHint(manualCapability, manualProtocol)}</p>}
                </>
            )}
            <p className="mb-3 text-xs text-stone-500">{t("config.modelSelect.description")}</p>
            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => {
                        const protocol = normalizeModelProtocol(model.protocol, model.capability);
                        const hasScript = Boolean(model.script?.trim());
                        const scriptIgnored = hasScript && protocol !== "auto" && protocol !== "custom-script";
                        const error = modelProtocolError(model);
                        return (
                            <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                                <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                    {model.name}
                                </span>
                                <div className="flex flex-wrap items-center gap-2">
                                    {isManaged ? (
                                        <span className="text-xs text-stone-500">{t(`config.channelEditor.capabilities.${model.capability}`)} · {t(`config.channelEditor.modelProtocols.${protocol}`)}</span>
                                    ) : (
                                        <>
                                            <Segmented size="small" aria-label={t("config.channelEditor.capability")} value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                            <Select size="small" aria-label={t("config.channelEditor.modelProtocol")} value={protocol} options={protocolOptions(model.capability)} onChange={(protocol) => setProtocol(model.name, protocol)} style={{ width: 200 }} />
                                            {model.capability === "video" ? (
                                                <InputNumber
                                                    size="small"
                                                    min={1}
                                                    max={VIDEO_SECONDS_MAX}
                                                    step={1}
                                                    value={model.maxSeconds ?? null}
                                                    placeholder={t("config.channelEditor.maxSecondsPlaceholder")}
                                                    aria-label={t("config.channelEditor.maxSeconds")}
                                                    onChange={(value) => setMaxSeconds(model.name, typeof value === "number" ? value : null)}
                                                    style={{ width: 92 }}
                                                    addonAfter="s"
                                                />
                                            ) : null}
                                            <Button size="small" type={hasScript && !scriptIgnored ? "primary" : "default"} ghost={hasScript && !scriptIgnored} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                                {t(scriptIgnored ? "config.channelEditor.scriptInactive" : hasScript ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                            </Button>
                                            <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                                        </>
                                    )}
                                </div>
                                <p className="w-full text-xs text-stone-500">{protocolHint(model.capability, protocol)}</p>
                                {scriptIgnored && <p className="w-full text-xs text-stone-500">{t("config.channelEditor.scriptIgnoredHint")}</p>}
                                {error && <p role="alert" className="w-full text-xs">{t(`config.channelEditor.${error}`, { model: model.name })}</p>}
                            </div>
                        );
                    })
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}
