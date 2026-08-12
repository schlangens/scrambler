/**
 * Scrambler front end.
 *
 * Text masking is 100% client-side: no network request is made while masking.
 * Always-mask and never-mask lists are intentionally NOT persisted to localStorage
 * by default, because they frequently contain the very secrets the tool protects.
 * Type toggles and the selected preset are persisted because they are not sensitive.
 */
(function () {
  'use strict';

  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  // A per-session random token embedded in every masked value. This makes it
  // vanishingly unlikely that an LLM will spontaneously write the exact same
  // string in unrelated text, which would cause unmaskText() to corrupt that
  // text. Values stay readable (Placeholder-Company-TOKEN-001 style).
  const SCRAMBLER_TOKEN = Math.random().toString(36).slice(2, 8).toUpperCase();

  const PATTERNS = [
    { type: 'ssn', regex: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, label: 'SSN' },
    { type: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'Email' },
    { type: 'phone', regex: /(?<!\w)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g, label: 'Phone' },
    { type: 'ip', regex: /(?<!\d\.)(?<![0-9])\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b(?!\.\d)/g, label: 'IP' },
    { type: 'dob', regex: /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:\d{2}|\d{4})\b/g, label: 'DOB' },
    { type: 'mrn', regex: /\b(?:MRN|MR#|Medical Record(?:\s*(?:Number|No|#))?)[:\s#]*\d{5,10}\b/gi, label: 'MRN' },
    { type: 'account', regex: /\b(?:account|acct|patient id|member id|policy)[:\s#]*\d{4,12}\b/gi, label: 'Account' },
    { type: 'creditCard', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, label: 'Credit Card' },
    { type: 'driversLicense', regex: /\b[A-Z]{1,3}\d{6,10}\b/gi, label: 'License' }
  ];

  const ALWAYS_TYPES = [
    { value: 'name', label: 'Name' },
    { value: 'company', label: 'Company' },
    { value: 'generic', label: 'Generic' }
  ];

  const PRESETS = {
    everything: { name: 'Everything', types: PATTERNS.map(p => p.type) },
    technical: { name: 'Technical documentation', types: ['ssn','email','phone','mrn','account','creditCard','driversLicense'] },
    medical: { name: 'Medical records', types: PATTERNS.map(p => p.type), emphasised: ['dob','mrn'] }
  };

  const STORAGE = {
    toggles: 'scrambler-toggles', preset: 'scrambler-preset', remember: 'scrambler-remember-terms',
    always: 'scrambler-always-mask', never: 'scrambler-never-mask'
  };

  let mappings = [], counters = {}, pdfBase64 = null, pdfBlobUrl = null, activePreset = 'custom';
  let toggles = Object.fromEntries(PATTERNS.map(p => [p.type, true])), alwaysMask = [], neverMask = [], rememberTerms = false;

  const $ = id => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function storageRead(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } }
  function storageWrite(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function storageRemove(k) { try { localStorage.removeItem(k); } catch {} }

  function esc(t) { const d = document.createElement('span'); d.textContent = t; return d.innerHTML; }
  function attrEsc(v) { return String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function wordPattern(t) { return new RegExp('(?<!\\w)' + escapeRegex(t) + '(?!\\w)', 'gi'); }
  function uid() { return 'a' + Math.random().toString(36).slice(2, 9); }
  function getNext(k) { if (!counters[k]) counters[k] = 0; return counters[k]++; }

  function fakeSuffix(k, width = 3) { return String(getNext(k)).padStart(width, '0'); }

  function generateFake(type) {
    switch (type) {
      case 'email': return `scrambler-${SCRAMBLER_TOKEN}-person-${fakeSuffix('em')}@example.org`;
      case 'phone': return `scrambler-${SCRAMBLER_TOKEN}-phone-${fakeSuffix('ph')}`;
      case 'ssn': return `scrambler-${SCRAMBLER_TOKEN}-ssn-${fakeSuffix('ssn')}`;
      case 'name': return `scrambler-${SCRAMBLER_TOKEN}-person-${fakeSuffix('nm')}`;
      case 'company': return `scrambler-${SCRAMBLER_TOKEN}-company-${fakeSuffix('co')}`;
      case 'ip': return `scrambler-${SCRAMBLER_TOKEN}-ip-${fakeSuffix('ip')}`;
      case 'dob': return `XX/XX/${1950+getNext('dob')%50}`;
      case 'mrn': return `scrambler-${SCRAMBLER_TOKEN}-mrn-${fakeSuffix('mrn', 6)}`;
      case 'account': return `scrambler-${SCRAMBLER_TOKEN}-account-${fakeSuffix('acct', 6)}`;
      case 'creditCard': return `scrambler-${SCRAMBLER_TOKEN}-cc-${fakeSuffix('cc')}`;
      case 'driversLicense': return `scrambler-${SCRAMBLER_TOKEN}-dl-${fakeSuffix('dl', 6)}`;
      default: return `scrambler-${SCRAMBLER_TOKEN}-redacted-${fakeSuffix('red')}`;
    }
  }

  function overlaps(s, e, intervals) { return intervals.some(i => s < i.end && e > i.start); }

  function getExclusionIntervals(text) {
    const intervals = [];
    for (const n of neverMask) for (const m of text.matchAll(wordPattern(n.term))) intervals.push({ start: m.index, end: m.index + m[0].length });
    return intervals;
  }

  const DOB_CONTEXT_RE = /(?:^|[^a-zA-Z.])D\.?O\.?B\.?(?:[:\s.,;]|$)|\bDate of Birth\b|\bBirth\s*Date\b|\bborn\b/i;
  function hasDobContext(text, s, e) {
    const window = (text.slice(Math.max(0, s - 40), Math.min(text.length, e + 40)) || '');
    return DOB_CONTEXT_RE.test(window);
  }

  function applyMasks(text, accepted, mapList = mappings) {
    const sorted = [...accepted].sort((a, b) => a.start - b.start);
    let out = '', pos = 0;
    for (const c of sorted) {
      out += text.slice(pos, c.start);
      const m = mapList.find(x => x.original === c.original);
      out += m ? m.masked : c.original;
      pos = c.end;
    }
    out += text.slice(pos);
    return out;
  }

  // Exclusions take precedence over both pattern detection and the always-mask list.
  function findCandidates(text) {
    const exclusions = getExclusionIntervals(text), candidates = [];
    for (const p of PATTERNS) {
      if (!toggles[p.type]) continue;
      for (const m of text.matchAll(p.regex)) {
        const s = m.index, e = s + m[0].length;
        if (overlaps(s, e, exclusions)) continue;
        if (p.type === 'dob' && !hasDobContext(text, s, e)) continue;
        candidates.push({ start: s, end: e, original: m[0], type: p.type, label: p.label });
      }
    }
    for (const a of alwaysMask) {
      for (const m of text.matchAll(wordPattern(a.term))) {
        const s = m.index, e = s + m[0].length;
        if (overlaps(s, e, exclusions)) continue;
        candidates.push({ start: s, end: e, original: m[0], type: a.replacementType, label: ALWAYS_TYPES.find(t => t.value === a.replacementType)?.label || 'Custom' });
      }
    }
    candidates.sort((a, b) => a.start - b.start || b.original.length - a.original.length);
    const accepted = [];
    for (const c of candidates) if (!accepted.some(a => c.start < a.end && c.end > a.start)) accepted.push(c);
    return accepted;
  }

  function maskText() {
    const text = $('input-text').value;
    if (!text.trim()) { setStatus('text-status', 'Please paste some text to mask.', 'error'); return; }
    $('mask-btn').disabled = true;
    setStatus('text-status', 'Masking...', 'processing');
    counters = {};
    const accepted = findCandidates(text);
    const keepOriginals = new Set(accepted.map(c => c.original));
    mappings = mappings.filter(m => keepOriginals.has(m.original));
    for (const c of accepted) {
      const existing = mappings.find(m => m.original === c.original);
      if (existing) { existing.type = c.label; }
      else { mappings.push({ id: uid(), original: c.original, masked: generateFake(c.type), type: c.label }); }
    }
    $('masked-text').value = applyMasks(text, accepted);
    show(['masked-card', 'arrow-divider', 'response-card']);
    hide('final-card');
    $('llm-response').value = '';
    renderDetected();
    updateCounts();
    setStatus('text-status', `${accepted.length} sensitive item(s) masked. Masked text is ready to copy.`, 'success');
    announce(`${accepted.length} sensitive item${accepted.length === 1 ? '' : 's'} masked.`);
    $('mask-btn').disabled = false;
  }

  function renderDetected() {
    const list = $('detected-list');
    if (mappings.length === 0) { hide('detected-card'); return; }
    show('detected-card');
    $('detected-count').textContent = mappings.length;
    list.innerHTML = mappings.map(m => `<li><span class="detected-type">${esc(m.type)}</span><span class="detected-original">${esc(m.original)}</span><span class="detected-arrow" aria-hidden="true">→</span><span class="detected-masked">${esc(m.masked)}</span><button type="button" class="detected-delete" data-action="delete-mapping" data-id="${m.id}" aria-label="Remove ${attrEsc(m.original)}">×</button></li>`).join('');
  }

  function deleteMapping(id) {
    mappings = mappings.filter(m => m.id !== id);
    const text = $('input-text').value;
    if (text.trim()) {
      const accepted = findCandidates(text);
      $('masked-text').value = applyMasks(text, accepted);
    }
    renderDetected();
    updateCounts();
    announce('Mapping removed.');
  }

  function unmaskText() {
    const text = $('llm-response').value.trim();
    if (!text) { setStatus('text-status', 'Please paste the LLM response first.', 'error'); return; }
    const sorted = [...mappings].sort((a, b) => b.masked.length - a.masked.length);
    const found = new Set(), missing = [];
    for (const m of sorted) if (text.includes(m.masked)) found.add(m.id);
    for (const m of mappings) if (!found.has(m.id)) missing.push(m);
    let result = text;
    for (const m of sorted) result = result.split(m.masked).join(m.original);
    $('final-text').value = result;
    show('final-card');
    const total = mappings.length;
    const msg = `Restored ${found.size} of ${total} value${total === 1 ? '' : 's'}.`;
    const detail = missing.length ? ` Not found: ${missing.slice(0, 3).map(m => m.type || m.original).join(', ')}${missing.length > 3 ? '...' : ''}.` : '';
    setStatus('text-status', msg + detail, missing.length ? 'warning' : 'success');
    announce(msg + detail);
  }

  async function copyTo(textareaId, successMessage) {
    try {
      await navigator.clipboard.writeText($(textareaId).value);
      setStatus('text-status', `${successMessage} copied to clipboard.`, 'success');
      announce(`${successMessage} copied.`);
    } catch {
      setStatus('text-status', 'Copy failed. Select the text and copy manually.', 'error');
    }
  }

  function addTerm(list, input, typeSelect, typeName) {
    const term = input.value.trim();
    if (!term) return;
    if (list.some(x => x.term.toLowerCase() === term.toLowerCase())) { setStatus('text-status', `That term is already in the ${typeName}-mask list.`, 'error'); return; }
    const item = { id: uid(), term };
    if (typeSelect) item.replacementType = typeSelect.value;
    list.push(item);
    input.value = '';
    saveTerms();
    typeSelect ? renderAlways() : renderNever();
    updateCounts();
    announce(`Term added to ${typeName}-mask list.`);
  }

  function removeTerm(list, id, render) { list.splice(list.findIndex(x => x.id === id), 1); saveTerms(); render(); updateCounts(); }

  function updateTerm(list, id, type, render) {
    const li = $(`${type}-${id}`);
    const input = li.querySelector('[data-edit]');
    const term = input.value.trim();
    if (!term) return;
    const item = list.find(x => x.id === id);
    if (!item) return;
    item.term = term;
    const typeSelect = li.querySelector('[data-edit-type]');
    if (typeSelect) item.replacementType = typeSelect.value;
    saveTerms(); render(); updateCounts();
  }

  function renderList(containerId, items, type) {
    const list = $(containerId);
    if (items.length === 0) { list.innerHTML = ''; return; }
    list.innerHTML = items.map(item => {
      const badge = type === 'always' ? `<span class="badge badge-type">${esc(ALWAYS_TYPES.find(t => t.value === item.replacementType)?.label || 'Generic')}</span>` : '';
      const typeSelect = type === 'always' ? `<select data-edit-type>${ALWAYS_TYPES.map(t => `<option value="${t.value}"${t.value === item.replacementType ? ' selected' : ''}>${t.label}</option>`).join('')}</select>` : '';
      return `<li id="${type}-${item.id}"><span class="view"><span class="term-text">${esc(item.term)}</span>${badge}<span class="match-count" data-match="${attrEsc(item.term)}"></span><button type="button" class="btn btn-ghost btn-sm" data-action="edit-${type}" data-id="${item.id}">Edit</button><button type="button" class="btn btn-danger btn-sm" data-action="remove-${type}" data-id="${item.id}">Remove</button></span><span class="edit"><input type="text" data-edit value="${attrEsc(item.term)}">${typeSelect}<button type="button" class="btn btn-success btn-sm" data-action="save-${type}" data-id="${item.id}">Save</button><button type="button" class="btn btn-ghost btn-sm" data-action="cancel-${type}" data-id="${item.id}">Cancel</button></span></li>`;
    }).join('');
  }

  function renderAlways() { renderList('always-list', alwaysMask, 'always'); }
  function renderNever() { renderList('never-list', neverMask, 'never'); }

  function renderToggles() {
    $('toggle-container').innerHTML = PATTERNS.map(p => `<div class="toggle-item" data-type="${p.type}"><label for="toggle-${p.type}"><input type="checkbox" id="toggle-${p.type}" data-toggle="${p.type}"><span>${p.label}</span></label><span class="badge badge-count empty" data-count="${p.type}">0</span></div>`).join('');
    updateTogglesUI();
  }

  function updateTogglesUI() {
    const emphasised = PRESETS[activePreset]?.emphasised || [];
    for (const p of PATTERNS) {
      const item = document.querySelector(`.toggle-item[data-type="${p.type}"]`);
      if (item) {
        item.querySelector('input[type="checkbox"]').checked = toggles[p.type];
        item.classList.toggle('emphasised', emphasised.includes(p.type));
      }
    }
    for (const btn of $$('.preset')) btn.classList.toggle('active', btn.dataset.preset === activePreset);
    updateCounts();
  }

  function updateCounts() {
    const text = $('input-text').value;
    const accepted = text.trim() ? findCandidates(text) : [];
    const counts = Object.fromEntries(PATTERNS.map(p => [p.type, 0]));
    for (const c of accepted) if (c.type in counts) counts[c.type]++;
    for (const p of PATTERNS) {
      const el = document.querySelector(`[data-count="${p.type}"]`);
      if (el) { el.textContent = counts[p.type]; el.classList.toggle('empty', counts[p.type] === 0); }
    }
    for (const el of $$('.match-count')) {
      const term = el.dataset.match;
      if (!term) continue;
      const count = [...text.matchAll(wordPattern(term))].length;
      el.textContent = count ? `${count} match${count === 1 ? '' : 'es'}` : '0 matches';
    }
  }

  function applyPreset(name) {
    activePreset = name;
    const preset = PRESETS[name];
    toggles = Object.fromEntries(PATTERNS.map(p => [p.type, preset.types.includes(p.type)]));
    saveSettings(); updateTogglesUI(); announce(`${preset.name} preset applied.`);
  }

  function onToggleChange(e) {
    if (!e.target.dataset.toggle) return;
    toggles[e.target.dataset.toggle] = e.target.checked;
    activePreset = 'custom';
    saveSettings(); updateTogglesUI();
  }

  function saveSettings() { storageWrite(STORAGE.toggles, toggles); storageWrite(STORAGE.preset, activePreset); storageWrite(STORAGE.remember, rememberTerms); }
  function saveTerms() { if (rememberTerms) { storageWrite(STORAGE.always, alwaysMask); storageWrite(STORAGE.never, neverMask); } else { storageRemove(STORAGE.always); storageRemove(STORAGE.never); } }

  function loadState() {
    const savedToggles = storageRead(STORAGE.toggles, null);
    if (savedToggles) toggles = { ...toggles, ...savedToggles };
    activePreset = storageRead(STORAGE.preset, 'everything');
    rememberTerms = storageRead(STORAGE.remember, false);
    if (rememberTerms) { alwaysMask = storageRead(STORAGE.always, []); neverMask = storageRead(STORAGE.never, []); }
    $('remember-terms').checked = rememberTerms;
  }

  function onRememberChange() { rememberTerms = $('remember-terms').checked; saveSettings(); saveTerms(); announce(rememberTerms ? 'Custom terms will be remembered on this device.' : 'Custom terms will not be stored on this device.'); }

  async function checkPdfStatus() {
    try { const res = await fetch('/api/pdf/status'); if (!res.ok) throw new Error('status failed'); const data = await res.json(); $('pdf-slots').textContent = `${data.available}/${data.maxSessions} slots available`; } catch { $('pdf-slots').textContent = ''; }
  }

  function setPdfBusy(busy) {
    const dz = $('drop-zone');
    if (busy) { show('pdf-processing'); dz.classList.add('disabled'); dz.setAttribute('aria-disabled','true'); dz.setAttribute('tabindex','-1'); }
    else { hide('pdf-processing'); dz.classList.remove('disabled'); dz.removeAttribute('aria-disabled'); dz.setAttribute('tabindex','0'); }
  }

  async function processPdf(file) {
    hide('pdf-result-card'); hide('pdf-status'); hide('pdf-scanned-warning');
    if (file.size > MAX_FILE_SIZE) { setStatus('pdf-status', 'That file is larger than 10 MB. Choose a smaller PDF.', 'error'); return; }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { setStatus('pdf-status', 'Only PDF files are accepted.', 'error'); return; }
    setPdfBusy(true);
    const style = document.querySelector('input[name="redact-style"]:checked')?.value || 'text';
    const formData = new FormData(); formData.append('pdf', file); formData.append('style', style);
    try {
      const res = await fetch('/api/pdf/analyze', { method: 'POST', body: formData });
      if (res.status === 503) throw new Error('Server busy — all PDF processing slots are in use. Wait a moment and try again.');
      if (res.status === 429) throw new Error('Too many requests. Please wait a moment and try again.');
      if (!res.ok) { let msg = 'The PDF could not be processed.'; try { const data = await res.json(); if (data.error) msg = data.error; } catch {} throw new Error(msg); }
      const data = await res.json(); pdfBase64 = data.pdfBase64; if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl); pdfBlobUrl = null;
      const pagesWithoutText = data.pagesWithoutText || [];
      const hasPagesWithoutText = data.hasUncheckedPages || data.hasPagesWithoutText || pagesWithoutText.length > 0;
      const totalPages = data.originalPageCount || 0;
      const allUnreadable = hasPagesWithoutText && totalPages > 0 && pagesWithoutText.length === totalPages;

      $('pdf-orig-pages').textContent = data.originalPageCount; $('pdf-new-pages').textContent = data.newPageCount; $('pdf-redacted-count').textContent = data.detections.length;
      const list = $('pdf-detections');
      if (data.detections.length > 0) {
        show(list);
        list.innerHTML = '<li><strong>Items redacted:</strong></li>' + data.detections.slice(0,20).map(d => `<li><span class="detected-type">${esc(d.type)}</span><span class="detected-original">${esc(d.original)}</span><span class="detected-arrow" aria-hidden="true">→</span><span class="detected-masked">${esc(d.redacted)}</span></li>`).join('') + (data.detections.length > 20 ? `<li class="more">... and ${data.detections.length - 20} more</li>` : '');
      } else { hide(list); }

      const warning = $('pdf-scanned-warning');
      warning.classList.remove('critical');
      $('pdf-result-header').textContent = 'Redaction Complete';
      show('pdf-results');

      if (allUnreadable) {
        $('pdf-result-header').textContent = 'No Readable Text Found';
        hide(['pdf-results', 'pdf-detections']);
        warning.classList.add('critical');
        $('pdf-scanned-title').textContent = 'No readable text found';
        $('pdf-scanned-text').textContent = 'This PDF appears to be entirely scanned images. No pages had readable text, so nothing could be checked for personal information. The file was returned unchanged.';
        $('pdf-scanned-pages').textContent = `Pages affected: ${pagesWithoutText.join(', ')}`;
        show(warning);
        setStatus('pdf-status', 'No readable text found. The PDF was returned unchanged.', 'warning');
        announce('No readable text found. The PDF was returned unchanged.');
      } else if (hasPagesWithoutText) {
        warning.classList.add('warning');
        $('pdf-scanned-title').textContent = 'Some pages could not be checked';
        $('pdf-scanned-text').textContent = 'Pages without readable text were not searched for personal information. Anything visible on those pages is still in the document.';
        $('pdf-scanned-pages').textContent = `Pages affected: ${pagesWithoutText.join(', ')}`;
        show(warning);
        setStatus('pdf-status', `PDF redaction complete. ${pagesWithoutText.length} page${pagesWithoutText.length === 1 ? '' : 's'} had no readable text and ${pagesWithoutText.length === 1 ? 'was' : 'were'} not checked.`, 'warning');
        announce(`${pagesWithoutText.length} page${pagesWithoutText.length === 1 ? '' : 's'} had no readable text and ${pagesWithoutText.length === 1 ? 'was' : 'were'} not checked.`);
      } else {
        hide(warning);
        setStatus('pdf-status', 'PDF redaction complete. Download it below.', 'success');
        announce('PDF redaction complete.');
      }
      show('pdf-result-card');
    } catch (e) {
      const message = e.message.includes('Failed to fetch') || e.message === 'NetworkError when attempting to fetch resource.' ? 'Could not reach the server. Check your connection and try again.' : e.message;
      setStatus('pdf-status', message, 'error'); announce(message);
    } finally { setPdfBusy(false); }
  }

  function downloadPdf() {
    if (!pdfBase64) { setStatus('pdf-status', 'No redacted PDF is available to download.', 'error'); return; }
    try {
      const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl); pdfBlobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = pdfBlobUrl; link.download = `redacted-${Date.now()}.pdf`; link.click();
      setStatus('pdf-status', 'Download started.', 'success');
    } catch { setStatus('pdf-status', 'Could not prepare the PDF download.', 'error'); }
  }

  function switchTab(tab) {
    $$('.tab').forEach(t => { const active = t.id === `tab-${tab}`; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); t.setAttribute('tabindex', active ? '0' : '-1'); });
    $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `${tab}-tab`));
    if (tab === 'pdf') checkPdfStatus();
  }

  function handleTabKey(e) {
    const tabs = $$('.tab');
    const idx = tabs.indexOf(document.activeElement); if (idx < 0) return;
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault(); tabs[next].focus(); switchTab(tabs[next].dataset.tab);
  }

  function show(ids) { if (!Array.isArray(ids)) ids = [ids]; for (const item of ids) { const el = typeof item === 'string' ? $(item) : item; if (el) el.classList.remove('hidden'); } }
  function hide(ids) { if (!Array.isArray(ids)) ids = [ids]; for (const item of ids) { const el = typeof item === 'string' ? $(item) : item; if (el) el.classList.add('hidden'); } }

  function setStatus(id, message, type) {
    const el = typeof id === 'string' ? $(id) : id;
    if (!message) { hide(el); return; }
    el.textContent = message; el.className = 'status-region ' + type;
  }

  function announce(message) { const a = $('announcer'); a.textContent = ''; requestAnimationFrame(() => { a.textContent = message; }); }

  function newSession() {
    if ((mappings.length > 0 || pdfBase64) && !confirm('Start over? This will clear everything.')) return;
    mappings = []; counters = {}; pdfBase64 = null;
    if (pdfBlobUrl) { URL.revokeObjectURL(pdfBlobUrl); pdfBlobUrl = null; }
    $('input-text').value = ''; $('masked-text').value = ''; $('llm-response').value = ''; $('final-text').value = '';
    hide(['detected-card','masked-card','arrow-divider','response-card','final-card','pdf-result-card']);
    setStatus('text-status', '', 'info'); setStatus('pdf-status', '', 'info');
    renderDetected(); updateCounts();
  }

  function bindEvents() {
    $('new-session').addEventListener('click', newSession);
    $('mask-btn').addEventListener('click', maskText);
    $('input-text').addEventListener('input', updateCounts);
    $('copy-masked-btn').addEventListener('click', () => copyTo('masked-text', 'Masked text'));
    $('unmask-btn').addEventListener('click', unmaskText);
    $('copy-final-btn').addEventListener('click', () => copyTo('final-text', 'Restored text'));
    $('always-add-btn').addEventListener('click', () => addTerm(alwaysMask, $('always-add-input'), $('always-add-type'), 'always'));
    $('always-add-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTerm(alwaysMask, $('always-add-input'), $('always-add-type'), 'always'); });
    $('never-add-btn').addEventListener('click', () => addTerm(neverMask, $('never-add-input'), null, 'never'));
    $('never-add-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTerm(neverMask, $('never-add-input'), null, 'never'); });
    $('remember-terms').addEventListener('change', onRememberChange);
    $('preset-row').addEventListener('click', e => { const p = e.target.closest('[data-preset]'); if (p) applyPreset(p.dataset.preset); });
    $('toggle-container').addEventListener('change', onToggleChange);
    $('detected-list').addEventListener('click', e => { const b = e.target.closest('[data-action="delete-mapping"]'); if (b) deleteMapping(b.dataset.id); });

    const onListClick = (list, type) => (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.action === `remove-${type}`) removeTerm(list, id, type === 'always' ? renderAlways : renderNever);
      else if (b.dataset.action === `edit-${type}`) { const li = b.closest('li'); if (li) li.classList.add('editing'); }
      else if (b.dataset.action === `save-${type}`) updateTerm(list, id, type, type === 'always' ? renderAlways : renderNever);
      else if (b.dataset.action === `cancel-${type}`) { type === 'always' ? renderAlways() : renderNever(); updateCounts(); }
    };
    $('always-list').addEventListener('click', onListClick(alwaysMask, 'always'));
    $('never-list').addEventListener('click', onListClick(neverMask, 'never'));

    const dz = $('drop-zone'), pdfInput = $('pdf-input');
    dz.addEventListener('click', () => { if (!dz.classList.contains('disabled')) pdfInput.click(); });
    dz.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !dz.classList.contains('disabled')) { e.preventDefault(); pdfInput.click(); } });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); const file = e.dataTransfer.files?.[0]; if (file && !dz.classList.contains('disabled')) processPdf(file); });
    pdfInput.addEventListener('change', e => { const f = e.target.files?.[0]; if (f && !dz.classList.contains('disabled')) processPdf(f); e.target.value = ''; });
    $('download-pdf-btn').addEventListener('click', downloadPdf);
    const tablist = document.querySelector('.tabs');
    if (tablist) { tablist.addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) switchTab(t.dataset.tab); }); tablist.addEventListener('keydown', handleTabKey); }
  }

  function init() { for (const t of $$('.tab')) t.dataset.tab = t.id.replace('tab-', ''); loadState(); bindEvents(); renderToggles(); renderAlways(); renderNever(); updateCounts(); }
  document.addEventListener('DOMContentLoaded', init);
})();
