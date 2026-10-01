import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { sha256Hex } from "./hash.js";
import { Errors, fail } from "./errors.js";

/**
 * 仅追加事件存储。每条事件保存前一事件哈希，形成哈希链：
 * 任何插入、删除、修改都会在 verifyChain 时被发现。
 *
 * 事件结构：
 * { seq, id, type, at, actor, data, prevHash, hash }
 */
export class EventStore {
  constructor(clock = () => new Date().toISOString()) {
    this.events = [];
    this.clock = clock;
  }

  static async fromFile(path, clock) {
    const store = new EventStore(clock);
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      store.events = Array.isArray(raw) ? raw : raw.events;
      store.verifyChain();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    store.path = path;
    return store;
  }

  append(type, data = {}, { actor = "system", at = this.clock() } = {}) {
    const seq = this.events.length;
    const prevHash = seq === 0 ? null : this.events[seq - 1].hash;
    const id = data.eventId ?? `evt_${randomUUID()}`;
    const unsigned = { seq, id, type, at, actor, data, prevHash };
    const event = { ...unsigned, hash: sha256Hex(unsigned) };
    this.events.push(event);
    return event;
  }

  /** 从空状态折叠投影；toSeq 为事件序号上界（不含），用于复现历史时点。 */
  fold(reducer, initial, { toSeq = this.events.length } = {}) {
    let state = initial;
    for (const event of this.events) {
      if (event.seq >= toSeq) break;
      state = reducer(state, event);
    }
    return state;
  }

  headHash() {
    return this.events.length === 0 ? null : this.events[this.events.length - 1].hash;
  }

  verifyChain() {
    let prevHash = null;
    for (const event of this.events) {
      const { hash, ...unsigned } = event;
      const expected = sha256Hex(unsigned);
      if (event.prevHash !== prevHash || hash !== expected) {
        fail(Errors.TAMPERED, "事件日志哈希链校验失败，日志可能被篡改", {
          seq: event.seq,
        });
      }
      prevHash = hash;
    }
    return true;
  }

  async persist(path = this.path) {
    if (!path) fail(Errors.VALIDATION, "未配置持久化路径");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.events, null, 2), "utf8");
  }
}
