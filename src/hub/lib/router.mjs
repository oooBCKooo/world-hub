// 路由：十字路口本体。
//
// 它只做一件事——把一个主题上的消息，交给所有声明关心这个主题的订阅。
// 它不知道主题是什么意思，也不改变载荷，见《定位与边界》。

import { topicMatches } from './topic.mjs';
import { addressMatches, operationMatches } from './address.mjs';

/**
 * @typedef {object} Subscription
 * @property {string} id
 * @property {string} bridgeId
 * @property {string[]} filters
 * @property {number} cursor        已确认投递到的位置（客户端 ack 推进）
 * @property {number} sentUpTo      已发出的最大序号
 * @property {number} pending       未确认投递数（背压窗口占用）
 * @property {boolean} atMostOnce   delivery=at_most_once：不排队、不补课
 */

export class Router {
  #subs = new Map();
  #byBridge = new Map();
  #nextSubId = 1;

  get subscriptionCount() {
    return this.#subs.size;
  }

  subscriptionsOf(bridgeId) {
    return this.#byBridge.get(bridgeId) ?? [];
  }

  get(subscriptionId) {
    return this.#subs.get(subscriptionId) ?? null;
  }

  all() {
    return [...this.#subs.values()];
  }

  add({ bridgeId, principal, session, filters, operations, cursor, atMostOnce = false, maxPending }) {
    const id = `sub-${this.#nextSubId++}`;
    const sub = {
      id,
      bridgeId,
      principal,
      session,
      filters,
      operations,
      cursor,
      sentUpTo: cursor,
      pending: 0,
      inFlight: new Set(),
      acknowledgementOrder: [],
      acknowledged: new Set(),
      scanCursor: cursor,
      atMostOnce,
      maxPending,
      /** 补课阶段排队的实时消息（seq 升序、去重）。补课结束就是普通投递。 */
      queue: [],
      queueEntries: new Map(),
      /** 已投递过的序号（有界）：防止补课与实时队列交界处重复投递。 */
      sentSeqs: new Set(),
      catchUp: false,
      catchUpTarget: cursor,
      catchUpRunning: false,
      catchUpAgain: false,
      createdAt: new Date().toISOString(),
    };
    this.#subs.set(id, sub);
    if (!this.#byBridge.has(bridgeId)) this.#byBridge.set(bridgeId, []);
    this.#byBridge.get(bridgeId).push(sub);
    return sub;
  }

  remove(subscriptionId) {
    const sub = this.#subs.get(subscriptionId);
    if (!sub) return null;
    clearTimeout(sub.idleTimer);
    this.#subs.delete(subscriptionId);
    const list = this.#byBridge.get(sub.bridgeId);
    if (list) {
      const i = list.indexOf(sub);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.#byBridge.delete(sub.bridgeId);
    }
    return sub;
  }

  removeAllOf(bridgeId) {
    const list = this.#byBridge.get(bridgeId) ?? [];
    const removed = [];
    for (const sub of [...list]) {
      clearTimeout(sub.idleTimer);
      this.#subs.delete(sub.id);
      removed.push(sub);
    }
    this.#byBridge.delete(bridgeId);
    return removed;
  }

  /**
   * 判定一条已接受的消息该投给谁。
   *
   * 三种处置，二选一：
   *   queue —— 订阅正在补课：进队列，等补课追平后按序送出（不丢）
   *   drop  —— 背压窗口已满：这是"有界丢失"，必须向订阅者上报缺口
   *
   * @returns {{deliver: Array<{sub: Subscription, seq: number, entry: object}>,
   *            queue: Array<{sub: Subscription, seq: number, entry: object}>,
   *            drop: Array<{sub: Subscription, seq: number, entry: object, reason: string}>}}
   */
  route(topic, seq, entry) {
    const deliver = [];
    const queue = [];
    const drop = [];
    for (const sub of this.#subs.values()) {
      if (!addressMatches(entry, sub) || !operationMatches(entry, sub.operations)) continue;
      if (!sub.filters.some((f) => topicMatches(f, topic))) continue;

      if (sub.atMostOnce) {
        // 至多一次：不排队、不重发；丢了自己承担（订阅时已明确选择）。
        if (!sub.catchUp) deliver.push({ sub, seq, entry });
        continue;
      }

      if (sub.catchUp) {
        if (sub.queue.length >= sub.maxPending) {
          drop.push({ sub, seq, entry, reason: 'catch-up queue full' });
        } else {
          sub.queue.push(seq);
          sub.queueEntries.set(seq, entry);
          queue.push({ sub, seq, entry });
        }
        continue;
      }

      if (sub.pending >= sub.maxPending) {
        drop.push({ sub, seq, entry, reason: 'subscriber window full' });
        continue;
      }
      deliver.push({ sub, seq, entry });
    }
    return { deliver, queue, drop };
  }

  markSent(sub, seq) {
    if (seq <= sub.sentUpTo) return false;
    sub.sentUpTo = seq;
    if (sub.atMostOnce) sub.cursor = seq;
    else {
      sub.inFlight.add(seq);
      sub.acknowledgementOrder.push(seq);
      sub.pending = sub.acknowledgementOrder.length;
    }
    return true;
  }

  ack(sub, seq) {
    if (!sub.inFlight.delete(seq)) return false;
    sub.acknowledged.add(seq);
    while (sub.acknowledgementOrder.length > 0 && sub.acknowledged.has(sub.acknowledgementOrder[0])) {
      const confirmed = sub.acknowledgementOrder.shift();
      sub.acknowledged.delete(confirmed);
      sub.cursor = confirmed;
    }
    sub.pending = sub.acknowledgementOrder.length;
    return true;
  }

  /** 队列里 seq <= upTo 且尚未送达的项，按升序返回。 */
  takeQueued(sub, upTo) {
    const out = [];
    while (sub.queue.length > 0 && sub.queue[0] <= upTo) {
      const seq = sub.queue.shift();
      const entry = sub.queueEntries.get(seq);
      sub.queueEntries.delete(seq);
      if (entry) out.push({ seq, entry });
    }
    return out;
  }

  clearQueue(sub) {
    sub.queue.length = 0;
    sub.queueEntries.clear();
  }
}
