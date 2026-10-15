/** 密钥掩码：已保存的密钥永不回显明文；长度足够（≥8）时保留末 4 位辅助辨认，短密钥完全不回显。 */
export function maskApiKey(value: string | undefined | null) {
    const key = String(value || "");
    if (!key) return "";
    return key.length >= 8 ? `••••${key.slice(-4)}` : "••••";
}
