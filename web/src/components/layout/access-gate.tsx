// 全屏访问密钥门：应用启动/刷新时经 /auth/verify 只读探测；无效则全屏拦截（路由切换零打扰）。
// 会话中密钥被吊销/过期时，axios 401 拦截器派发 auth-error 事件 → 重新探测并拉起本门。
import { App, Button, Input } from "antd";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { bindDevice, isDeviceBound, onAuthError, verifyAccessKey, type AccessVerifyResult } from "@/lib/access-control";
import { syncManagedChannels, useConfigStore } from "@/stores/use-config-store";

type GatePhase = "checking" | "blocked" | "pass";

const KNOWN_CODES = new Set(["KEY_REQUIRED", "KEY_INVALID", "KEY_REVOKED", "KEY_EXPIRED", "DEVICE_REQUIRED", "DEVICE_LIMIT", "DEVICE_BLOCKED"]);

export function AccessGate() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [phase, setPhase] = useState<GatePhase>("checking");
    const [errorText, setErrorText] = useState("");
    const [draft, setDraft] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const verifySeq = useRef(0);
    const updateConfig = useConfigStore((state) => state.updateConfig);

    const messageForCode = useCallback(
        (code?: string) => (code && KNOWN_CODES.has(code) ? t(`accessKey.gate.msg.${code}`) : t("accessKey.guard.defaultError")),
        [t],
    );

    const runVerify = useCallback(async () => {
        const seq = ++verifySeq.current;
        try {
            const result = await verifyAccessKey();
            if (seq !== verifySeq.current) return; // 已有更新一次探测（如门内提交），晚到结果作废
            if (result.valid) {
                setPhase("pass");
                setErrorText("");
                // 进门即登记设备（幂等）：让管理端台账立刻可见；被拒（设备超限/禁用/Key 失效）拉回门。
                if (!isDeviceBound()) {
                    void bindDevice().then((bind) => {
                        if (!bind.ok && bind.code && seq === verifySeq.current) {
                            setErrorText(messageForCode(bind.code));
                            setPhase("blocked");
                        }
                    }).catch(() => {
                        // bind 网络失败不拦人：后续业务请求失败仍会重新拉起门。
                    });
                }
            } else {
                setErrorText(messageForCode(result.code));
                setPhase("blocked");
            }
        } catch {
            // 探测端点不可达（代理未启动等）：放行进入应用（真正强制在代理 authenticate，纵深仍在）。
            if (seq !== verifySeq.current) return;
            console.warn("[access-gate] /auth/verify 不可达，临时放行；代理恢复后请求失败会重新拉起门禁");
            setPhase("pass");
        }
    }, [messageForCode]);

    useEffect(() => {
        void runVerify();
        const off = onAuthError(() => {
            // 会话中鉴权失效（吊销/过期/设备被禁）：重新探测并拉起门。
            void runVerify();
        });
        return off;
    }, [runVerify]);

    // 进门后同步平台渠道（管理员托管分发；失败静默，不影响本地渠道）。
    useEffect(() => {
        if (phase === "pass") void syncManagedChannels();
    }, [phase]);

    const apply = async () => {
        const value = draft.trim();
        if (!value) {
            message.warning(t("accessKey.guard.required"));
            return;
        }
        setSubmitting(true);
        const seq = ++verifySeq.current; // 提交期间的旧探测结果一律作废
        let result: AccessVerifyResult | null = null;
        try {
            result = await verifyAccessKey(value);
        } catch {
            result = null;
        }
        setSubmitting(false);
        if (seq !== verifySeq.current) return;
        if (!result) {
            message.error(t("accessKey.gate.verifyFailed"));
            return;
        }
        if (!result.valid) {
            setErrorText(messageForCode(result.code));
            return;
        }
        updateConfig("accessKey", value);
        // 先登记设备再放行：设备超限/被禁在门口就拦下，而不是进应用后业务请求 401。
        try {
            const bind = await bindDevice(value);
            if (seq !== verifySeq.current) return;
            if (!bind.ok) {
                setErrorText(messageForCode(bind.code));
                return;
            }
        } catch {
            // bind 网络失败不拦人：与 verify fail-open 口径一致，业务请求失败会重新拉起门。
        }
        setPhase("pass");
        setErrorText("");
        setDraft("");
        message.success(t("accessKey.gate.welcome", { name: result.keyName || "" }));
    };

    if (phase === "pass") return null;

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-stone-950">
            {/* 背景氛围层 */}
            <div aria-hidden className="pointer-events-none absolute inset-0">
                <div className="absolute -top-40 left-1/2 size-[520px] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[120px]" />
                <div className="absolute bottom-0 right-10 size-[380px] rounded-full bg-amber-500/10 blur-[100px]" />
            </div>
            <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-stone-800/80 bg-stone-900/70 p-8 shadow-2xl shadow-black/60 backdrop-blur-xl">
                {phase === "checking" ? (
                    <div className="flex flex-col items-center gap-4 py-6">
                        <span className="inline-flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-900/40">
                            <ShieldCheck className="size-6 animate-pulse text-white" />
                        </span>
                        <span className="text-sm text-stone-400">{t("accessKey.gate.verifying")}</span>
                    </div>
                ) : (
                    <div className="space-y-5">
                        <div className="flex flex-col items-center gap-3 text-center">
                            <span className="inline-flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 shadow-lg shadow-amber-900/40">
                                <KeyRound className="size-6 text-white" />
                            </span>
                            <div>
                                <h1 className="text-lg font-semibold text-stone-100">{t("accessKey.gate.title")}</h1>
                                <p className="mt-1 text-xs leading-5 text-stone-400">{t("accessKey.gate.subtitle")}</p>
                            </div>
                        </div>
                        {errorText ? (
                            <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-300">
                                {errorText}
                            </div>
                        ) : null}
                        <Input.Password
                            size="large"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onPressEnter={() => void apply()}
                            placeholder="cak-..."
                            autoComplete="new-password"
                            autoFocus
                        />
                        <Button type="primary" size="large" block loading={submitting} onClick={() => void apply()}>
                            {t("accessKey.gate.enter")}
                        </Button>
                        <p className="text-center text-[11px] leading-4 text-stone-500">{t("accessKey.guard.description")}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
