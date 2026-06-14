// ============================================================================
//  json-repair.ts — deterministic, string-aware JSON auto-correction.
//
//  repairJson(text) takes human-edited (often-broken) JSON and returns a best-
//  effort *valid* JSON string plus the list of transforms it applied. It is the
//  engine behind the editor's "Auto-fix" button and inline correction hints.
//
//  DESIGN PRINCIPLES (the safety contract — pinned by scripts/test-json-editor.mts)
//  --------------------------------------------------------------------------
//  • PURE + deterministic: same input → same output. No I/O, no globals, no LLM.
//  • NEVER throws. Worst case it returns { ok:false, errors } with text it could
//    not fully fix.
//  • Already-valid JSON is returned BYTE-FOR-BYTE unchanged (changed:false,
//    fixes:[]).
//  • String-aware: every structural transform respects string literals, so a
//    comma / brace / `//` / `True` *inside a string* is never touched.
//  • Minimal correction: transforms run in a fixed order and we re-parse after
//    each one; the moment the text parses, we stop. So a doc that only needs
//    its comments stripped never reaches the riskier missing-comma pass.
//  • NO FABRICATION: we never invent data. Unbalanced braces / truncated input
//    stay invalid (the red squiggle guides the human) — there is deliberately
//    no `wrap_sequence` or `balance_brackets` transform.
//
//  This module has ZERO schema imports (local const vocabs only) so the tsx test
//  script can import it relatively without the `@/` alias.
// ============================================================================

import { parse as jsoncParse, type ParseError, printParseErrorCode } from 'jsonc-parser';

/** The distinct kinds of repair this engine can apply (snake_case, stable). */
export type RepairKind =
  | 'strip_bom'
  | 'strip_block_comment'
  | 'strip_line_comment'
  | 'smart_quote'
  | 'single_quote'
  | 'unquoted_key'
  | 'python_literal'
  | 'js_literal'
  | 'trailing_semicolon'
  | 'trailing_comma'
  | 'missing_comma';

/** One applied transform, for display in the fix log. */
export interface RepairFix {
  kind: RepairKind;
  /** Human-readable, count-bearing summary, e.g. "Removed 2 trailing commas". */
  detail: string;
  /** How many occurrences this transform fixed. */
  count: number;
}

/** A located JSON syntax error (offset + 1-based line/column). */
export interface JsonSyntaxError {
  offset: number;
  length: number;
  line: number;
  column: number;
  code: string;
  message: string;
}

/** Result of a repair attempt. `ok` reflects whether `text` now parses strictly. */
export interface RepairResult {
  /** The repaired text (=== input when already valid or nothing changed). */
  text: string;
  /** Transforms applied, in order. Empty when the input was already valid. */
  fixes: RepairFix[];
  /** True when `text !== input`. */
  changed: boolean;
  /** Does `text` parse as strict JSON (JSON.parse)? */
  ok: boolean;
  /** Located syntax errors when `ok === false`; [] when ok. */
  errors: JsonSyntaxError[];
}

// ---------------------------------------------------------------------------
// Parse oracles (strict JSON.parse for `ok`; jsonc-parser for located errors)
// ---------------------------------------------------------------------------

/** Strict parse. Never throws. */
export function tryParseJson<T = unknown>(
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build an offset→{line,column} resolver for `text` in ONE linear pass, then
 * answer each query with a binary search. Equivalent to a scan-from-0 but O(1)
 * per lookup, so mapping N parse errors is O(n + N log n) instead of O(n²) — the
 * editor's debounced diagnostics over a large invalid layer must never freeze
 * the UI thread (see scripts/test-json-editor.mts §5).
 */
function lineColResolver(text: string): (offset: number) => { line: number; column: number } {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  return (offset: number) => {
    const off = Math.min(Math.max(offset, 0), text.length);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: off - lineStarts[lo]! + 1 };
  };
}

/** Locate JSON syntax errors with offsets + line/column. Never throws. */
export function lintJsonSyntax(text: string): JsonSyntaxError[] {
  const errors: ParseError[] = [];
  try {
    jsoncParse(text, errors, {
      allowTrailingComma: false,
      disallowComments: true,
      allowEmptyContent: false,
    });
  } catch {
    // jsoncParse is itself non-throwing, but stay defensive.
    return [{ offset: 0, length: 0, line: 1, column: 1, code: 'ParseError', message: 'Invalid JSON' }];
  }
  const resolve = lineColResolver(text);
  return errors.map((e) => {
    const { line, column } = resolve(e.offset);
    return {
      offset: e.offset,
      length: e.length,
      line,
      column,
      code: printParseErrorCode(e.error),
      message: `${printParseErrorCode(e.error)} at line ${line}, column ${column}`,
    };
  });
}

// ---------------------------------------------------------------------------
// String-aware scanning core
// ---------------------------------------------------------------------------

/**
 * Mark every character that is part of a JSON string literal (opening +
 * closing quotes included). Handles `"` and `'` delimiters and `\` escapes; an
 * unterminated string masks to end-of-input. Used so structural transforms skip
 * anything inside a string.
 */
function stringMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      mask[i] = true;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      mask[i] = true;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Individual transforms — each returns the new text + a count of changes made.
// A count of 0 means "no change".
// ---------------------------------------------------------------------------

function stripBom(text: string): { text: string; count: number } {
  if (text.charCodeAt(0) === 0xfeff) return { text: text.slice(1), count: 1 };
  return { text, count: 0 };
}

const SMART_QUOTES: Record<string, string> = {
  '“': '"', // left double
  '”': '"', // right double
  '„': '"', // low double
  '″': '"', // double prime
  '‘': "'", // left single
  '’': "'", // right single
  '‚': "'", // low single
  '′': "'", // prime
};

function normalizeSmartQuotes(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/[“”„″‘’‚′]/g, (ch) => {
    count++;
    return SMART_QUOTES[ch]!;
  });
  return { text: out, count };
}

/** Strip `/* … *\/` block comments outside of strings. */
function stripBlockComments(text: string): { text: string; count: number } {
  let out = '';
  let count = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (quote !== null) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '*') {
      count++;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 1; // skip '*'; loop i++ skips '/'
      continue;
    }
    out += c;
  }
  return { text: out, count };
}

/** Strip `//…` line comments outside of strings. */
function stripLineComments(text: string): { text: string; count: number } {
  let out = '';
  let count = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (quote !== null) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      count++;
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += text[i]!; // keep the newline
      continue;
    }
    out += c;
  }
  return { text: out, count };
}

/**
 * Quote bare identifier object keys: `{ foo: 1 }` → `{ "foo": 1 }`. A key is an
 * identifier (incl. `-`/`$`/digits) sitting after `{` or `,` and followed by `:`.
 */
function quoteUnquotedKeys(text: string): { text: string; count: number } {
  let out = '';
  let count = 0;
  let quote: string | null = null;
  let escaped = false;
  let lastStruct = ''; // last significant non-ws char seen outside strings
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      lastStruct = c;
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      continue;
    }
    if ((lastStruct === '{' || lastStruct === ',') && /[A-Za-z_$]/.test(c)) {
      let j = i;
      let ident = '';
      while (j < text.length && /[A-Za-z0-9_$-]/.test(text[j]!)) {
        ident += text[j]!;
        j++;
      }
      let k = j;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text[k] === ':') {
        out += `"${ident}"`;
        count++;
        i = j - 1;
        lastStruct = 'k';
        continue;
      }
      out += ident;
      i = j - 1;
      lastStruct = 'k';
      continue;
    }
    out += c;
    lastStruct = c;
  }
  return { text: out, count };
}

/** Convert single-quoted string tokens to double-quoted, escaping inner `"`. */
function singleToDoubleQuotes(text: string): { text: string; count: number } {
  let out = '';
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      out += c;
      i++;
      let escaped = false;
      while (i < text.length) {
        const d = text[i]!;
        out += d;
        if (escaped) escaped = false;
        else if (d === '\\') escaped = true;
        else if (d === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "'") {
      count++;
      i++;
      let body = '';
      let escaped = false;
      while (i < text.length) {
        const d = text[i]!;
        if (escaped) {
          body += d === "'" ? "'" : `\\${d}`; // `\'` → literal '
          escaped = false;
          i++;
          continue;
        }
        if (d === '\\') {
          escaped = true;
          i++;
          continue;
        }
        if (d === "'") {
          i++;
          break;
        }
        body += d === '"' ? '\\"' : d;
        i++;
      }
      out += `"${body}"`;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, count };
}

/** Replace bare non-JSON literal VALUE tokens (string-aware). */
function replaceLiteral(
  text: string,
  re: RegExp,
  map: Record<string, string>,
): { text: string; count: number } {
  let count = 0;
  const mask = stringMask(text);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    if (mask[start]) continue; // inside a string
    const repl = map[m[0]];
    if (repl === undefined) continue;
    out += text.slice(last, start) + repl;
    last = start + m[0].length;
    count++;
  }
  out += text.slice(last);
  return { text: out, count };
}

const PYTHON_LITERALS: Record<string, string> = { True: 'true', False: 'false', None: 'null' };
function replacePythonLiterals(text: string): { text: string; count: number } {
  return replaceLiteral(text, /\b(?:True|False|None)\b/g, PYTHON_LITERALS);
}

const JS_LITERALS: Record<string, string> = {
  NaN: 'null',
  Infinity: 'null',
  '-Infinity': 'null',
  undefined: 'null',
};
function replaceJsLiterals(text: string): { text: string; count: number } {
  return replaceLiteral(text, /-?\b(?:NaN|Infinity|undefined)\b/g, JS_LITERALS);
}

/** Remove stray `;` outside strings (e.g. trailing JS-style semicolons). */
function stripSemicolons(text: string): { text: string; count: number } {
  const mask = stringMask(text);
  let count = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ';' && !mask[i]) {
      count++;
      continue;
    }
    out += text[i]!;
  }
  return { text: out, count };
}

/** Remove a comma that directly precedes `}` or `]` (string-aware). */
function removeTrailingCommas(text: string): { text: string; count: number } {
  const mask = stringMask(text);
  let count = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',' && !mask[i]) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        count++;
        continue; // drop the comma
      }
    }
    out += text[i]!;
  }
  return { text: out, count };
}

/**
 * Insert missing commas between adjacent values/members. Conservative + string-
 * aware: we walk "units" (a whole string token, a `{`/`[`, or a full value-token
 * run), and when a value-ending unit is followed (after whitespace only) by a
 * value-starting unit, we splice in a comma. Value-token runs are consumed whole
 * so multi-digit numbers like `12` are never split.
 */
function insertMissingCommas(text: string): { text: string; count: number } {
  const mask = stringMask(text);
  let count = 0;
  let out = '';
  let prevSig = ''; // '"' | '}' | ']' | 'v' | '{' | '[' | ',' | ':' | ''
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    // string token
    if (mask[i] && (c === '"' || c === "'")) {
      if (needComma(prevSig, '"')) {
        out += ',';
        count++;
      }
      const q = c;
      out += c;
      i++;
      let escaped = false;
      while (i < text.length) {
        const d = text[i]!;
        out += d;
        if (escaped) escaped = false;
        else if (d === '\\') escaped = true;
        else if (d === q) {
          i++;
          break;
        }
        i++;
      }
      prevSig = '"';
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    if (c === '{' || c === '[') {
      if (needComma(prevSig, c)) {
        out += ',';
        count++;
      }
      out += c;
      prevSig = c;
      i++;
      continue;
    }
    // bare value token run (number / true / false / null / -Infinity / etc.)
    if (/[-+0-9A-Za-z._]/.test(c)) {
      if (needComma(prevSig, 'v')) {
        out += ',';
        count++;
      }
      while (i < text.length && /[-+0-9A-Za-z._]/.test(text[i]!) && !mask[i]) {
        out += text[i]!;
        i++;
      }
      prevSig = 'v';
      continue;
    }
    out += c;
    prevSig = c;
    i++;
  }
  return { text: out, count };

  function needComma(prev: string, next: string): boolean {
    if (prev === '') return false;
    const prevEndsValue = prev === '}' || prev === ']' || prev === '"' || prev === 'v';
    const nextStartsValue = next === '{' || next === '[' || next === '"' || next === 'v';
    return prevEndsValue && nextStartsValue;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const LABELS: Record<RepairKind, (n: number) => string> = {
  strip_bom: () => 'Removed byte-order mark',
  strip_block_comment: (n) => `Stripped ${n} block comment${n === 1 ? '' : 's'}`,
  strip_line_comment: (n) => `Stripped ${n} line comment${n === 1 ? '' : 's'}`,
  smart_quote: (n) => `Normalized ${n} smart quote${n === 1 ? '' : 's'}`,
  single_quote: (n) => `Converted ${n} single-quoted string${n === 1 ? '' : 's'} to double`,
  unquoted_key: (n) => `Quoted ${n} unquoted key${n === 1 ? '' : 's'}`,
  python_literal: (n) => `Replaced ${n} Python literal${n === 1 ? '' : 's'}`,
  js_literal: (n) => `Replaced ${n} non-JSON literal${n === 1 ? '' : 's'}`,
  trailing_semicolon: (n) => `Removed ${n} semicolon${n === 1 ? '' : 's'}`,
  trailing_comma: (n) => `Removed ${n} trailing comma${n === 1 ? '' : 's'}`,
  missing_comma: (n) => `Inserted ${n} missing comma${n === 1 ? '' : 's'}`,
};

/** Ordered repair pipeline. Each step is tried; we re-parse and stop early. */
const PIPELINE: { kind: RepairKind; run: (t: string) => { text: string; count: number } }[] = [
  { kind: 'strip_bom', run: stripBom },
  { kind: 'strip_block_comment', run: stripBlockComments },
  { kind: 'strip_line_comment', run: stripLineComments },
  { kind: 'smart_quote', run: normalizeSmartQuotes },
  { kind: 'single_quote', run: singleToDoubleQuotes },
  { kind: 'unquoted_key', run: quoteUnquotedKeys },
  { kind: 'python_literal', run: replacePythonLiterals },
  { kind: 'js_literal', run: replaceJsLiterals },
  { kind: 'trailing_semicolon', run: stripSemicolons },
  { kind: 'trailing_comma', run: removeTrailingCommas },
  { kind: 'missing_comma', run: insertMissingCommas },
];

/**
 * Repair `input` into valid JSON, best-effort. Already-valid input is returned
 * byte-for-byte unchanged with no fixes. Never throws.
 */
export function repairJson(input: string): RepairResult {
  if (typeof input !== 'string') {
    return { text: '', fixes: [], changed: false, ok: false, errors: lintJsonSyntax('') };
  }
  // Fast path: already valid → do not touch it.
  if (tryParseJson(input).ok) {
    return { text: input, fixes: [], changed: false, ok: true, errors: [] };
  }

  let text = input;
  const fixes: RepairFix[] = [];
  // Iterate the pipeline to a fixpoint (capped). One pass can leave a doc that a
  // later pass's output makes fixable by an EARLIER pass — e.g. missing_comma
  // creates a `,` after which unquoted_key can finally quote the next key. We
  // re-run until the text parses, a full pass changes nothing, or we hit the cap
  // (the cap preserves the no-hang guarantee). No fabrication: the transforms
  // never close brackets, so truncated/unbalanced input still ends `ok:false`.
  const MAX_ROUNDS = 5;
  let parsed = false;
  outer: for (let round = 0; round < MAX_ROUNDS; round++) {
    let roundChanged = false;
    for (const step of PIPELINE) {
      const res = step.run(text);
      if (res.count > 0 && res.text !== text) {
        text = res.text;
        roundChanged = true;
        fixes.push({ kind: step.kind, detail: LABELS[step.kind](res.count), count: res.count });
        if (tryParseJson(text).ok) {
          parsed = true;
          break outer; // minimal correction: stop once it parses
        }
      }
    }
    if (!roundChanged) break; // fixpoint reached, still invalid
  }

  const ok = parsed || tryParseJson(text).ok;
  return {
    text,
    fixes,
    changed: text !== input,
    ok,
    errors: ok ? [] : lintJsonSyntax(text),
  };
}

/**
 * Convenience: repair then parse. Returns the parsed value on success (with the
 * applied fixes) or an error. Never throws.
 */
export function repairAndParse(
  input: string,
): { value: unknown; fixes: RepairFix[]; ok: boolean; error?: string } {
  const r = repairJson(input);
  if (!r.ok) return { value: undefined, fixes: r.fixes, ok: false, error: r.errors[0]?.message ?? 'Invalid JSON' };
  const parsed = tryParseJson(r.text);
  if (!parsed.ok) return { value: undefined, fixes: r.fixes, ok: false, error: parsed.error };
  return { value: parsed.value, fixes: r.fixes, ok: true };
}
