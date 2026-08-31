'use strict';
// A DOM small enough to read in one sitting, faithful enough to run the real app.js.
//
// This used to be a flat Map of isolated <div>s, one per id scraped out of index.html with a
// regex. That was enough to exercise anything app.js reached by getElementById, and nothing
// else — elements had no parents, no children, and no classes from the markup, so
// querySelectorAll had nothing to return and was stubbed to []. Both loops in
// setupDisplayToggle/updateToggleStyles iterate querySelectorAll('button'), so the listener's
// display toggle was never actually tested: every assertion about it passed vacuously because
// the loop body never ran. The toggle's buttons carry no ids at all — they're addressed by
// data-mode — so no amount of id-scraping would have found them.
//
// Hence a real (small) parser. Elements now come out of index.html with their true classes,
// nesting, and data-* attributes, which also means views start hidden because the markup says
// so rather than because app.js got around to hiding them.
//
// What this deliberately is NOT: there is no layout, no styling, no event dispatch, and no
// network. It cannot catch a button that reflows when its label changes, or a write that
// races a page unload. Those need a device and a real Firebase; see CLAUDE.md.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => x && this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  toString() { return [...this.set].join(' '); }
}

class El {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this._text = '';
    this._class = '';
    this.classList = new ClassList(this);
  }

  get className() { return this._class; }
  set className(v) {
    this._class = String(v);
    this.classList.set = new Set(this._class.split(/\s+/).filter(Boolean));
  }

  // Real textContent is every descendant's text in document order. Own text is accumulated
  // as it is encountered during parsing, so a node that interleaves text and elements
  // reports them grouped rather than interleaved — close enough, and nothing asserts on it.
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.children.forEach((c) => { c.parent = null; });
    this.children = [];
    this._text = String(v);
  }

  get firstElementChild() { return this.children[0] || null; }

  get innerHTML() { return this._html || ''; }
  // Parsed rather than merely stored, so an element written in as markup (the speaker's
  // empty-state hint is the live case) really enters the tree and can be found by id and
  // removed later, exactly as it would in a browser.
  set innerHTML(v) {
    this._html = String(v);
    this.children.forEach((c) => { c.parent = null; });
    this.children = [];
    this._text = '';
    parseInto(this._html, this);
  }

  appendChild(c) { c.parent = this; this.children.push(c); return c; }

  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    this.parent = null;
  }

  setAttribute(k, v) {
    if (k === 'class') this.className = v;
    else if (k === 'id') this.id = v;
    else this[k] = v;
  }

  addEventListener() {}

  matches(sel) { return matchesSelector(this, sel); }

  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matchesSelector(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  closest(sel) {
    let el = this;
    while (el) {
      if (matchesSelector(el, sel)) return el;
      el = el.parent;
    }
    return null;
  }
}

// Only the three selector forms app.js actually uses. Anything else throws rather than
// quietly returning nothing — a silently-empty selector is what hid the toggle bug for
// this long, and a loud failure is cheap to fix when someone adds a new selector.
function matchesSelector(el, sel) {
  const s = String(sel).trim();
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) return el.tagName === s.toUpperCase();
  if (/^\.[-\w]+$/.test(s)) return el.classList.contains(s.slice(1));
  if (/^#[-\w]+$/.test(s)) return el.id === s.slice(1);
  throw new Error(`domshim: unsupported selector ${JSON.stringify(sel)} — teach matchesSelector about it`);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function parseAttrs(el, str) {
  if (!str) return;
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    const name = m[1];
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if (name === 'class') el.className = value;
    else if (name === 'id') el.id = value;
    else if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      el.dataset[key] = value;
    } else el[name] = value;
  }
}

// Tolerant of the things a hand-written page contains and a spec-compliant parser would
// fuss over: stray close tags, implicit closes, unquoted attributes. It is parsing one
// known file, not the open web.
function parseInto(html, root) {
  const src = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let last = 0;
  let m;

  const addText = (raw) => {
    const text = decodeEntities(raw).replace(/\s+/g, ' ');
    if (text.trim()) stack[stack.length - 1]._text += text;
  };

  while ((m = tagRe.exec(src))) {
    addText(src.slice(last, m.index));
    last = tagRe.lastIndex;

    const [, closing, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();

    if (closing) {
      // Unwind to the nearest matching open tag; ignore a close with no opener.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }

    const el = new El(tag);
    parseAttrs(el, attrs);
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
  }
  addText(src.slice(last));
  return root;
}

// `html` is the full text of index.html. Every element it declares exists here with its real
// nesting, classes and data-attributes — including the ones with no id.
function makeDoc(html) {
  const documentElement = new El('html');
  parseInto(html, documentElement);

  const byId = (id) => {
    let found = null;
    const walk = (el) => {
      for (const c of el.children) {
        if (found) return;
        if (c.id === id) { found = c; return; }
        walk(c);
      }
    };
    walk(documentElement);
    return found;
  };

  return {
    documentElement,
    getElementById: (id) => byId(id),
    createElement: (t) => new El(t),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    querySelector: (sel) => documentElement.querySelector(sel),
    addEventListener: () => {},
  };
}

module.exports = { makeDoc, El, parseInto };
