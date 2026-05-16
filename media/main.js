// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById('messages'));
  const formEl = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sendBtn'));
  const settingsBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('settingsBtn'));
  const attachBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('attachBtn'));
  const attachmentsEl = /** @type {HTMLElement | null} */ (document.getElementById('attachments'));
  const statusbarEl = /** @type {HTMLElement} */ (document.getElementById('statusbar'));
  const statusModelEl = /** @type {HTMLElement} */ (document.getElementById('statusModel'));
  const statusInfoEl = /** @type {HTMLElement} */ (document.getElementById('statusInfo'));
  const sendIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  const stopIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';

  /** @type {HTMLElement | null} */ let activeAssistantEl = null;
  /** @type {HTMLElement | null} */ let activeAssistantBody = null;
  let activeAssistantText = '';
  let pendingChunks = '';
  let typingTimer = 0;
  let isStreaming = false;

  /** @type {Array<{kind:'image'|'text', name:string, mime?:string, data:string}>} */
  let pendingAttachments = [];

  function applyRuntimeStatus(status) {
    if (!status || typeof status !== 'object') return;
    const model = String(status.model || '').trim();
    const baseUrl = String(status.baseUrl || '').trim();
    if (statusModelEl && model) {
      statusModelEl.textContent = model;
      statusModelEl.title = `Current model: ${model}`;
    }
    if (settingsBtn) {
      settingsBtn.title = baseUrl
        ? `Open settings (effective baseUrl: ${baseUrl})`
        : 'Open settings';
      settingsBtn.setAttribute('aria-label', settingsBtn.title);
    }
    if (model) {
      inputEl.placeholder = `Message ${model}`;
    }
  }

  function renderAttachmentChips() {
    if (!attachmentsEl) return;
    if (pendingAttachments.length === 0) {
      attachmentsEl.innerHTML = '';
      attachmentsEl.hidden = true;
      return;
    }
    attachmentsEl.hidden = false;
    attachmentsEl.innerHTML = '';
    pendingAttachments.forEach((a, idx) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'attach-chip-thumb';
        img.src = `data:${a.mime || 'image/png'};base64,${a.data}`;
        img.alt = a.name;
        chip.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'attach-chip-icon';
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
        chip.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'attach-chip-name';
      name.textContent = a.name;
      chip.appendChild(name);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'attach-chip-close';
      close.title = 'Remove';
      close.textContent = '\u00d7';
      close.addEventListener('click', () => {
        pendingAttachments.splice(idx, 1);
        renderAttachmentChips();
      });
      chip.appendChild(close);
      attachmentsEl.appendChild(chip);
    });
  }

  function renderAttachmentPreview(list) {
    if (!list || list.length === 0) return '';
    const items = list.map((a) => {
      const name = escapeHtml(a.name || '');
      const icon = a.kind === 'image'
        ? '<svg class="attach-chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
        : '<svg class="attach-chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      return `<span class="attach-chip">${icon}<span class="attach-chip-name">${name}</span></span>`;
    }).join('');
    return `<div class="msg-attachments">${items}</div>`;
  }

  function createMarkdownRenderer() {
    const factory = typeof window !== 'undefined' ? window.markdownit : undefined;
    if (typeof factory !== 'function') return null;

    const renderer = factory({
      html: false,
      breaks: true,
      linkify: true,
      typographer: true
    });

    const fallbackLinkOpen = renderer.renderer.rules.link_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

    renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
      return fallbackLinkOpen(tokens, idx, options, env, self);
    };

    return renderer;
  }

  const markdownRenderer = createMarkdownRenderer();

  // -------- Markdown (safe, improved) --------
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderInline(src) {
    if (!src) return '';
    let s = escapeHtml(src);

    const codeSpans = [];
    s = s.replace(/`([^`\n]+)`/g, (_, code) => {
      const token = `\u0000INL${codeSpans.length}\u0000`;
      codeSpans.push(`<code>${code}</code>`);
      return token;
    });

    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?=[^*]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^a-zA-Z0-9])_([^_\n]+?)_(?=[^a-zA-Z0-9]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    s = s.replace(/\u0000INL(\d+)\u0000/g, (_, i) => codeSpans[Number(i)] || '');
    return s;
  }

  function parseTable(lines) {
    if (lines.length < 2) return null;
    const header = lines[0].trim();
    const divider = lines[1].trim();
    if (!header.includes('|')) return null;
    if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(divider)) return null;

    const splitRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const headers = splitRow(header);
    const body = lines.slice(2).map(splitRow).filter((r) => r.length > 0);

    const thead = `<thead><tr>${headers.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
    const tbody = body.length
      ? `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
      : '';
    return `<table>${thead}${tbody}</table>`;
  }

  function renderMarkdown(src) {
    if (!src) return '';
    if (markdownRenderer) {
      return markdownRenderer.render(src);
    }

    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      const codeOpen = line.match(/^```([a-zA-Z0-9_+\-]*)\s*$/);
      if (codeOpen) {
        const lang = codeOpen[1] || '';
        i += 1;
        const codeLines = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
        out.push('<hr/>');
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
        continue;
      }

      const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
      if (ulMatch) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*]\s+(.+)$/);
          if (!m) break;
          items.push(`<li>${renderInline(m[1])}</li>`);
          i += 1;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
      if (olMatch) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*\d+\.\s+(.+)$/);
          if (!m) break;
          items.push(`<li>${renderInline(m[1])}</li>`);
          i += 1;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      if (trimmed.includes('|') && i + 1 < lines.length) {
        const tableLines = [];
        let k = i;
        while (k < lines.length && lines[k].trim() && lines[k].includes('|')) {
          tableLines.push(lines[k]);
          k += 1;
        }
        const table = parseTable(tableLines);
        if (table) {
          out.push(table);
          i = k;
          continue;
        }
      }

      const para = [];
      while (i < lines.length && lines[i].trim()) {
        if (/^(#{1,3})\s+/.test(lines[i])) break;
        if (/^\s*```/.test(lines[i])) break;
        if (/^\s*>\s?/.test(lines[i])) break;
        if (/^\s*[-*]\s+/.test(lines[i])) break;
        if (/^\s*\d+\.\s+/.test(lines[i])) break;
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) break;
        para.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br/>')}</p>`);
    }

    return out.join('\n');
  }

  // -------- DOM helpers --------
  function hideHero() {
    const hero = document.getElementById('hero');
    if (hero && hero.parentNode) hero.parentNode.removeChild(hero);
  }
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function appendMessage(role, contentHtml) {
    hideHero();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent = role === 'user' ? '› You' : role === 'assistant' ? '✻ Yamakawa' : '⚠ Error';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = contentHtml;
    wrap.appendChild(roleEl);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return { wrap, body };
  }

  function startAssistantMessage() {
    const { wrap, body } = appendMessage('assistant', '<span class="cursor"></span>');
    activeAssistantEl = wrap;
    activeAssistantBody = body;
    activeAssistantText = '';
    pendingChunks = '';
    setStreaming(true);
  }

  function renderActiveAssistant(showCursor) {
    if (!activeAssistantBody) return;
    const html = renderMarkdown(activeAssistantText);
    activeAssistantBody.innerHTML = html + (showCursor ? '<span class="cursor"></span>' : '');
    scrollToBottom();
  }

  function finishAssistant() {
    if (activeAssistantBody) {
      activeAssistantText += pendingChunks;
      pendingChunks = '';
      renderActiveAssistant(false);
    }
    activeAssistantEl = null;
    activeAssistantBody = null;
    activeAssistantText = '';
    if (typingTimer) { clearInterval(typingTimer); typingTimer = 0; }
    setStreaming(false);
  }

  function updatePrimaryButton() {
    if (!sendBtn) return;
    if (isStreaming) {
      sendBtn.classList.add('stop-btn');
      sendBtn.title = 'Stop';
      sendBtn.setAttribute('aria-label', 'Stop generation');
      sendBtn.innerHTML = stopIcon;
      return;
    }

    sendBtn.classList.remove('stop-btn');
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.innerHTML = sendIcon;
  }

  function setStreaming(streaming) {
    isStreaming = streaming;
    updatePrimaryButton();
    if (statusbarEl) statusbarEl.classList.toggle('busy', streaming);
    if (statusInfoEl) statusInfoEl.textContent = streaming ? 'generating…' : 'ready';
    inputEl.disabled = false;
  }

  function startTypingLoop() {
    if (typingTimer) return;
    typingTimer = window.setInterval(() => {
      if (!activeAssistantBody) return;
      if (pendingChunks.length === 0) return;
      const take = Math.max(1, Math.ceil(pendingChunks.length / 6));
      const piece = pendingChunks.slice(0, take);
      pendingChunks = pendingChunks.slice(take);
      activeAssistantText += piece;
      renderActiveAssistant(true);
    }, 18);
  }

  // -------- Composer --------
  function autoresize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }
  inputEl.addEventListener('input', autoresize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  formEl.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  sendBtn.addEventListener('click', () => {
    if (isStreaming) {
      vscode.postMessage({ type: 'abort' });
      return;
    }
    submit();
  });
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  }
  if (attachBtn) {
    attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  }

  function submit() {
    if (isStreaming) return;
    const text = inputEl.value.trim();
    if (!text && pendingAttachments.length === 0) return;

    if (text === '/clear') {
      inputEl.value = ''; autoresize();
      vscode.postMessage({ type: 'clear' });
      return;
    }
    if (text === '/settings') {
      inputEl.value = ''; autoresize();
      vscode.postMessage({ type: 'openSettings' });
      return;
    }
    if (text === '/help') {
      inputEl.value = ''; autoresize();
      appendMessage('assistant', renderMarkdown([
        '**Yamakawa Code — quick help**',
        '',
        '- `/clear` — clear the conversation',
        '- `/settings` — open extension settings',
        '- Click the 📎 icon to attach images or text files',
        '- `Enter` send · `Shift+Enter` newline',
        '- Toggle `yamakawaCode.workspaceTools` to let the AI read/write project files.'
      ].join('\n')));
      return;
    }

    const attachments = pendingAttachments.slice();
    pendingAttachments = [];
    renderAttachmentChips();

    inputEl.value = '';
    autoresize();
    vscode.postMessage({ type: 'send', text, attachments });
  }

  // -------- Inbound messages --------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hydrate': {
        messagesEl.innerHTML = '';
        if (Array.isArray(msg.history) && msg.history.length > 0) {
          for (const m of msg.history) {
            if (m.role === 'user') appendMessage('user', escapeHtml(m.content));
            else if (m.role === 'assistant') appendMessage('assistant', renderMarkdown(m.content));
          }
        } else {
          ensureHero();
        }
        break;
      }
      case 'userMessage': {
        const attachHtml = renderAttachmentPreview(msg.attachments);
        appendMessage('user', attachHtml + escapeHtml(msg.content || ''));
        break;
      }
      case 'assistantStart':
        startAssistantMessage();
        startTypingLoop();
        break;
      case 'assistantDelta':
        pendingChunks += msg.delta || '';
        startTypingLoop();
        break;
      case 'assistantDone':
        finishAssistant();
        break;
      case 'error':
        appendMessage('error', escapeHtml(msg.message || 'Unknown error'));
        finishAssistant();
        break;
      case 'cleared':
        messagesEl.innerHTML = '';
        ensureHero();
        break;
      case 'focusInput':
        inputEl.focus();
        break;
      case 'themeUpdate':
        applyTheme(msg.theme || {});
        applyRuntimeStatus(msg.status || {});
        break;
      case 'runtimeStatus':
        applyRuntimeStatus(msg.status || {});
        break;
      case 'attachmentsPicked':
        if (Array.isArray(msg.attachments)) {
          for (const a of msg.attachments) {
            pendingAttachments.push({ kind: a.kind, name: a.name, mime: a.mime, data: a.data });
          }
          renderAttachmentChips();
          inputEl.focus();
        }
        break;
      case 'toolResult':
        if (Array.isArray(msg.summary)) {
          const lines = msg.summary.map((s) => `> ${s.ok ? '\u2713' : '\u2717'} **${s.name}** \u2014 ${s.snippet || ''}`).join('\n');
          if (lines) appendMessage('assistant', renderMarkdown(lines));
        }
        break;
    }
  });

  function applyTheme(t) {
    let style = document.getElementById('theme-vars');
    if (!style) {
      style = document.createElement('style');
      style.id = 'theme-vars';
      document.head.appendChild(style);
    }
    const lines = [':root {'];
    if (t.accent) lines.push(`--yk-accent: ${t.accent};`);
    if (t.background) lines.push(`--yk-bg: ${t.background};`);
    if (t.foreground) lines.push(`--yk-fg: ${t.foreground};`);
    if (t.muted) lines.push(`--yk-muted: ${t.muted};`);
    if (t.border) lines.push(`--yk-border: ${t.border};`);
    if (t.fontFamily) lines.push(`--yk-font: ${t.fontFamily};`);
    lines.push('}');
    style.textContent = lines.join('\n');
  }

  function ensureHero() {
    if (document.getElementById('hero')) return;
    const hero = document.createElement('div');
    hero.className = 'hero';
    hero.id = 'hero';
    const logo = document.body.getAttribute('data-logo');
    const logoHtml = logo
      ? `<img class="hero-logo hero-logo-img" src="${logo}" alt="Yamakawa Code" />`
      : '<div class="hero-star" aria-hidden="true">✻</div>';
    const model = statusModelEl ? statusModelEl.textContent || '' : '';
    hero.innerHTML =
      `<div class="hero-banner">${logoHtml}` +
      `<div class="hero-text">` +
      `<div class="hero-title">Welcome to <span class="brand">Yamakawa Code</span></div>` +
      `<div class="hero-sub">/help for help, /clear to reset · ${escapeHtml(model)}</div>` +
      `</div></div>` +
      `<ul class="tips">` +
      `<li><span class="tip-key">Enter</span><span>send message</span></li>` +
      `<li><span class="tip-key">Shift+Enter</span><span>new line</span></li>` +
      `<li><span class="tip-key">/clear</span><span>clear the conversation</span></li>` +
      `<li><span class="tip-key">/settings</span><span>open extension settings</span></li>` +
      `</ul>`;
    messagesEl.appendChild(hero);
  }

  vscode.postMessage({ type: 'ready' });
  updatePrimaryButton();
  autoresize();
  inputEl.focus();
})();
