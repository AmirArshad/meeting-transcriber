'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRICT_DOMPURIFY_CONFIG,
  formatCitationPillLabel,
  formatCitationSeconds,
  renderGroundedMarkdown,
} = require('../../src/renderer/markdown-render-helpers');

function createMockDocument(fillTemplate = null) {
  class MockNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
    }

    appendChild(child) {
      if (child.nodeType === 11) {
        for (const nested of [...child.childNodes]) {
          this.appendChild(nested);
        }
        child.childNodes = [];
        return child;
      }
      if (child.parentNode) {
        const idx = child.parentNode.childNodes.indexOf(child);
        if (idx !== -1) child.parentNode.childNodes.splice(idx, 1);
      }
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }

    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }

    replaceChild(newChild, oldChild) {
      const idx = this.childNodes.indexOf(oldChild);
      if (idx === -1) return oldChild;
      oldChild.parentNode = null;
      if (newChild.nodeType === 11) {
        const items = [...newChild.childNodes];
        newChild.childNodes = [];
        for (const item of items) item.parentNode = this;
        this.childNodes.splice(idx, 1, ...items);
      } else {
        newChild.parentNode = this;
        this.childNodes.splice(idx, 1, newChild);
      }
      return oldChild;
    }

    replaceChildren(...nodes) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      this.append(...nodes);
    }
  }

  class MockText extends MockNode {
    constructor(value) {
      super(3);
      this.nodeValue = String(value);
    }
  }

  class MockFragment extends MockNode {
    constructor() {
      super(11);
    }

    querySelectorAll(selector) {
      const tag = String(selector || '').toUpperCase();
      const out = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1 && child.tagName === tag) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
  }

  class MockElement extends MockNode {
    constructor(tagName) {
      super(1);
      this.tagName = String(tagName || '').toUpperCase();
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.title = '';
      this.type = '';
      this._listeners = {};
      this.content = this.tagName === 'TEMPLATE' ? new MockFragment() : null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }

    set textContent(val) {
      this.replaceChildren(new MockText(val));
    }

    get textContent() {
      return this.childNodes
        .map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent))
        .join('');
    }

    set innerHTML(html) {
      // Minimal <p>...</p> parser for unit testing citation upgrading.
      const target = this.tagName === 'TEMPLATE' ? this.content : this;
      target.replaceChildren();
      if (fillTemplate) {
        fillTemplate(target, createElement, createTextNode);
        return;
      }
      const p = new MockElement('p');
      p.appendChild(new MockText(String(html).replace(/^<p>|<\/p>$/g, '')));
      target.appendChild(p);
    }

    querySelectorAll(selector) {
      const tag = String(selector || '').toUpperCase();
      const out = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1 && child.tagName === tag) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
  }

  const createElement = (tag) => new MockElement(tag);
  const createTextNode = (text) => new MockText(text);
  return {
    createElement,
    createTextNode,
    createDocumentFragment: () => new MockFragment(),
  };
}

test('STRICT_DOMPURIFY_CONFIG remains strict and immutable', () => {
  assert.equal(Object.isFrozen(STRICT_DOMPURIFY_CONFIG), true);
  assert.deepEqual(STRICT_DOMPURIFY_CONFIG.ALLOWED_ATTR, []);
  assert.equal(STRICT_DOMPURIFY_CONFIG.ALLOW_DATA_ATTR, false);
  assert.equal(STRICT_DOMPURIFY_CONFIG.ALLOW_ARIA_ATTR, false);
  for (const tag of ['script', 'style', 'iframe', 'svg', 'a', 'img', 'button']) {
    assert.ok(STRICT_DOMPURIFY_CONFIG.FORBID_TAGS.includes(tag), `FORBID_TAGS must include ${tag}`);
  }
});

test('formatCitationPillLabel renders timestamp, Summary for untimed summary citations, and compact titles', () => {
  assert.equal(formatCitationSeconds(862), '14:22');
  assert.equal(formatCitationSeconds(3665), '1:01:05');

  assert.equal(
    formatCitationPillLabel({ meetingTitle: 'Q4 Planning', startSec: 862, kind: 'transcript' }),
    'Q4 Planning · 14:22',
  );
  assert.equal(
    formatCitationPillLabel({ meetingTitle: 'Q4 Planning', startSec: null, kind: 'summary' }),
    'Q4 Planning · Summary',
  );
  assert.equal(
    formatCitationPillLabel({ meetingTitle: 'Q4 Planning', kind: 'Summary' }),
    'Q4 Planning · Summary',
  );
  assert.equal(
    formatCitationPillLabel({ meetingTitle: 'Q4 Planning', startSec: 45, kind: 'summary' }),
    'Q4 Planning · 00:45',
  );
  assert.equal(
    formatCitationPillLabel({ meetingTitle: 'Q4 Planning', startSec: null, kind: 'transcript' }),
    'Q4 Planning',
  );
  assert.equal(
    formatCitationPillLabel({
      meetingTitle: 'A Very Long Recording Title That Exceeds Thirty Four Characters',
      startSec: null,
      kind: 'summary',
    }),
    'A Very Long Recording Title That… · Summary',
  );
});

test('renderGroundedMarkdown deduplicates adjacent identical citation pills and labels summary pills', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const markedLib = { parse: (md) => `<p>${md}</p>` };
  const domPurifyLib = { sanitize: (html, cfg) => { assert.equal(cfg, STRICT_DOMPURIFY_CONFIG); return html; } };

  const citations = [
    { evidenceId: 'E1', meetingId: 'm1', meetingTitle: 'Song Demo', startSec: 11, kind: 'transcript' },
    { evidenceId: 'E2', meetingId: 'm1', meetingTitle: 'Song Demo', startSec: 11, kind: 'transcript' },
    { evidenceId: 'E3', meetingId: 'm1', meetingTitle: 'Song Demo', startSec: 45, kind: 'transcript' },
    { evidenceId: 'E4', meetingId: 'm2', meetingTitle: 'Design Review', startSec: null, kind: 'summary' },
  ];

  renderGroundedMarkdown(
    container,
    'Verse one [E1][E1] [E2] transitions to verse two [E3]. Repeated later [E1]. Summary says [E4] [E4].',
    citations,
    { markedLib, domPurifyLib, documentObj: doc },
  );

  const buttons = container.querySelectorAll('button');
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    [
      'Song Demo · 00:11',
      'Song Demo · 00:45',
      'Song Demo · 00:11',
      'Design Review · Summary',
    ],
  );
  assert.equal(buttons[3].dataset.kind, 'summary');
  assert.equal(buttons[3].title, 'Open Design Review summary');

  // Verify no double spaces left where duplicate pills were dropped.
  const p = container.querySelectorAll('p')[0];
  assert.equal(
    p.textContent,
    'Verse one Song Demo · 00:11 transitions to verse two Song Demo · 00:45. Repeated later Song Demo · 00:11. Summary says Design Review · Summary.',
  );
});


test('deduplicates across inline formatting and preserves precise timestamps and block boundaries', () => {
  const doc = createMockDocument((root, element, text) => {
    const paragraph = element('p');
    const emphasis = element('strong');
    emphasis.append(text('[E1]'));
    paragraph.append(text('[E1] '), emphasis, text(' [E2]'), text(' [E3]'));
    const code = element('code');
    code.append(text('[E3]'));
    paragraph.append(code, text('[E3]'), element('br'), text('[E3]'));
    const nextParagraph = element('p');
    nextParagraph.append(text('[E3]'));
    root.append(paragraph, nextParagraph);
  });
  const container = doc.createElement('div');
  const citations = [11.1, 11.9, '11.9'].map((startSec, i) => ({
    evidenceId: `E${i + 1}`, meetingId: 'm1', startSec, kind: 'transcript',
  }));

  renderGroundedMarkdown(container, '[E1] **[E1]** [E2] [E3]`[E3]`[E3]<br>[E3]\n\n[E3]', citations, {
    markedLib: { parse: (markdown) => markdown },
    domPurifyLib: { sanitize: (html, config) => { assert.equal(config, STRICT_DOMPURIFY_CONFIG); return html; } },
    documentObj: doc,
  });

  assert.deepEqual(container.querySelectorAll('button').map((button) => button.dataset.evidenceId),
    ['E1', 'E2', 'E3', 'E3', 'E3']);
  assert.deepEqual(container.querySelectorAll('button').slice(0, 2).map((button) => button.dataset.startSec),
    ['11.1', '11.9']);
  assert.equal(container.querySelectorAll('code')[0].textContent, '[E3]');
});
