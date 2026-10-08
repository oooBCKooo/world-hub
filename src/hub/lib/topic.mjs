// 主题匹配。枢纽只会做这一种字符串运算——它不理解主题里的任何词是什么意思。
//
// 语法（沿用通配符主题的既有习惯，避免发明第二套）：
//   game/player/move      具体主题
//   game/+/move           + 匹配恰好一层
//   game/#                # 匹配零层或多层，只能出现在末尾
//   #                     订阅一切（需要更强的权限授权，见 acl.mjs）

/** 主题必须是斜杠分隔的非空段；不允许空段。 */
export function isValidTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0 || topic.length > 512) return false;
  const parts = topic.split('/');
  for (const p of parts) {
    if (p.length === 0) return false;
    if (p === '#' || p === '+') return false; // 通配符只允许出现在 filter 里
    if (p.includes(' ') || p.includes('\u0000')) return false;
  }
  return true;
}

/** 订阅过滤器：具体主题、含 + / # 的模式。 */
export function isValidFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0 || filter.length > 512) return false;
  const parts = filter.split('/');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 0) return false;
    if (p === '#') {
      if (i !== parts.length - 1) return false; // # 只能在末尾
      continue;
    }
    if (p === '+') continue;
    if (p.includes('#') || p.includes('+')) return false; // 通配符必须独占一段
  }
  return true;
}

/**
 * filter 是否匹配 topic。
 * 纯字符串运算，无回溯，无正则，可判定。
 */
export function topicMatches(filter, topic) {
  if (filter === '#') return true;
  const f = filter.split('/');
  const t = topic.split('/');
  let i = 0;
  for (; i < f.length; i++) {
    const seg = f[i];
    if (seg === '#') return true;
    if (i >= t.length) return false;
    if (seg === '+') continue;
    if (seg !== t[i]) return false;
  }
  return i === t.length;
}

/** 归一化：去重 + 保持顺序。 */
export function normalizeFilters(filters) {
  const seen = new Set();
  const out = [];
  for (const f of filters ?? []) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}
