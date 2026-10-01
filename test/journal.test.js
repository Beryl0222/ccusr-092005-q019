import assert from "node:assert/strict";
import test from "node:test";

import { EventJournal, computeEventHash } from "../src/domain/journal.js";

test("事件按序号与链式哈希追加", () => {
  const journal = new EventJournal();
  const e1 = journal.append("A", { x: 1 }, "u1");
  const e2 = journal.append("B", { x: 2 }, "u1");
  assert.equal(e1.seq, 1);
  assert.equal(e1.prevHash, "GENESIS");
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(journal.verify().ok, true);
});

test("哈希对负载内容敏感：改一个字段即断链", () => {
  const journal = new EventJournal();
  journal.append("A", { x: 1 });
  journal.append("B", { x: 2 });
  const events = journal.events.map((e) => ({ ...e, payload: { ...e.payload } }));
  events[1].payload.x = 99; // 暗改第二条
  assert.throws(() => new EventJournal(events), /哈希不符/);
});

test("插入历史事件同样被拒绝", () => {
  const journal = new EventJournal();
  journal.append("A", { x: 1 });
  journal.append("B", { x: 2 });
  const [e1, e2] = journal.events;
  const forged = { seq: 2, type: "X", payload: {}, actor: "x", occurredAt: new Date().toISOString(), prevHash: e1.hash };
  forged.hash = computeEventHash(forged);
  // 伪造者把原第二条挤到第三位：第三条的 prevHash 指向原链，与伪造条不衔接
  assert.throws(() => new EventJournal([e1, forged, e2]), /哈希链断裂/);
});

test("fold 可在任意序号停止以重建历史时刻", () => {
  const journal = new EventJournal();
  journal.append("n", { v: 1 });
  journal.append("n", { v: 2 });
  journal.append("n", { v: 3 });
  const sum = journal.fold((s, e) => s + e.payload.v, 0, { upToSeq: 2 });
  assert.equal(sum, 3);
});

test("首条事件 prevHash 必须为 GENESIS", () => {
  const bad = { seq: 1, type: "X", payload: {}, actor: "x", occurredAt: new Date().toISOString(), prevHash: "WRONG" };
  bad.hash = computeEventHash(bad);
  assert.throws(() => new EventJournal([bad]), /GENESIS/);
});
