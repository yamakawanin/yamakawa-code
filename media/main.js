// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById('messages'));
  const formEl = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sendBtn'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stopBtn'));
  const settingsBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('settingsBtn'));
  const statusbarEl = /** @type {HTMLElement} */ (document.getElementById('statusbar'));
  const statusModelEl = /** @type {HTMLElement} */ (document.getElementById('statusModel'));
  const statusInfoEl = /** @type {HTMLElement} */ (document.getElementById('statusInfo'));

  /** @type {HTMLElement | null} */ let activeAssistantEl = null;
  /** @type {HTMLElement | null} */ let activeAssistantBody = null;
  let activeAssistantText = '';
  let pendingChunks = '';
  let typingTimer = 0;
  let isStreaming = false;

  // -------- Markdown (minimal, safe) --------
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(src) {
    if (!src) return '';
    const codeBlocks = [];
    let s = src.replace(/```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const token = `\u0000CODE${codeBlocks.length}\u0000`;
      const escaped = escapeHtml(code.replace(/\n$/, ''));
      codeBlocks.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escaped}</code></pre>`);
      return token;
    });

    s = escapeHtml(s);

    s = s.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    s = s.replace(/^---$/gm, '<hr/>');
    s = s.replace(/(^|\n)&gt;\s?(.*?)(?=\n|$)/g, '$1<blockquote>$2</blockquote>');
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s_])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    s = s.replace(/(?:^|\n)((?:[-*]\s.+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split(/\n/)
        .map((l) => l.replace(/^[-*]\s+/, ''))
        .map((l) => `<li>${l}</li>`).join('');
      return `\n<ul>${items}</ul>`;
    });
    s = s.replace(/(?:^|\n)((?:\d+\.\s.+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split(/\n/)
        .map((l) => l.replace(/^\d+\.\s+/, ''))
        .map((l) => `<li>${l}</li>`).join('');
      return `\n<ol>${items}</ol>`;
    });

    const blocks = s.split(/\n{2,}/).map((b) => {
      const t = b.trim();
      if (!t) return '';
      if (/^<(h\d|ul|ol|pre|blockquote|hr)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br/>')}</p>`;
    });
    s = blocks.join('\n');
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)] || '');
    return s;
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

  function setStreaming(streaming) {
    isStreaming = streaming;
    if (sendBtn) sendBtn.hidden = streaming;
    if (stopBtn) stopBtn.hidden = !streaming;
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
  stopBtn.addEventListener('click', () => { vscode.postMessage({ type: 'abort' }); });
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  }

  function submit() {
    if (isStreaming) return;
    const text = inputEl.value.trim();
    if (!text) return;

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
        '- `Enter` send · `Shift+Enter` newline',
        '- Click the ⚙ icon next to the input to open settings any time.'
      ].join('\n')));
      return;
    }

    inputEl.value = '';
    autoresize();
    vscode.postMessage({ type: 'send', text });
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
      case 'userMessage':
        appendMessage('user', escapeHtml(msg.content));
        break;
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
        if (msg.status && statusModelEl) statusModelEl.textContent = msg.status.model || '';
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
  autoresize();
  inputEl.focus();
})();
