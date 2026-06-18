// ============================================================================
//  logger.ts — best-effort file logger for the ontology pipeline.
//
//  Appends one line per event to <root>/logs/<YYYY-MM-DD>.log, with the date and
//  every timestamp in the OS-LOCAL timezone (offset included). It captures:
//    - ACTION dispatches  (handler.ts entrypoint: action + method + user),
//    - pipeline STEPS     (every run-log line, e.g. "[objects] starting"),
//    - LLM calls          (task name + provider/model + token usage + duration).
//
//  Writes are serialized through an in-process promise chain so lines never
//  interleave, and EVERY failure degrades to a silent no-op — logging must never
//  break a request. On a read-only FS (e.g. Vercel) it disables itself after the
//  first mkdir failure. Local dev (`npm run dev`) runs from the repo root, so the
//  files land in <repo>/logs/.
//
//  Config: ONTOLOGY_GEN_LOG=0 disables it; ONTOLOGY_GEN_LOG_DIR overrides the
//  directory (default <cwd>/logs).
//
//  HARD RULES (NodeNext / strict TS): fs/path only (no project imports), no `any`.
// ============================================================================

import { promises as fs } from 'fs';
import * as path from 'path';

const LOG_DIR = (process.env.ONTOLOGY_GEN_LOG_DIR || path.join(process.cwd(), 'logs')).trim();

let disabled = process.env.ONTOLOGY_GEN_LOG === '0';
let dirReady: Promise<void> | null = null;
let chain: Promise<void> = Promise.resolve();

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, '0');
}

/**
 * Local-timezone parts for a Date: the file `date` (YYYY-MM-DD) and a full
 * `stamp` (`YYYY-MM-DD HH:mm:ss.SSS ±HHMM`). Pure — exported for tests.
 */
export function stampParts(d: Date): { date: string; stamp: string } {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const offMin = -d.getTimezoneOffset(); // minutes east of UTC
  const tz = `${offMin >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offMin) / 60))}${pad(Math.abs(offMin) % 60)}`;
  return { date, stamp: `${date} ${time} ${tz}` };
}

function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.mkdir(LOG_DIR, { recursive: true }).then(
      () => {},
      () => {
        disabled = true; // read-only FS (e.g. serverless) — stop trying.
      },
    );
  }
  return dirReady;
}

/** One LLM-call record. */
export interface LlmLogRecord {
  /** The agent task / action name (e.g. "ontology_extract_objects"). */
  actionName: string;
  module?: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  ok: boolean;
  error?: string;
  /** Optional note, e.g. "retry" / "will retry". */
  note?: string;
}

/** Format the message body of an LLM-call line. Pure — exported for tests. */
export function formatLlm(rec: LlmLogRecord): string {
  const tokens =
    rec.totalTokens !== undefined || rec.promptTokens !== undefined || rec.completionTokens !== undefined
      ? ` tokens(prompt=${rec.promptTokens ?? 0}, completion=${rec.completionTokens ?? 0}, total=${rec.totalTokens ?? 0})`
      : '';
  const dur = rec.durationMs !== undefined ? ` ${rec.durationMs}ms` : '';
  const note = rec.note ? ` [${rec.note}]` : '';
  const status = rec.ok ? 'ok' : `ERROR${rec.error ? ': ' + oneLine(rec.error) : ''}`;
  return `task=${rec.actionName}${rec.module ? ` module=${rec.module}` : ''} provider=${rec.provider} model=${rec.model}${tokens}${dur} ${status}${note}`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/** Append one event line `[stamp] [category] message`. Never throws. */
export function logEvent(category: string, message: string): void {
  if (disabled) return;
  const { date, stamp } = stampParts(new Date());
  const line = `[${stamp}] [${category}] ${oneLine(message)}\n`;
  const file = path.join(LOG_DIR, `${date}.log`);
  chain = chain
    .then(() => ensureDir())
    .then(() => {
      if (!disabled) return fs.appendFile(file, line, 'utf8');
      return undefined;
    })
    .catch(() => {
      /* best-effort: drop the line on any FS error */
    });
}

/** A pipeline step (a run-log line). `scope` ties it to a run id when known. */
export function logStep(scope: string, message: string): void {
  logEvent('step', scope ? `${scope} ${message}` : message);
}

/** One LLM call: task name + provider/model + token usage + timing. */
export function logLlm(rec: LlmLogRecord): void {
  logEvent('llm', formatLlm(rec));
}
