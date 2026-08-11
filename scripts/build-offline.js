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

function removeTopLevelFunctionBlocks(js, predicate) {
  let result = '';
  let i = 0;

  while (i < js.length) {
    const match = js.slice(i).match(/\n\s*(async\s+)?function\s+(\w+)\s*\(/);
    if (!match) {
      result += js.slice(i);
      break;
    }

    const fnStart = i + match.index;
    const fnName = match[2];
    const sigEnd = fnStart + match[0].length;
    const braceIdx = js.indexOf('{', sigEnd);
    if (braceIdx === -1) {
      result += js.slice(i);
      break;
    }

    // Top-level functions inside the IIFE are at brace depth 1.
    let depth = 0;
    for (let k = 0; k < braceIdx; k++) {
      if (js[k] === '{') depth++;
      else if (js[k] === '}') depth--;
    }

    if (depth !== 1 || !predicate(fnName)) {
      result += js.slice(i, sigEnd);
      i = sigEnd;
      continue;
    }

    let d = 1;
    let j = braceIdx + 1;
    while (j < js.length && d > 0) {
      if (js[j] === '{') d++;
      else if (js[j] === '}') d--;
      j++;
    }

    if (d === 0) {
      result += js.slice(i, fnStart);
      i = j;
      while (i < js.length && /[ \t]/.test(js[i])) i++;
      if (i < js.length && js[i] === '\n') i++;
    } else {
      result += js.slice(i);
      break;
    }
  }

  return result;
}

function removeMatchingLines(js, pattern) {
  return js.split('\n').filter(line => !pattern.test(line)).join('\n');
}

function stripScriptPdf(js) {
  // Remove top-level PDF-only function declarations by name.
  js = removeTopLevelFunctionBlocks(js, name => /pdf/i.test(name));

  // Remove the PDF status check inside switchTab.
  js = js.replace(/\n\s*if\s*\(\s*tab\s*===?\s*["']pdf["']\s*\)\s*\{\s*checkPdfStatus\s*\(\s*\)\s*;?\s*\}\s*/gi, '\n');
  js = js.replace(/\n\s*if\s*\(\s*tab\s*===?\s*["']pdf["']\s*\)\s*checkPdfStatus\s*\(\s*\)\s*;?\s*/gi, '\n');

  // Remove PDF state variables from the let declaration.
  js = js.replace(/,\s*pdfBase64\s*=\s*null\s*,\s*pdfBlobUrl\s*=\s*null\s*,?/g, ',');

  // Remove references to PDF state in newSession.
  js = js.replace(/\s*\|\|\s*pdfBase64/g, '');
  js = js.replace(/;\s*pdfBase64\s*=\s*null\s*;?/g, ';');
  js = js.replace(/\n\s*if\s*\(\s*pdfBlobUrl\s*\)\s*\{\s*URL\.revokeObjectURL\s*\(\s*pdfBlobUrl\s*\)\s*;\s*pdfBlobUrl\s*=\s*null\s*;\s*\}\s*/g, '\n');

  // Remove PDF-specific listeners, variables and UI lines from bindEvents/newSession.
  js = removeMatchingLines(js, /\b(?:dz|pdfInput|processPdf|downloadPdf|download-pdf-btn|drop-zone|pdf-input|pdf-status)\b/);

  // Remove dead pdf-result-card reference from the hide list.
  js = js.replace(/,\s*['"]pdf-result-card['"]/g, '');

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
  return /\baria-controls=["'][^"']*pdf/i.test(attrs)
    || /\bid=["'][^"']*pdf/i.test(attrs)
    || /\bdata-tab=["'][^"']*pdf["']/.test(attrs)
    || /\bhref=["'][^"']*pdf[^"']*["']/.test(attrs);
}

function sanitizeHtml(html, css, js) {
  html = removeExternalTags(html);
  html = removeExternalLinks(html);

  // Remove the tab bar by role or class, covering <div>, <nav>, <ul>, <ol>.
  const tablistPredicate = attrs => /\brole=["']tablist["']/.test(attrs) || /\bclass=["'][^"']*\btabs\b/.test(attrs);
  html = removeBalancedBlock(html, 'div', tablistPredicate);
  html = removeBalancedBlock(html, 'nav', tablistPredicate);
  html = removeBalancedBlock(html, 'ul', tablistPredicate);
  html = removeBalancedBlock(html, 'ol', tablistPredicate);

  // If the tablist markup changed and a PDF tab button still exists, remove it.
  ['button', 'a', 'li'].forEach(tag => {
    html = removeBalancedBlock(html, tag, isPdfTabButton);
  });

  // Remove the PDF content panel(s) by role and id/aria-labelledby.
  html = removeBalancedBlock(html, 'section', isPdfTabpanel);
  html = removeBalancedBlock(html, 'div', isPdfTabpanel);
  html = removeBalancedBlock(html, 'article', isPdfTabpanel);

  // Remove the "Use Scrambler Offline" card (we are already offline).
  html = removeBalancedBlock(html, 'div', attrs => /\bclass=["'][^"']*\boffline-card\b/.test(attrs));

  // Remove the offline download link if it is outside the offline card.
  html = removeBalancedBlock(html, 'a', attrs => /\bid=["']offline-link["']/.test(attrs) || /\bdownload\b/.test(attrs));

  // Rewrite any remaining paragraphs that mention PDF so the copy is accurate.
  html = html.replace(/<p[^>]*>(?:(?!<\/p>).)*?\bPDFs?\b[\s\S]*?<\/p>/gi, '<p>Mask PII in text before sharing with LLMs or external parties</p>');

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

  // Add an offline note near the top of the text section.
  html = html.replace(
    /<section id=["']text-tab["'][^>]*>/i,
    match => `${match}\n    <div class="security-notice">\n      <div class="icon" aria-hidden="true">💻</div>\n      <div>\n        <h2>Offline Copy — Text Masking Only</h2>\n        <p>This file runs entirely on your computer. No network connection is required, no data is sent anywhere, and nothing is stored. PDF redaction is not available because it requires the server-side redactor.</p>\n      </div>\n    </div>`
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

module.exports = { main, stripScriptPdf, addOfflineApi, insertOfflinePolyfills, sanitizeHtml, removeTopLevelFunctionBlocks, removeMatchingLines };
