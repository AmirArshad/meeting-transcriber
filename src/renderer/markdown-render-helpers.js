(function initMarkdownRenderHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.markdownRenderHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildMarkdownRenderHelpers() {
  const STRICT_DOMPURIFY_CONFIG = Object.freeze({
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'code',
      'pre',
      'ul',
      'ol',
      'li',
      'blockquote',
      'h1',
      'h2',
      'h3',
      'h4',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'hr',
      'del',
    ],
    ALLOWED_ATTR: [],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'svg',
      'math',
      'a',
      'img',
      'button',
      'input',
      'textarea',
      'select',
      'form',
      'link',
      'meta',
      'base',
    ],
    FORBID_ATTR: [
      'style',
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onfocus',
      'href',
      'src',
      'class',
      'id',
    ],
  });

  const CITATION_TOKEN_RE = /\[(E\d+)\]/g;

  function formatCitationSeconds(startSec) {
    if (startSec === null || startSec === undefined || startSec === '' || typeof startSec === 'boolean') {
      return '';
    }
    const num = Number(startSec);
    if (!Number.isFinite(num) || num < 0) {
      return '';
    }
    const total = Math.floor(num);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatCitationPillLabel(citation) {
    const title = String(citation && citation.meetingTitle ? citation.meetingTitle : 'Recording').trim() || 'Recording';
    const compactTitle = title.length > 34 ? `${title.slice(0, 33).trimEnd()}…` : title;
    const ts = formatCitationSeconds(citation ? citation.startSec : null);
    return ts ? `${compactTitle} · ${ts}` : compactTitle;
  }

  function buildCitationMap(verifiedCitations) {
    const map = new Map();
    if (!Array.isArray(verifiedCitations)) {
      return map;
    }
    for (const item of verifiedCitations) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const evidenceId = String(item.evidenceId || '').trim();
      const meetingId = String(item.meetingId || '').trim();
      if (!evidenceId || !meetingId) {
        continue;
      }
      map.set(evidenceId, item);
    }
    return map;
  }

  function sanitizeMarkdownHtml(markdownText, { markedLib, domPurifyLib } = {}) {
    const raw = String(markdownText == null ? '' : markdownText);
    const markedImpl = markedLib || (typeof globalThis !== 'undefined' ? globalThis.marked : null);
    const purifyImpl = domPurifyLib || (typeof globalThis !== 'undefined' ? globalThis.DOMPurify : null);

    if (!markedImpl || !purifyImpl || typeof purifyImpl.sanitize !== 'function') {
      return null;
    }

    let html = '';
    if (typeof markedImpl.Marked === 'function') {
      const instance = new markedImpl.Marked({
        gfm: true,
        breaks: true,
        async: false,
      });
      html = String(instance.parse(raw) || '');
    } else if (typeof markedImpl.parse === 'function') {
      html = String(markedImpl.parse(raw, { gfm: true, breaks: true, async: false }) || '');
    } else {
      return null;
    }

    return String(purifyImpl.sanitize(html, STRICT_DOMPURIFY_CONFIG) || '');
  }

  function isInsideCodeElement(node) {
    let cursor = node && node.parentNode;
    while (cursor) {
      const tag = String(cursor.tagName || '').toUpperCase();
      if (tag === 'CODE' || tag === 'PRE') {
        return true;
      }
      cursor = cursor.parentNode;
    }
    return false;
  }

  function upgradeCitationTextNodes(rootNode, citationMap, doc, onCitationClick) {
    const textNodes = [];
    const showText = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT) ? NodeFilter.SHOW_TEXT : 4;
    if (typeof doc.createTreeWalker === 'function') {
      const walker = doc.createTreeWalker(rootNode, showText, null);
      let current = walker.nextNode();
      while (current) {
        if (!isInsideCodeElement(current) && current.nodeValue && current.nodeValue.includes('[')) {
          textNodes.push(current);
        }
        current = walker.nextNode();
      }
    }

    for (const textNode of textNodes) {
      const value = String(textNode.nodeValue || '');
      CITATION_TOKEN_RE.lastIndex = 0;
      if (!CITATION_TOKEN_RE.test(value)) {
        continue;
      }
      CITATION_TOKEN_RE.lastIndex = 0;

      const fragment = doc.createDocumentFragment();
      let cursor = 0;
      let match = CITATION_TOKEN_RE.exec(value);
      while (match) {
        if (match.index > cursor) {
          fragment.appendChild(doc.createTextNode(value.slice(cursor, match.index)));
        }
        const evidenceId = match[1];
        const citation = citationMap.get(evidenceId);
        if (citation) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'chat-citation-pill';
          btn.dataset.evidenceId = evidenceId;
          btn.dataset.meetingId = String(citation.meetingId);
          const formattedTs = formatCitationSeconds(citation.startSec);
          if (formattedTs) {
            btn.dataset.startSec = String(citation.startSec);
          }
          const label = formatCitationPillLabel(citation);
          btn.textContent = label;
          btn.title = formattedTs
            ? `Open ${citation.meetingTitle || 'recording'} at ${formattedTs}`
            : `Open ${citation.meetingTitle || 'recording'}`;
          btn.setAttribute('aria-label', btn.title);
          if (typeof onCitationClick === 'function') {
            btn.addEventListener('click', () => onCitationClick(citation, btn));
          }
          fragment.appendChild(btn);
        }
        cursor = match.index + match[0].length;
        match = CITATION_TOKEN_RE.exec(value);
      }
      if (cursor < value.length) {
        fragment.appendChild(doc.createTextNode(value.slice(cursor)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    }
  }

  function enhanceCodeBlocks(rootNode, doc, onCopyCode) {
    const pres = [...rootNode.querySelectorAll('pre')];
    for (const pre of pres) {
      if (!pre.parentNode || pre.parentNode.classList?.contains('chat-code-block')) {
        continue;
      }
      const wrapper = doc.createElement('div');
      wrapper.className = 'chat-code-block';

      const header = doc.createElement('div');
      header.className = 'chat-code-header';

      const langLabel = doc.createElement('span');
      langLabel.className = 'chat-code-lang';
      langLabel.textContent = 'Snippet';

      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'chat-code-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy snippet');
      copyBtn.addEventListener('click', async () => {
        const codeText = String(pre.textContent || '');
        try {
          if (typeof onCopyCode === 'function') {
            await onCopyCode(codeText, copyBtn);
          } else if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(codeText);
          }
          copyBtn.textContent = 'Copied';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1600);
        } catch (_error) {
          copyBtn.textContent = 'Copy failed';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1600);
        }
      });

      header.append(langLabel, copyBtn);
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.append(header, pre);
    }
  }

  function renderGroundedMarkdown(
    container,
    markdownText,
    verifiedCitations = [],
    {
      markedLib = null,
      domPurifyLib = null,
      documentObj = null,
      onCitationClick = null,
      onCopyCode = null,
    } = {},
  ) {
    const doc = documentObj || (typeof document !== 'undefined' ? document : null);
    if (!container || !doc) {
      return container;
    }
    container.replaceChildren();

    const sanitizedHtml = sanitizeMarkdownHtml(markdownText, { markedLib, domPurifyLib });
    if (sanitizedHtml === null) {
      // Fail-closed plain text fallback if libraries are unavailable.
      const fallback = doc.createElement('p');
      fallback.textContent = String(markdownText == null ? '' : markdownText);
      container.appendChild(fallback);
      return container;
    }

    const template = doc.createElement('template');
    template.innerHTML = sanitizedHtml;

    const citationMap = buildCitationMap(verifiedCitations);
    upgradeCitationTextNodes(template.content, citationMap, doc, onCitationClick);
    enhanceCodeBlocks(template.content, doc, onCopyCode);

    container.appendChild(template.content);
    return container;
  }

  return {
    STRICT_DOMPURIFY_CONFIG,
    buildCitationMap,
    formatCitationPillLabel,
    formatCitationSeconds,
    renderGroundedMarkdown,
    sanitizeMarkdownHtml,
  };
}));
