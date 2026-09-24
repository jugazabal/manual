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

  // The source document hyphenates a word to wrap it across the end of a
  // line ("pro-" / "blèmes"), and OCR reads that hyphen literally, leaving
  // "pro- blèmes" instead of "problèmes" wherever a wrapped line gets
  // rejoined. A trailing ASCII hyphen right after a letter, followed by a
  // lowercase continuation, is treated as that line-wrap artifact and
  // removed; a real em/en dash or a hyphen before a capital letter (much
  // more likely a genuine dash or a new sentence than a mid-word break) is
  // left alone. A genuine hyphenated compound word that happens to wrap at
  // its own hyphen (e.g. "au-" / "delà") is rare enough, and unaffected
  // either way once rejoined, that this needs no per-language dictionary —
  // it works the same for every language the tool supports.
  function joinWrappedText(a, b) {
    const m = a.match(/^(.*\p{L})-$/u);
    if (m && /^\p{Ll}/u.test(b)) return m[1] + b;
    return a + ' ' + b;
  }

  // The manual style deliberately pads numbered list items with three spaces,
  // e.g. "1.   Married". Enforced explicitly rather than trying to detect
  // "intentional" spacing runs from OCR/typed text.
  function normalizeListNumber(text) {
    return text.replace(/^(\d{1,3}\.)\s*/, '$1   ');
  }

  // ========================================================================
  // High-confidence OCR spelling correction.
  //
  // OCR sometimes glues classic look-alike character pairs together inside
  // an otherwise correctly-read word (rn/m, cl/d, l/1, o/0, vv/w, ri/n). A
  // fix is only ever applied when the ORIGINAL word is not a recognized
  // dictionary word AND exactly one of these substitutions turns it into one
  // that is — no match, or more than one distinct match, leaves the word
  // untouched. That's what keeps this from ever silently rewriting a
  // clinical term, item code, or proper noun the dictionary simply doesn't
  // know: unrecognized-and-unfixable is treated as "leave it alone", not
  // "guess". Dictionaries are Hunspell wordlists loaded lazily per OCR
  // language from a CDN, matching this tool's zero-backend,
  // CDN-only-for-libraries architecture (same approach as Tesseract.js).
  // ========================================================================

  // Finnish has no practical Hunspell dictionary — its inflectional
  // morphology needs a dedicated analyzer (Voikko), not a flat wordlist — so
  // it's intentionally left out. correctOcrWord() is a no-op for any
  // language with no loaded dictionary (empty `spellers`), never a guess.
  const DICTIONARY_PACKAGES = {
    eng: 'dictionary-en@4',
    fra: 'dictionary-fr@3',
    deu: 'dictionary-de@3',
    ita: 'dictionary-it@2',
    swe: 'dictionary-sv@4',
  };

  let nspellLibPromise = null;
  function loadNspellLib() {
    if (!nspellLibPromise) {
      nspellLibPromise = import('https://cdn.jsdelivr.net/npm/nspell@2/+esm').then((m) => m.default || m);
    }
    return nspellLibPromise;
  }

  const spellerPromiseCache = {};
  function loadSpeller(pkg) {
    if (!spellerPromiseCache[pkg]) {
      spellerPromiseCache[pkg] = Promise.all([
        loadNspellLib(),
        fetch(`https://cdn.jsdelivr.net/npm/${pkg}/index.aff`).then((r) => r.arrayBuffer()),
        fetch(`https://cdn.jsdelivr.net/npm/${pkg}/index.dic`).then((r) => r.arrayBuffer()),
      ]).then(([nspell, aff, dic]) => nspell({ aff: new Uint8Array(aff), dic: new Uint8Array(dic) }));
    }
    return spellerPromiseCache[pkg];
  }

  // `languageValue` is the tool's OCR language selector value, e.g. "fra" or
  // the combined "eng+fra". Loads every dictionary that has one available
  // and skips the rest; a failed fetch (offline, CDN unreachable) is
  // swallowed per language so a network hiccup degrades to "no
  // spell-correction for that language" instead of blocking conversion.
  async function getSpellers(languageValue) {
    const codes = (languageValue || '').split('+').map((s) => s.trim()).filter(Boolean);
    const pkgs = codes.map((c) => DICTIONARY_PACKAGES[c]).filter(Boolean);
    const results = await Promise.all(pkgs.map((pkg) => loadSpeller(pkg).catch((err) => {
      console.error('Spell-check dictionary failed to load:', pkg, err);
      return null;
    })));
    return results.filter(Boolean);
  }

  // rn/m, cl/d, l/1, o/0, vv/w: the classic OCR look-alike pairs, kept to a
  // short, well-established set rather than trying to be exhaustive.
  // Matched against a lowercased copy of the word (case is restored on the
  // winning candidate afterwards), so one list covers every case shape.
  // Deliberately excludes single-common-letter pairs like ri/n: verified
  // against real OCR output that bidirectionally swapping "n" (one of the
  // most frequent letters in these languages) for the rarer 2-char "ri" false
  // -positives on short, unrelated words (a stray "nel" fragment was
  // "corrected" to the unrelated real word "riel") — exactly the kind of
  // guess this feature must never make.
  const OCR_CONFUSION_PATTERNS = [['rn', 'm'], ['cl', 'd'], ['vv', 'w'], ['l', '1'], ['o', '0']];

  function generateOcrCandidates(lowerCore) {
    const candidates = new Set();
    OCR_CONFUSION_PATTERNS.forEach(([a, b]) => {
      [[a, b], [b, a]].forEach(([from, to]) => {
        let idx = lowerCore.indexOf(from);
        while (idx !== -1) {
          candidates.add(lowerCore.slice(0, idx) + to + lowerCore.slice(idx + from.length));
          idx = lowerCore.indexOf(from, idx + 1);
        }
      });
    });
    candidates.delete(lowerCore);
    return Array.from(candidates);
  }

  // 'lower' | 'upper' | 'capitalized' | null. Anything else (mixed interior
  // case — a stray OCR glitch, or a name like "McKay") is left alone by
  // returning null, out of caution.
  function caseShapeOf(core) {
    if (core === core.toLowerCase()) return 'lower';
    if (core === core.toUpperCase()) return 'upper';
    if (core.charAt(0) === core.charAt(0).toUpperCase() && core.slice(1) === core.slice(1).toLowerCase()) return 'capitalized';
    return null;
  }

  function applyCaseShape(word, shape) {
    if (shape === 'upper') return word.toUpperCase();
    if (shape === 'capitalized') return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
  }

  // Item codes (G1c, B4f.) and short all-caps acronyms (AIVQ, MDS) are never
  // dictionary words in any language and must never be run through
  // candidate generation — skip them outright rather than relying on "no
  // valid candidate found" to protect them.
  function looksLikeCodeOrAcronym(core) {
    if (looksLikeItemCode(core)) return true;
    return /^[A-Z]{2,6}$/.test(core);
  }

  function correctOcrWord(rawWord, spellers) {
    if (!spellers || !spellers.length || !rawWord) return rawWord;
    const m = rawWord.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    const lead = m[1];
    const core = m[2];
    const trail = m[3];
    // A trailing hyphen marks a not-yet-rejoined line-wrap fragment ("pro-")
    // — spell-checking half a word is meaningless, so leave it for the
    // hyphenation fix to rejoin first.
    if (trail.includes('-') || !core) return rawWord;
    if (core.replace(/[^\p{L}]/gu, '').length < 3) return rawWord;
    if (looksLikeCodeOrAcronym(core)) return rawWord;

    const lowerCore = core.toLowerCase();
    if (spellers.some((sp) => sp.correct(core) || sp.correct(lowerCore))) return rawWord;

    const shape = caseShapeOf(core);
    if (!shape) return rawWord;

    const validCandidates = new Set();
    generateOcrCandidates(lowerCore).forEach((candidate) => {
      if (spellers.some((sp) => sp.correct(candidate))) validCandidates.add(candidate);
    });
    if (validCandidates.size !== 1) return rawWord;

    const [winner] = validCandidates;
    return lead + applyCaseShape(winner, shape) + trail;
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

  // Common OCR confusion: "l", "I" or "T" read instead of digit "1" in item codes ("Al.", "MT.").
  function fixItemCode(text) {
    return text.replace(/^([A-Z]{1,3})[lIT]([a-z]{0,2}\.?)$/, '$1' + '1' + '$2');
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
    const m = text.match(/^([A-Z][A-Za-z]{0,2}\d{0,3}[a-z]{0,2}[.,)]|[a-z][.,)]|\d{1,3}[.,)]?)\s+(.*)$/);
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

  // A worked-example "conversation" block (assessor/respondent dialogue) is
  // written as "Speaker: text", one turn per line/paragraph — the same
  // "short label, colon, more text" shape as everything else here, just with
  // a much smaller gap than a page-level label/content column split (~45-60px
  // on a real screenshot vs. the 40px+ threshold tuned for that). Detected by
  // text pattern instead of geometry for that reason. A lone match (a single
  // "Label: text" line with no turn before or after it, e.g. "REMARQUE :
  // ...") is not a real dialogue and is demoted back to prose by the caller —
  // this pattern alone is too generic to trust in isolation.
  function looksLikeDialogueLine(text) {
    const m = text.match(/^([^:]{2,40}):\s+(.+)$/);
    if (!m) return null;
    const speaker = cleanText(m[1]);
    if (!speaker || /\d/.test(speaker)) return null;
    return { speaker, rest: m[2] };
  }

  // Best-effort multi-language list of "the person being interviewed" roles,
  // whose dialogue lines are conventionally italicized in these worked
  // examples (confirmed both in the target markup and visually in the source
  // screenshot, where the respondent's lines are rendered in italic font).
  const DIALOGUE_RESPONDENT_KEYWORDS = [
    'la personne', 'le client', 'la cliente', 'person', 'client', 'patient',
    'resident', 'the person', 'the client', 'the resident', 'bewohner',
    'paziente', 'potilas', 'brukaren',
  ];

  function renderDialogueRow(p) {
    const d = looksLikeDialogueLine(p.text);
    const speaker = escapeHtml(d.speaker);
    const isRespondent = DIALOGUE_RESPONDENT_KEYWORDS.includes(d.speaker.toLowerCase());
    const content = escapeHtml(cleanText(d.rest));
    return `<tr><td><b>${speaker}:</b></td><td>${isRespondent ? `<i>${content}</i>` : content}</td></tr>`;
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

  // Merges a line-wrap-hyphenated word pair ("pro-", "blèmes") into one word
  // object before rendering. renderProseWords joins words with a plain space,
  // which would otherwise bypass the same fix already applied to the merged
  // paragraph text (that string isn't what gets rendered here — this word
  // array is, precisely so inline bold detection has per-word data to work
  // with), leaving the literal "pro- blèmes" artifact in prose output.
  function mergeHyphenatedWords(words) {
    const merged = [];
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i];
      const next = words[i + 1];
      if (next) {
        const joined = joinWrappedText(w.text, next.text);
        if (joined !== `${w.text} ${next.text}`) {
          merged.push({ text: joined, bold: w.bold, bbox: w.bbox });
          i += 1;
          continue;
        }
      }
      merged.push(w);
    }
    return merged;
  }

  // Renders a run of words with bold spans wrapped in <b>, for plain prose
  // where inline bold (e.g. a bolded code value inside a sentence) has no
  // structural marker to detect it by — only the pixel-density signal above.
  function renderProseWords(rawWords) {
    const words = mergeHyphenatedWords(rawWords);
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

  function flattenLines(blocks, spellers) {
    const lines = [];
    (blocks || []).forEach((block) => {
      (block.paragraphs || []).forEach((para) => {
        (para.lines || []).forEach((line) => {
          const words = (line.words || [])
            .map((w) => ({ text: correctOcrWord(cleanFragment(w.text || ''), spellers), bbox: w.bbox }))
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
      const isNewStart = !!looksLikeListMarker(ev.text) || !!looksLikeDialogueLine(ev.text);
      if (current && gap < ratio * medianLineH && !isNewStart) {
        current.text = cleanText(joinWrappedText(current.text, ev.text));
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

  function renderSectionContent(contentEvents, medianLineH, options) {
    if (!contentEvents.length) return '';
    const opts = options || {};
    const allowLeadingTerm = !!opts.allowLeadingTerm;
    const gapRatio = opts.gapRatio == null ? 0.6 : opts.gapRatio;
    const paras = mergeParagraphs(contentEvents, medianLineH, gapRatio);

    const knownX0 = paras.map((p) => p.x0).filter((x) => x != null);
    const baseline = knownX0.length ? Math.min(...knownX0) : 0;
    const bulletThreshold = Math.max(BULLET_INDENT_RATIO * medianLineH, 35);
    const flagged = paras.map((p) => {
      const isMarker = !!looksLikeListMarker(p.text);
      const isDialogue = !isMarker && !!looksLikeDialogueLine(p.text);
      // A marker-led paragraph is never a bullet, regardless of indent —
      // marker detection is the more reliable, structural signal.
      const isBullet = !isMarker && !isDialogue && p.x0 != null && (p.x0 - baseline) > bulletThreshold;
      return { p, kind: isDialogue ? 'dialogue' : (isBullet ? 'bullet' : 'prose') };
    });

    const runs = [];
    flagged.forEach((f) => {
      const last = runs[runs.length - 1];
      if (last && last.kind === f.kind) last.paras.push(f.p);
      else runs.push({ kind: f.kind, paras: [f.p] });
    });
    // A single isolated "Label: text" line (e.g. "REMARQUE : ...") isn't a
    // real dialogue turn — only trust the pattern once it repeats.
    runs.forEach((run) => { if (run.kind === 'dialogue' && run.paras.length < 2) run.kind = 'prose'; });

    return runs.map((run) => {
      if (run.kind === 'bullet') {
        const liHtml = run.paras.map((p) => `<li>${renderParagraph(p, false)}</li>`).join('\n<br>\n');
        return `<ul>\n${liHtml}\n</ul>`;
      }
      if (run.kind === 'dialogue') {
        const rows = run.paras.map((p) => renderDialogueRow(p)).join('\n');
        return `<table border="0">\n${rows}\n</table>`;
      }
      return renderParagraphGroup(run.paras, allowLeadingTerm);
    }).join('\n<br><br>\n');
  }

  // A genuine gridded data table (header row + N columns, e.g. an AIVQ/IADL
  // coding-examples table) is a different shape from the 2-column "Speaker:
  // text" dialogue table: it has a real header row with 2+ big gaps within
  // one Tesseract-merged line (the same shape splitLine looks for, just with
  // multiple splits instead of one), and its columns can span many wrapped
  // lines that Tesseract itself merges together across columns. Detected by
  // that header shape; column boundaries come from where the header segments
  // start, and every later line's words are bucketed into columns by
  // x-position rather than trusting Tesseract's own line grouping.
  function splitByBigGaps(words, medianLineH) {
    const threshold = Math.max(3 * medianLineH, 60);
    const segments = [[words[0]]];
    for (let i = 1; i < words.length; i += 1) {
      const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
      if (gap > threshold) segments.push([words[i]]);
      else segments[segments.length - 1].push(words[i]);
    }
    return segments;
  }

  // A table cell's concluding scoring statement always mentions a code and a
  // quoted or "=" value ("Code = 6, Dépendance totale"; "Dans cette
  // catégorie, le code «8» devrait être attribué à..."), consistently and
  // entirely bold in every example seen — a reliable text-pattern signal,
  // unlike relying on the pixel-density bold fallback for a whole sentence.
  function looksLikeCodingStatement(text) {
    const norm = text.toLowerCase();
    return /\bcode\b/.test(norm) && /[«"][^»"]*[»"]|=\s*\d/.test(text);
  }

  // The narrative sentence right before a coding statement is sometimes
  // merged into the same paragraph (the OCR gap between them isn't always
  // wide enough to register as a paragraph break on its own), which would
  // otherwise bold that leading sentence too. Split at the phrase that
  // starts the coding statement instead of requiring the whole paragraph to
  // match, so only the statement itself — not what precedes it — gets bold.
  const CODING_STATEMENT_STARTS = [/dans cette catégorie/i, /utilisez le code\b/i, /\bcode\s*=/i];

  function splitCodingStatement(text) {
    for (const re of CODING_STATEMENT_STARTS) {
      const m = text.match(re);
      if (m && looksLikeCodingStatement(text.slice(m.index))) {
        return { before: cleanText(text.slice(0, m.index)), statement: cleanText(text.slice(m.index)) };
      }
    }
    return null;
  }

  // Deliberately requires 3+ segments (2+ gaps): a line with exactly one big
  // gap is the normal "Label: content" shape splitLine already handles
  // correctly, and must be left alone — only a genuine multi-column header
  // (3+ columns) needs to bypass splitLine's single-label detection.
  function looksLikeMultiColumnHeader(line, medianLineH) {
    const words = line.words;
    if (!words || words.length < 2) return false;
    const segments = splitByBigGaps(words, medianLineH);
    return segments.length >= 3 && segments.length <= 6;
  }

  function detectGridTableColumns(headerEvent, medianLineH) {
    const words = headerEvent && headerEvent.words;
    if (!words || words.length < 2) return null;
    const segments = splitByBigGaps(words, medianLineH);
    if (segments.length < 2) return null;
    // Anchor each boundary to where the NEXT column starts, not the midpoint
    // between this column's header and the next one's. A column's own body
    // text commonly wraps far wider than its (short) header label — on a
    // real screenshot, column 0's header ("AIVQ") ended around x=100 but its
    // wrapped body text legitimately ran out past x=480, while column 1's
    // body text reliably started right where its own header did (~578).
    // Using the header-to-header midpoint (~340) clipped column 0's own
    // overflow words into column 1; anchoring to column 1's known start
    // (minus a small buffer) keeps them correctly in column 0 instead.
    const bounds = [];
    for (let i = 0; i < segments.length - 1; i += 1) {
      bounds.push(segments[i + 1][0].bbox.x0 - 10);
    }
    const headers = segments.map((seg) => cleanText(seg.map((w) => w.text).join(' ')));
    return { bounds, headers };
  }

  // Rows are segmented using column 0's own paragraph gaps rather than
  // Tesseract's line grouping, since column 0 (the case description) is
  // reliably present for every row while the other columns may wrap to a
  // different number of physical lines within the same logical row.
  function renderGridTable(events, medianLineH) {
    if (!events.length) return null;
    const cols = detectGridTableColumns(events[0], medianLineH);
    if (!cols) return null;
    const { bounds, headers } = cols;
    const numCols = headers.length;
    function columnOf(x0) {
      for (let i = 0; i < bounds.length; i += 1) if (x0 < bounds[i]) return i;
      return numCols - 1;
    }

    const bodyEvents = events.slice(1);
    const col0Lines = bodyEvents.filter((ev) => ev.words && ev.words.length && columnOf(ev.words[0].bbox.x0) === 0);
    if (!col0Lines.length) return null;
    // On a real screenshot, within-paragraph continuation gaps measured 2-9px
    // against 27px+ for a genuine row boundary (medianLineH 23) — a full
    // line height comfortably separates the two with margin on both sides.
    const rowGapThreshold = Math.max(medianLineH, 20);
    const rowStartsY = [];
    let prevY1 = null;
    col0Lines.forEach((ev) => {
      const gap = prevY1 == null ? Infinity : ev.y0 - prevY1;
      if (gap > rowGapThreshold) rowStartsY.push(ev.y0);
      prevY1 = ev.y1;
    });
    if (!rowStartsY.length) return null;

    const rows = rowStartsY.map((y0, i) => ({
      y0,
      cells: Array.from({ length: numCols }, () => []),
    }));
    function rowIndexFor(y) {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (y >= rows[i].y0) return i;
      return 0;
    }

    bodyEvents.forEach((ev) => {
      if (!ev.words || !ev.words.length) return;
      const byCol = Array.from({ length: numCols }, () => []);
      ev.words.forEach((w) => { byCol[columnOf(w.bbox.x0)].push(w); });
      const rIdx = rowIndexFor(ev.y0);
      byCol.forEach((wordsInCol, colIdx) => {
        if (!wordsInCol.length) return;
        const text = cleanText(wordsInCol.map((w) => w.text).join(' '));
        if (text) rows[rIdx].cells[colIdx].push({ text, words: wordsInCol, y0: ev.y0, y1: ev.y1 });
      });
    });

    function renderCell(cellEvents) {
      if (!cellEvents.length) return '';
      const paras = mergeParagraphs(cellEvents, medianLineH, 0.6);
      return paras.map((p) => {
        // A cell's concluding scoring statement ("Code = 6, Dépendance
        // totale", "Dans cette catégorie, le code «8» devrait être
        // attribué...") is consistently rendered entirely bold across every
        // example seen — a structural convention, not something worth
        // leaving to the pixel-density fallback, which is confirmed
        // unreliable at fully covering a multi-word bold run.
        const split = splitCodingStatement(p.text);
        if (split) {
          const prefix = split.before ? `${escapeHtml(split.before)}<br><br>\n` : '';
          return `${prefix}<b>${escapeHtml(split.statement)}</b>`;
        }
        if (looksLikeCodingStatement(p.text)) return `<b>${escapeHtml(cleanText(p.text))}</b>`;
        return renderParagraph(p, false);
      }).join('\n<br><br>\n');
    }

    const headHtml = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    const bodyHtml = rows.map((row) => `<tr>${row.cells.map((c) => `<td>${renderCell(c)}</td>`).join('')}</tr>`).join('\n');
    return `<table border="1">\n${headHtml}\n${bodyHtml}\n</table>`;
  }

  // A worked-example page has no item-code title, just a short heading (on
  // a real screenshot, visibly centered — well clear of the body's own left
  // margin), directly above single-column body content. Wraps the whole
  // thing in a box, matching how these callouts are meant to stand out from
  // regular item content.
  function renderBoxExample(events, medianLineH) {
    if (!events.length) return '';
    let headingText = '';
    let prevY1 = null;
    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      const gap = prevY1 == null ? -Infinity : ev.y0 - prevY1;
      if (i === 0 || gap < 0.6 * medianLineH) {
        headingText = headingText ? joinWrappedText(headingText, ev.text) : ev.text;
        prevY1 = ev.y1;
        i += 1;
      } else break;
    }
    const heading = cleanText(headingText);
    const rest = events.slice(i);
    const inner = renderGridTable(rest, medianLineH) || renderSectionContent(rest, medianLineH, { gapRatio: 0.6 });
    const headingHtml = heading ? `<b>${escapeHtml(heading)}</b>\n<br><br>\n\n` : '';
    return `<div class="box">\n${headingHtml}${inner}\n</div>`;
  }

  function convertBlocksToHtml(blocks, pixelInfo, spellers) {
    const lines = flattenLines(blocks, spellers)
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
      // Dialogue lines ("Évaluateur : ...", "La personne: ...") match the
      // same "label, gap, content" shape splitLine looks for, but with a
      // much smaller gap tuned for a different purpose (page-level column
      // splits). Intercepted here by text pattern before splitLine ever
      // sees them, so they can't be mistaken for a section label via the
      // short-label fallback.
      const lineText = cleanText(line.words.map((w) => w.text).join(' '));
      if (looksLikeDialogueLine(lineText)) {
        events.push({ type: 'content', text: lineText, words: line.words, y0: line.bbox.y0, y1: line.bbox.y1 });
        return;
      }
      // A genuine table header ("AIVQ | Catégorie Performance | Catégorie
      // Capacité") has TWO+ big gaps (3+ columns), unlike the normal
      // "Label: content" shape splitLine looks for (exactly one gap, two
      // columns) — without this check, a short first segment like "AIVQ"
      // would pass the short-label fallback and get misread as a section
      // label with the rest of the header as its content.
      if (looksLikeMultiColumnHeader(line, medianLineH)) {
        events.push({ type: 'content', text: lineText, words: line.words, y0: line.bbox.y0, y1: line.bbox.y1 });
        return;
      }
      const { label, words } = splitLine(line);
      const text = cleanText(words.map((w) => w.text).join(' '));
      if (label) events.push({ type: 'label', label, text, words, y0: line.bbox.y0, y1: line.bbox.y1 });
      else if (text) events.push({ type: 'content', text, words, y0: line.bbox.y0, y1: line.bbox.y1 });
    });

    // A "worked example" page (a callout box demonstrating how to code an
    // item, e.g. a sample assessor/respondent conversation) has no recognized
    // label at all — no item-code title, no section keyword like Objectif or
    // Codes — just a plain heading, with its body a single flat column
    // rather than the usual label/content structure. This must be "no label
    // anywhere", not "no item-code title": a screenshot can be legitimately
    // cropped to show only a Définition/Codes section with no title line in
    // frame, and that's still normal item content, not a worked example.
    const hasAnyLabel = events.some((ev) => ev.type === 'label');
    if (!hasAnyLabel) return renderBoxExample(events, medianLineH);

    const out = [];
    let i = 0;
    let sawTitle = false;
    while (i < events.length) {
      const ev = events[i];
      if (ev.type === 'content') {
        const group = [ev];
        let j = i + 1;
        while (j < events.length && events[j].type === 'content') { group.push(events[j]); j += 1; }
        out.push(renderSectionContent(group, medianLineH, { gapRatio: 0.6 }));
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
          titleText = joinWrappedText(titleText, events[j].text);
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
      const inner = renderSectionContent(contentEvents, medianLineH, { allowLeadingTerm: true, gapRatio: SECTION_MERGE_GAP_RATIO });
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
          // pixelInfo.inverted is deliberately always false, not `inverted`:
          // by this point imageData.data has already been normalized to
          // standard dark-text-on-light-background orientation (inverted in
          // place above if it started dark, left alone if it didn't), so
          // computeInkDensity should always use the standard "dark pixel =
          // ink" threshold. Passing `inverted` here was a real bug — it told
          // computeInkDensity to treat BRIGHT pixels as ink on data that had
          // already been flipped to make ink dark, so on every dark-mode
          // screenshot it was measuring background coverage instead of ink
          // coverage, producing effectively random-looking false-positive
          // bold words.
          pixelInfo: { data: imageData.data, width: canvas.width, height: canvas.height, inverted: false },
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
      // Kicked off alongside OCR (not awaited yet) so the dictionary fetch
      // doesn't add latency on top of recognition.
      const spellersPromise = getSpellers(ocrLanguage.value);
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

      const spellers = await spellersPromise;
      const html = convertBlocksToHtml(data.blocks, pixelInfo, spellers);
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
