import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventJournal } from "./journal.js";

/**
 * 事件日志的文件仓储。读回时 EventJournal 会逐条重验哈希链：
 * 存储文件被直接改写会在加载阶段暴露，而不是静默接受。
 */
export async function saveJournal(journal, path) {
  await mkdir(dirname(path), { recursive: true });
  const data = {
    format: "selection-event-log/v1",
    exportedAt: new Date().toISOString(),
    events: journal.events,
  };
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

export async function loadJournal(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(raw.events)) throw new Error("日志文件格式错误：缺少 events");
  return new EventJournal(raw.events);
}
