// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById('messages'));
  const emptyStateEl = document.getElementById('emptyState');
  const formEl = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sendBtn'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stopBtn'));

  /** @type {HTMLElement | null} */
  let activeAssistantEl = null;
  /** @type {HTMLElement | null} */
  let activeAssistantBody = null;
  let activeAssistantText = '';
  let pendingChunks = '';
  let typingTimer = 0;
  let isStreaming = false;

  // -------- Markdown (minimal, safe) --------

  /** @param {string} s */
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** @param {string} src */
  function renderMarkdown(src) {
    if (!src) return '';
    /** @type {string[]} */
    const codeBlocks = [];
    let s = src.replace(/```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const token = `\u0000CODE${codeBlocks.length}\u0000`;
      const escaped = escapeHtml(code.replace(/\n$/, ''));
      codeBlocks.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escaped}</code></pre>`
      );
      return token;
    });

    // Escape remaining HTML
    s = escapeHtml(s);

    // Headings
    s = s.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule
    s = s.replace(/^---$/gm, '<hr/>');

    // Blockquote
    s = s.replace(/(^|\n)&gt;\s?(.*?)(?=\n|$)/g, '$1<blockquote>$2</blockquote>');

    // Inline code
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);

    // Bold + italic
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s_])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');

    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    // Lists (very lightweight)
    s = s.replace(/(?:^|\n)((?:[-*]\s.+(?:\n|$))+)/g, (_, block) => {
      const items = block
        .trim()
        .split(/\n/)
        .map((/** @type {string} */ l) => l.replace(/^[-*]\s+/, ''))
        .map((/** @type {string} */ l) => `<li>${l}</li>`)
        .join('');
      return `\n<ul>${items}</ul>`;
    });
    s = s.replace(/(?:^|\n)((?:\d+\.\s.+(?:\n|$))+)/g, (_, block) => {
      const items = block
        .trim()
        .split(/\n/)
        .map((/** @type {string} */ l) => l.replace(/^\d+\.\s+/, ''))
        .map((/** @type {string} */ l) => `<li>${l}</li>`)
        .join('');
      return `\n<ol>${items}</ol>`;
    });

    // Paragraphs / line breaks
    const blocks = s.split(/\n{2,}/).map((b) => {
      const t = b.trim();
      if (!t) return '';
      if (/^<(h\d|ul|ol|pre|blockquote|hr)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br/>')}</p>`;
    });
    s = blocks.join('\n');

    // Restore code blocks
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)] || '');
    return s;
  }

  // -------- DOM helpers --------

  function hideEmptyState() {
    if (emptyStateEl && emptyStateEl.parentNode) {
      emptyStateEl.parentNode.removeChild(emptyStateEl);
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** @param {'user' | 'assistant' | 'error'} role
   *  @param {string} contentHtml */
  function appendMessage(role, contentHtml) {
    hideEmptyState();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent =
      role === 'user' ? 'You' : role === 'assistant' ? 'Yamakawa' : 'Error';
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
      // flush any remaining chunks
      activeAssistantText += pendingChunks;
      pendingChunks = '';
      renderActiveAssistant(false);
    }
    activeAssistantEl = null;
    activeAssistantBody = null;
    activeAssistantText = '';
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = 0;
    }
    setStreaming(false);
  }

  function setStreaming(streaming) {
    isStreaming = streaming;
    if (sendBtn) sendBtn.hidden = streaming;
    if (stopBtn) stopBtn.hidden = !streaming;
    inputEl.disabled = false;
  }

  function startTypingLoop() {
    if (typingTimer) return;
    typingTimer = window.setInterval(() => {
      if (!activeAssistantBody) return;
      if (pendingChunks.length === 0) {
        // keep cursor blinking only
        return;
      }
      // Emit a chunk of characters per tick for a smooth typewriter feel
      const take = Math.max(1, Math.ceil(pendingChunks.length / 6));
      const piece = pendingChunks.slice(0, take);
      pendingChunks = pendingChunks.slice(take);
      activeAssistantText += piece;
      renderActiveAssistant(true);
    }, 18);
  }

  // -------- Composer behavior --------

  function autoresize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
  }

  inputEl.addEventListener('input', autoresize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'abort' });
  });

  function submit() {
    if (isStreaming) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autoresize();
    vscode.postMessage({ type: 'send', text });
  }

  // -------- Messages from extension --------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'hydrate': {
        messagesEl.innerHTML = '';
        if (Array.isArray(msg.history) && msg.history.length > 0) {
          for (const m of msg.history) {
            if (m.role === 'user') {
              appendMessage('user', escapeHtml(m.content));
            } else if (m.role === 'assistant') {
              appendMessage('assistant', renderMarkdown(m.content));
            }
          }
        } else {
          // restore empty state
          messagesEl.appendChild(buildEmptyState());
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
        messagesEl.appendChild(buildEmptyState());
        break;
      case 'focusInput':
        inputEl.focus();
        break;
    }
  });

  function buildEmptyState() {
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.id = 'emptyState';
    el.innerHTML =
      '<div class="empty-logo">⌘</div>' +
      '<h2>Yamakawa Code</h2>' +
      "<p>Ask anything. Built for code, powered by an OpenAI-compatible model.</p>";
    return el;
  }

  vscode.postMessage({ type: 'ready' });
  autoresize();
  inputEl.focus();
})();
