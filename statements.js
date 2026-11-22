/* statements.js - read a Service Canada "CPP Statement of Contributions" PDF inside the browser.
 * PRIVACY: the PDF is read in memory on this device. NOTHING is uploaded, stored or logged.
 * This file must make NO network calls (scripts/check_planner.py enforces it). It only loads the
 * two self-hosted pdf.js files under vendor/pdfjs/, and only when a person picks a PDF.
 * Part 1 (parser): text in, rows out. Codes M P Q B CQ CS S E, "Not yet available", YMPE table.
 * Part 2 (page): Preview first; only the statement's own estimate at 65 can be applied.
 * A contribution history alone is NOT turned into a pension figure here (no invented maths).
 * Written from the official legend only; check it on a real statement. Recipes: docs/common-edits.md. Test: python3 scripts/test_statements.py
 */
(function () {
'use strict';
// Year's Maximum Pensionable Earnings (CRA table of CPP maximums).
const YMPE = {
  1966: 5000, 1967: 5000, 1968: 5100, 1969: 5200, 1970: 5300, 1971: 5400, 1972: 5500,
  1973: 5600, 1974: 6600, 1975: 7400, 1976: 8300, 1977: 9300, 1978: 10400, 1979: 11700,
  1980: 13100, 1981: 14700, 1982: 16500, 1983: 18500, 1984: 20800, 1985: 23400,
  1986: 25800, 1987: 25900, 1988: 26500, 1989: 27700, 1990: 28900, 1991: 30500,
  1992: 32200, 1993: 33400, 1994: 34400, 1995: 34900, 1996: 35400, 1997: 35800,
  1998: 36900, 1999: 37400, 2000: 37600, 2001: 38300, 2002: 39100, 2003: 39900,
  2004: 40500, 2005: 41100, 2006: 42100, 2007: 43700, 2008: 44900, 2009: 46300,
  2010: 47200, 2011: 48300, 2012: 50100, 2013: 51100, 2014: 52500, 2015: 53600,
  2016: 54900, 2017: 55300, 2018: 55900, 2019: 57400, 2020: 58700, 2021: 61600,
  2022: 64900, 2023: 66600, 2024: 68500, 2025: 71300, 2026: 74600,
};

// Year's Additional Maximum Pensionable Earnings (second ceiling, CPP2). Exists from 2024 only.
const YAMPE = { 2024: 73200, 2025: 81200, 2026: 85000 };

const FIRST_YEAR = 1966;
// Codes defined on the Service Canada page. "isQPP" is true for Q and CQ.
const KNOWN_CODES = {
  M: 'Maximum pensionable earnings and maximum contribution',
  P: 'Contributions to the post-retirement benefit',
  Q: 'Quebec Pension Plan contributions',
  CQ: 'Both CPP and QPP in the same year',
  B: 'Earnings below the basic exemption',
  CS: 'Credit split',
  S: 'Self-employed earnings',
  E: 'Child-rearing drop-in',
};

/**
 * @typedef {Object} CppRow
 * @property {number} year
 * @property {number|null} contributions        dollars, null if not a number
 * @property {number|null} pensionableEarnings  dollars; "M" is resolved from YMPE (or YAMPE)
 * @property {string|null} rawCode              M, P, Q, B, CQ, CS, S, E, or an unknown code as printed
 * @property {boolean} isMaximum
 * @property {boolean} isQPP
 * @property {boolean} isPostRetirement
 * @property {boolean} isPending                "Not yet available" / "Pas encore disponible"
 * @property {string[]} codes                   every code seen on the row
 * @property {number|null} ympe                 statutory YMPE for that year (reference)
 * @property {number|null} yampe                statutory YAMPE for that year (2024+)
 * @property {string[]} warnings                warning codes raised for this row
 * @property {string} raw                       the cells as read, for debugging
 */

// ---------------------------------------------------------------- text helpers

function normalize(text) {
  return String(text)
    .replace(/[    ]/g, ' ') // NBSP / narrow NBSP (French thousands) / thin spaces
    .replace(/[−–—]/g, '-')
    .replace(/­/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t+/g, ' | ') // tabs from a copy-paste are real cell boundaries
    .replace(/[ ]{2,}/g, ' ');
}

/** "1,234.56", "$1 234,56", "1.234,56 $" -> 1234.56 */
function parseMoney(s) {
  let t = String(s).replace(/[$\s]/g, '').replace(/[,]+$/, '');
  if (/^-?[\d.]*,\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const NUMG = String.raw`(?:\d{1,3}(?:[, ]\d{3})+|\d+)`;
const CENTS = String.raw`[.,]\d{2}`;

/**
 * English statements put "$" first ($1,234.56); French put it last (1 234,56 $).
 * The two cannot share one regex because a trailing "$" would swallow the next cell's "$".
 */
function detectStyle(text) {
  const suffix = (text.match(/\d\s?\$/g) || []).length;
  const prefix = (text.match(/\$\s?\d/g) || []).length;
  return suffix > prefix ? 'suffix' : 'prefix';
}

function tokenRx(style) {
  const amt =
    style === 'suffix'
      ? String.raw`${NUMG}${CENTS}(?:\s?\$)?|${NUMG}\s?\$`
      : String.raw`\$\s?${NUMG}(?:${CENTS})?|${NUMG}${CENTS}`;
  return new RegExp(
    [
      String.raw`(?<pending>[Nn]ot yet available|[Pp]as encore disponible|[Nn]on disponible)`,
      `(?<amt>${amt})`,
      String.raw`(?<year>(?:19[6-9]\d|20\d\d)(?![\d,.]))`,
      String.raw`(?<code>(?:CQ|CS|[BMPQSE])(?![A-Za-z0-9]))`,
      String.raw`(?<sep>[|,;]+)`,
      String.raw`(?<junk>\S+)`,
    ].join('|'),
    'y'
  );
}

function tokenize(line, rx) {
  const out = [];
  let pos = 0;
  while (pos < line.length) {
    if (line[pos] === ' ') { pos++; continue; }
    rx.lastIndex = pos;
    const m = rx.exec(line);
    if (!m) { pos++; continue; }
    pos = rx.lastIndex;
    const g = m.groups;
    if (g.sep !== undefined) continue;
    const t = g.pending !== undefined ? 'pending' : g.amt !== undefined ? 'amt'
      : g.year !== undefined ? 'year' : g.code !== undefined ? 'code' : 'junk';
    out.push({ t, text: m[0].trim() });
  }
  return out;
}

// ---------------------------------------------------------------- pdf.js helpers

/**
 * Turn pdf.js textContent.items into lines. Items that share a baseline (within yTol points)
 * are joined left to right, so two table halves printed side by side land on one line.
 */
function textFromPdfItems(items, { yTol = 2.5 } = {}) {
  const its = items
    .filter((i) => i && typeof i.str === 'string' && i.str.trim() !== '')
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of its) {
    if (!cur || Math.abs(cur.y - it.y) > yTol) { cur = { y: it.y, parts: [] }; lines.push(cur); }
    cur.parts.push(it);
  }
  return lines
    .map((l) => {
      l.parts.sort((a, b) => a.x - b.x);
      let s = '';
      let end = null;
      for (const p of l.parts) {
        if (end !== null && p.x - end > 1) s += ' ';
        s += p.s;
        end = p.x + p.w;
      }
      return s;
    })
    .join('\n');
}

/** Convenience: read every page of a pdf.js PDFDocumentProxy. */
async function textFromPdfDocument(pdfDoc) {
  const pages = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const content = await page.getTextContent();
    pages.push(textFromPdfItems(content.items));
  }
  return pages.join('\n');
}

// ---------------------------------------------------------------- metadata

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
};
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function parseDate(s) {
  let m = s.match(/\b(20\d\d)-(\d{2})-(\d{2})\b/);
  if (m) return iso(m[1], +m[2], +m[3]);
  m = s.match(/\b([A-Za-zéû]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/\b(\d{1,2})(?:er)?\s+([A-Za-zéû]+)\.?\s+(20\d\d)\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

const AMT_LOOSE = String.raw`(\$\s?\d[\d, ]*(?:[.,]\d{2})?|\d[\d ]*,\d{2}\s?\$)`;

function extractMetadata(lines) {
  const meta = { statementDate: null, estimatedMonthly: { 60: null, 65: null, 70: null, now: null }, confidence: 'best-effort' };
  const label = /statement date|date of (?:the )?statement|date du relev[eé]|date de l[’']?[ée]tat/i;
  for (let i = 0; i < lines.length && !meta.statementDate; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    meta.statementDate = parseDate(lines[i].slice(m.index + m[0].length)) || parseDate(lines[i + 1] || '');
  }
  const flat = lines.join(' ');
  for (const age of [60, 65, 70]) {
    const en = new RegExp(String.raw`(?:age|âge)\s*(?:of|de)?\s*${age}(?!\d)[^$\d]{0,100}?${AMT_LOOSE}`, 'i');
    const fr = new RegExp(String.raw`${age}\s*ans[^$\d]{0,100}?${AMT_LOOSE}`, 'i');
    const m = flat.match(en) || flat.match(fr);
    if (m) meta.estimatedMonthly[age] = parseMoney(m[1]);
  }
  const now = flat.match(new RegExp(String.raw`(?:estimate|estim[ée])[^$\d]{0,120}?${AMT_LOOSE}\s*(?:per month|a month|monthly|par mois)`, 'i'));
  if (now) meta.estimatedMonthly.now = parseMoney(now[1]);
  return meta;
}

// ---------------------------------------------------------------- rows

function makeRow(year, cells, opts, warn) {
  const row = {
    year, contributions: null, pensionableEarnings: null, rawCode: null,
    isMaximum: false, isQPP: false, isPostRetirement: false, isPending: false,
    codes: [], ympe: YMPE[year] ?? null, yampe: YAMPE[year] ?? null,
    warnings: [], raw: cells.map((c) => c.text).join(' | '),
  };
  const w = (code, msg, severity = 'warn') => { row.warnings.push(code); warn(code, msg, year, severity); };
  const addCode = (code, col) => {
    row.codes.push(code);
    if (row.rawCode === null || col === 1) row.rawCode = code;
  };
  const handle = (c, col) => {
    if (c.t === 'amt') {
      const v = parseMoney(c.text);
      if (col === 0) row.contributions = v; else row.pensionableEarnings = v;
    } else if (c.t === 'pending') row.isPending = true;
    else if (c.t === 'code') addCode(c.text, col);
    else if (c.t === 'junk') {
      if (/^[A-Z]{1,3}$/.test(c.text)) { addCode(c.text, col); w('UNKNOWN_CODE', `Unrecognized code "${c.text}" in ${year}`); }
      else w('UNRECOGNIZED_TOKEN', `Unrecognized text "${c.text}" in ${year}`);
    }
  };
  if (cells.length === 1 && cells[0].t === 'amt') {
    w('AMBIGUOUS_SINGLE_AMOUNT', `${year}: one amount, cannot tell contributions from earnings`);
  } else {
    cells.slice(0, 2).forEach((c, i) => handle(c, i));
  }
  const extra = cells.slice(2);
  if (extra.length) {
    w('EXTRA_CELLS', `${year}: ${extra.length} cell(s) beyond the expected two (new column?)`);
    for (const c of extra) if (c.t === 'code') addCode(c.text, 2);
  }
  row.isMaximum = row.codes.includes('M');
  row.isQPP = row.codes.includes('Q') || row.codes.includes('CQ');
  row.isPostRetirement = row.codes.includes('P');
  if (row.isMaximum && row.pensionableEarnings === null) {
    const cap = opts.maximumBasis === 'YAMPE' && YAMPE[year] ? YAMPE[year] : YMPE[year];
    if (cap === undefined) w('MAX_UNRESOLVED', `${year}: "M" but no YMPE on file for that year`);
    else row.pensionableEarnings = cap;
  }
  if (row.contributions !== null && row.contributions < 0) w('NEGATIVE_AMOUNT', `${year}: negative contribution`);
  if (!row.isMaximum && typeof row.pensionableEarnings === 'number' && row.ympe !== null && row.pensionableEarnings > row.ympe + 0.005) {
    w('EARNINGS_ABOVE_YMPE', `${year}: earnings ${row.pensionableEarnings} exceed that year's YMPE ${row.ympe}`);
  }
  if (year > opts.maxYear) w('YEAR_IN_FUTURE', `${year} is after ${opts.maxYear}`);
  if (row.isPending && year < opts.maxYear - 1) w('PENDING_OLD_YEAR', `${year} is "not yet available" but is not a recent year`, 'info');
  return row;
}

/** Split one line's tokens into candidate rows (handles two table halves on one line). */
function candidateRows(tokens) {
  const found = [];
  let cur = null;
  const flush = () => { if (cur) found.push(cur); cur = null; };
  for (const tk of tokens) {
    if (tk.t === 'year') {
      const y = +tk.text;
      if (!cur || y > cur.year) { flush(); cur = { year: y, cells: [] }; continue; }
      cur.cells.push({ t: 'junk', text: tk.text });
      continue;
    }
    if (cur) cur.cells.push(tk);
  }
  flush();
  return found;
}

function looksLikeTableRow(c) {
  if (!c.cells.some((x) => x.t === 'amt' || x.t === 'pending' || x.t === 'code')) return false;
  // prose such as "2026 Estimated $640 per month" is not a table row
  return !c.cells.some((x) => x.t === 'junk' && /[A-Za-zÀ-ÿ]/.test(x.text) && x.text.length > 3);
}

/** Fallback for PDFs that emit a whole column at a time: years, then all amounts. */
function columnMajor(allTokens, opts, warn) {
  const rows = [];
  const segs = [];
  let seg = null;
  for (const tk of allTokens) {
    if (tk.t === 'year') {
      if (!seg || seg.cells.length) { seg = { years: [], cells: [] }; segs.push(seg); }
      seg.years.push(+tk.text);
    } else if (seg && tk.t !== 'junk') seg.cells.push(tk);
  }
  for (const s of segs) {
    const n = s.years.length;
    if (n < 5 || s.cells.length !== 2 * n) continue;
    const asNum = (c) => (c && c.t === 'amt' ? parseMoney(c.text) : null);
    const score = (pairs) => pairs.reduce((acc, [a, b]) => {
      const x = asNum(a), y = asNum(b);
      let ok = a.t !== 'code' || b.t === 'code';
      if (x !== null && y !== null && x > y + 0.005) ok = false;
      if (x !== null && x > 5000) ok = false;
      return acc + (ok ? 1 : 0);
    }, 0);
    const block = s.years.map((_, i) => [s.cells[i], s.cells[n + i]]);
    const inter = s.years.map((_, i) => [s.cells[2 * i], s.cells[2 * i + 1]]);
    const pairs = score(block) >= score(inter) ? block : inter;
    s.years.forEach((y, i) => rows.push(makeRow(y, [pairs[i][0], pairs[i][1]], opts, warn)));
    warn('LAYOUT_COLUMN_MAJOR', `Read ${n} years as separate columns; check a few rows by eye`, null, 'info');
  }
  return rows;
}

// ---------------------------------------------------------------- main

/**
 * @param {string|string[]} input  text (or array of lines)
 * @param {{maxYear?:number, maximumBasis?:'YMPE'|'YAMPE'}} [options]
 * @returns {{rows:CppRow[], metadata:object, warnings:object[], gaps:number[], layout:string, language:string, ok:boolean}}
 */
function parseCppStatement(input, options = {}) {
  const opts = {
    maxYear: options.maxYear ?? new Date().getFullYear(),
    maximumBasis: options.maximumBasis ?? 'YMPE',
  };
  const text = normalize(Array.isArray(input) ? input.join('\n') : input);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const warnings = [];
  const warn = (code, message, year = null, severity = 'warn') => warnings.push({ code, message, year, severity });

  const language = /Ann[ée]e|cotisations|gains ouvrant|Pas encore disponible|relev[ée]/i.test(text) ? 'fr' : 'en';
  const rx = tokenRx(detectStyle(text));
  let rows = [];
  let layout = 'row';

  for (const line of lines) {
    for (const c of candidateRows(tokenize(line, rx))) {
      if (looksLikeTableRow(c)) rows.push(makeRow(c.year, c.cells, opts, warn));
    }
  }

  if (rows.length < 3) {
    const all = lines.flatMap((l) => tokenize(l, rx));
    const cm = columnMajor(all, opts, warn);
    if (cm.length > rows.length) { rows = cm; layout = 'column-major'; }
  }

  // de-duplicate (repeated page headers, overlapping pages), sort, find gaps
  const byYear = new Map();
  for (const r of rows) {
    const prev = byYear.get(r.year);
    if (!prev) byYear.set(r.year, r);
    else if (prev.contributions !== r.contributions || prev.pensionableEarnings !== r.pensionableEarnings || prev.rawCode !== r.rawCode) {
      warn('DUPLICATE_YEAR', `${r.year} appears twice with different values; kept the first`, r.year);
    }
  }
  rows = [...byYear.values()].sort((a, b) => a.year - b.year);
  const gaps = [];
  if (rows.length) {
    for (let y = rows[0].year; y <= rows[rows.length - 1].year; y++) if (!byYear.has(y)) gaps.push(y);
    if (gaps.length) warn('GAPS', `No row for year(s): ${gaps.join(', ')}`, null, 'info');
    if (rows[0].year < FIRST_YEAR) warn('YEAR_BEFORE_1966', 'Row before 1966', rows[0].year);
    if (rows.some((r) => r.year >= 2024 && r.isMaximum)) {
      warn('CPP2_M_AMBIGUITY',
        'For 2024+ the page does not say whether "M" means the first ceiling (YMPE) or the second (YAMPE). ' +
        `Resolved to ${opts.maximumBasis}. Check one real statement.`, null, 'info');
    }
  } else {
    warn('NO_ROWS_FOUND', 'No contribution rows recognized. Is this the right document, or a scan with no text layer?', null, 'error');
  }

  const metadata = extractMetadata(lines);
  return { rows, metadata, warnings, gaps, layout, language, ok: !warnings.some((w) => w.severity === 'error') };
}

/* ===================== Part 2: the page ===================== */
var PDFJS_SRC = 'vendor/pdfjs/pdf.min.js';
var PDFJS_WORKER = 'vendor/pdfjs/pdf.worker.min.js';
var MAX_PAGES = 8;
var MIN_MONTHLY = 20, MAX_MONTHLY = 3000;
var state = null, mounted = false;

function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmt(v) { return '$' + (Math.round(v * 100) / 100).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function msg(cls, text) { return '<div class="ai-msg ' + cls + '">' + esc(text) + '</div>'; }
function isCouple() { var m = document.getElementById('calcMode'); return !!m && m.value === 'couple'; }
function targetId(who) { return (who === 'spouse' && !hhOn()) ? 'spouseCppMonthlyAmt' : 'cppMonthlyAmt'; }
// couple (household) mode: each person has their own form; a statement can be filed for the person on screen or for the other one
function hhOn() { return isCouple() && typeof HH !== 'undefined' && !!HH; }
function openWho() { return (hhOn() && HH.who === 'spouse') ? 'spouse' : 'me'; }
function whoName(w) { try { if (typeof hhLabel === 'function') return hhLabel(w === 'spouse' ? 'sp' : 'me'); } catch (e) { /* ignore */ } return w === 'spouse' ? 'my spouse' : 'me'; }
function storedOnly(w) { return hhOn() && w !== openWho(); }
function storedProfile(w) { if (w === 'spouse' && !HH.spouse && typeof hhEnsureSpouse === 'function') hhEnsureSpouse(); return w === 'spouse' ? HH.spouse : HH.me; }
function whoBlock() {
    if (!hhOn()) return '';
    var w = (state && state.forWho) || openWho();
    function row(v) { return '<label class="ai-row"><input type="radio" name="stmtWho" value="' + v + '"' + (w === v ? ' checked' : '') + ' style="width:auto;margin:0 0.5rem 0 0"><span class="ai-lbl">' + esc(whoName(v)) + '</span></label>'; }
    return '<div id="stmtWho" style="margin:0.5rem 0"><div style="font-weight:600">This statement is for</div>' + row('me') + row('spouse') + '</div>';
}
function plausible(v) { return typeof v === 'number' && v >= MIN_MONTHLY && v <= MAX_MONTHLY; }

var pdfjsPromise = null;
function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = PDFJS_SRC;
        s.onload = function () {
            if (!window.pdfjsLib) { reject(new Error('pdfjs missing')); return; }
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
            resolve(window.pdfjsLib);
        };
        s.onerror = function () { pdfjsPromise = null; reject(new Error('pdfjs load failed')); };
        document.head.appendChild(s);
    });
    return pdfjsPromise;
}

function readText(buf) {
    return loadPdfJs().then(function (lib) {
        return lib.getDocument({ data: buf, isEvalSupported: false }).promise;
    }).then(function (pdf) {
        var n = Math.min(pdf.numPages, MAX_PAGES), jobs = [];
        for (var i = 1; i <= n; i++) {
            jobs.push(pdf.getPage(i).then(function (pg) { return pg.getTextContent(); }).then(function (tc) { return textFromPdfItems(tc.items); }));
        }
        return Promise.all(jobs);
    }).then(function (pages) { return pages.join('\n'); });
}

var INTRO = 'Download your CPP Statement of Contributions as a PDF from My Service Canada Account, then choose it here. It is read on this device only; nothing is uploaded and nothing is saved. Your name and SIN are ignored.';
var MSGS = {
    notPdf: 'That is not a PDF. Download the statement as a PDF from My Service Canada Account (a screenshot cannot be read yet).',
    noText: 'This PDF has no readable text (it may be a scan). Download it again from My Service Canada Account.',
    failed: 'Could not read that file. Try downloading the PDF again.',
    notFound: 'I could not recognise a contributions table in this file. Nothing was filled in.'
};

function render() {
    var sum = document.getElementById('stmtSum'), body = document.getElementById('stmtBody');
    if (!sum || !body) return;
    sum.textContent = 'Read your CPP contributions statement (Service Canada)';
    var keepFile = document.getElementById('stmtFile');
    body.innerHTML = '<p style="margin:0 0 0.5rem;font-size:0.85rem;color:var(--medium-gray)">' + esc(INTRO) + '</p>' +
        '<label for="stmtFile" style="font-weight:600">Choose the PDF</label><div id="stmtFileSlot"></div>' +
        '<div id="stmtOut" aria-live="polite"></div>' +
        '<p style="margin:0.6rem 0 0;font-size:0.76rem">Privacy: the file never leaves this page. Always check the numbers against your statement before relying on them.</p>';
    var slot = document.getElementById('stmtFileSlot');
    if (keepFile) slot.appendChild(keepFile);
    else {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.id = 'stmtFile'; inp.accept = '.pdf,application/pdf';
        inp.addEventListener('change', onFile);
        slot.appendChild(inp);
    }
    renderResult();
}

function summaryHtml(r) {
    var rows = r.rows, first = rows[0].year, last = rows[rows.length - 1].year;
    var withC = rows.filter(function (x) { return x.contributions > 0; }).length;
    var max = rows.filter(function (x) { return x.isMaximum; }).length;
    var q = rows.filter(function (x) { return x.isQPP; }).length;
    var pend = rows.filter(function (x) { return x.isPending; }).length;
    var h = msg('', 'Found ' + rows.length + ' years of contributions (' + first + ' to ' + last + '): ' + withC + ' with CPP contributions, ' + max + ' at the maximum' +
        (q ? ', ' + q + ' in the Quebec Pension Plan' : '') + (pend ? ', ' + pend + ' not yet available' : '') + '.');
    if (r.metadata.statementDate) h += msg('note', 'Statement date: ' + r.metadata.statementDate + '.');
    var shown = r.warnings.filter(function (w) { return w.severity !== 'info'; }).slice(0, 4);
    shown.forEach(function (w) { h += msg('bad', w.message); });
    return h;
}

function estimateHtml(r) {
    var e = r.metadata.estimatedMonthly, opts = [];
    if (plausible(e[65])) opts.push({ label: 'Estimated CPP at age 65', v: e[65], def: true });
    if (plausible(e.now)) opts.push({ label: 'Estimate for starting now (only if you are 65 or older)', v: e.now, def: !opts.length });
    if (!opts.length) {
        return msg('note', 'This statement lists your contribution history but no pension estimate at 65, and this page does not turn a history into a pension figure. For the planner’s “CPP per month at 65”, use the estimate in My Service Canada Account or the CPP retirement pension estimator.');
    }
    var h = msg('', 'Found a pension estimate in your statement. Tick the one to use.') + '<div class="ai-table">';
    opts.forEach(function (o) {
        h += '<label class="ai-row"><input type="radio" name="stmtChoice" data-v="' + o.v + '"' + (o.def ? ' checked' : '') + '><span class="ai-lbl">' + esc(o.label) + '</span><strong class="ai-new">' + esc(fmt(o.v)) + ' / month</strong></label>';
    });
    h += '</div>';
    var who = (state && state.forWho) || 'me';
    if (who === 'spouse' && !isCouple()) return h + msg('bad', 'Switch “Who is this plan for?” to couple mode to apply a spouse statement.');
    var cur;
    if (storedOnly(who)) { var sp0 = storedProfile(who); cur = sp0 ? parseFloat(sp0.cppMonthlyAmt) : NaN; }
    else { var el = document.getElementById(targetId(who)); cur = el ? parseFloat(el.value) : NaN; }
    return h + msg('', 'Will set ' + (hhOn() ? 'the CPP per month at 65 for ' + whoName(who) : '“' + (who === 'spouse' ? 'Spouse CPP per month at 65' : 'CPP per month at 65') + '”') + (isFinite(cur) ? ' (now ' + fmt(cur) + ')' : '') + '. The planner adjusts for your start age itself.') +
        '<div class="btn-row"><button type="button" class="save-btn" id="stmtApply">Apply</button></div>';
}

function renderResult() {
    var out = document.getElementById('stmtOut');
    if (!out) return;
    if (!state) { out.innerHTML = ''; return; }
    if (state.error) { out.innerHTML = msg('bad', MSGS[state.error]); return; }
    var r = state.result;
    if (!r || !r.rows.length) { out.innerHTML = msg('bad', MSGS.notFound); return; }
    out.innerHTML = whoBlock() + summaryHtml(r) + estimateHtml(r);
    var radios = out.querySelectorAll('input[name=stmtWho]');
    for (var ri = 0; ri < radios.length; ri++) radios[ri].addEventListener('change', function () { if (state) state.forWho = this.value; renderResult(); });
    var ap = document.getElementById('stmtApply');
    if (ap) ap.addEventListener('click', function () {
        var c = out.querySelector('input[name=stmtChoice]:checked');
        if (c) setValue(parseFloat(c.getAttribute('data-v')));
    });
}

function setValue(v) {
    var w0 = (state && state.forWho) || 'me';
    if (storedOnly(w0)) {
        var sp1 = storedProfile(w0); if (!sp1) return;
        sp1.cppMonthlyAmt = v;   // the other person's saved form; they see it when you switch to them
    } else {
        var el = document.getElementById(targetId(w0));
        if (!el) return;
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (typeof window.refreshCollapsibleSummaries === 'function') { try { window.refreshCollapsibleSummaries(); } catch (e) { /* ignore */ } }
    if (typeof window.showSaveBadge === 'function') { try { window.showSaveBadge('✓ Applied'); } catch (e) { /* ignore */ } }
    var out = document.getElementById('stmtOut');
    if (out) out.insertAdjacentHTML('afterbegin', msg('good', 'Applied. Review it in step 2, then calculate. ' + fmt(v) + ' / month'));
}

function onFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    var out = document.getElementById('stmtOut');
    if (!f) return;
    state = { forWho: hhOn() ? openWho() : 'me' };
    if (!(/\.pdf$/i.test(f.name) || f.type === 'application/pdf')) { state.error = 'notPdf'; renderResult(); return; }
    if (out) out.innerHTML = msg('', 'Reading the PDF…');
    var rd = new FileReader();
    rd.onerror = function () { state.error = 'failed'; renderResult(); };
    rd.onload = function () {
        readText(rd.result).then(function (text) {
            if (!text.trim()) { state.error = 'noText'; renderResult(); return; }
            state.result = parseCppStatement(text);
            renderResult();
        }).catch(function () { state.error = 'failed'; renderResult(); });
    };
    rd.readAsArrayBuffer(f);
    ev.target.value = '';
}

function mount() {
    if (mounted) return; mounted = true;
    render();
    var cm = document.getElementById('calcMode');
    if (cm) cm.addEventListener('change', function () { renderResult(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

window.ONRP_STMT = { parseCppStatement: parseCppStatement, textFromPdfItems: textFromPdfItems, parseMoney: parseMoney, YMPE: YMPE, YAMPE: YAMPE };
})();
