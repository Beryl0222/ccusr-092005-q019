import { hashValue, sha256Hex } from "./crypto.js";
import { fail } from "./errors.js";

/**
 * 追加写事件日志——遴选全过程的唯一事实来源。
 *
 * 每条事件携带链式哈希：hash_n = SHA256(prevHash_n-1 || canonical(event_n))。
 * 任何对历史事件的插入、删除或暗改都会断裂校验链；
 * 选票在公示前同样以事件落盘，事后比对即可证明“未暗改选票”。
 */
export class EventJournal {
  #events = [];

  constructor(events = []) {
    for (const event of events) this.#ingest(event);
  }

  #ingest(event) {
    if (this.#events.length > 0) {
      const prev = this.#events[this.#events.length - 1];
      if (event.prevHash !== prev.hash) {
        fail("JOURNAL_BROKEN_CHAIN", "事件哈希链断裂，日志已被篡改或写入不完整", {
          atSeq: event.seq,
        });
      }
    } else if (event.prevHash !== "GENESIS") {
      fail("JOURNAL_BAD_GENESIS", "首条事件的 prevHash 必须为 GENESIS");
    }
    if (event.seq !== this.#events.length + 1) {
      fail("JOURNAL_BAD_SEQ", "事件序号不连续", { expected: this.#events.length + 1, got: event.seq });
    }
    if (event.hash !== computeEventHash(event)) {
      fail("JOURNAL_BAD_HASH", "事件内容与哈希不符", { atSeq: event.seq });
    }
    this.#events.push(event);
  }

  append(type, payload, actor = "system", occurredAt = new Date().toISOString()) {
    const seq = this.#events.length + 1;
    const prevHash = this.#events.length === 0 ? "GENESIS" : this.#events[this.#events.length - 1].hash;
    const event = { seq, type, payload, actor, occurredAt, prevHash };
    event.hash = computeEventHash(event);
    this.#events.push(event);
    return event;
  }

  get events() {
    return this.#events.slice();
  }

  get length() {
    return this.#events.length;
  }

  headHash() {
    return this.#events.length === 0 ? "GENESIS" : this.#events[this.#events.length - 1].hash;
  }

  /** 从空状态折叠到指定序号（默认为当前），用于复现任一历史时刻。 */
  fold(reducer, state, { upToSeq = Number.POSITIVE_INFINITY } = {}) {
    for (const event of this.#events) {
      if (event.seq > upToSeq) break;
      state = reducer(state, event);
    }
    return state;
  }

  /** 独立重算整链哈希，供外部审计调用。 */
  verify() {
    let prev = "GENESIS";
    for (const event of this.#events) {
      if (event.prevHash !== prev || event.hash !== computeEventHash(event)) {
        fail("JOURNAL_VERIFY_FAILED", "审计校验失败", { atSeq: event.seq });
      }
      prev = event.hash;
    }
    return { ok: true, events: this.#events.length, head: prev };
  }
}

export function computeEventHash(event) {
  const { hash: _omit, ...body } = event;
  return sha256Hex(`${event.prevHash}.${hashValue(body)}`);
}
