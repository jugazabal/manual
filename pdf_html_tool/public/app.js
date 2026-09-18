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

  // Best-effort multi-language vocabulary (interRAI manuals are localized into
  // many languages — English, French, German, Italian, Finnish, Swedish, ...).
  // This is only a hint, not a requirement: sectionKeywordInfo() also accepts
  // any short, unrecognized label, since the two-column layout itself is
  // already strong evidence, so an untranslated keyword doesn't block a match.
  const SECTION_KEYWORDS = [
    'intent', 'definition', 'definitions', 'process', 'coding', 'discussion',
    'interview', 'rationale', 'note', 'notes', 'examples', 'example',
    'observation', 'record review', 'time frame', 'response',
    // French
    'objectif', 'but', 'définition', 'définitions', 'processus', 'codage',
    'codes', 'discussion', 'entretien', 'justification', 'remarque',
    'remarques', 'exemples', 'exemple', 'réponse',
    // German
    'zweck', 'definition', 'prozess', 'kodierung', 'diskussion', 'hinweis',
    'hinweise', 'beispiel', 'beispiele', 'antwort',
    // Italian
    'scopo', 'definizione', 'processo', 'codifica', 'discussione', 'nota',
    'note', 'esempio', 'esempi', 'risposta',
    // Finnish
    'tarkoitus', 'määritelmä', 'prosessi', 'koodaus', 'esimerkki', 'vastaus',
    // Swedish
    'syfte', 'definition', 'process', 'kodning', 'exempel', 'svar',
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
    // Not in our (necessarily incomplete) translated vocabulary — still accept
    // it as a section label if it's short, since the two-column layout match
    // itself (gap + adjacent indented content) is already strong evidence.
    // This is what makes unrecognized-language manuals work without a
    // translation for every possible label.
    const wordCount = norm.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 3 && norm.length <= 24) return { matched: true, heading: false };
    return { matched: false, heading: false };
  }

  // Numeric markers may omit trailing punctuation entirely (some localized
  // manuals render "1 Texte" instead of "1. Texte"); alphabetic markers still
  // require a period/paren closer so an ordinary word isn't mistaken for one.
  function looksLikeListMarker(text) {
    const m = text.match(/^([A-Za-z]{1,3}\d{0,3}[a-z]{0,2}[.)]|\d{1,3}[.)]?)\s+(.*)$/);
    if (!m) return null;
    const raw = m[1];
    const closer = raw.endsWith(')') ? ')' : '.';
    const bare = /[.)]$/.test(raw) ? raw.slice(0, -1) : raw;
    // No padding applied here — it's added at render time (padMarker) so it's
    // applied exactly once regardless of how the marker is subsequently used.
    return { marker: fixItemCode(bare) + closer, rest: m[2] };
  }

  // The manual style pads a pure-numeric marker with three spaces before the
  // label ("1.   Married"); alphabetic item codes just get a single space
  // ("A1a. First name"). Applied once, here, at render time.
  function padMarker(marker) {
    return /^\d{1,3}\.$/.test(marker) ? normalizeListNumber(marker) : marker + ' ';
  }

  // Em/en dashes sometimes have no leading space in justified/reflowed source
  // text (kerning quirks), so only the trailing space is required for those;
  // a plain hyphen still needs both sides to avoid splitting hyphenated words.
  function findDashSplit(text) {
    return text.match(/\s?[—–]\s/) || text.match(/\s-\s/);
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
      const prefix = padMarker(listInfo.marker);
      const dashMatch = findDashSplit(listInfo.rest);
      if (dashMatch) {
        const idx = dashMatch.index;
        const before = cleanText(listInfo.rest.slice(0, idx));
        const after = cleanText(listInfo.rest.slice(idx + dashMatch[0].length));
        return `<b>${escapeHtml(prefix)}${escapeHtml(before)}</b> — ${escapeHtml(after)}`;
      }
      return `<b>${escapeHtml(prefix)}${escapeHtml(cleanText(listInfo.rest))}</b>`;
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

  // Tesseract is trained on dark-text-on-light-background documents and does
  // noticeably worse on dark-mode UI screenshots (accented characters in
  // particular get mangled). Detect a dark background by average luminance
  // and invert it before OCR, since that's cheap and reversible (we hand
  // Tesseract a converted copy, never touching the original file/preview).
  function prepareImageForOcr(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imageData.data;
        let sum = 0;
        let count = 0;
        const step = Math.max(4, Math.floor(d.length / 4 / 20000) * 4);
        for (let i = 0; i < d.length; i += step) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          count += 1;
        }
        const avgLuminance = sum / count;
        const inverted = avgLuminance < 128;
        if (inverted) {
          for (let i = 0; i < d.length; i += 4) {
            d[i] = 255 - d[i];
            d[i + 1] = 255 - d[i + 1];
            d[i + 2] = 255 - d[i + 2];
          }
          ctx.putImageData(imageData, 0, 0);
        }
        canvas.toBlob((blob) => resolve({ blob, inverted }), 'image/png');
      };
      img.onerror = () => reject(new Error('Could not load the image for OCR preprocessing.'));
      img.src = URL.createObjectURL(file);
    });
  }

  // ========================================================================
  // Convert pipeline: OCR (with word/line bounding boxes) -> automatic layout
  // conversion -> HTML output. No per-line tagging step.
  // ========================================================================

  const htmlOutput = document.getElementById('htmlOutput');
  const htmlPreview = document.getElementById('htmlPreview');
  const copyStatus = document.getElementById('copyStatus');
  const ocrLanguage = document.getElementById('ocrLanguage');

  function refreshPreview() {
    htmlPreview.innerHTML = htmlOutput.value;
  }

  convertBtn.addEventListener('click', async () => {
    if (!currentImageFile) return;
    convertBtn.disabled = true;
    ocrProgress.classList.remove('hidden');
    ocrProgress.value = 0;
    ocrStatus.textContent = 'Preparing image...';
    try {
      const { blob, inverted } = await prepareImageForOcr(currentImageFile);
      ocrStatus.textContent = (inverted ? 'Dark background detected — inverted for OCR. ' : '') + 'Loading OCR engine...';
      const worker = await Tesseract.createWorker(ocrLanguage.value, 1, {
        logger: (m) => {
          if (m.status) ocrStatus.textContent = m.status + (m.progress ? ` (${Math.round(m.progress * 100)}%)` : '');
          if (typeof m.progress === 'number') ocrProgress.value = m.progress;
        },
      });
      const { data } = await worker.recognize(blob, {}, { blocks: true });
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
