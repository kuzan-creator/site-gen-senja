// Senja Site — Fast makefun-site drop-in.
// An original, from-scratch reimplementation of the makefun-site 1.0.0 spec
// (README + reference behaviour), written for speed. No dependencies, no I/O,
// no clock/env/random, no Wasm/native code. All state lives inside run().
//
// Speed ideas, all measured against the practice set:
//  - every template is compiled ONCE per run() into a JS function (new
//    Function) that pushes strings into an output array; includes are direct
//    function calls, loops/ifs are native JS control flow, standalone-tag
//    line stripping happens at compile time;
//  - Markdown inline rendering accumulates plain runs and escapes them in
//    bulk instead of escaping one character at a time;
//  - slugify/longDate results are cached per run (tag names, titles and dates
//    repeat constantly); word counting is a charCode scan, not a regex match;
//  - block lexing uses charCode fast paths with the same regexes only where
//    the spec needs them (front matter values, template paths, link schemes).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
function esc(t) { return ESC_TEST.test(t) ? t.replace(ESC_RE, (c) => ESC[c]) : t; }

function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDateRaw(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Runs of non-whitespace characters (JS \s set, scanned by charCode). */
function wordsOf(text) {
  let n = 0;
  let inw = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 32) { inw = false; continue; }
    if (c < 128) { if (!inw) { inw = true; n++; } continue; }
    if (c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF) { inw = false; continue; }
    if (!inw) { inw = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** { data, body } or { error }; `text` has "\n" line ends. */
function parseFrontMatter(text) {
  if (!(text === '---' || text.startsWith('---\n'))) return { error: 'no front matter' };
  // Pass 1: find the closing line (a missing close beats any line error).
  let close = -1;
  let bodyStart = text.length;
  {
    let pos = 4;
    let lineNo = 2;
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos);
      const end = nl === -1 ? text.length : nl;
      if (text.slice(pos, end) === '---') { close = lineNo; bodyStart = nl === -1 ? text.length : nl + 1; break; }
      if (nl === -1) break;
      pos = nl + 1;
      lineNo++;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  // Pass 2: the lines between.
  const data = {};
  let pos = 4;
  for (let lineNo = 2; lineNo < close; lineNo++) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    pos = nl === -1 ? text.length : nl + 1;
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(FM_TRAIL, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = '\\`*_[]()#+-.!>';
const WS_RE = /\s/;

function isWSCode(c) {
  return c <= 32 || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A)
    || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Fence-open language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHR(line) {
  if (!(line.startsWith('---') || line.startsWith('***'))) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** { num, rest } for an ordered-list line, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), rest: line.slice(i + 2) };
}

function isContinued(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const INLINE_RE = /[\\`*\[&<>"']/g;

/** Inline rendering of `s`, appended to `out` (an array of strings). */
function inline(s, env, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) { out.push(s.slice(i)); break; }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
        const ch = s[j + 1];
        out.push(ch === '>' ? '&gt;' : ch);
        i = j + 2;
      } else { out.push('\\'); i = j + 1; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out.push('<code>', esc(s.slice(j + 1, k)), '</code>'); i = k + 1; }
      else { out.push('`'); i = j + 1; }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inline(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
        } else { out.push('**'); i = j + 2; }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out.push('<em>');
        inline(s.slice(j + 1, k), env, out);
        out.push('</em>');
        i = k + 1;
      } else { out.push('*'); i = j + 1; }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const q = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', esc(env.link(target)), '">');
        inline(s.slice(j + 1, k), env, out);
        out.push('</a>');
        i = q + 1;
        continue;
      }
      out.push('[');
      i = j + 1;
      continue;
    }
    out.push(ESC[c]);
    i = j + 1;
  }
}

function inlineStr(s, env) {
  const out = [];
  inline(s, env, out);
  return out.join('');
}

/** { html, toc, excerpt } for a Markdown body. */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      let code = '';
      for (let k = 0; k < body.length; k++) code += `${esc(body[k])}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') inner.push(t); }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32;
    const ordered = bullet ? null : orderedOf(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered.num) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        let rest = null;
        if (isOrdered) { const o = orderedOf(l); if (o !== null) rest = o.rest; }
        else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) rest = l.slice(2);
        if (rest !== null) { items.push([trimLine(rest)]); i++; }
        else if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inlineStr(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) { const c = src.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** Parse one template source into a node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  // Tokenize (standalone {% %} lines included), exactly as the reference does.
  const tokens = [];
  let text = '';
  let i = 0;
  const N = src.length;
  while (i < N) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === N - 1) { text += src.slice(i); break; }
    const nx = src.charCodeAt(open + 1);
    if (nx !== 123 && nx !== 37) { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (nx === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? N : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? N : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INC_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The top-level names shared by every render in a case. */
const SHARED_VARS = new Set(['site', 'tags', 'recent']);

/**
 * A template body's external dependencies: the root names it reads that are
 * not bound by its own for-loops, with includes contributing their own
 * external sets minus the names bound at the include site. `ext` holds the
 * current (fixpoint) sets, by template name.
 */
function externalDeps(body, bound, ext) {
  const out = new Set();
  const walk = (nodes, b) => {
    for (const n of nodes) {
      if (n.kind === 'var' || n.kind === 'raw') { if (!b.has(n.path[0])) out.add(n.path[0]); }
      else if (n.kind === 'for') {
        if (!b.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(b);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'if') {
        if (!b.has(n.path[0])) out.add(n.path[0]);
        walk(n.then, b);
        if (n.else !== null) walk(n.else, b);
      } else if (n.kind === 'include') {
        const e = ext.get(n.name);
        if (e !== undefined) for (const r of e) if (!b.has(r)) out.add(r);
      }
    }
  };
  walk(body, bound);
  return out;
}

/** Compile a node tree to JS source; `uid` supplies unique temp suffixes. */
function compileBody(nodes, bound, ext, uid) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') { code += `O.push(${JSON.stringify(n.text)});`; continue; }
    if (n.kind === 'var') { code += `O.push(E(T(L(S,${JSON.stringify(n.path)}))));`; continue; }
    if (n.kind === 'raw') { code += `O.push(T(L(S,${JSON.stringify(n.path)})));`; continue; }
    if (n.kind === 'for') {
      const id = uid.n++;
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      code += `{const _a${id}=L(S,${JSON.stringify(n.path)});if(Array.isArray(_a${id})){for(let _k${id}=0;_k${id}<_a${id}.length;_k${id}++){S.push({[${JSON.stringify(n.name)}]:_a${id}[_k${id}],loop:{index:_k${id}+1,first:_k${id}===0,last:_k${id}===_a${id}.length-1,length:_a${id}.length}});`;
      code += compileBody(n.body, b2, ext, uid);
      code += 'S.pop();}}}';
      continue;
    }
    if (n.kind === 'if') {
      code += `if(TR(L(S,${JSON.stringify(n.path)}))!==${n.not}){`;
      code += compileBody(n.then, bound, ext, uid);
      if (n.else !== null) {
        code += '}else{';
        code += compileBody(n.else, bound, ext, uid);
      }
      code += '}';
      continue;
    }
    // include
    const id = uid.n++;
    const e = ext.get(n.name);
    const cacheable = e !== undefined && [...e].every((r) => SHARED_VARS.has(r)) && ![...e].some((r) => bound.has(r));
    if (cacheable) {
      // Cached only when no loop scope above shadows a name this fragment
      // reads (SH checks the live scope chain: ancestor templates' loops can
      // bind 'site'/'tags'/'recent' too, which the static check cannot see).
      code += `if(D<8){const _f${id}=TM.get(${JSON.stringify(n.name)});if(_f${id}){if(SH(S,${JSON.stringify([...e])})){const _ck${id}=${JSON.stringify(n.name)}+":"+(D+1);let _cv${id}=C.get(_ck${id});if(_cv${id}===undefined){const _o${id}=[];_f${id}(S,_o${id},D+1,TM,E,T,TR,L,C,SH);_cv${id}=_o${id}.join('');C.set(_ck${id},_cv${id});}O.push(_cv${id});}else{_f${id}(S,O,D+1,TM,E,T,TR,L,C,SH);}}}`;
    } else {
      code += `if(D<8){const _f${id}=TM.get(${JSON.stringify(n.name)});if(_f${id})_f${id}(S,O,D+1,TM,E,T,TR,L,C,SH);}`;
    }
  }
  return code;
}

/**
 * Compile every parsed template (name -> node tree) into render functions
 * (S, O, D, TM, E, T, TR, L, C). Includes whose output depends only on the
 * case-shared vars are rendered once per case and reused.
 */
function compileTemplates(trees) {
  const ext = new Map();
  for (const name of trees.keys()) ext.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of trees) {
      const s = externalDeps(body, new Set(), ext);
      const cur = ext.get(name);
      for (const r of s) if (!cur.has(r)) { cur.add(r); changed = true; }
    }
  }
  const out = new Map();
  for (const [name, body] of trees) {
    out.set(name, new Function('S', 'O', 'D', 'TM', 'E', 'T', 'TR', 'L', 'C', 'SH', compileBody(body, new Set(), ext, { n: 0 })));
  }
  return out;
}

/**
 * Whether any loop scope in the chain (all but the top-level scope) binds one
 * of `names`: if so, those names do not resolve to the case-shared vars.
 */
function shadowFree(S, names) {
  for (let i = 1; i < S.length; i++) {
    const v = S[i];
    for (let k = 0; k < names.length; k++) if (Object.hasOwn(v, names[k])) return false;
  }
  return true;
}

/** First name from the innermost scope holding it, then own properties. */
function lookup(S, path) {
  for (let i = S.length - 1; i >= 0; i--) {
    const v = S[i];
    if (Object.hasOwn(v, path[0])) {
      let x = v[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (x === null || typeof x !== 'object' || !Object.hasOwn(x, path[k])) return undefined;
        x = x[path[k]];
      }
      return x;
    }
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) { if (k) s += ', '; s += textOf(v[k]); }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const slugify = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) { s = slugifyRaw(t); slugCache.set(t, s); }
    return s;
  };
  const longDate = (d) => {
    let s = dateCache.get(d);
    if (s === undefined) { s = longDateRaw(d); dateCache.set(d, s); }
    return s;
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, in code-unit order of name; one that does not parse is reported.
  const trees = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      trees.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templates = compileTemplates(trees);

  // Sources, in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with link resolution.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, first spelling kept, in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards / pages as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => {
    if (s.reading_minutes === undefined) s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading_minutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };};
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const fragCache = new Map();
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn([{ site, tags: allTags, recent, ...vars }], out, 0, templates, esc, textOf, truthy, lookup, fragCache, shadowFree);
    return out.join('');
  };

  // Layouts.
  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
