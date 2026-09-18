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
  // "intentional" spacing runs from OCR/typed text.
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
    // A bare number (page number, etc.) is never a real section label, no
    // matter how short — this must be checked before the short-label
    // fallback below, which would otherwise happily accept it.
    if (/^\d+$/.test(norm)) return { matched: false, heading: false };
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
  // require a closer so an ordinary word isn't mistaken for one. A comma is
  // accepted as a closer too (OCR commonly misreads "." as "," in bold small
  // caps, e.g. "B4f," for "B4f."), but only when the marker also contains a
  // digit — a bare word followed by a comma ("In,") is far more likely to
  // just be a comma in prose than a misread item code.
  function looksLikeListMarker(text) {
    const m = text.match(/^([A-Za-z]{1,3}\d{0,3}[a-z]{0,2}[.,)]|\d{1,3}[.,)]?)\s+(.*)$/);
    if (!m) return null;
    const raw = m[1];
    if (raw.endsWith(',') && !/\d/.test(raw)) return null;
    const closer = raw.endsWith(')') ? ')' : '.';
    const bare = /[.,)]$/.test(raw) ? raw.slice(0, -1) : raw;
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

  // Em/en dashes can end up with no space on either side when OCR glues them
  // onto an adjacent word ("exemple)—Un", "mentale—Une" — confirmed on real
  // screenshots), so neither side is required for those; a real word never
  // contains an em/en dash, so this can't collide with genuine text. A plain
  // hyphen still needs both sides to avoid splitting hyphenated words.
  function findDashSplit(text) {
    return text.match(/\s?[—–]\s?/) || text.match(/\s-\s/);
  }

  // Running page headers/footers follow a distinctive shape regardless of
  // where they sit in the image (a screenshot spanning a page break can have
  // one in the middle, not just at the top/bottom, and the page number can
  // land on either side, e.g. "Section A Identification Information   15" or
  // "16   Section A Identification Information"): short title text plus an
  // isolated bare page number, set off by a much wider gap than normal word
  // spacing because it sits in the page's outer margin.
  function medianGap(words) {
    const gaps = [];
    for (let i = 0; i < words.length - 1; i += 1) {
      gaps.push(words[i + 1].bbox.x0 - words[i].bbox.x1);
    }
    return gaps.length ? median(gaps) : 10;
  }

  function looksLikePageFooter(line) {
    const words = line.words;
    if (words.length < 2) return false;

    const last = words[words.length - 1];
    if (/^\d{1,4}$/.test(last.text)) {
      const rest = words.slice(0, -1);
      const lineText = rest.map((w) => w.text).join(' ');
      const gap = last.bbox.x0 - rest[rest.length - 1].bbox.x1;
      if (lineText.length <= 90 && gap > Math.max(medianGap(rest) * 3, 40)) return true;
    }

    const first = words[0];
    if (/^\d{1,4}$/.test(first.text)) {
      const rest = words.slice(1);
      const lineText = rest.map((w) => w.text).join(' ');
      const gap = rest[0].bbox.x0 - first.bbox.x1;
      if (lineText.length <= 90 && gap > Math.max(medianGap(rest) * 3, 40)) return true;
    }

    return false;
  }

  // Fill-in-the-blank answer grids (bordered single-character boxes, e.g. a
  // Canadian postal code entry "Z 1 Z   1 Z 1" or a mostly-empty variant with
  // just one filled box, "1") are UI widgets, not manual text — they contain
  // nothing but isolated single-character tokens with no real words. A line
  // made up entirely of such tokens (even just one) is excluded; anything
  // with an actual multi-character word (including the explanatory caption
  // that follows, e.g. "(pour les sans-abri)") is left untouched.
  function looksLikeAnswerBoxGrid(line) {
    const text = line.words.map((w) => w.text).join(' ');
    return /^[A-Za-z0-9](\s+[A-Za-z0-9])*$/.test(text);
  }

  // Tesseract's font-attribute detection (is_bold/font_name) is unavailable
  // in the default LSTM engine — confirmed empty even for words that are
  // visibly bold (section labels) on real screenshots, so it can't be used.
  // Instead, measure ink density (fraction of dark pixels) inside each
  // word's bounding box: bold strokes are thicker, so bold words have
  // measurably higher density than regular words of the same font size.
  // Comparison is bucketed by word height so it isn't confounded by
  // heading-vs-body font-size differences.
  const BOLD_DENSITY_RATIO = 1.22;

  function computeInkDensity(pixels, width, height, bbox, inverted) {
    const x0 = Math.max(0, Math.floor(bbox.x0));
    const y0 = Math.max(0, Math.floor(bbox.y0));
    const x1 = Math.min(width, Math.ceil(bbox.x1));
    const y1 = Math.min(height, Math.ceil(bbox.y1));
    let ink = 0;
    let total = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const idx = (width * y + x) * 4;
        const lum = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
        if (inverted ? lum > 115 : lum < 140) ink += 1;
        total += 1;
      }
    }
    return total ? ink / total : 0;
  }

  // Mutates word objects in `lines` with a `.bold` flag. `pixelInfo` is
  // `{ data, width, height, inverted }` from the source canvas, or falsy to
  // skip bold detection entirely (e.g. when no image is available, as in
  // tests that feed synthetic layout data with no pixels behind it).
  function computeBoldFlags(lines, pixelInfo) {
    if (!pixelInfo) return;
    const { data, width, height, inverted } = pixelInfo;
    const measurable = [];
    // Words under 3 real characters (Il, Le, Un, ...) are excluded: their
    // bounding boxes are small enough that anti-aliasing noise along the
    // glyph edges swings the density measurement too much to trust.
    lines.forEach((line) => {
      const lineSeq = [];
      line.words.forEach((w) => {
        if (w.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) {
          const h = w.bbox.y1 - w.bbox.y0;
          const entry = { w, h, density: computeInkDensity(data, width, height, w.bbox, inverted) };
          lineSeq.push(entry);
          measurable.push(entry);
        }
      });
      line.boldSeq = lineSeq;
    });

    const buckets = {};
    measurable.forEach((m) => {
      const key = Math.round(m.h / 2) * 2;
      (buckets[key] = buckets[key] || []).push(m.density);
    });
    const medianOf = {};
    Object.keys(buckets).forEach((k) => { medianOf[k] = median(buckets[k]); });
    measurable.forEach((m) => {
      m.med = medianOf[Math.round(m.h / 2) * 2];
      if (m.med > 0 && m.density > m.med * BOLD_DENSITY_RATIO) m.w.bold = true;
    });
    lines.forEach((line) => { delete line.boldSeq; });
  }

  // Renders a run of words with bold spans wrapped in <b>, for plain prose
  // where inline bold (e.g. a bolded code value inside a sentence) has no
  // structural marker to detect it by — only the pixel-density signal above.
  function renderProseWords(words) {
    const parts = [];
    let i = 0;
    while (i < words.length) {
      if (words[i].bold) {
        const run = [];
        while (i < words.length && words[i].bold) { run.push(words[i].text); i += 1; }
        parts.push(`<b>${escapeHtml(run.join(' '))}</b>`);
      } else {
        parts.push(escapeHtml(words[i].text));
        i += 1;
      }
    }
    return parts.join(' ');
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

  function mergeParagraphs(contentEvents, medianLineH, gapRatio) {
    const ratio = gapRatio == null ? 0.6 : gapRatio;
    const paras = [];
    let current = null;
    let prevY1 = null;
    contentEvents.forEach((ev) => {
      const gap = prevY1 == null ? Infinity : ev.y0 - prevY1;
      const isListStart = !!looksLikeListMarker(ev.text);
      if (current && gap < ratio * medianLineH && !isListStart) {
        current.text = cleanText(current.text + ' ' + ev.text);
        if (ev.words) current.words = (current.words || []).concat(ev.words);
      } else {
        const x0 = ev.words && ev.words.length ? ev.words[0].bbox.x0 : null;
        current = { text: ev.text, words: ev.words ? ev.words.slice() : undefined, x0 };
        paras.push(current);
      }
      prevY1 = ev.y1;
    });
    return paras;
  }

  // A "Term — description" entry with no numbered/lettered marker at all
  // (e.g. a lone Définition: "Langue maternelle — Langue de préférence...",
  // or an unnumbered checkbox-style Codes list where every option is its own
  // "Term — description" paragraph — "Noir(e) — Personne d'ascendance
  // africaine...", "Autochtone — Personne d'ascendance des Premières
  // Nations...", one after another), vs. the same convention but with a
  // marker ("B4f. Terme — description"), which looksLikeListMarker already
  // catches. Applies to every paragraph in a real section (not stray content
  // before the first section, e.g. a title's continuation line — see
  // allowLeadingTerm below), and only when the dash shows up early enough to
  // plausibly be a short term rather than a dash used mid-sentence for a
  // parenthetical aside.
  const LEADING_TERM_MAX_CHARS = 60;

  function renderParagraph(p, allowLeadingTerm) {
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
    if (allowLeadingTerm) {
      const dashMatch = findDashSplit(p.text);
      if (dashMatch && dashMatch.index > 0 && dashMatch.index <= LEADING_TERM_MAX_CHARS) {
        const before = cleanText(p.text.slice(0, dashMatch.index));
        const after = cleanText(p.text.slice(dashMatch.index + dashMatch[0].length));
        if (before && after) return `<b>${escapeHtml(before)}</b> — ${escapeHtml(after)}`;
      }
    }
    if (p.words && p.words.length) return renderProseWords(p.words);
    return escapeHtml(cleanText(p.text));
  }

  function renderParagraphGroup(paras, allowLeadingTerm) {
    return paras.map((p, pi) => {
      if (pi === paras.length - 1) return renderParagraph(p, allowLeadingTerm);
      const next = paras[pi + 1];
      const bothListItems = !!looksLikeListMarker(p.text) && !!looksLikeListMarker(next.text);
      const br = bothListItems ? (p.text.length > 90 ? '<br><br>' : '<br>') : '<br><br>';
      return renderParagraph(p, allowLeadingTerm) + br;
    }).join('\n');
  }

  // Bulleted sub-lists have no marker character to detect at all — OCR drops
  // bullet glyphs (■, •, ...) entirely, confirmed on a real screenshot, so
  // this relies purely on geometry: bullet items sit at a deeper indent than
  // the section's own intro sentence. The catch is that a numbered/lettered
  // item's WRAPPED lines sit at that same deeper indent too (hanging indent:
  // the marker line starts shallow, its continuation lines align under the
  // text rather than the marker — confirmed on a real screenshot, same ~70px
  // offset as a genuine bullet indent). So this can't be judged per line —
  // it has to run on paragraphs (mergeParagraphs already merges continuation
  // lines correctly via tight-gap + marker-aware logic), classifying each
  // paragraph by where its FIRST line starts, not any of its later lines.
  const BULLET_INDENT_RATIO = 1.2;
  // Tighter than mergeParagraphs' 0.6 default: on a real bullet-list
  // screenshot, wrapped-continuation gaps measured 4-8px against a 14-25px
  // range for genuinely separate items/paragraphs (medianLineH 24), and 0.6
  // (14.4) was just barely wide enough to wrongly swallow the narrowest of
  // those (14px, the intro-sentence-to-first-item gap) as a continuation.
  const SECTION_MERGE_GAP_RATIO = 0.45;

  function renderSectionContent(contentEvents, medianLineH) {
    if (!contentEvents.length) return '';
    const paras = mergeParagraphs(contentEvents, medianLineH, SECTION_MERGE_GAP_RATIO);

    const knownX0 = paras.map((p) => p.x0).filter((x) => x != null);
    const baseline = knownX0.length ? Math.min(...knownX0) : 0;
    const bulletThreshold = Math.max(BULLET_INDENT_RATIO * medianLineH, 35);
    const flagged = paras.map((p) => ({
      p,
      // A marker-led paragraph is never a bullet, regardless of indent —
      // marker detection is the more reliable, structural signal.
      isBullet: p.x0 != null && !looksLikeListMarker(p.text) && (p.x0 - baseline) > bulletThreshold,
    }));

    const runs = [];
    flagged.forEach((f) => {
      const last = runs[runs.length - 1];
      if (last && last.isBullet === f.isBullet) last.paras.push(f.p);
      else runs.push({ isBullet: f.isBullet, paras: [f.p] });
    });

    return runs.map((run) => {
      if (!run.isBullet) return renderParagraphGroup(run.paras, true);
      const liHtml = run.paras.map((p) => `<li>${renderParagraph(p, false)}</li>`).join('\n<br>\n');
      return `<ul>\n${liHtml}\n</ul>`;
    }).join('\n<br><br>\n');
  }

  function convertBlocksToHtml(blocks, pixelInfo) {
    const lines = flattenLines(blocks)
      .filter((line) => !looksLikePageFooter(line))
      .filter((line) => !looksLikeAnswerBoxGrid(line));
    if (!lines.length) return '';

    computeBoldFlags(lines, pixelInfo);

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
      if (label) events.push({ type: 'label', label, text, words, y0: line.bbox.y0, y1: line.bbox.y1 });
      else if (text) events.push({ type: 'content', text, words, y0: line.bbox.y0, y1: line.bbox.y1 });
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
        if (j < events.length) out.push('<br><br>');
        i = j;
        continue;
      }
      if (!sawTitle && looksLikeItemCode(ev.label)) {
        // A title can wrap onto a second line (e.g. a country-specific
        // annotation like "[Propre au pays—Canada]"): that line has no label
        // of its own, so it comes through as a separate content event with a
        // tight gap right under the title. Absorb any such tightly-spaced
        // continuation into the bold title itself, rather than treating it as
        // stray content (which would wrongly run it through prose rendering).
        let titleText = fixItemCode(ev.label) + (ev.text ? ' ' + ev.text : '');
        let prevY1 = ev.y1;
        let j = i + 1;
        while (j < events.length && events[j].type === 'content' && (events[j].y0 - prevY1) < 0.6 * medianLineH) {
          titleText += ' ' + events[j].text;
          prevY1 = events[j].y1;
          j += 1;
        }
        out.push(`<b>${escapeHtml(cleanText(titleText))}</b><br><br>`);
        sawTitle = true;
        i = j;
        continue;
      }
      const contentEvents = [];
      if (ev.text) contentEvents.push({ text: ev.text, words: ev.words, y0: ev.y0, y1: ev.y1 });
      let j = i + 1;
      while (j < events.length && events[j].type === 'content') { contentEvents.push(events[j]); j += 1; }
      const info = sectionKeywordInfo(ev.label);
      const labelHtml = info.heading ? `<h3>${escapeHtml(ev.label)}</h3>` : `<b>${escapeHtml(ev.label)}</b>`;
      const inner = renderSectionContent(contentEvents, medianLineH);
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
        canvas.toBlob((blob) => resolve({
          blob,
          inverted,
          pixelInfo: { data: imageData.data, width: canvas.width, height: canvas.height, inverted },
        }), 'image/png');
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
      const { blob, inverted, pixelInfo } = await prepareImageForOcr(currentImageFile);
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

      const html = convertBlocksToHtml(data.blocks, pixelInfo);
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
