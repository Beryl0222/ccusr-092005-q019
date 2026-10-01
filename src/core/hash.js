import { createHash } from "node:crypto";

/**
 * 规范化 JSON：对象键递归排序，保证同一逻辑内容无论来源如何都得到同一字符串，
 * 从而哈希既可作为证据原件指纹，也可作为事件链完整性凭证。
 */
export function canonicalize(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** 对证据原文/二进制计算指纹（十六进制字符串或 Buffer 均可）。 */
export function fingerprint(content) {
  return createHash("sha256").update(content).digest("hex");
}
