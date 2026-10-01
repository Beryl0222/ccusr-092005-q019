import { createHash } from "node:crypto";

/** 确定性 JSON：键排序、无多余空白，保证哈希跨进程一致。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

export function sha256Hex(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

export function hashValue(value) {
  return sha256Hex(stableStringify(value));
}
