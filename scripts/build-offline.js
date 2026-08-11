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

function removeTag(html, tag, predicate) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  return html.replace(re, (match) => {
    const attrs = match.slice(tag.length + 1, match.length - 1);
    return predicate(attrs) ? '' : match;
  });
}

function stripExternalLinks(html) {
  // Remove any <a> tag whose href is an absolute http(s) URL, preserving inner content.
  return html.replace(/<a\b[^>]*\bhref=["']https?:\/\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1');
}

function stripExternalTags(html) {
  // <link> tags (external fonts, stylesheets, etc.)
  html = html.replace(/<link\b[^>]*>/gi, '');
  // <script> tags with a src attribute (external or hosted app.js)
  html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');
  // inline <script> and <style> blocks; the sanitized versions are inserted later
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  return html;
}

function stripScriptPdf(js) {
  // Remove the PDF-only functions: checkPdfStatus, setPdfBusy, processPdf, downloadPdf.
  const pdfStart = js.search(/\n\s*async function checkPdfStatus\b/);
  if (pdfStart !== -1) {
    // The PDF block ends where the tab-switching function begins.
    const after = js.slice(pdfStart + 1);
    const nextMatch = after.match(/\n\s*function switchTab\b/);
    if (nextMatch) {
      const nextIndex = after.indexOf(nextMatch[0]) + pdfStart + 1;
      js = js.slice(0, pdfStart) + '\n' + js.slice(nextIndex);
    } else {
      js = js.slice(0, pdfStart);
    }
  }

  // Remove the checkPdfStatus call inside switchTab.
  js = js.replace(/\n\s*if\s*\(\s*tab\s*===\s*['"]pdf['"]\s*\)\s*checkPdfStatus\(\)\s*;?\s*/g, '\n');

  // Remove the drop-zone / PDF event-listener block from bindEvents.
  const dzStart = js.search(/\n\s*const dz = \$\(['"]drop-zone['"]\)/);
  if (dzStart !== -1) {
    const after = js.slice(dzStart + 1);
    const tablistMatch = after.match(/\n\s*const tablist = document\.querySelector\(['"].tabs['"]\)/);
    if (tablistMatch) {
      const tablistIndex = after.indexOf(tablistMatch[0]) + dzStart + 1;
      js = js.slice(0, dzStart) + '\n' + js.slice(tablistIndex);
    }
  }

  // Remove references to PDF state in newSession that are no-ops anyway.
  js = js.replace(/if \(\(mappings\.length > 0 \|\| pdfBase64\) && !confirm\(/g, 'if ((mappings.length > 0) && !confirm(');
  js = js.replace(/mappings = \[\]; counters = \{\}; pdfBase64 = null;/g, 'mappings = []; counters = {};');
  js = js.replace(/if \(pdfBlobUrl\) \{ URL\.revokeObjectURL\(pdfBlobUrl\); pdfBlobUrl = null; \}/g, '');

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

function sanitizeHtml(html, css, js) {
  html = stripExternalTags(html);
  html = stripExternalLinks(html);

  // Remove the tab bar and the PDF-only content section.
  html = removeBalancedBlock(html, 'div', attrs => /class=["'][^"']*\btabs\b/.test(attrs));
  html = removeBalancedBlock(html, 'section', attrs => /\bid=["']pdf-tab["']/.test(attrs));
  html = removeBalancedBlock(html, 'div', attrs => /\bid=["']pdf-tab["']/.test(attrs));
  // Remove the "Use Scrambler Offline" card (we are already offline).
  html = removeBalancedBlock(html, 'div', attrs => /class=["'][^"']*\boffline-card\b/.test(attrs));

  // Add an offline note near the top of the text section.
  html = html.replace(
    /<section id=["']text-tab["'][^>]*>/i,
    match => `${match}\n    <div class="security-notice">\n      <div class="icon" aria-hidden="true">💻</div>\n      <div>\n        <h2>Offline Copy — Text Masking Only</h2>\n        <p>This file runs entirely on your computer. No network connection is required, no data is sent anywhere, and nothing is stored. PDF redaction is not available because it requires the server-side redactor.</p>\n      </div>\n    </div>`
  );

  // Replace the description in the hero to match the offline scope.
  html = html.replace(
    /<p>Mask PII in text or redact PII from PDFs before sharing with LLMs or external parties<\/p>/i,
    '<p>Mask PII in text before sharing with LLMs or external parties</p>'
  );

  js = insertOfflinePolyfills(js);

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

  // Deterministic: collapse only the line endings/indentation we control.
  fs.writeFileSync(OUT, html, 'utf8');

  console.log(`Wrote ${OUT} (${html.length} bytes)`);
}

if (require.main === module) {
  main();
}

module.exports = { main, stripScriptPdf, addOfflineApi, insertOfflinePolyfills, sanitizeHtml };
