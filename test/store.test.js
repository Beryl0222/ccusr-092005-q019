import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";

import { EventJournal } from "../src/domain/journal.js";
import { saveJournal, loadJournal } from "../src/domain/store.js";

test("日志落盘后可完整重载并通过哈希链校验", async () => {
  const journal = new EventJournal();
  journal.append("A", { x: 1 });
  journal.append("B", { x: 2 });
  const path = join(tmpdir(), `selection-log-${process.pid}-${Date.now()}.json`);
  try {
    await saveJournal(journal, path);
    const reloaded = await loadJournal(path);
    assert.equal(reloaded.length, 2);
    assert.equal(reloaded.verify().ok, true);
    assert.equal(reloaded.headHash(), journal.headHash());
  } finally {
    await rm(path, { force: true });
  }
});

test("文件被直接改写后，加载阶段即暴露篡改", async () => {
  const journal = new EventJournal();
  journal.append("A", { x: 1 });
  journal.append("B", { x: 2 });
  const path = join(tmpdir(), `selection-log-tamper-${process.pid}-${Date.now()}.json`);
  try {
    await saveJournal(journal, path);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.events[0].payload.x = 999; // 直接改库，不重算哈希
    await writeFile(path, JSON.stringify(raw));
    await assert.rejects(() => loadJournal(path), /哈希/);
  } finally {
    await rm(path, { force: true });
  }
});
