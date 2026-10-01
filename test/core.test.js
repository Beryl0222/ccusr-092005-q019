import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, expectError } from "./helpers/setup.js";
import { EventStore } from "../src/core/eventStore.js";
import { canonicalize, sha256Hex, fingerprint } from "../src/core/hash.js";
import { Errors } from "../src/core/errors.js";

test("规范化哈希：键顺序不影响结果", () => {
  assert.equal(
    sha256Hex({ a: 1, b: { c: 2, d: 3 } }),
    sha256Hex({ b: { d: 3, c: 2 }, a: 1 })
  );
  assert.notEqual(sha256Hex({ a: 1 }), sha256Hex({ a: 2 }));
});

test("证据指纹对内容敏感", () => {
  assert.equal(fingerprint("证明原文"), fingerprint("证明原文"));
  assert.notEqual(fingerprint("证明原文"), fingerprint("证明原文 "));
});

test("事件存储形成哈希链，折叠可复现任意时点", () => {
  const store = new EventStore();
  store.append("A", { v: 1 }, { actor: "x" });
  store.append("B", { v: 2 }, { actor: "x" });
  store.append("C", { v: 3 }, { actor: "x" });
  assert.equal(store.events.length, 3);
  assert.equal(store.events[0].prevHash, null);
  assert.equal(store.events[1].prevHash, store.events[0].hash);
  assert.ok(store.verifyChain());

  const count = store.fold((n) => n + 1, 0, { toSeq: 2 });
  assert.equal(count, 2);
});

test("直接改动历史事件会被哈希链发现", () => {
  const store = new EventStore();
  store.append("A", { v: 1 });
  store.append("B", { v: 2 });
  store.events[0].data = { v: 999 };
  assert.throws(() => store.verifyChain(), (e) => e.code === Errors.TAMPERED);
});

test("插入或删除事件也会破坏哈希链", () => {
  const store = new EventStore();
  store.append("A", { v: 1 });
  store.append("B", { v: 2 });
  store.append("C", { v: 3 });
  store.events.splice(1, 1); // 删除中间事件
  assert.throws(() => store.verifyChain(), (e) => e.code === Errors.TAMPERED);
});

test("事件存储可落盘并重新载入校验", async () => {
  const path = join(tmpdir(), `honors-${Date.now()}-${Math.random()}.json`);
  const store = new EventStore();
  store.append("A", { v: 1 });
  await store.persist(path);

  const reloaded = await EventStore.fromFile(path);
  assert.ok(reloaded.verifyChain());
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.headHash(), store.headHash());
});

test("载入被篡改的日志文件直接失败", async () => {
  const path = join(tmpdir(), `honors-bad-${Date.now()}.json`);
  const store = new EventStore();
  store.append("A", { v: 1 });
  store.append("B", { v: 2 });
  await store.persist(path);
  const { writeFile } = await import("node:fs/promises");
  const raw = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(path, "utf8")));
  raw[1].data.v = 999;
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(() => EventStore.fromFile(path), (e) => e.code === Errors.TAMPERED);
});

test("canonicalize 对数组与基本类型稳定", () => {
  assert.equal(canonicalize([1, 2, 3]), "[1,2,3]");
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize("s"), '"s"');
});
