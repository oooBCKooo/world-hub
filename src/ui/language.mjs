// Presentation preferences only. Wire frames, user content and application
// contracts never pass through this translator.
export const LANGUAGE_STORAGE_KEY = 'world-hub.ui.language';
export const LANGUAGE_EVENT = 'world-hub:ui-language';
export const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en']);

export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  if (/^en(?:-|$)/i.test(value)) return 'en';
  if (/^zh(?:-|$)/i.test(value)) return 'zh-CN';
  return null;
}

function storageFor(environment) {
  try { return environment.localStorage; } catch { return null; }
}

function preferredLanguage(environment, fallback) {
  // Node can expose navigator too; pure presentation helpers still default to
  // Chinese outside a browser unless a language is explicitly selected.
  if (!environment.document && !environment.location) return normalizeLanguage(fallback) ?? 'zh-CN';
  const languages = environment.navigator?.languages ?? [environment.navigator?.language];
  for (const value of languages) {
    const language = normalizeLanguage(value);
    if (language) return language;
  }
  return normalizeLanguage(fallback) ?? 'zh-CN';
}

function queryLanguage(environment) {
  try { return normalizeLanguage(new URL(environment.location.href).searchParams.get('lang')); }
  catch { return null; }
}

export function createI18n(english = {}, { environment = globalThis, defaultLanguage = 'zh-CN' } = {}) {
  const storage = storageFor(environment);
  let saved;
  try { saved = normalizeLanguage(storage?.getItem(LANGUAGE_STORAGE_KEY)); } catch { /* Private or blocked storage. */ }
  const explicit = queryLanguage(environment);
  let language = explicit ?? saved ?? preferredLanguage(environment, defaultLanguage);
  const subscribers = new Set();

  function save(value) {
    try { storage?.setItem(LANGUAGE_STORAGE_KEY, value); } catch { /* Switching still works without persistence. */ }
  }
  function updateDocument() {
    if (environment.document?.documentElement) environment.document.documentElement.lang = language;
  }
  function receive(value) {
    const next = normalizeLanguage(value);
    if (!next || next === language) return;
    language = next;
    updateDocument();
    for (const callback of [...subscribers]) callback(language);
  }
  updateDocument();
  if (explicit) save(explicit);

  const handleLanguage = event => receive(event.detail?.language);
  const handleStorage = event => {
    if (event.key === LANGUAGE_STORAGE_KEY) {
      receive(normalizeLanguage(event.newValue) ?? preferredLanguage(environment, defaultLanguage));
    }
  };
  environment.addEventListener?.(LANGUAGE_EVENT, handleLanguage);
  environment.addEventListener?.('storage', handleStorage);

  function t(source, params = {}) {
    const key = String(source ?? '');
    const template = language === 'en' && Object.hasOwn(english, key) ? english[key] : key;
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.hasOwn(params, name) ? String(params[name] ?? '') : match);
  }

  const attributes = [['title', 'data-i18n-title'], ['placeholder', 'data-i18n-placeholder'],
    ['aria-label', 'data-i18n-aria-label'], ['alt', 'data-i18n-alt']];
  const selector = ['[data-i18n]', ...attributes.map(([, name]) => '[' + name + ']')].join(',');
  function apply(root = environment.document) {
    if (!root) return;
    const elements = [...(root.querySelectorAll?.(selector) ?? [])];
    if (root.matches?.(selector)) elements.unshift(root);
    for (const element of elements) {
      const source = element.getAttribute('data-i18n');
      if (source !== null) element.textContent = t(source);
      for (const [attribute, key] of attributes) {
        const value = element.getAttribute(key);
        if (value !== null) element.setAttribute(attribute, t(value));
      }
    }
  }

  return {
    get language() { return language; },
    t,
    apply,
    setLanguage(value) {
      const next = normalizeLanguage(value);
      if (!next) return false;
      save(next);
      receive(next);
      const CustomEventClass = environment.CustomEvent ?? globalThis.CustomEvent;
      if (environment.dispatchEvent && CustomEventClass) {
        environment.dispatchEvent(new CustomEventClass(LANGUAGE_EVENT, { detail: { language: next } }));
      }
      return true;
    },
    onChange(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    dispose() {
      environment.removeEventListener?.(LANGUAGE_EVENT, handleLanguage);
      environment.removeEventListener?.('storage', handleStorage);
      subscribers.clear();
    },
  };
}
