// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Written fresh from the dialect description (DESIGN.md) and the vendor
// README. Node 22 standard library only. Fully deterministic: no clock,
// no randomness, no iteration over unordered structures.
//
// Export: run(input) -> { outputPath: text, ... } for one case.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dateLong(d) {
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

// ---------------------------------------------------------------- slugs

const NON_ASCII_RE = /[^\x00-\x7F]/;
const COMBINING_RE = /\p{M}/gu;
const NON_ALNUM_RUN_RE = /[^a-z0-9]+/g;
function slugify(text) {
  let s = text;
  if (NON_ASCII_RE.test(s)) s = s.normalize('NFKD').replace(COMBINING_RE, '');
  s = s.toLowerCase().replace(NON_ALNUM_RUN_RE, '-');
  if (s.startsWith('-')) s = s.slice(1);
  if (s.endsWith('-')) s = s.slice(0, -1);
  if (s.length > 64) {
    s = s.slice(0, 64);
    if (s.endsWith('-')) s = s.slice(0, -1);
  }
  return s === '' ? 'untitled' : s;
}

// ------------------------------------------------------------ text utils

function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isWSCode(c) {
  return c <= 32 || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// Word count over the raw body lines: runs of non-whitespace characters.
function countWords(lines) {
  let count = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      if (isWSCode(line.charCodeAt(i))) inWord = false;
      else if (!inWord) { inWord = true; count++; }
    }
  }
  return count;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------- front matter

const KNOWN_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
const KEY_RE = /^[a-z_]+$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = +value.slice(0, 4);
  const m = +value.slice(5, 7);
  const d = +value.slice(8, 10);
  if (y < 1970 || y > 2099 || m < 1 || m > 12) return false;
  let dim = DAYS_IN_MONTH[m - 1];
  if (m === 2 && isLeap(y)) dim = 29;
  return d >= 1 && d <= dim;
}

// Parse a title/summary value: quoted ("..." with only \" and \\ escapes)
// or bare (anything not opening on " or [). A quoted string must close at
// the very end of the value; inside, a stray unescaped quote is its own
// error, and any other escape is another. Returns { value } or { error }.
function parseStringValue(value) {
  if (value.charCodeAt(0) === 34) {
    if (value.length < 2 || value.charCodeAt(value.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < value.length - 1; i++) {
      const c = value[i];
      if (c === '\\') {
        const nx = value[i + 1];
        if (nx !== '"' && nx !== '\\') return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (value.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value };
}

function parseTagsValue(value) {
  if (value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = value.slice(1, -1);
  if (inner === '') return { value: [] };
  const parts = inner.split(',');
  const tags = [];
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i].trim();
    if (name === '' || name.indexOf('"') >= 0 || name.indexOf('[') >= 0 || name.indexOf(']') >= 0) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(name);
  }
  return { value: tags };
}

// Validate one key's value. Returns { value } or { error }. Key-specific
// validation errors are prefixed with `key "<k>": `.
function validateKeyValue(key, value) {
  if (key === 'title' || key === 'summary') {
    const r = parseStringValue(value);
    if (r.error) return { error: 'key "' + key + '": ' + r.error };
    return r;
  }
  if (key === 'date') {
    if (!validateDate(value)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value };
  }
  if (key === 'tags') return parseTagsValue(value);
  if (key === 'draft') {
    if (value === 'true') return { value: true };
    if (value === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!/^[a-z0-9-]+$/.test(value)) return { error: 'key "layout": not a template name' };
    return { value };
  }
  if (key === 'slug') {
    if (value.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) return { error: 'key "slug": not a slug' };
    return { value };
  }
  return { value };
}

// Parse the front-matter lines (indices 1..closeIdx-1 of lines; line 1 is
// the opening ---). Returns { fm } or { error }.
function parseFrontMatter(lines, closeIdx) {
  const fm = {};
  const seen = new Set();
  for (let idx = 1; idx < closeIdx; idx++) {
    const line = lines[idx];
    const n = idx + 1;
    if (isBlank(line)) continue;
    if (line.charCodeAt(0) === 35) continue; // '#': comment
    const colon = line.indexOf(':');
    if (colon < 0) return { error: 'line ' + n + ' is not "key: value"' };
    const key = line.slice(0, colon);
    if (!KEY_RE.test(key)) return { error: 'line ' + n + ' is not "key: value"' };
    const rest = line.slice(colon + 1);
    if (rest !== '' && rest.charCodeAt(0) !== 32) return { error: 'line ' + n + ' is not "key: value"' };
    let value = rest === '' ? '' : rest.slice(1);
    value = value.replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { error: 'key "' + key + '" is given twice' };
    if (value === '') return { error: 'key "' + key + '" has no value' };
    seen.add(key);
    const checked = validateKeyValue(key, value);
    if (checked.error) return { error: checked.error };
    fm[key] = checked.value;
  }
  if (!seen.has('title')) return { error: 'no title' };
  return { fm };
}

// ------------------------------------------------------------ inline md

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const TRIGGER_RE = /[\\`*[]/;

function inlineParse(s, ctx) {
  if (!TRIGGER_RE.test(s)) return esc(s);
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        if (i > start) out += esc(s.slice(start, i));
        out += nx === '>' ? '&gt;' : nx;
        i += 2;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out += esc(s.slice(start, i));
        out += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const close = findStrongClose(s, i);
        if (close >= 0) {
          if (i > start) out += esc(s.slice(start, i));
          out += '<strong>' + inlineParse(s.slice(i + 2, close), ctx) + '</strong>';
          i = close + 2;
          start = i;
          continue;
        }
        i += 2;
        continue;
      }
      const close = findEmClose(s, i);
      if (close >= 0) {
        if (i > start) out += esc(s.slice(start, i));
        out += '<em>' + inlineParse(s.slice(i + 1, close), ctx) + '</em>';
        i = close + 1;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const link = tryLink(s, i, ctx);
      if (link !== null) {
        if (i > start) out += esc(s.slice(start, i));
        out += link.html;
        i = link.end;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (start < n) out += esc(s.slice(start));
  return out;
}

// Find the closer for a strong opener at i ('**'): the first unescaped
// '**' pair after the opener. A pair that is immediately adjacent (zero
// characters between) makes the opener fail outright — the search does not
// look for a later pair. Escaped asterisks are skipped. Returns the closer
// index or -1.
function findStrongClose(s, i) {
  const n = s.length;
  let j = i + 2;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '*' && s[j + 1] === '*') {
      if (j === i + 2) return -1;
      return j;
    }
    j++;
  }
  return -1;
}

// Find the closer for an emphasis opener at i (single '*'). A '**' pair
// counts as one strong delimiter and is skipped as a unit; an escaped
// asterisk is skipped. Returns the closer index or -1.
function findEmClose(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '*') {
      if (s[j + 1] === '*') { j += 2; continue; }
      return j;
    }
    j++;
  }
  return -1;
}

function tryLink(s, i, ctx) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === ']') break;
    j++;
  }
  if (j >= n) return null;
  if (s[j + 1] !== '(') return null;
  const k = s.indexOf(')', j + 2);
  if (k < 0) return null;
  const target = s.slice(j + 2, k);
  if (target === '' || /\s/.test(target)) return null;
  const text = inlineParse(s.slice(i + 1, j), ctx);
  const href = resolveLink(target, ctx);
  return { html: '<a href="' + esc(href) + '">' + text + '</a>', end: k + 1 };
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolvePath(dir, p) {
  const segs = [];
  if (dir !== '') {
    const dparts = dir.split('/');
    for (let i = 0; i < dparts.length; i++) segs.push(dparts[i]);
  }
  const parts = p.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '' || part === '.') continue;
    if (part === '..') { if (segs.length > 0) segs.pop(); continue; }
    segs.push(part);
  }
  return segs.join('/');
}

function resolveLink(target, ctx) {
  if (SCHEME_RE.test(target)) return target;
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return target; // '/' or '#'
  const hashIdx = target.indexOf('#');
  const pathPart = hashIdx < 0 ? target : target.slice(0, hashIdx);
  const frag = hashIdx < 0 ? null : target.slice(hashIdx + 1);
  const resolved = resolvePath(ctx.sourceDir, pathPart);
  const pageUrl = ctx.pageUrls.get(resolved);
  if (pageUrl !== undefined) return frag === null ? pageUrl : pageUrl + '#' + frag;
  if (ctx.staticPaths.has(resolved)) {
    const href = (ctx.base ? ctx.base + '/' : '/') + resolved;
    return frag === null ? href : href + '#' + frag;
  }
  const key = ctx.sourcePath + '\0' + target;
  if (!ctx.brokenSeen.has(key)) {
    ctx.brokenSeen.add(key);
    ctx.report.push('broken-link ' + ctx.sourcePath + ' -> ' + target);
  }
  return target;
}

// ------------------------------------------------------------ block md

function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const n = line.length;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function matchHeading(line) {
  let hashes = 0;
  while (hashes < 6 && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0) return null;
  if (hashes === 6 && line.charCodeAt(6) === 35) return null;
  const c = line.charCodeAt(hashes);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(line.slice(hashes));
  if (text === '') return null;
  return { level: hashes, text };
}

function isBreak(line) {
  if (line === '---' || line === '***') return true;
  if (line.startsWith('---') || line.startsWith('***')) {
    for (let k = 3; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return false;
}

// Returns { kind: 'ul'|'ol', num, text } or null.
function matchListMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { kind: 'ul', num: 0, text: trimST(line.slice(2)) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 1;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { kind: 'ol', num: parseInt(line.slice(0, j), 10), text: trimST(line.slice(j + 2)) };
    }
  }
  return null;
}

function isContinuation(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length;
}

function renderMarkdown(lines, ctx) {
  const out = [];
  let excerpt = '';
  let hasParagraph = false;
  const toc = [];
  const usedIds = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      let body = '';
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        body += esc(lines[i]) + '\n';
        i++;
      }
      if (i < n) i++;
      out.push('<pre><code' + (lang !== '' ? ' class="language-' + lang + '"' : '') + '>' + body + '</code></pre>\n');
      continue;
    }
    const h = matchHeading(line);
    if (h !== null) {
      let id = slugify(h.text);
      if (usedIds.has(id)) {
        let k = 2;
        while (usedIds.has(id + '-' + k)) k++;
        id = id + '-' + k;
      }
      usedIds.add(id);
      const html = inlineParse(h.text, ctx);
      if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html });
      out.push('<h' + h.level + ' id="' + id + '">' + html + '</h' + h.level + '>\n');
      i++;
      continue;
    }
    if (isBreak(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimST(t);
        if (t !== '') parts.push(t);
        i++;
      }
      const inner = parts.join('\n');
      out.push('<blockquote>\n' + (inner === '' ? '' : '<p>' + inlineParse(inner, ctx) + '</p>\n') + '</blockquote>\n');
      continue;
    }
    const lm = matchListMarker(line);
    if (lm !== null) {
      const kind = lm.kind;
      const items = [];
      let cur = lm.text;
      const firstNum = lm.num;
      i++;
      while (i < n) {
        const l2 = lines[i];
        if (isBlank(l2)) break;
        const m2 = matchListMarker(l2);
        if (m2 !== null) {
          if (m2.kind !== kind) break;
          items.push(cur);
          cur = m2.text;
          i++;
          continue;
        }
        if (isContinuation(l2)) { cur += '\n' + trimST(l2); i++; continue; }
        break;
      }
      items.push(cur);
      let html = kind === 'ul' ? '<ul>\n' : (firstNum === 1 ? '<ol>\n' : '<ol start="' + firstNum + '">\n');
      for (let q = 0; q < items.length; q++) html += '<li>' + inlineParse(items[q], ctx) + '</li>\n';
      html += kind === 'ul' ? '</ul>\n' : '</ol>\n';
      out.push(html);
      continue;
    }
    const plines = [trimST(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      if (isBlank(l2)) break;
      if (fenceLang(l2) !== null) break;
      if (matchHeading(l2) !== null) break;
      if (isBreak(l2)) break;
      plines.push(trimST(l2));
      i++;
    }
    const phtml = inlineParse(plines.join('\n'), ctx);
    if (!hasParagraph) { excerpt = phtml; hasParagraph = true; }
    out.push('<p>' + phtml + '</p>\n');
  }
  return { html: out.join(''), excerpt, toc };
}

// -------------------------------------------------------------- templates

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INCLUDE_NAME_RE = /^"[a-z0-9-]+"$/;

function parsePath(text) {
  if (text === '') return null;
  const parts = text.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!NAME_RE.test(parts[i])) return null;
  }
  return parts;
}

function processTag(content, stack) {
  const parts = content.split(' ');
  const head = parts[0];
  const cur = () => stack[stack.length - 1].list;
  if (head === 'if') {
    let neg = false;
    let pathText;
    if (parts.length === 2) {
      pathText = parts[1];
    } else if (parts.length === 3 && parts[1] === 'not') {
      neg = true;
      pathText = parts[2];
    } else {
      return '{% ' + content + ' %} is not a tag';
    }
    const path = parsePath(pathText);
    if (path === null) return JSON.stringify(pathText) + ' is not a path';
    const node = { t: 'if', path, neg, then: [], els: null };
    cur().push(node);
    stack.push({ node, list: node.then, kind: 'if' });
    return null;
  }
  if (head === 'for') {
    if (parts.length !== 4 || parts[2] !== 'in') return '{% ' + content + ' %} is not a tag';
    if (!NAME_RE.test(parts[1])) return '{% ' + content + ' %} is not a tag';
    const path = parsePath(parts[3]);
    if (path === null) return JSON.stringify(parts[3]) + ' is not a path';
    const node = { t: 'for', varName: parts[1], path, body: [] };
    cur().push(node);
    stack.push({ node, list: node.body, kind: 'for' });
    return null;
  }
  if (head === 'include') {
    if (parts.length !== 2 || !INCLUDE_NAME_RE.test(parts[1])) return '{% ' + content + ' %} is not a tag';
    cur().push({ t: 'include', name: parts[1].slice(1, -1) });
    return null;
  }
  if (head === 'endfor' && parts.length === 1) {
    if (stack[stack.length - 1].kind !== 'for') return 'an endfor with no open for';
    stack.pop();
    return null;
  }
  if (head === 'endif' && parts.length === 1) {
    if (stack[stack.length - 1].kind !== 'if') return 'an endif with no open if';
    stack.pop();
    return null;
  }
  if (head === 'else' && parts.length === 1) {
    const top = stack[stack.length - 1];
    if (top.kind !== 'if' || top.node.els !== null) return 'an else outside an if';
    top.node.els = [];
    top.list = top.node.els;
    return null;
  }
  return '{% ' + content + ' %} is not a tag';
}

// Parse a template source into a node tree. Returns { nodes } or { error }.
//
// Two phases, matching the reference's error precedence:
//   Pass 1 — scan the source left to right, validating every substitution's
//   closure and path, and every {% %} tag's closure. A substitution error
//   beats any tag error, whatever its position; an unclosed {% %} beats a
//   later substitution error because the scan meets it first. Tag contents
//   are recorded here, not validated.
//   Pass 2 — walk the recorded tokens in order, validating each tag's
//   shape and path and the if/for block structure.
function parseTemplate(src) {
  const flat = [];
  let i = 0;
  let textStart = 0;
  const n = src.length;
  while (i < n) {
    const jSub = src.indexOf('{{', i);
    const jTag = src.indexOf('{%', i);
    if (jSub < 0 && jTag < 0) break;
    let j;
    let isTag;
    if (jTag < 0 || (jSub >= 0 && jSub < jTag)) { j = jSub; isTag = false; } else { j = jTag; isTag = true; }
    if (!isTag) {
      const raw = src.charCodeAt(j + 2) === 123;
      const close = raw ? '}}}' : '}}';
      const closeIdx = src.indexOf(close, j + (raw ? 3 : 2));
      if (closeIdx < 0) return { error: raw ? 'a {{{ is not closed' : 'a {{ is not closed' };
      const content = trimST(src.slice(j + (raw ? 3 : 2), closeIdx));
      const path = parsePath(content);
      if (path === null) return { error: JSON.stringify(content) + ' is not a path' };
      if (j > textStart) flat.push({ t: 'text', s: src.slice(textStart, j) });
      flat.push({ t: raw ? 'raw' : 'esc', path });
      i = closeIdx + close.length;
      textStart = i;
      continue;
    }
    const closeIdx = src.indexOf('%}', j + 2);
    if (closeIdx < 0) return { error: 'a {% is not closed' };
    const content = trimST(src.slice(j + 2, closeIdx));
    const afterClose = closeIdx + 2;
    const lineStart = src.lastIndexOf('\n', j - 1) + 1;
    let lineEnd = src.indexOf('\n', afterClose);
    if (lineEnd < 0) lineEnd = n;
    let standalone = true;
    for (let k = lineStart; k < j; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = afterClose; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) {
      if (lineStart > textStart) flat.push({ t: 'text', s: src.slice(textStart, lineStart) });
      i = lineEnd < n ? lineEnd + 1 : n;
      textStart = i;
    } else {
      if (j > textStart) flat.push({ t: 'text', s: src.slice(textStart, j) });
      i = afterClose;
      textStart = i;
    }
    flat.push({ t: 'tag', content });
  }
  if (n > textStart) flat.push({ t: 'text', s: src.slice(textStart) });
  return buildTree(flat);
}

// Pass 2: build the node tree from the flat token list, validating tag
// shapes, tag paths and block structure in token order.
function buildTree(flat) {
  const root = [];
  const stack = [{ node: null, list: root, kind: 'root' }];
  for (let fi = 0; fi < flat.length; fi++) {
    const tok = flat[fi];
    if (tok.t === 'tag') {
      const err = processTag(tok.content, stack);
      if (err) return { error: err };
    } else {
      stack[stack.length - 1].list.push(tok);
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 'for' ? 'a for is not closed' : 'a if is not closed' };
  }
  return { nodes: root };
}

function isFalsy(v) {
  return !v || (Array.isArray(v) && v.length === 0);
}

function lookup(scope, names) {
  const first = names[0];
  let v;
  let found = false;
  for (let f = scope.frames.length - 1; f >= 0; f--) {
    const fr = scope.frames[f];
    if (first === 'loop') { v = fr.loop; found = true; break; }
    if (fr.varName === first) { v = fr.value; found = true; break; }
  }
  if (!found) {
    if (Object.prototype.hasOwnProperty.call(scope.root, first)) {
      v = scope.root[first];
      found = true;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < names.length; k++) {
    if (v === null || typeof v !== 'object') return undefined;
    const name = names[k];
    if (!Object.prototype.hasOwnProperty.call(v, name)) return undefined;
    v = v[name];
  }
  return v;
}

function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += writeValue(v[i]);
    }
    return s;
  }
  return '';
}

const EMPTY_ARR = [];

function renderNodes(nodes, scope, depth, templates, outArr) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    if (node.t === 'text') { outArr.push(node.s); continue; }
    if (node.t === 'esc') { outArr.push(esc(writeValue(lookup(scope, node.path)))); continue; }
    if (node.t === 'raw') { outArr.push(writeValue(lookup(scope, node.path))); continue; }
    if (node.t === 'if') {
      const truthy = !isFalsy(lookup(scope, node.path));
      const take = node.neg ? !truthy : truthy;
      renderNodes(take ? node.then : (node.els || EMPTY_ARR), scope, depth, templates, outArr);
      continue;
    }
    if (node.t === 'for') {
      const v = lookup(scope, node.path);
      if (Array.isArray(v)) {
        const len = v.length;
        for (let idx = 0; idx < len; idx++) {
          scope.frames.push({
            varName: node.varName,
            value: v[idx],
            loop: { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len },
          });
          renderNodes(node.body, scope, depth, templates, outArr);
          scope.frames.pop();
        }
      }
      continue;
    }
    if (node.t === 'include') {
      if (depth < 8) {
        const tpl = templates.get(node.name);
        if (tpl !== undefined) renderNodes(tpl.nodes, scope, depth + 1, templates, outArr);
      }
      continue;
    }
  }
}

function renderTemplate(tpl, root, templates) {
  const outArr = [];
  renderNodes(tpl.nodes, { root, frames: [] }, 0, templates, outArr);
  return outArr.join('');
}

// ------------------------------------------------------------------ build

function dedupTags(names) {
  const seen = new Set();
  const tags = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    tags.push({ name, slug });
  }
  return tags;
}

export function run(input) {
  const site = input.site;
  let base = site.base_url;
  if (base.endsWith('/')) base = base.replace(/\/+$/, '');
  const report = [];
  const brokenSeen = new Set();

  // Templates, parsed once per case in code-unit order of name.
  const templates = new Map();
  const templateNames = Object.keys(input.templates).sort();
  for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    const parsed = parseTemplate(input.templates[name]);
    if (parsed.error) report.push('template "' + name + '": ' + parsed.error);
    else templates.set(name, parsed);
  }

  // Files, sorted by path in code-unit order.
  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      let content = f.content;
      if (content.indexOf('\r') >= 0) content = content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, content });
    } else {
      statics.push(f);
    }
  }

  // Front matter and refusal checks, in source order.
  const pages = [];
  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    const lines = src.content.split('\n');
    if (lines[0] !== '---') { report.push('refused ' + src.path + ': no front matter'); continue; }
    let closeIdx = -1;
    for (let k = 1; k < lines.length; k++) {
      if (lines[k] === '---') { closeIdx = k; break; }
    }
    if (closeIdx < 0) { report.push('refused ' + src.path + ': the front matter is not closed'); continue; }
    const parsed = parseFrontMatter(lines, closeIdx);
    if (parsed.error) { report.push('refused ' + src.path + ': ' + parsed.error); continue; }
    const fm = parsed.fm;
    const isPost = src.path.startsWith('posts/');
    if (src.path.startsWith('tags/')) { report.push('refused ' + src.path + ": tags/ is the generator's own"); continue; }
    if (src.path.startsWith('page/')) { report.push('refused ' + src.path + ": page/ is the generator's own"); continue; }
    if (isPost && fm.date === undefined) { report.push('refused ' + src.path + ': a post needs a date'); continue; }
    const layoutName = fm.layout !== undefined ? fm.layout : (isPost ? 'post' : 'page');
    if (!templates.has(layoutName)) { report.push('refused ' + src.path + ': layout "' + layoutName + '" is no template that parses'); continue; }
    if (fm.draft === true) { report.push('draft ' + src.path); continue; }
    pages.push({ path: src.path, fm, bodyLines: lines.slice(closeIdx + 1), isPost, layoutName });
  }

  // Slugs and permalinks, in source order.
  const takenByDir = new Map();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const dir = page.isPost ? 'posts' : dirOf(page.path);
    const rawSlug = page.fm.slug !== undefined ? page.fm.slug : slugify(page.fm.title);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = dir === '' ? new Set(['posts', 'tags', 'page']) : new Set();
      takenByDir.set(dir, taken);
    }
    let slug = rawSlug;
    if (taken.has(slug)) {
      let k = 2;
      while (taken.has(rawSlug + '-' + k)) k++;
      slug = rawSlug + '-' + k;
    }
    taken.add(slug);
    page.slug = slug;
    page.dir = dir;
    page.outPath = (dir === '' ? '' : dir + '/') + slug + '/index.html';
    page.url = (base ? base + '/' : '/') + (dir === '' ? '' : dir + '/') + slug + '/';
  }

  // Link targets: every built page's source path, and every static path.
  const pageUrls = new Map();
  for (let i = 0; i < pages.length; i++) pageUrls.set(pages[i].path, pages[i].url);
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const linkBase = { pageUrls, staticPaths, base, report, brokenSeen };

  // Render each page's Markdown once.
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const ctx = {
      pageUrls, staticPaths, base, report, brokenSeen,
      sourcePath: page.path, sourceDir: dirOf(page.path),
    };
    const rendered = renderMarkdown(page.bodyLines, ctx);
    page.content = rendered.html;
    page.excerpt = rendered.excerpt;
    page.toc = rendered.toc;
    page.readingMinutes = Math.max(1, Math.ceil(countWords(page.bodyLines) / 200));
    page.ownTags = dedupTags(page.fm.tags || []);
  }

  // Posts collection: newest first, ties by slug.
  const posts = [];
  for (let i = 0; i < pages.length; i++) if (pages[i].isPost) posts.push(pages[i]);
  posts.sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    post.newer = i > 0 ? neighbour(posts[i - 1]) : null;
    post.older = i < posts.length - 1 ? neighbour(posts[i + 1]) : null;
  }

  // Tag registry, walking posts in collection order.
  const registry = new Map();
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    for (let j = 0; j < post.ownTags.length; j++) {
      const t = post.ownTags[j];
      let reg = registry.get(t.slug);
      if (reg === undefined) {
        reg = {
          name: t.name,
          slug: t.slug,
          url: (base ? base + '/' : '/') + 'tags/' + t.slug + '/',
          posts: [],
        };
        registry.set(t.slug, reg);
      }
      reg.posts.push(post);
    }
  }
  const tagList = Array.from(registry.values());
  tagList.sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Cards and page values.
  function makeCard(page) {
    const tags = [];
    for (let j = 0; j < page.ownTags.length; j++) {
      const t = page.ownTags[j];
      const reg = registry.get(t.slug);
      tags.push(reg !== undefined
        ? { name: reg.name, slug: t.slug, url: reg.url }
        : { name: t.name, slug: t.slug, url: '' });
    }
    return {
      title: page.fm.title,
      url: page.url,
      date: page.fm.date !== undefined ? page.fm.date : '',
      date_long: page.fm.date !== undefined ? dateLong(page.fm.date) : '',
      summary: page.fm.summary !== undefined ? page.fm.summary : '',
      excerpt: page.excerpt,
      reading_minutes: page.readingMinutes,
      tags,
    };
  }
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    page.card = makeCard(page);
    page.values = {
      title: page.card.title,
      url: page.card.url,
      date: page.card.date,
      date_long: page.card.date_long,
      summary: page.card.summary,
      excerpt: page.card.excerpt,
      reading_minutes: page.card.reading_minutes,
      tags: page.card.tags,
      slug: page.slug,
      content: page.content,
      toc: page.toc,
      newer: page.isPost ? page.newer : null,
      older: page.isPost ? page.older : null,
      is_post: page.isPost,
    };
  }

  const siteVal = { title: site.title, base_url: base };
  const tagsVal = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentVal = posts.slice(0, site.recent).map((p) => p.card);
  const baseSlash = base ? base + '/' : '/';

  const out = Object.create(null);

  // Content pages through their layout.
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const root = { site: siteVal, tags: tagsVal, recent: recentVal, page: page.values };
    out[page.outPath] = renderTemplate(templates.get(page.layoutName), root, templates);
  }

  // Index pages, paginated.
  if (templates.has('index')) {
    const perPage = site.per_page > 0 ? site.per_page : Infinity;
    const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
    for (let pnum = 1; pnum <= totalPages; pnum++) {
      const pagePosts = posts.slice((pnum - 1) * perPage, pnum * perPage);
      const pager = {
        number: pnum,
        total: totalPages,
        url: pnum === 1 ? baseSlash : baseSlash + 'page/' + pnum + '/',
        newer_url: pnum > 1 ? (pnum === 2 ? baseSlash : baseSlash + 'page/' + (pnum - 1) + '/') : '',
        older_url: pnum < totalPages ? baseSlash + 'page/' + (pnum + 1) + '/' : '',
      };
      const root = {
        site: siteVal, tags: tagsVal, recent: recentVal,
        posts: pagePosts.map((p) => p.card), pager,
      };
      out[pnum === 1 ? 'index.html' : 'page/' + pnum + '/index.html'] =
        renderTemplate(templates.get('index'), root, templates);
    }
  }

  // Tag pages and the tags index.
  if (templates.has('tag')) {
    for (let i = 0; i < tagList.length; i++) {
      const t = tagList[i];
      const root = {
        site: siteVal, tags: tagsVal, recent: recentVal,
        tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
      };
      out['tags/' + t.slug + '/index.html'] = renderTemplate(templates.get('tag'), root, templates);
    }
  }
  if (templates.has('tags')) {
    const root = { site: siteVal, tags: tagsVal, recent: recentVal };
    out['tags/index.html'] = renderTemplate(templates.get('tags'), root, templates);
  }

  // Static files, unless a built page has their path.
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.prototype.hasOwnProperty.call(out, f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      out[f.path] = f.content;
    }
  }

  // The report: sorted lines, then the summary; every line ends in \n.
  report.sort();
  report.push('built ' + (pages.length - posts.length) + ' pages, ' + posts.length +
    ' posts, ' + tagList.length + ' tags and ' + statics.length + ' static files');
  out['build-report.txt'] = report.join('\n') + '\n';
  return out;
}

function neighbour(p) {
  return { title: p.fm.title, url: p.url, date: p.fm.date, date_long: dateLong(p.fm.date) };
}
