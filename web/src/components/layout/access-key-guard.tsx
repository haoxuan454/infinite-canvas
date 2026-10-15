// 全局访问鉴权守卫：代理返回 401/403 鉴权错误时弹出引导，提示填写管理员分配的访问密钥。
import { Alert, App, Input, Modal } from "antd";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { onAuthError } from "@/lib/access-control";
import { useConfigStore } from "@/stores/use-config-store";

export function AccessKeyGuard() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [errorText, setErrorText] = useState("");
    const [draft, setDraft] = useState("");
    const updateConfig = useConfigStore((state) => state.updateConfig);

    useEffect(() => {
        const off = onAuthError((payload) => {
            setErrorText(payload.error || t("accessKey.guard.defaultError"));
            setOpen(true);
        });
        return off;
    }, [t]);

    const apply = () => {
        const value = draft.trim();
        if (!value) {
            message.warning(t("accessKey.guard.required"));
            return;
        }
        updateConfig("accessKey", value);
        message.success(t("accessKey.guard.saved"));
        setOpen(false);
        setDraft("");
    };

    return (
        <Modal
            open={open}
            title={
                <span className="inline-flex items-center gap-2">
                    <KeyRound className="size-4 text-amber-500" />
                    {t("accessKey.guard.title")}
                </span>
            }
            okText={t("accessKey.guard.apply")}
            cancelText={t("common.close")}
            onOk={apply}
            onCancel={() => setOpen(false)}
            destroyOnClose
        >
            <div className="space-y-3">
                <Alert type="warning" showIcon message={errorText} />
                <Input.Password
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="cak-..."
                    onPressEnter={apply}
                />
                <p className="text-xs text-stone-500">{t("accessKey.guard.description")}</p>
            </div>
        </Modal>
    );
}
