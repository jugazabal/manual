(() => {
  'use strict';

  // ========================================================================
  // Text cleanup utilities — strip OCR/paste artifacts (control chars, zero-
  // width chars, non-breaking spaces, ligatures, doubled spaces) so nothing
  // stray leaks into the generated HTML.
  // ========================================================================

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Strip ASCII control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F) via
  // char codes, rather than embedding literal control bytes in this source file.
  function stripControlChars(str) {
    let out = '';
    for (let i = 0; i < str.length; i += 1) {
      const code = str.charCodeAt(i);
      const isControl = code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
      if (!isControl) out += str[i];
    }
    return out;
  }

  function cleanFragment(str) {
    if (!str) return '';
    const out = str
      .normalize('NFC')
      .replace(/ﬀ/g, 'ff')
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬃ/g, 'ffi')
      .replace(/ﬄ/g, 'ffl')
      .replace(/[​-‍﻿­]/g, '') // zero-width, BOM, soft hyphen
      .replace(/[  -   　]/g, ' ') // unicode spaces -> regular space
      .replace(/�/g, '') // decoding-failure marker
      .replace(/ {2,}/g, ' ');
    return stripControlChars(out);
  }

  // Full clean for a standalone line/value: same as cleanFragment plus trim.
  function cleanText(str) {
    return cleanFragment(str).trim();
  }

  // The manual style deliberately pads numbered list items with three spaces,
  // e.g. "1.   Married". Enforced explicitly rather than trying to detect
  // "intentional" runs.
  function normalizeListNumber(text) {
    return text.replace(/^(\d{1,3}\.)\s*/, '$1   ');
  }

  // ========================================================================
  // Automatic layout-based conversion.
  //
  // interRAI manuals are laid out as a strict two-column definition list:
  // a short bold label on the left ("Intent", "Definition", "Coding", or an
  // item code like "A1.") and its content indented in a column further
  // right. That's a purely geometric, font-independent signal we can read
  // straight from OCR word bounding boxes (Tesseract's bold/italic/font
  // detection is unreliable and returns empty on real screenshots, so we
  // don't rely on it at all). This lets us infer bold labels, indentation,
  // and section boundaries automatically instead of asking the user to tag
  // every line by hand.
  // ========================================================================

  const SECTION_KEYWORDS = [
    'intent', 'definition', 'definitions', 'process', 'coding', 'discussion',
    'interview', 'rationale', 'note', 'notes', 'examples', 'example',
    'observation', 'record review', 'time frame', 'response',
  ];
  const H3_SECTION_KEYWORDS = ['problem', 'triggers', 'guidelines', 'additional resources'];

  function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Common OCR confusion: lowercase "l" read instead of digit "1" in item codes.
  function fixItemCode(text) {
    return text.replace(/^([A-Z]{1,3})l([a-z]{0,2}\.?)$/, '$1' + '1' + '$2');
  }

  function looksLikeItemCode(label) {
    const fixed = fixItemCode(label.trim());
    return /^[A-Z]{1,3}\d{1,3}[a-z]{0,2}\.?$/.test(fixed);
  }

  function sectionKeywordInfo(label) {
    const norm = label.trim().toLowerCase().replace(/[:.]$/, '');
    if (H3_SECTION_KEYWORDS.includes(norm)) return { matched: true, heading: true };
    if (SECTION_KEYWORDS.includes(norm)) return { matched: true, heading: false };
    return { matched: false, heading: false };
  }

  function looksLikeListMarker(text) {
    const m = text.match(/^([A-Za-z]{1,3}\d{0,3}[a-z]{0,2}[.)]|\d{1,3}[.)])\s+(.*)$/);
    if (!m) return null;
    const closer = m[1].endsWith(')') ? ')' : '.';
    return { marker: normalizeListNumber(fixItemCode(m[1].replace(/[.)]$/, '')) + closer), rest: m[2] };
  }

  function flattenLines(blocks) {
    const lines = [];
    (blocks || []).forEach((block) => {
      (block.paragraphs || []).forEach((para) => {
        (para.lines || []).forEach((line) => {
          const words = (line.words || [])
            .map((w) => ({ text: cleanFragment(w.text || ''), bbox: w.bbox }))
            .filter((w) => w.text);
          if (words.length) lines.push({ bbox: line.bbox, words });
        });
      });
    });
    lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
    return lines;
  }

  function mergeParagraphs(contentEvents, medianLineH) {
    const paras = [];
    let current = null;
    let prevY1 = null;
    contentEvents.forEach((ev) => {
      const gap = prevY1 == null ? Infinity : ev.y0 - prevY1;
      const isListStart = !!looksLikeListMarker(ev.text);
      if (current && gap < 0.6 * medianLineH && !isListStart) {
        current.text = cleanText(current.text + ' ' + ev.text);
      } else {
        current = { text: ev.text };
        paras.push(current);
      }
      prevY1 = ev.y1;
    });
    return paras;
  }

  function renderParagraph(p) {
    const listInfo = looksLikeListMarker(p.text);
    if (listInfo) {
      const dashMatch = listInfo.rest.match(/\s[—–-]\s/);
      if (dashMatch) {
        const idx = dashMatch.index;
        const before = cleanText(listInfo.rest.slice(0, idx));
        const after = cleanText(listInfo.rest.slice(idx + dashMatch[0].length));
        return `<b>${escapeHtml(listInfo.marker)} ${escapeHtml(before)}</b> — ${escapeHtml(after)}`;
      }
      return `<b>${escapeHtml(listInfo.marker)} ${escapeHtml(cleanText(listInfo.rest))}</b>`;
    }
    return escapeHtml(cleanText(p.text));
  }

  function renderParagraphGroup(paras) {
    return paras.map((p, pi) => {
      if (pi === paras.length - 1) return renderParagraph(p);
      const next = paras[pi + 1];
      const bothListItems = !!looksLikeListMarker(p.text) && !!looksLikeListMarker(next.text);
      const br = bothListItems ? (p.text.length > 90 ? '<br><br>' : '<br>') : '<br><br>';
      return renderParagraph(p) + br;
    }).join('\n');
  }

  function convertBlocksToHtml(blocks) {
    const lines = flattenLines(blocks);
    if (!lines.length) return '';

    const leftMargin = Math.min(...lines.map((l) => l.words[0].bbox.x0));
    const medianLineH = median(lines.map((l) => l.bbox.y1 - l.bbox.y0));
    const gapThreshold = Math.max(2.2 * medianLineH, 40);
    const marginTolerance = Math.max(1.5 * medianLineH, 25);

    // Split a line into an optional {label, contentWords} based on the widest
    // word-to-word horizontal gap, if that gap is wide enough to be a column
    // break AND the line starts near the page's left margin AND the label
    // text matches a known section keyword or an item-code pattern (this
    // last check is what keeps running page headers/footers from being
    // mistaken for a label — their "label" text doesn't match either).
    function splitLine(line) {
      const words = line.words;
      const startsAtMargin = Math.abs(words[0].bbox.x0 - leftMargin) <= marginTolerance;
      if (!startsAtMargin || words.length < 2) return { label: null, words };

      let bestGap = -1;
      let bestIdx = -1;
      for (let i = 0; i < words.length - 1; i += 1) {
        const gap = words[i + 1].bbox.x0 - words[i].bbox.x1;
        if (gap > bestGap) { bestGap = gap; bestIdx = i; }
      }
      if (bestGap < gapThreshold) return { label: null, words };

      const labelWords = words.slice(0, bestIdx + 1);
      const contentWords = words.slice(bestIdx + 1);
      const labelText = cleanText(labelWords.map((w) => w.text).join(' '));
      if (!(sectionKeywordInfo(labelText).matched || looksLikeItemCode(labelText))) {
        return { label: null, words };
      }
      return { label: labelText, words: contentWords };
    }

    const events = [];
    lines.forEach((line) => {
      const { label, words } = splitLine(line);
      const text = cleanText(words.map((w) => w.text).join(' '));
      if (label) events.push({ type: 'label', label, text, y0: line.bbox.y0, y1: line.bbox.y1 });
      else if (text) events.push({ type: 'content', text, y0: line.bbox.y0, y1: line.bbox.y1 });
    });

    const out = [];
    let i = 0;
    let sawTitle = false;
    while (i < events.length) {
      const ev = events[i];
      if (ev.type === 'content') {
        const group = [ev];
        let j = i + 1;
        while (j < events.length && events[j].type === 'content') { group.push(events[j]); j += 1; }
        out.push(renderParagraphGroup(mergeParagraphs(group, medianLineH)));
        i = j;
        continue;
      }
      if (!sawTitle && looksLikeItemCode(ev.label)) {
        out.push(`<b>${escapeHtml(fixItemCode(ev.label))}${ev.text ? ' ' + escapeHtml(ev.text) : ''}</b><br><br>`);
        sawTitle = true;
        i += 1;
        continue;
      }
      const contentEvents = [];
      if (ev.text) contentEvents.push({ text: ev.text, y0: ev.y0, y1: ev.y1 });
      let j = i + 1;
      while (j < events.length && events[j].type === 'content') { contentEvents.push(events[j]); j += 1; }
      const paras = mergeParagraphs(contentEvents, medianLineH);
      const info = sectionKeywordInfo(ev.label);
      const labelHtml = info.heading ? `<h3>${escapeHtml(ev.label)}</h3>` : `<b>${escapeHtml(ev.label)}</b>`;
      const inner = renderParagraphGroup(paras);
      out.push(`${labelHtml}\n<div style="padding-left:3em;">\n${inner}\n</div>`);
      if (j < events.length) out.push('<br>');
      i = j;
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ========================================================================
  // Image input (drag/drop, file picker, clipboard paste)
  // ========================================================================

  let currentImageFile = null;

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const imagePreviewWrap = document.getElementById('imagePreviewWrap');
  const imagePreview = document.getElementById('imagePreview');
  const convertBtn = document.getElementById('convertBtn');
  const clearImageBtn = document.getElementById('clearImageBtn');
  const appendToggle = document.getElementById('appendToggle');
  const ocrStatus = document.getElementById('ocrStatus');
  const ocrProgress = document.getElementById('ocrProgress');
  const rawTextDetails = document.getElementById('rawTextDetails');
  const rawTextOutput = document.getElementById('rawTextOutput');

  function setImage(file) {
    currentImageFile = file;
    const url = URL.createObjectURL(file);
    imagePreview.src = url;
    imagePreviewWrap.classList.remove('hidden');
    ocrStatus.textContent = '';
    rawTextDetails.classList.add('hidden');
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setImage(fileInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) setImage(file);
  });

  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { setImage(file); e.preventDefault(); break; }
      }
    }
  });

  clearImageBtn.addEventListener('click', () => {
    currentImageFile = null;
    imagePreview.src = '';
    imagePreviewWrap.classList.add('hidden');
    fileInput.value = '';
  });

  // ========================================================================
  // Convert pipeline: OCR (with word/line bounding boxes) -> automatic layout
  // conversion -> HTML output. No per-line tagging step.
  // ========================================================================

  const htmlOutput = document.getElementById('htmlOutput');
  const htmlPreview = document.getElementById('htmlPreview');
  const copyStatus = document.getElementById('copyStatus');

  function refreshPreview() {
    htmlPreview.innerHTML = htmlOutput.value;
  }

  convertBtn.addEventListener('click', async () => {
    if (!currentImageFile) return;
    convertBtn.disabled = true;
    ocrProgress.classList.remove('hidden');
    ocrProgress.value = 0;
    ocrStatus.textContent = 'Loading OCR engine...';
    try {
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status) ocrStatus.textContent = m.status + (m.progress ? ` (${Math.round(m.progress * 100)}%)` : '');
          if (typeof m.progress === 'number') ocrProgress.value = m.progress;
        },
      });
      const { data } = await worker.recognize(currentImageFile, {}, { blocks: true });
      await worker.terminate();

      rawTextOutput.textContent = data.text;
      rawTextDetails.classList.remove('hidden');

      const html = convertBlocksToHtml(data.blocks);
      if (appendToggle.checked && htmlOutput.value.trim()) {
        htmlOutput.value = htmlOutput.value.trim() + '\n\n' + html;
      } else {
        htmlOutput.value = html;
      }
      refreshPreview();
      ocrStatus.textContent = html ? 'Converted — review the HTML below.' : 'No text detected in this image.';
    } catch (err) {
      console.error(err);
      ocrStatus.textContent = 'Conversion failed: ' + err.message;
    } finally {
      convertBtn.disabled = false;
      ocrProgress.classList.add('hidden');
    }
  });

  htmlOutput.addEventListener('input', refreshPreview);

  document.getElementById('clearOutputBtn').addEventListener('click', () => {
    if (!htmlOutput.value) return;
    if (confirm('Clear the generated HTML?')) {
      htmlOutput.value = '';
      refreshPreview();
    }
  });

  document.getElementById('copyBtn').addEventListener('click', async () => {
    if (!htmlOutput.value) return;
    try {
      await navigator.clipboard.writeText(htmlOutput.value);
      copyStatus.textContent = 'Copied!';
    } catch (err) {
      htmlOutput.select();
      document.execCommand('copy');
      copyStatus.textContent = 'Copied!';
    }
    setTimeout(() => { copyStatus.textContent = ''; }, 2000);
  });
})();
