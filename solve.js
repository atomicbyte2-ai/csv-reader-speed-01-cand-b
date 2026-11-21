// csv-reader-speed-01 — candidate B: indexOf-driven field scanner.
//
// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly the same
// {columns, rows, errors} for every {text, header}. Written from the written
// policy (BOM, stray_cr, quote_junk, unterminated_quote, short_row/long_row,
// error line/row numbering), not from the reference's code.
//
// Design:
//  - Record-level fast path: a line with no quote and no stray CR is one
//    slice + split(',').
//  - Unquoted field: one indexOf(',') first; the segment up to the comma (or
//    to the line end when there is no comma) is checked for '\n' / '\r' with
//    short bounded scans only — never an unbounded indexOf('\r'), which in an
//    LF file would scan to the next stray CR, possibly thousands of chars
//    away. A stray CR anywhere in the segment falls back to a general loop
//    (rare: ~0.4% of records), which keeps error order exact.
//  - Quoted field: indexOf('"') loop for the close ("" skipped); the span is
//    one slice when it holds no CR/LF and no "" (line count untouched), and is
//    rebuilt with split/join only when it does — with the line delta counted
//    over the whole span, including segments before a "".
//  - No per-character loop, no += per character, no object allocated per
//    field: field results travel in shared locals (fVal/fEnd/fAdded).
//  - Deterministic, dependency-free, no network, no I/O; all paths resolve
//    from nothing but the input.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on, and the index in rows it
  // takes (null for the header). Errors are attributed to these, never to
  // where inside the record the fault sits.
  let recordLine = 1;
  let recordRow = null;

  // Field result, shared so no object is allocated per field.
  let fVal = '';
  let fEnd = 0; // 0 = comma, 1 = line break, 2 = end of text
  let fAdded = 0; // characters kept after `init` (quote_junk test)

  // Reads an unquoted field starting at pos, with `init` already in the
  // value ('' normally; the quoted value for quote junk; '"' for the
  // unterminated-quote re-read). Sets fVal/fEnd/fAdded, advances pos/line.
  function readUnquoted(init) {
    const ci = text.indexOf(',', pos);
    if (ci !== -1) {
      const seg = text.slice(pos, ci);
      const nl = seg.indexOf('\n');
      if (nl === -1) {
        if (seg.indexOf('\r') === -1) {
          fVal = init === '' ? seg : init + seg;
          fAdded = seg.length;
          fEnd = 0;
          pos = ci + 1;
          return;
        }
        // A CR before the comma is stray: general loop below.
      } else {
        const before = seg.slice(0, nl);
        const cr = before.indexOf('\r');
        if (cr === -1) {
          fVal = init === '' ? before : init + before;
          fAdded = nl;
          fEnd = 1;
          pos = pos + nl + 1;
          line += 1;
          return;
        }
        if (cr === nl - 1) {
          // The only CR is the CRLF's own: strip it, end at the line break.
          const v = seg.slice(0, nl - 1);
          fVal = init === '' ? v : init + v;
          fAdded = nl - 1;
          fEnd = 1;
          pos = pos + nl + 1;
          line += 1;
          return;
        }
        // A CR before the CRLF is stray: general loop below.
      }
    } else {
      const ni = text.indexOf('\n', pos);
      const m = ni === -1 ? n : ni;
      const seg = text.slice(pos, m);
      const cr = seg.indexOf('\r');
      if (cr === -1) {
        fVal = init === '' ? seg : init + seg;
        fAdded = seg.length;
        fEnd = ni === -1 ? 2 : 1;
        pos = ni === -1 ? n : ni + 1;
        if (ni !== -1) line += 1;
        return;
      }
      if (ni !== -1 && cr === seg.length - 1) {
        // Trailing CRLF at the line end.
        const v = seg.slice(0, -1);
        fVal = init === '' ? v : init + v;
        fAdded = seg.length - 1;
        fEnd = 1;
        pos = ni + 1;
        line += 1;
        return;
      }
      // A stray CR (or a lone trailing CR at end of text): general loop.
    }

    // General path: this field holds a stray CR. Walk delimiter to
    // delimiter, dropping each stray CR (error) and keeping the rest.
    let parts = init === '' ? null : [init];
    let added = 0;
    let start = pos;
    for (;;) {
      const c2 = text.indexOf(',', pos);
      const n2 = text.indexOf('\n', pos);
      const r2 = text.indexOf('\r', pos);
      let m = -1;
      let kind = 2;
      if (c2 !== -1) { m = c2; kind = 0; }
      if (n2 !== -1 && (m === -1 || n2 < m)) { m = n2; kind = 1; }
      if (r2 !== -1 && (m === -1 || r2 < m)) { m = r2; kind = 3; }
      if (m === -1) {
        const tail = text.slice(start, n);
        added += n - start;
        pos = n;
        fVal = parts ? parts.join('') + tail : tail;
        fAdded = added;
        fEnd = 2;
        return;
      }
      if (kind === 3) {
        if (text.charCodeAt(m + 1) === 10) {
          const s = text.slice(start, m);
          added += m - start;
          pos = m + 2;
          line += 1;
          fVal = parts ? parts.join('') + s : s;
          fAdded = added;
          fEnd = 1;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [text.slice(start, m)];
        else parts.push(text.slice(start, m));
        added += m - start;
        pos = m + 1;
        start = pos;
        continue;
      }
      const s = text.slice(start, m);
      added += m - start;
      fVal = parts ? parts.join('') + s : s;
      fAdded = added;
      if (kind === 0) { pos = m + 1; fEnd = 0; return; }
      pos = m + 1;
      line += 1;
      fEnd = 1;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnd,
  // advances pos/line. Junk after the closing quote is read as unquoted;
  // quote_junk fires only when junk characters were actually kept.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let q = open + 1;
    let segStart = open + 1;
    let parts = null;
    let closed = -1;
    for (;;) {
      q = text.indexOf('"', q);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [text.slice(segStart, q), '"'];
        else parts.push(text.slice(segStart, q), '"');
        q += 2;
        segStart = q;
        continue;
      }
      closed = q;
      break;
    }
    if (closed === -1) {
      // Never closes: the quote is literal, re-read the rest as unquoted.
      // The search ran to the end of the text, so a later record's quote
      // could have closed it — handled above by the same loop.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      line = openLine;
      readUnquoted('"');
      return;
    }
    const span = text.slice(open + 1, closed);
    let value;
    if (parts === null && span.indexOf('\n') === -1 && span.indexOf('\r') === -1) {
      value = span;
    } else {
      // Count the line delta over the WHOLE span (segments before a "" count
      // too): each LF, each CRLF and each lone CR inside quotes is one line.
      let nl = 0;
      let i = -1;
      while ((i = span.indexOf('\n', i + 1)) !== -1) nl++;
      let cr = 0;
      i = -1;
      while ((i = span.indexOf('\r', i + 1)) !== -1) cr++;
      let crlf = 0;
      i = -1;
      while ((i = span.indexOf('\r\n', i + 1)) !== -1) crlf++;
      line += nl + cr - crlf;
      let s = span;
      if (cr > 0) {
        s = s.split('\r\n').join('\n');
        s = s.split('\r').join('\n');
      }
      if (parts !== null) s = s.split('""').join('"');
      value = s;
    }
    pos = closed + 1;
    if (pos >= n) { fVal = value; fEnd = 2; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fVal = value; fEnd = 0; return; }
    if (c === 10) { pos += 1; line += 1; fVal = value; fEnd = 1; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; fVal = value; fEnd = 1; return; }
    // What follows the closing quote is appended as it stands.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Record-level fast path: a line with no quote and no stray CR. The
    // trailing CR of a CRLF is stripped; a lone CR at end of text is NOT
    // (it is stray, so the slow path must see it). All checks are bounded
    // to this line.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    let contentEnd = lineEnd;
    if (le !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
    const lineStr = text.slice(pos, contentEnd);
    let fields;
    let lastQuoted = false;
    if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
      fields = lineStr.split(',');
      pos = le === -1 ? n : le + 1;
      line += 1;
    } else {
      fields = [];
      do {
        if (text.charCodeAt(pos) === 34) { lastQuoted = true; readQuoted(); }
        else { lastQuoted = false; readUnquoted(''); }
        fields.push(fVal);
      } while (fEnd === 0);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
