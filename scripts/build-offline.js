#!/usr/bin/env node
/**
 * Build a single self-contained offline HTML file for Scrambler's text masking.
 *
 * This script is intentionally written with only Node.js standard-library calls.
 * It reads the hosted frontend assets (public/index.html, public/styles.css,
 * public/app.js) and emits public/scrambler-offline.html with all CSS and JS
 * inlined and every network-dependent feature removed.
 *
 * The offline artefact deliberately differs from the hosted page: the hosted
 * page is served with a strict Content-Security-Policy and therefore keeps JS/CSS
 * in separate files, while the downloaded copy must work from a local file://
 * origin with no server and no policy headers, so inlining is both safe and
 * necessary. The offline copy also omits the PDF tab entirely, because PDF
 * redaction requires the server-side Python redactor.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX_HTML = path.join(PUBLIC, 'index.html');
const STYLES_CSS = path.join(PUBLIC, 'styles.css');
const APP_JS = path.join(PUBLIC, 'app.js');
const OUT = path.join(PUBLIC, 'scrambler-offline.html');
const NETWORK_KEYWORDS = [
  'fetch',
  'xmlhttprequest',
  'http://',
  'https://',
  '<script src=',
  '<link ',
  'href="//',
  "href='//",
  'src="//',
  "src='//",
  '@import url',
];
const PDF_ENDPOINTS = [
  '/api/pdf/',
  '/api/pdf/analyze',
  '/api/pdf/redact',
  '/api/pdf/status',
];
function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}
function readIfExists(p) {
  try {
    return readUtf8(p);
  } catch {
    return null;
  }
}
function extractFirst(html, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const start = html.indexOf(open);
  if (start === -1) return null;
  const contentStart = html.indexOf('>', start) + 1;
  const contentEnd = html.indexOf(close, contentStart);
  if (contentEnd === -1) return null;
  return html.slice(contentStart, contentEnd);
}
/**
 * Find the matching closing brace for the brace at openIdx, skipping strings,
 * comments, template literals and (optionally) regex literals.
 */
function findMatchingBrace(src, openIdx, opts = { regex: true, backtick: true }) {
  let i = openIdx + 1;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inRegex = false;
  let escape = false;
  while (i < src.length && depth > 0) {
    const c = src[i];
    const p = src[i - 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (c === '/' && p === '*') inBlockComment = false;
    } else if (inRegex) {
      if (c === '/' && !escape) inRegex = false;
      if (c === '\\' && !escape) escape = true;
      else escape = false;
    } else if (inSingle) {
      if (c === "'" && !escape) inSingle = false;
      if (c === '\\' && !escape) escape = true;
      else escape = false;
    } else if (inDouble) {
      if (c === '"' && !escape) inDouble = false;
      if (c === '\\' && !escape) escape = true;
      else escape = false;
    } else if (inBacktick) {
      if (c === '`' && !escape) inBacktick = false;
      if (c === '\\' && !escape) escape = true;
      else escape = false;
    } else {
      if (c === '/' && src[i + 1] === '/') {
        inLineComment = true;
        i++;
      } else if (c === '/' && src[i + 1] === '*') {
        inBlockComment = true;
        i++;
      } else if (c === "'") {
        inSingle = true;
      } else if (c === '"') {
        inDouble = true;
      } else if (opts.backtick !== false && c === '`') {
        inBacktick = true;
      } else if (opts.regex !== false && c === '/' && isRegexStart(src, i)) {
        inRegex = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
      }
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}
function isRegexStart(src, i) {
  if (src[i] !== '/') return false;
  if (src[i + 1] === '/' || src[i + 1] === '*') return false;
  if (i === 0) return true;
  const prev = src[i - 1];
  if (/[a-zA-Z0-9_$)\]]/.test(prev)) return false;
  return true;
}
function removeBalancedBlock(html, tag, predicate) {
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = openRe.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = html.indexOf('>', tagStart);
    if (tagEnd === -1) break;
    const attrs = html.slice(tagStart + tag.length + 1, tagEnd);
    if (predicate(attrs)) {
      const openStr = `<${tag}`;
      const closeStr = `</${tag}>`;
      let depth = 1;
      let i = tagEnd + 1;
      let blockEnd = -1;
      while (i < html.length && depth > 0) {
        const nextOpen = html.indexOf(openStr, i);
        const nextClose = html.indexOf(closeStr, i);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          i = nextOpen + openStr.length;
        } else {
          depth--;
          if (depth === 0) {
            blockEnd = nextClose + closeStr.length;
            break;
          }
          i = nextClose + closeStr.length;
        }
      }
      if (blockEnd !== -1) {
        result += html.slice(lastIndex, tagStart);
        lastIndex = blockEnd;
        openRe.lastIndex = lastIndex;
      }
    }
  }
  return result + html.slice(lastIndex);
}
function removeExternalLinks(html) {
  // Remove any <a> tag whose href is an absolute http(s) URL, preserving inner content.
  return html.replace(/<a\b[^>]*\bhref=["']https?:\/\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1');
}
function removeExternalTags(html) {
  // <link> tags (external fonts, stylesheets, etc.)
  html = html.replace(/<link\b[^>]*>/gi, '');
  // <script> tags with a src attribute (external or hosted app.js)
  html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');
  // inline <script> and <style> blocks; the sanitized versions are inserted later
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  return html;
}
/**
 * Remove whole top-level function declarations whose names match the predicate.
 * Functions are recognised by the IIFE's top-level `function name(` declarations.
 */
function removeTopLevelFunctionBlocks(js, predicate) {
  const openRe = /\n(\s*)(async\s+)?function\s+(\w+)\s*\(/g;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = openRe.exec(js)) !== null) {
    const fnStart = match.index;
    const fnName = match[3];
    const sigEnd = openRe.lastIndex;
    const braceIdx = js.indexOf('{', sigEnd);
    if (braceIdx === -1) break;
    if (!predicate(fnName)) {
      result += js.slice(lastIndex, sigEnd);
      lastIndex = sigEnd;
      continue;
    }
    const braceEnd = findMatchingBrace(js, braceIdx, { regex: true, backtick: true });
    if (braceEnd === -1) break;
    result += js.slice(lastIndex, fnStart);
    lastIndex = braceEnd + 1;
    while (lastIndex < js.length && /[ \t]/.test(js[lastIndex])) lastIndex++;
    if (lastIndex < js.length && js[lastIndex] === '\n') lastIndex++;
    openRe.lastIndex = lastIndex;
  }
  result += js.slice(lastIndex);
  return result;
}
function removeMatchingLines(js, pattern) {
  return js.split('\n').filter((line) => !pattern.test(line)).join('\n');
}
function stripScriptPdf(js) {
  // Remove PDF-only top-level functions, plus the tab-switching helpers.
  js = removeTopLevelFunctionBlocks(
    js,
    (name) => /pdf/i.test(name) || name === 'switchTab' || name === 'handleTabKey'
  );
  // Remove the dataset assignment that iterates over the (removed) tab buttons.
  js = js.replace(
    /for\s*\(\s*const\s+t\s+of\s+\$\$\(['"].tab['"]\)\)\s*t\.dataset\.tab\s*=\s*t\.id\.replace\(['"]tab-['"],\s*['"]['"]\)\s*;?\s*/g,
    ''
  );
  // Remove PDF state variables from the top-level let declaration.
  js = js.replace(
    /(let\s+mappings\s*=\s*\[\],\s*counters\s*=\s*\{\},\s*)pdfBase64\s*=\s*null,\s*pdfBlobUrl\s*=\s*null,\s*(\w+)/,
    '$1$2'
  );
  // Remove PDF references inside newSession and bindEvents.
  js = js.replace(/\s*\|\|\s*pdfBase64/g, '');
  js = js.replace(/;\s*pdfBase64\s*=\s*null\s*;?/g, ';');
  js = js.replace(
    /\n\s*if\s*\(\s*pdfBlobUrl\s*\)\s*\{\s*URL\.revokeObjectURL\s*\(\s*pdfBlobUrl\s*\)\s*;\s*pdfBlobUrl\s*=\s*null\s*;\s*\}\s*/g,
    '\n'
  );
  js = js.replace(/,\s*['"]pdf-result-card['"]/g, '');
  // Drop lines that reference PDF UI elements or dead tab helpers.
  js = removeMatchingLines(
    js,
    /\b(?:dz|pdfInput|processPdf|downloadPdf|download-pdf-btn|drop-zone|pdf-input|pdf-status|tablist|switchTab|handleTabKey)\b/
  );
  return js;
}
function addOfflineApi(js) {
  const close = /\n\s*\}\)\(\);\s*$/.exec(js);
  if (!close) return js;
  const api = `
  // Offline-only API exposed for programmatic use and tests.
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
      alwaysMask = config.alwaysMask.map((term) => ({ id: uid(), term, replacementType: 'generic' }));
    }
    if (Array.isArray(config.neverMask)) {
      neverMask = config.neverMask.map((term) => ({ id: uid(), term }));
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
  return js.slice(0, close.index) + api + '\n})();';
}
function insertOfflinePolyfills(js) {
  // The offline file may be opened in a simple runtime without requestAnimationFrame.
  // Use a setTimeout-based fallback so the announcer does not throw.
  return js.replace(
    "  'use strict';",
    "  'use strict';\n\n  const requestAnimationFrame = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')\n    ? window.requestAnimationFrame\n    : (cb) => setTimeout(cb, 0);"
  );
}
function isPdfTabpanel(attrs) {
  if (!/\brole=["']tabpanel["']/.test(attrs)) return false;
  return /\bid=["'][^"']*pdf/i.test(attrs) || /\baria-labelledby=["'][^"']*pdf/i.test(attrs);
}
function isPdfTabButton(attrs) {
  if (!/\brole=["']tab["']/.test(attrs)) return false;
  return (
    /\baria-controls=["'][^"']*pdf/i.test(attrs) ||
    /\bid=["'][^"']*pdf/i.test(attrs) ||
    /\bdata-tab=["'][^"']*pdf["']/.test(attrs) ||
    /\bhref=["'][^"']*pdf[^"']*["']/.test(attrs)
  );
}
function isPdfCssSelector(prelude) {
  return /(?:^|,)\s*(?:\.drop-zone|\.pdf-|\.scanned-warning|\.how-it-works|\.style-fieldset|\.offline-card|\.tabs|\.tab(?:-content)?)\b/gi.test(
    prelude
  );
}
function filterCssBlocks(css, shouldRemove) {
  let out = '';
  let i = 0;
  let blockStart = 0;
  while (i < css.length) {
    if (css[i] === '{') {
      const prelude = css.slice(blockStart, i).trim();
      const end = findMatchingBrace(css, i, { regex: false, backtick: false });
      if (end === -1) {
        out += css.slice(blockStart);
        break;
      }
      const body = css.slice(i + 1, end);
      if (/^@(media|supports|container)\b/i.test(prelude)) {
        const filtered = filterCssBlocks(body, shouldRemove);
        if (filtered.trim()) {
          out += css.slice(blockStart, i + 1) + filtered + css.slice(end, end + 1);
        }
      } else if (!shouldRemove(prelude)) {
        out += css.slice(blockStart, end + 1);
      }
      i = end + 1;
      blockStart = i;
    } else {
      i++;
    }
  }
  out += css.slice(blockStart);
  return out;
}
function stripCssPdf(css) {
  return filterCssBlocks(css, isPdfCssSelector);
}
function sanitizeHtml(html, css, js) {
  html = removeExternalTags(html);
  html = removeExternalLinks(html);
  // Remove the tab bar by role or class, covering <div>, <nav>, <ul>, <ol>.
  const tablistPredicate = (attrs) =>
    /\brole=["']tablist["']/.test(attrs) || /\bclass=["'][^"']*\btabs\b/.test(attrs);
  html = removeBalancedBlock(html, 'div', tablistPredicate);
  html = removeBalancedBlock(html, 'nav', tablistPredicate);
  html = removeBalancedBlock(html, 'ul', tablistPredicate);
  html = removeBalancedBlock(html, 'ol', tablistPredicate);
  // If the tablist markup changed and a PDF tab button still exists, remove it.
  ['button', 'a', 'li'].forEach((tag) => {
    html = removeBalancedBlock(html, tag, isPdfTabButton);
  });
  // Remove the PDF content panel(s) by role and id/aria-labelledby.
  html = removeBalancedBlock(html, 'section', isPdfTabpanel);
  html = removeBalancedBlock(html, 'div', isPdfTabpanel);
  html = removeBalancedBlock(html, 'article', isPdfTabpanel);
  // Remove the "Use Scrambler Offline" card (we are already offline).
  html = removeBalancedBlock(html, 'div', (attrs) => /\bclass=["'][^"']*\boffline-card\b/.test(attrs));
  // Remove the offline download link if it is outside the offline card.
  html = removeBalancedBlock(html, 'a', (attrs) => /\bid=["']offline-link["']/.test(attrs) || /\bdownload\b/.test(attrs));
  // Rewrite any remaining paragraphs that mention PDF so the copy is accurate.
  html = html.replace(
    /<p[^>]*>(?:(?!<\/p>).)*?\bPDFs?\b[\s\S]*?<\/p>/gi,
    '<p>Mask PII in text before sharing with LLMs or external parties</p>'
  );
  // Update the meta description to describe the offline, text-only copy.
  html = html.replace(
    /(<meta[^>]*\bname=["']description["'][^>]*\bcontent=)["'][^"']*["']/i,
    '$1"Scrambler masks PII in text locally in your browser. This offline copy requires no network connection and sends nothing to any server."'
  );
  html = html.replace(
    /(<meta[^>]*\bcontent=["'][^"']*["'][^>]*\bname=["']description["'])/i,
    '$1 content="Scrambler masks PII in text locally in your browser. This offline copy requires no network connection and sends nothing to any server."'
  );
  js = insertOfflinePolyfills(js);
  // Replace the text tab's opening tag with a clean section and an offline notice.
  html = html.replace(
    /<section id=["']text-tab["'][^>]*>/i,
    `<section id="text-tab">
    <div class="security-notice">
      <div class="icon" aria-hidden="true">💻</div>
      <div>
        <h2>Offline Copy — Text Masking Only</h2>
        <p>This file runs entirely on your computer. No network connection is required, no data is sent anywhere, and nothing is stored. PDF redaction is not available because it requires the server-side redactor.</p>
      </div>
    </div>`
  );
  // Insert inlined CSS and JS. Use a function replacement so that '$'
  // characters in the CSS/JS source are not interpreted as special patterns.
  html = html.replace('</head>', () => `  <style>\n${css.trim()}\n  </style>\n</head>`);
  html = html.replace('</body>', () => `  <script>\n${js.trim()}\n  </script>\n</body>`);
  return html;
}
function assertNoNetworkReferences(html) {
  const lower = html.toLowerCase();
  const hits = [];
  for (const kw of NETWORK_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      hits.push(kw);
    }
  }
  if (hits.length) {
    throw new Error(`Offline file contains forbidden network reference(s): ${hits.join(', ')}`);
  }
  for (const endpoint of PDF_ENDPOINTS) {
    if (html.includes(endpoint)) {
      throw new Error(`Offline file references PDF endpoint: ${endpoint}`);
    }
  }
}
function main() {
  if (!fs.existsSync(INDEX_HTML)) {
    throw new Error(`Missing source file: ${INDEX_HTML}`);
  }
  let html = readUtf8(INDEX_HTML);
  let css = readIfExists(STYLES_CSS) || extractFirst(html, 'style') || '';
  let js = readIfExists(APP_JS) || extractFirst(html, 'script') || '';
  if (!css.trim()) {
    throw new Error('Could not find a stylesheet source (public/styles.css or <style> in index.html)');
  }
  if (!js.trim()) {
    throw new Error('Could not find a script source (public/app.js or <script> in index.html)');
  }
  css = stripCssPdf(css);
  js = stripScriptPdf(js);
  js = addOfflineApi(js);
  html = sanitizeHtml(html, css, js);
  assertNoNetworkReferences(html);
  // Deterministic: the script performs no date/random-dependent transformations.
  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`Wrote ${OUT} (${html.length} bytes)`);
}
if (require.main === module) {
  main();
}
