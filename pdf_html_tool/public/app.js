(() => {
  'use strict';

  // ---------- State ----------
  let rows = [];
  let rowIdCounter = 0;
  let currentImageFile = null;

  const rowsContainer = document.getElementById('rows');
  const emptyRowsHint = document.getElementById('emptyRowsHint');
  const rowTemplate = document.getElementById('row-template');

  // ---------- Utilities ----------
  function nextId() {
    rowIdCounter += 1;
    return 'row-' + rowIdCounter;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Restrict contenteditable output to b/i/u/text only.
  function sanitizeInline(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    const tagMap = { strong: 'b', b: 'b', em: 'i', i: 'i', u: 'u' };

    function walk(node) {
      const children = Array.from(node.childNodes);
      children.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) return;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          child.remove();
          return;
        }
        const tag = child.tagName.toLowerCase();
        if (tagMap[tag]) {
          walk(child);
          if (tag !== tagMap[tag]) {
            const replacement = document.createElement(tagMap[tag]);
            replacement.innerHTML = child.innerHTML;
            child.replaceWith(replacement);
          }
        } else if (tag === 'br') {
          child.replaceWith(document.createTextNode(' '));
        } else if (tag === 'div' || tag === 'p') {
          walk(child);
          const frag = document.createDocumentFragment();
          Array.from(child.childNodes).forEach((n) => frag.appendChild(n));
          frag.appendChild(document.createTextNode(' '));
          child.replaceWith(frag);
        } else {
          walk(child);
          const frag = document.createDocumentFragment();
          Array.from(child.childNodes).forEach((n) => frag.appendChild(n));
          child.replaceWith(frag);
        }
      });
    }
    walk(container);
    return container.innerHTML.replace(/\s+/g, ' ').trim();
  }

  function defaultRow(type) {
    const last = rows[rows.length - 1];
    const inheritIndent = last ? (last.type === 'section' || ((last.type === 'text' || last.type === 'list') && last.indent)) : false;
    const base = {
      id: nextId(),
      type,
      text: '',
      html: '',
      heading: false,
      indent: inheritIndent && type !== 'title' && type !== 'section',
      listStyle: 'paragraph', // paragraph | ol | ul
      spacing: 'single',
    };
    if (type === 'title') { base.spacing = 'double'; base.indent = false; }
    if (type === 'section') { base.spacing = 'none'; base.indent = false; }
    if (type === 'spacer') { base.spacing = 'double'; }
    return base;
  }

  // ---------- Row rendering ----------
  function addRow(type, presetText) {
    const row = defaultRow(type);
    if (presetText !== undefined) {
      row.text = presetText;
      row.html = escapeHtml(presetText);
    }
    rows.push(row);
    renderRows();
    return row;
  }

  function removeRow(id) {
    rows = rows.filter((r) => r.id !== id);
    renderRows();
  }

  function moveRow(id, dir) {
    const idx = rows.findIndex((r) => r.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= rows.length) return;
    const [r] = rows.splice(idx, 1);
    rows.splice(newIdx, 0, r);
    renderRows();
  }

  function renderRows() {
    emptyRowsHint.classList.toggle('hidden', rows.length > 0);
    rowsContainer.innerHTML = '';
    rows.forEach((row) => {
      rowsContainer.appendChild(buildRowCard(row));
    });
  }

  function buildSpacingSelect(row) {
    const sel = document.createElement('select');
    [['none', 'No space'], ['single', 'Single <br>'], ['double', 'Double <br><br>']].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (row.spacing === val) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => { row.spacing = sel.value; });
    return sel;
  }

  function buildIndentToggle(row) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = row.indent;
    cb.addEventListener('change', () => {
      row.indent = cb.checked;
      renderRows();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode('Indented'));
    return label;
  }

  function buildMiniToolbar(target) {
    const bar = document.createElement('div');
    bar.className = 'mini-toolbar';
    [['bold', 'B'], ['italic', 'I'], ['underline', 'U']].forEach(([cmd, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.cmd = cmd;
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
      btn.addEventListener('click', () => {
        target.focus();
        document.execCommand(cmd, false, null);
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  function buildEditableLine(row, onInput) {
    const div = document.createElement('div');
    div.className = 'editable-line';
    div.contentEditable = 'true';
    div.innerHTML = row.html || escapeHtml(row.text || '');
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault(); // single-line field
    });
    div.addEventListener('input', () => {
      row.html = sanitizeInline(div.innerHTML);
      row.text = div.textContent;
      if (onInput) onInput();
    });
    div.addEventListener('blur', () => {
      row.html = sanitizeInline(div.innerHTML);
      row.text = div.textContent;
    });
    return div;
  }

  function buildRowCard(row) {
    const card = rowTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.id = row.id;
    card.dataset.indent = String(row.indent);

    const badge = card.querySelector('.row-type-badge');
    badge.textContent = row.type;
    badge.classList.add(row.type);

    const controls = card.querySelector('.row-controls');
    const body = card.querySelector('.row-body');

    if (row.type !== 'title' && row.type !== 'section' && row.type !== 'spacer') {
      controls.appendChild(buildIndentToggle(row));
    }
    if (row.type !== 'spacer') {
      controls.appendChild(document.createTextNode(' '));
      const spacingLabel = document.createElement('label');
      spacingLabel.textContent = 'Space after: ';
      spacingLabel.appendChild(buildSpacingSelect(row));
      controls.appendChild(spacingLabel);
    }

    if (row.type === 'section') {
      const headingLabel = document.createElement('label');
      const headingCb = document.createElement('input');
      headingCb.type = 'checkbox';
      headingCb.checked = row.heading;
      headingCb.addEventListener('change', () => { row.heading = headingCb.checked; });
      headingLabel.appendChild(headingCb);
      headingLabel.appendChild(document.createTextNode('Use <h3> (CAP-style major section)'));
      controls.appendChild(headingLabel);
    }

    if (row.type === 'list') {
      const styleLabel = document.createElement('label');
      const sel = document.createElement('select');
      [['paragraph', 'Numbered paragraph (recommended)'], ['ol', 'Ordered <ol> item'], ['ul', 'Bullet <ul> item']].forEach(([val, txt]) => {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = txt;
        if (row.listStyle === val) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { row.listStyle = sel.value; });
      styleLabel.appendChild(sel);
      controls.appendChild(styleLabel);
    }

    // Body content per type
    if (row.type === 'title' || row.type === 'section') {
      const input = document.createElement('input');
      input.className = 'plain-input';
      input.type = 'text';
      input.value = row.text || '';
      input.placeholder = row.type === 'title' ? 'e.g. A1. Name' : 'e.g. Intent / Definition / Process / Coding';
      input.addEventListener('input', () => { row.text = input.value; });
      body.appendChild(input);
    } else if (row.type === 'spacer') {
      const note = document.createElement('div');
      note.className = 'hint';
      note.textContent = 'Forces a paragraph break (no text).';
      body.appendChild(note);
    } else {
      // text or list
      const editable = buildEditableLine(row);
      body.appendChild(buildMiniToolbar(editable));
      body.appendChild(editable);

      if (row.type === 'list') {
        const extra = document.createElement('div');
        extra.className = 'list-extra';
        const autoBtn = document.createElement('button');
        autoBtn.type = 'button';
        autoBtn.textContent = 'Auto-bold before dash';
        autoBtn.title = 'Bolds the text before the first " — " (or "-") and leaves the rest plain, e.g. "1.   Married" bold + " — description" plain.';
        autoBtn.addEventListener('click', () => {
          const text = row.text || '';
          const dashMatch = text.match(/\s[—–-]\s/);
          if (dashMatch) {
            const idx = dashMatch.index;
            const before = text.slice(0, idx).trim();
            const after = text.slice(idx + dashMatch[0].length).trim();
            row.html = `<b>${escapeHtml(before)}</b> — ${escapeHtml(after)}`;
          } else {
            row.html = `<b>${escapeHtml(text.trim())}</b>`;
          }
          renderRows();
        });
        extra.appendChild(autoBtn);
        extra.appendChild(document.createTextNode('Long item (auto <br><br>): '));
        const longCb = document.createElement('input');
        longCb.type = 'checkbox';
        longCb.checked = (row.text || '').length > 90;
        longCb.addEventListener('change', () => { row.spacing = longCb.checked ? 'double' : 'single'; });
        extra.appendChild(longCb);
        body.appendChild(extra);
      }
    }

    card.querySelector('.move-up').addEventListener('click', () => moveRow(row.id, -1));
    card.querySelector('.move-down').addEventListener('click', () => moveRow(row.id, 1));
    card.querySelector('.delete-row').addEventListener('click', () => removeRow(row.id));

    return card;
  }

  // ---------- HTML generation ----------
  function spacingBr(spacing) {
    if (spacing === 'double') return '<br><br>';
    if (spacing === 'single') return '<br>';
    return '';
  }

  function renderRowContent(row) {
    switch (row.type) {
      case 'title':
        return `<b>${escapeHtml(row.text || '')}</b>`;
      case 'section':
        return row.heading ? `<h3>${escapeHtml(row.text || '')}</h3>` : `<b>${escapeHtml(row.text || '')}</b>`;
      case 'text':
        return row.html || '';
      case 'list':
        return row.html || '';
      case 'spacer':
        return '';
      default:
        return '';
    }
  }

  function renderCluster(clusterRows) {
    const parts = [];
    let k = 0;
    while (k < clusterRows.length) {
      const r = clusterRows[k];
      if (r.type === 'list' && r.listStyle !== 'paragraph') {
        const style = r.listStyle;
        const group = [];
        while (k < clusterRows.length && clusterRows[k].type === 'list' && clusterRows[k].listStyle === style) {
          group.push(clusterRows[k]);
          k += 1;
        }
        const items = group.map((g) => `  <li>${g.html || ''}</li>`).join('\n');
        parts.push(`<${style}>\n${items}\n</${style}>`);
        const lastSpacing = group[group.length - 1].spacing;
        const br = spacingBr(lastSpacing);
        if (br) parts.push(br);
      } else {
        const content = renderRowContent(r);
        parts.push(content + spacingBr(r.spacing));
        k += 1;
      }
    }
    return parts.join('\n');
  }

  function generateHtml() {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (row.indent) {
        let j = i;
        const cluster = [];
        while (j < rows.length && rows[j].indent) {
          cluster.push(rows[j]);
          j += 1;
        }
        const inner = renderCluster(cluster);
        out.push(`<div style="padding-left:3em;">\n${inner}\n</div>`);
        const lastSpacing = cluster[cluster.length - 1].spacing;
        const hasMore = j < rows.length;
        if (hasMore) {
          const br = spacingBr(lastSpacing === 'none' ? 'single' : lastSpacing);
          if (br) out.push(br);
        }
        i = j;
      } else {
        const content = renderRowContent(row);
        out.push(content + spacingBr(row.spacing));
        i += 1;
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- Image input ----------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const imagePreviewWrap = document.getElementById('imagePreviewWrap');
  const imagePreview = document.getElementById('imagePreview');
  const runOcrBtn = document.getElementById('runOcrBtn');
  const clearImageBtn = document.getElementById('clearImageBtn');
  const ocrStatus = document.getElementById('ocrStatus');
  const ocrProgress = document.getElementById('ocrProgress');

  function setImage(file) {
    currentImageFile = file;
    const url = URL.createObjectURL(file);
    imagePreview.src = url;
    imagePreviewWrap.classList.remove('hidden');
    ocrStatus.textContent = '';
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

  runOcrBtn.addEventListener('click', async () => {
    if (!currentImageFile) return;
    runOcrBtn.disabled = true;
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
      const { data } = await worker.recognize(currentImageFile);
      await worker.terminate();
      const lines = data.text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      lines.forEach((line) => addRow('text', line));
      ocrStatus.textContent = `Done — added ${lines.length} line(s) to the builder below.`;
    } catch (err) {
      console.error(err);
      ocrStatus.textContent = 'OCR failed: ' + err.message;
    } finally {
      runOcrBtn.disabled = false;
      ocrProgress.classList.add('hidden');
    }
  });

  // ---------- Toolbar / output wiring ----------
  document.querySelectorAll('.toolbar [data-add]').forEach((btn) => {
    btn.addEventListener('click', () => addRow(btn.dataset.add));
  });

  document.getElementById('clearRowsBtn').addEventListener('click', () => {
    if (rows.length === 0) return;
    if (confirm('Remove all rows from the builder?')) {
      rows = [];
      renderRows();
    }
  });

  const htmlOutput = document.getElementById('htmlOutput');
  const htmlPreview = document.getElementById('htmlPreview');
  const copyStatus = document.getElementById('copyStatus');

  document.getElementById('generateBtn').addEventListener('click', () => {
    const html = generateHtml();
    htmlOutput.value = html;
    htmlPreview.innerHTML = html;
    copyStatus.textContent = '';
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

  // Initial render
  renderRows();
})();
