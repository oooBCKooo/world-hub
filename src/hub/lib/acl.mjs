// 权限：谁能发什么主题、谁能订什么主题。
//
// 这是枢纽唯一的"语义判断"，而且它判断的是字符串模式，不是业务含义。
// 默认拒绝：配置里没写的连不上，见《可靠性与访问边界》。
//
// 两种登记方式，对应两种真实需求：
//   acl.bridges.<bridgeId>    一个身份一条连接。同名重连 = 接管旧连接（网络抖动场景）
//   acl.credentials.<credId>  一个凭据最多 N 条连接，每条连接拿到独立实例身份
//                             （同一个程序开多个实例的正确做法：如两个面板窗口）

import { safeEqual } from './store.mjs';
import { isValidFilter, isValidTopic, topicMatches } from './topic.mjs';
import { isValidBridgeId } from './identity.mjs';

// 实例身份里的冒号只由枢纽添加；客户端自报的标识不允许含冒号，
// 以免伪造出"看起来像另一个实例"的名字。
export { BRIDGE_ID_PATTERN, isValidBridgeId } from './identity.mjs';

export class Acl {
  #config;

  constructor(config) {
    this.#config = config;
  }

  /**
   * 认证一次接入。
   * @returns {{ok: true, authenticated: boolean, unlisted?: boolean, credential: string, instance?: number}
   *          | {ok: false, code: string, message: string}}
   */
  authenticate(bridgeId, token, remoteAddress, credentialId, liveInstances = 0) {
    if (!isValidBridgeId(bridgeId)) {
      return { ok: false, code: 'BRIDGE_ID_INVALID', message: 'bridge id must match [a-z0-9][a-z0-9._-]{0,63}' };
    }
    if (credentialId) {
      return this.#authenticateCredential(bridgeId, token, remoteAddress, credentialId, liveInstances);
    }
    const entry = this.#config.acl.bridges[bridgeId];
    if (!entry) {
      if (this.#config.acl.allowUnlistedBridges && isLoopback(remoteAddress)) {
        return { ok: true, authenticated: false, unlisted: true, credential: bridgeId };
      }
      return {
        ok: false,
        code: 'BRIDGE_NOT_REGISTERED',
        message: `bridge "${bridgeId}" is not present in acl.bridges`,
      };
    }
    if (entry.token) {
      if (!safeEqual(entry.token, token ?? '')) {
        return { ok: false, code: 'BRIDGE_TOKEN_REJECTED', message: 'token does not match' };
      }
      return { ok: true, authenticated: true, credential: bridgeId };
    }
    if (!isLoopback(remoteAddress)) {
      return {
        ok: false,
        code: 'BRIDGE_TOKEN_REQUIRED',
        message: 'bridge has no token configured and the connection is not loopback',
      };
    }
    return { ok: true, authenticated: false, credential: bridgeId };
  }

  #authenticateCredential(bridgeId, token, remoteAddress, credentialId, liveInstances) {
    if (!isValidBridgeId(credentialId)) {
      return { ok: false, code: 'CREDENTIAL_ID_INVALID', message: 'credential id must match [a-z0-9][a-z0-9._-]{0,63}' };
    }
    const cred = this.#config.acl.credentials[credentialId];
    if (!cred) {
      return { ok: false, code: 'CREDENTIAL_NOT_REGISTERED', message: `credential "${credentialId}" is unknown` };
    }
    if (cred.token) {
      if (!safeEqual(cred.token, token ?? '')) {
        return { ok: false, code: 'BRIDGE_TOKEN_REJECTED', message: 'token does not match' };
      }
    } else if (!isLoopback(remoteAddress)) {
      return {
        ok: false,
        code: 'BRIDGE_TOKEN_REQUIRED',
        message: 'credential has no token and the connection is not loopback',
      };
    }
    if (liveInstances >= cred.maxConnections) {
      return {
        ok: false,
        code: 'CREDENTIAL_QUOTA_EXCEEDED',
        message: `credential "${credentialId}" already has ${liveInstances} live connection(s), max ${cred.maxConnections}`,
      };
    }
    return {
      ok: true,
      authenticated: Boolean(cred.token),
      credential: credentialId,
      instance: liveInstances + 1,
    };
  }

  /** 发布授权。 */
  canPublish(credentialId, topic) {
    if (!isValidTopic(topic)) {
      return { ok: false, code: 'TOPIC_INVALID', message: `topic "${topic}" is not a valid topic` };
    }
    const entry = this.#config.acl.bridges[credentialId] ?? this.#config.acl.credentials[credentialId];
    if (!entry) {
      // 开发模式下的未预置桥：本机放行全部主题，但每一次都在接线图上显示为"未认证"。
      if (this.#config.acl.allowUnlistedBridges) return { ok: true };
      return { ok: false, code: 'BRIDGE_NOT_REGISTERED', message: 'bridge is not registered' };
    }
    const rules = entry.allow.publish;
    if (rules.length === 0) {
      return { ok: false, code: 'PUBLISH_DENIED', message: `"${credentialId}" has no publish rule` };
    }
    if (!rules.some((f) => topicMatches(f, topic))) {
      return { ok: false, code: 'PUBLISH_DENIED', message: `"${credentialId}" may not publish to "${topic}"` };
    }
    return { ok: true };
  }

  /** 订阅授权：过滤器里的通配符同样受规则约束。 */
  canSubscribe(credentialId, filter) {
    if (!isValidFilter(filter)) {
      return { ok: false, code: 'FILTER_INVALID', message: `filter "${filter}" is not a valid filter` };
    }
    const entry = this.#config.acl.bridges[credentialId] ?? this.#config.acl.credentials[credentialId];
    if (!entry) {
      if (this.#config.acl.allowUnlistedBridges) return { ok: true };
      return { ok: false, code: 'BRIDGE_NOT_REGISTERED', message: 'bridge is not registered' };
    }
    const rules = entry.allow.subscribe;
    if (rules.length === 0) {
      return { ok: false, code: 'SUBSCRIBE_DENIED', message: `"${credentialId}" has no subscribe rule` };
    }
    // 过滤器必须被某条规则覆盖：规则的每一段都要能容纳过滤器的每一段。
    if (!rules.some((rule) => filterCovers(rule, filter))) {
      return { ok: false, code: 'SUBSCRIBE_DENIED', message: `"${credentialId}" may not subscribe to "${filter}"` };
    }
    return { ok: true };
  }
}

/**
 * 规则 rule 是否覆盖过滤器 filter。
 * rule 是授权上限：`source/#` 覆盖 `source/+/move`，反之不成立。
 */
export function filterCovers(rule, filter) {
  if (rule === '#') return true;
  const r = rule.split('/');
  const f = filter.split('/');
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '#') return true;
    if (i >= f.length) return false;
    if (f[i] === '#') return false; // 过滤器比规则更宽
    if (r[i] === '+') continue; // 规则仅放宽一段，不能覆盖多层通配符
    if (f[i] === '+') {
      if (r[i] !== '+') return false;
      continue;
    }
    if (r[i] !== f[i]) return false;
  }
  return f.length === r.length;
}

function isLoopback(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
