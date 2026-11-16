'use strict';
/*
 * ask.js — the ASK protocol's one pure function.
 *
 * parseAsk(text) scans a task's final result for a line-anchored
 * `ASK: question | option | option` marker and returns
 * { question, options } — or null when there is nothing to ask.
 * Only the first line-anchored ASK counts; options are optional and
 * capped at 4; mid-prose mentions never match.
 */

const ASK_RE = /^[ \t]*ASK:[ \t]*(.+?)[ \t]*$/m;

function parseAsk(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(ASK_RE);
  if (!m) return null;
  const parts = m[1].split('|');
  const question = parts[0].trim();
  if (!question) return null;
  const options = parts.slice(1)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  return { question, options };
}

module.exports = { parseAsk };
