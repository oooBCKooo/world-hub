// Envelope syntax only. Preserve the original body text for routing/storage;
// no payload key is used to select destinations or execute application behavior.
function valueEnd(text, start) {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (depth === 0) return i;
      depth--;
    } else if (char === ',' && depth === 0) return i;
  }
  return text.length;
}

export function parseEnvelope(text) {
  const frame = JSON.parse(text); // Validate JSON syntax; decoded body is never the retransmission source.
  if (!frame || Array.isArray(frame) || typeof frame !== 'object') return { frame, bodyRaw: undefined };
  let i = text.indexOf('{') + 1;
  let bodyRaw;
  const keys = new Set();
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '') || text[i] === ',') i++;
    if (text[i] === '}') break;
    const keyStart = i++;
    let escaped = false;
    while (i < text.length) {
      const char = text[i++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const key = JSON.parse(text.slice(keyStart, i));
    if (keys.has(key)) throw new SyntaxError('duplicate envelope field');
    keys.add(key);
    while (/\s/.test(text[i] ?? '')) i++;
    i++; // colon, already validated by JSON.parse
    while (/\s/.test(text[i] ?? '')) i++;
    const end = valueEnd(text, i);
    if (key === 'body') bodyRaw = text.slice(i, end).trimEnd();
    i = end;
  }
  return { frame, bodyRaw };
}

export function stringifyEnvelope(frame, bodyRaw = frame.bodyRaw) {
  return '{' + Object.keys(frame).filter((key) => key !== 'bodyRaw').map((key) => {
    const value = key === 'body' && typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(frame[key]);
    return value === undefined ? null : JSON.stringify(key) + ':' + value;
  }).filter((part) => part !== null).join(',') + '}';
}

export function attachBodyRaw(frame, bodyRaw) {
  if (typeof bodyRaw === 'string') Object.defineProperty(frame, 'bodyRaw', { value: bodyRaw, configurable: true });
  return frame;
}
