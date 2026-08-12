const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function makeElement(id) {
  const listeners = {};
  const el = {
    id,
    value: '',
    style: {},
    innerHTML: '',
    textContent: '',
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    removeEventListener: () => {},
    _listeners: listeners,
    _fire: (evt, arg) => (listeners[evt] || []).forEach((fn) => fn(arg)),
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => {},
    click: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    children: [],
  };
  return el;
}

function createDom() {
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: (tag) => makeElement(`${tag}-${Math.random().toString(36).slice(2)}`),
    querySelector: (sel) => {
      if (sel.includes('input[name="redact-style"]')) {
        return { value: 'text', checked: true };
      }
      return null;
    },
    querySelectorAll: () => [],
    body: makeElement('body'),
    addEventListener: () => {},
  };
  return { document, elements };
}

function createLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
    _keys: () => Array.from(store.keys()),
  };
}

// Transform the hosted app.js so the test harness can drive it via window.Scrambler
// without modifying any source outside tests/.
function prepareAppJs(code) {
  if (code.includes('window.Scrambler')) return code;

  const polyfill = `
  const requestAnimationFrame = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    ? window.requestAnimationFrame
    : (cb) => setTimeout(cb, 0);
`;

  const api = `

  // Test-only API exposed for programmatic use.
  function offlineMask(input, config) {
    if (config) offlineConfigure(config);
    $('input-text').value = input;
    maskText();
    return { text: $('masked-text').value, mappings };
  }

  function offlineUnmask(maskedText, mappingsArg) {
    if (mappingsArg) mappings = mappingsArg;
    $('llm-response').value = maskedText;
    unmaskText();
    return $('final-text').value;
  }

  function offlineConfigure(config) {
    if (config.preset && PRESETS[config.preset]) applyPreset(config.preset);
    for (const p of PATTERNS) {
      if (typeof config[p.type] === 'boolean') toggles[p.type] = config[p.type];
    }
    if (Array.isArray(config.alwaysMask)) {
      alwaysMask = config.alwaysMask.map(term => ({ id: uid(), term, replacementType: 'generic' }));
    }
    if (Array.isArray(config.neverMask)) {
      neverMask = config.neverMask.map(term => ({ id: uid(), term }));
    }
    if (typeof config.rememberCustomTerms === 'boolean') {
      rememberTerms = config.rememberCustomTerms;
    }
    saveTerms();
  }

  window.Scrambler = {
    mask: offlineMask,
    unmask: offlineUnmask,
    configure: offlineConfigure,
    PRESETS,
    get mappings() { return mappings; }
  };
`;

  code = code.replace("  'use strict';", "  'use strict';" + polyfill);

  const close = /\n\s*\}\)\(\);\s*$/.exec(code);
  if (!close) return code;
  return code.slice(0, close.index) + api + '\n})();';
}

function findScriptSource(preferred = null) {
  if (preferred === 'offline') {
    const offlineHtml = path.join(PUBLIC_DIR, 'scrambler-offline.html');
    if (fs.existsSync(offlineHtml)) {
      const html = fs.readFileSync(offlineHtml, 'utf8');
      const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (match) return { source: 'offline', code: match[1] };
    }
  }

  const appJs = path.join(PUBLIC_DIR, 'app.js');
  if (fs.existsSync(appJs)) {
    return { source: 'app.js', code: fs.readFileSync(appJs, 'utf8') };
  }
  const indexHtml = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    const html = fs.readFileSync(indexHtml, 'utf8');
    const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (match) {
      return { source: 'inline', code: match[1] };
    }
  }
  const offlineHtml = path.join(PUBLIC_DIR, 'scrambler-offline.html');
  if (fs.existsSync(offlineHtml)) {
    const html = fs.readFileSync(offlineHtml, 'utf8');
    const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (match) {
      return { source: 'offline', code: match[1] };
    }
  }
  return { source: null, code: null };
}

function loadApp({ preferred } = {}) {
  const { source, code } = findScriptSource(preferred);
  let preparedCode = code;
  if (!source) {
    return { exists: false, source: null };
  }

  const networkCalls = [];
  const { document, elements } = createDom();
  const localStorage = createLocalStorage();

  const context = {
    window: {},
    document,
    localStorage,
    console: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
    alert: () => {},
    confirm: () => true,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: (...args) => {
      networkCalls.push({ type: 'fetch', args });
      return Promise.reject(new Error('Network disabled in tests'));
    },
    XMLHttpRequest: function () {
      networkCalls.push({ type: 'xhr' });
      throw new Error('Network disabled in tests');
    },
    FormData: function () {
      this.append = () => {};
    },
    File: function () {},
    setTimeout,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    Buffer,
  };
  context.window = context;

  if (source === 'app.js') {
    preparedCode = prepareAppJs(code);
  }

  vm.createContext(context);
  vm.runInContext(preparedCode, context, { filename: source });

  // Expose internal state so tests can inspect mappings without relying on globals.
  const stateExposure = `
    if (typeof window !== 'undefined') {
      window.__getState = function() {
        return {
          mappings: typeof mappings !== 'undefined' ? mappings : [],
          counters: typeof counters !== 'undefined' ? counters : {}
        };
      };
    }
  `;
  vm.runInContext(stateExposure, context);

  const globals = Object.keys(context);
  let pendingConfig = {};

  function currentMappings() {
    if (context.Scrambler && context.Scrambler.mappings) return context.Scrambler.mappings;
    if (context.mappings) return context.mappings;
    if (typeof context.__getState === 'function') {
      return context.__getState().mappings;
    }
    return [];
  }

  function mask(input, config = {}) {
    networkCalls.length = 0;
    const mergedConfig = { ...pendingConfig, ...config };
    const inputEl = document.getElementById('input-text');
    const outputEl = document.getElementById('masked-text');
    const llmEl = document.getElementById('llm-response');

    if (context.Scrambler && typeof context.Scrambler.mask === 'function') {
      const result = context.Scrambler.mask(input, mergedConfig);
      return typeof result === 'string' ? { text: result, mappings: currentMappings() } : result;
    }

    if (typeof context.mask === 'function' && context.mask.length >= 1) {
      const result = context.mask(input, mergedConfig);
      return typeof result === 'string' ? { text: result, mappings: currentMappings() } : result;
    }

    // Fall back to inline DOM-driven functions.
    if (inputEl) inputEl.value = input;
    if (llmEl) llmEl.value = '';
    if (typeof context.maskText === 'function') {
      context.maskText();
      return { text: outputEl ? outputEl.value : '', mappings: currentMappings() };
    }

    throw new Error('No mask function found in loaded app source');
  }

  function unmask(maskedText, mappingsArg) {
    networkCalls.length = 0;
    const llmEl = document.getElementById('llm-response');
    const finalEl = document.getElementById('final-text');
    const mappings = mappingsArg || currentMappings();

    if (context.Scrambler && typeof context.Scrambler.unmask === 'function') {
      return context.Scrambler.unmask(maskedText, mappings);
    }

    if (typeof context.unmask === 'function') {
      return context.unmask(maskedText, mappings);
    }

    if (llmEl) llmEl.value = maskedText;
    if (typeof context.unmaskText === 'function') {
      context.unmaskText();
      return finalEl ? finalEl.value : '';
    }

    throw new Error('No unmask function found in loaded app source');
  }

  function configure(config) {
    pendingConfig = { ...pendingConfig, ...config };

    if (context.Scrambler && typeof context.Scrambler.configure === 'function') {
      context.Scrambler.configure(pendingConfig);
      return;
    }
    if (context.Scrambler && typeof context.Scrambler.setConfig === 'function') {
      context.Scrambler.setConfig(pendingConfig);
      return;
    }
    if (typeof context.configure === 'function') {
      context.configure(pendingConfig);
      return;
    }
    if (typeof context.setConfig === 'function') {
      context.setConfig(pendingConfig);
      return;
    }
    if (context.Scrambler && context.Scrambler.config) {
      Object.assign(context.Scrambler.config, pendingConfig);
      return;
    }
    if (context.config) {
      Object.assign(context.config, pendingConfig);
    }
  }

  function getMappings() {
    return currentMappings();
  }

  function getPresets() {
    if (context.Scrambler && context.Scrambler.PRESETS) return context.Scrambler.PRESETS;
    if (context.Scrambler && context.Scrambler.presets) return context.Scrambler.presets;
    if (context.PRESETS) return context.PRESETS;
    if (context.presets) return context.presets;
    return null;
  }

  return {
    exists: true,
    source,
    context,
    document,
    elements,
    localStorage,
    networkCalls,
    mask,
    unmask,
    configure,
    getMappings,
    getPresets,
    globals,
  };
}

module.exports = { loadApp, findScriptSource };
