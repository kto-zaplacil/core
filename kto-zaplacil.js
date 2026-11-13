// SPDX-License-Identifier: AGPL-3.0-only
// Source: https://github.com/kto-zaplacil/core
// CRC-8, poly 0x07, init 0x00, over the first 32 chars (hyphens included). Verified against the docs example 5265877635-20250826-0100001AF629-AF.
function crc8(s) {
    let c = 0;
    for (const b of new TextEncoder().encode(s)) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c.toString(16).toUpperCase().padStart(2, '0');
}

// IZ layout NIP-IZYYYYMM-12HEX-CRC uses the same CRC. Verified against the KSeF API example 1111111111-IZ202607-65ED02180000-E7.
const PATTERNS = [
    { type: 'ksef', re: /(?<!\d)(\d{10})-?(\d{8})-?([0-9A-F]{6})-?([0-9A-F]{6})-?([0-9A-F]{2})(?![0-9A-F])/g, canon: m => `${m[1]}-${m[2]}-${m[3]}${m[4]}-${m[5]}` },
    { type: 'iz', re: /(?<!\d)(\d{10})-?IZ(\d{6})-?([0-9A-F]{12})-?([0-9A-F]{2})(?![0-9A-F])/g, canon: m => `${m[1]}-IZ${m[2]}-${m[3]}-${m[4]}` },
];

function findIds(text) {
    const out = new Map();
    const up = String(text).toUpperCase();
    for (const t of [up, up.replace(/\s*-\s*/g, '-'), up.replace(/\s+/g, '')]) {
        for (const p of PATTERNS) {
            for (const m of t.matchAll(p.re)) {
                const id = p.canon(m);
                const ok = crc8(id.slice(0, 32)) === id.slice(33);
                // A hyphen-less digit run with a bad checksum is most likely an account number, not a typo.
                if (!ok && (m[0].match(/-/g) || []).length < 3) continue;
                if (!out.has(id)) out.set(id, { id, type: p.type, ok });
            }
        }
    }
    return [...out.values()];
}

function classify(ids) {
    if (ids.some(i => i.ok && i.type === 'ksef')) return 'ksef';
    if (ids.some(i => i.ok && i.type === 'iz')) return 'iz';
    return ids.length ? 'bad' : 'none';
}

function parseAmount(s) {
    s = String(s ?? '').replace(/−/g, '-').replace(/[^\d,.\-]/g, '');
    const d = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    if (d < 0) return parseFloat(s);
    return parseFloat(s.slice(0, d).replace(/[,.]/g, '') + '.' + s.slice(d + 1));
}

// Polish :86: is "CCC~00...~20title~21title...~32name~33name"; banks use ~ ^ < or ? as the separator.
function parse86(body) {
    const s = body.replace(/\n/g, '');
    const sep = (s.match(/^\d{3}([~^<?])/) || s.match(/^([~^<?])\d{2}/) || [])[1];
    if (!sep) return { title: s, name: '', text: s };
    const f = {};
    for (const part of s.split(sep).slice(1)) f[part.slice(0, 2)] = (f[part.slice(0, 2)] || '') + part.slice(2);
    const pick = ks => ks.map(k => f[k] || '').join('');
    const title = pick(['20', '21', '22', '23', '24', '25', '26']) || s;
    return { title, name: (pick(['32', '33']) || pick(['27', '28', '29'])).trim(), text: title + ' ' + s };
}

function parseMT940(text) {
    const txs = [];
    for (const block of text.replace(/\r/g, '').split(/\n(?=:\d{2}[A-Z]?:)/)) {
        const m = block.match(/^:(\d{2}[A-Z]?):([\s\S]*)$/);
        if (!m) continue;
        if (m[1] === '61') {
            const f = m[2].match(/^(\d{2})(\d{2})(\d{2})(?:\d{4})?(RC|RD|C|D)[A-Z]?(\d+,\d*)/);
            if (f) txs.push({ date: `20${f[1]}-${f[2]}-${f[3]}`, credit: f[4] === 'C' || f[4] === 'RD', amount: parseAmount(f[5]), title: '', name: '', text: m[2], has86: false });
        } else if (m[1] === '86' && txs.length && !txs[txs.length - 1].has86) {
            Object.assign(txs[txs.length - 1], parse86(m[2]), { has86: true });
        }
    }
    return { txs };
}

function parseCSVRows(text, d) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
        } else if (c === '"') q = true;
        else if (c === d) { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

// Non-empty rows, with the delimiter guessed from the first lines.
function csvRows(text) {
    const head = text.split('\n').slice(0, 40).join('\n');
    const d = [';', '\t', ','].sort((a, b) => head.split(b).length - head.split(a).length)[0];
    return parseCSVRows(text, d).filter(r => r.some(c => c.trim()));
}

function parseCSV(text) {
    const rows = csvRows(text);
    const hi = rows.findIndex(r => r.some(c => /kwota|amount|uzna|obciąż/i.test(c)) && r.some(c => /tytu|opis|title|szczeg|descr/i.test(c)));
    if (hi < 0) {
        return {
            txs: rows.map(r => ({ date: '', credit: null, amount: NaN, name: '', title: r.join(' '), text: r.join(' ') })),
            warning: 'Nie rozpoznano kolumn pliku CSV. Przeszukano wszystkie wiersze, ale nie da się odróżnić wpływów od wydatków.',
        };
    }
    const h = rows[hi].map(c => c.replace(/^#/, '').trim().toLowerCase());
    const col = re => h.findIndex(c => re.test(c));
    const cDate = col(/data/), cIn = col(/uzna|wpływ|credit/), cOut = col(/obciąż|debit/), cAmt = col(/kwota|amount/);
    const cTitle = col(/tytu/) >= 0 ? col(/tytu/) : col(/opis|title|szczeg|descr/);
    const cName = col(/kontrahent|nadawc|odbiorc|nazwa|counterparty/);
    const txs = rows.slice(hi + 1).map(r => {
        const amount = cIn >= 0 && cOut >= 0
            ? (r[cIn]?.trim() ? Math.abs(parseAmount(r[cIn])) : -Math.abs(parseAmount(r[cOut])))
            : parseAmount(r[cAmt]);
        // Whole row is searched: some banks (e.g. PKO) spill the title into unnamed trailing columns.
        return { date: r[cDate] || '', credit: amount > 0, amount, name: r[cName] || '', title: r[cTitle] || r.join(' '), text: r.join(' ') };
    }).filter(t => !isNaN(t.amount));
    return { txs };
}

function parseCAMT(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return { txs: [], warning: 'Plik XML jest uszkodzony.' };
    const q = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
    const txt = (el, tag) => q(el, tag).map(e => e.textContent.trim()).join(' ');
    return {
        txs: q(doc, 'Ntry').map(e => {
            const credit = txt(e, 'CdtDbtInd').startsWith('CRDT');
            const party = q(e, credit ? 'Dbtr' : 'Cdtr')[0];
            const nm = party && q(party, 'Nm')[0];
            const date = q(q(e, 'BookgDt')[0] || e, 'Dt')[0] || q(e, 'DtTm')[0];
            const title = txt(e, 'Ustrd') || txt(e, 'AddtlNtryInf');
            return {
                date: date ? date.textContent.slice(0, 10) : '',
                credit,
                amount: parseAmount(q(e, 'Amt')[0]?.textContent) * (credit ? 1 : -1),
                name: nm ? nm.textContent.trim() : '',
                title,
                // Minified XML has no space between fields, and a digit right before a number blocks its match. Title first, so a number split across Ustrd lines stays whole.
                text: [title, ...q(e, '*').filter(n => !q(n, '*').length).map(n => n.textContent.trim())].join(' '),
            };
        }),
    };
}

function parseStatement(text) {
    const t = text.replace(/^﻿/, '');
    if (/^\s*</.test(t)) return { format: 'CAMT.053', ...parseCAMT(t) };
    if (/^:61:/m.test(t)) return { format: 'MT940', ...parseMT940(t) };
    return { format: 'CSV', ...parseCSV(t) };
}

// --- Sales invoices: FA(3) XML files from KSeF or a CSV export from the invoicing tool ---

function parseFA(xml, fileName) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const q = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
    const first = (el, tag) => q(el, tag)[0]?.textContent.trim() || '';
    const buyer = q(doc, 'Podmiot2')[0];
    return [{
        number: first(doc, 'P_2'),
        date: first(doc, 'P_1'),
        gross: parseAmount(first(doc, 'P_15')),
        buyer: buyer ? first(buyer, 'Nazwa') || first(buyer, 'NIP') : '',
        // The KSeF number is not inside the XML; KSeF exports name each file after it.
        ksef: findIds(fileName).find(i => i.ok && i.type === 'ksef')?.id || '',
    }].filter(i => i.number);
}

function parseInvoiceCSV(text) {
    const rows = csvRows(text);
    const hi = rows.findIndex(r => r.some(c => /numer|^\s*#?nr|number/i.test(c)) && r.some(c => /brutto|gross|zapłat|razem|kwota|wartość|amount|total/i.test(c)));
    if (hi < 0) return [];
    const h = rows[hi].map(c => c.replace(/^#/, '').trim().toLowerCase());
    const col = (re, not) => h.findIndex(c => re.test(c) && !(not && not.test(c)));
    const cNo = col(/numer|^nr|number/, /ksef|nip|konta|rachun|zamów/);
    const cGross = [col(/brutto|gross/), col(/zapłat|razem|total/), col(/kwota|wartość|amount/, /netto|net\b|vat/)].find(i => i >= 0);
    const cBuyer = col(/nabywc|kontrahent|klient|buyer|odbiorc/, /nip/), cKsef = col(/ksef/), cDate = col(/data/);
    return rows.slice(hi + 1).map(r => ({
        number: (r[cNo] || '').trim(),
        date: r[cDate] || '',
        gross: parseAmount(r[cGross]),
        buyer: r[cBuyer] || '',
        ksef: cKsef >= 0 ? findIds(r[cKsef] || '').find(i => i.ok && i.type === 'ksef')?.id || '' : '',
    })).filter(i => i.number);
}

function parseInvoiceFile(text, name) {
    const t = text.replace(/^﻿/, '');
    return /^\s*</.test(t) ? parseFA(t, name) : parseInvoiceCSV(t);
}

// "FV 2026/12/014" must match "FV2026-12-014", "fv 2026 12 14" and, loosely, "Faktura 2026/12/14",
// but never "FV 2026/12/0140" or "1/2026" inside "21/2026".
function invoiceRegexes(number) {
    const parts = String(number).toUpperCase().split(/[^A-Z0-9]+|(?<=[A-Z])(?=\d)|(?<=\d)(?=[A-Z])/).filter(Boolean);
    if (parts.length < 2 && parts.join('').length < 6) return { strict: null, loose: null, keys: [] }; // a bare "101" would match noise
    const pat = p => /^\d+$/.test(p) ? '0*' + p.replace(/^0+(?=\d)/, '') : p; // payers drop leading zeros
    const re = ps => new RegExp(`(?<![A-Z0-9])${ps.map(pat).join('[\\s/\\\\_.-]*')}(?![A-Z0-9])`);
    const lead = parts.findIndex(p => /\d/.test(p));
    const body = lead < 0 ? [] : parts.slice(lead);
    // Payers often skip the series prefix ("FV", "FA"); allow that only when the numeric rest is still distinctive.
    const loose = lead > 0 && body.length >= 2 && body.join('').length >= 5 ? re(body) : null;
    // Any match contains every numeric part without its leading zeros: a cheap pre-check before the regex.
    const keys = parts.filter(p => /^\d+$/.test(p)).map(p => p.replace(/^0+(?=\d)/, ''));
    return { strict: re(parts), loose, keys };
}

const cents = n => Math.round(n * 100) / 100;

// Without the series prefix "1/2026" also reads as a month and "2026/12/014" as a date,
// so a loose match needs an invoice word in the title or the exact amount still due.
// Title only: bank rows add words like "rachunek nadawcy" (sender's account) to every line.
const INVOICE_WORD = /FAKTUR|(?<!\p{L})F[VA](?!\p{L})/u;

function matchInvoices(incoming, invoices) {
    const byKsef = new Map(invoices.filter(i => i.ksef).map(i => [i.ksef, i]));
    const res = new Map(invoices.map(inv => [inv, invoiceRegexes(inv.number)]));
    for (const inv of invoices) inv.paid = 0;
    for (const t of incoming) {
        const up = t.text.toUpperCase();
        const hits = new Map();
        for (const id of t.ids) if (id.ok && byKsef.has(id.id)) hits.set(byKsef.get(id.id), 'KSeF');
        // Full number (with series prefix) wins; only without any full hit fall back to the number without prefix,
        // so "FK 1/2026" (a correction) is not taken for "FV 1/2026".
        const byNumber = kind => invoices.filter(inv => !hits.has(inv) && res.get(inv).keys.every(k => up.includes(k)) && res.get(inv)[kind]?.test(up));
        const wordy = INVOICE_WORD.test(t.title.toUpperCase());
        const strict = byNumber('strict');
        const kind = strict.length ? 'strict' : 'loose';
        const numbered = strict.length ? strict
            : byNumber('loose').filter(inv => wordy || cents(t.amount) === cents(inv.gross - inv.paid));
        const pos = inv => up.search(res.get(inv)[kind]);
        for (const inv of numbered.sort((a, b) => pos(a) - pos(b))) hits.set(inv, 'numer faktury');
        t.matches = [...hits].map(([inv, by]) => ({ inv, by }));
        if ((t.status === 'none' || t.status === 'bad') && t.matches.length) t.status = 'nr';
        // One transfer can pay several invoices: KSeF hits first, then invoice numbers in title order; the rest is an overpayment.
        let left = isNaN(t.amount) ? 0 : t.amount;
        for (const { inv } of t.matches) {
            const part = isNaN(inv.gross) ? left : Math.min(left, Math.max(cents(inv.gross - inv.paid), 0));
            inv.paid = cents(inv.paid + part);
            left = cents(left - part);
        }
        t.overpaid = t.matches.length ? left : 0;
    }
    for (const inv of invoices) inv.status = inv.paid <= 0 ? 'unpaid' : isNaN(inv.gross) || inv.paid >= inv.gross ? 'paid' : 'partial';
}

// Search box: an invoice number typed by the user -> matching invoices and the payments for them.
function searchInvoiceNumber(query, analysis) {
    const q = String(query).toUpperCase();
    const own = invoiceRegexes(query);
    const pick = (items, test) => {
        for (const kind of ['strict', 'loose']) { const r = items.filter(x => test(x, kind)); if (r.length) return r; }
        return [];
    };
    const invoices = pick(analysis.invoices, (inv, kind) => invoiceRegexes(inv.number)[kind]?.test(q));
    const payments = analysis.incoming.filter(t => t.matches.some(m => invoices.includes(m.inv)))
        .concat(pick(analysis.incoming, (t, kind) => own[kind]?.test(t.text.toUpperCase())));
    return { invoices, payments: [...new Set(payments)] };
}

function analyze(text, invoices = []) {
    const res = parseStatement(text);
    const incoming = res.txs.filter(t => t.credit !== false).map(t => {
        const ids = findIds(t.text);
        return { ...t, ids, status: classify(ids), matches: [], overpaid: 0 };
    });
    invoices = invoices.map(i => ({ ...i }));
    matchInvoices(incoming, invoices);
    const count = s => incoming.filter(t => t.status === s).length;
    const invCount = s => invoices.filter(i => i.status === s).length;
    const stats = {
        incoming: incoming.length, ksef: count('ksef'), iz: count('iz'), bad: count('bad'), none: count('none'), nr: count('nr'),
        matched: incoming.filter(t => t.matches.length).length,
        paid: invCount('paid'), partial: invCount('partial'), unpaid: invCount('unpaid'),
    };
    stats.ready = incoming.length ? Math.round(100 * (stats.ksef + stats.iz) / incoming.length) : 0;
    return { format: res.format, warning: res.warning, total: res.txs.length, incoming, invoices, stats };
}

// --- Demo data for the "Zobacz przykład" button (also used by the tests) ---

const SAMPLE = `:20:PRZYKLAD
:25:/PL61109010140000071219812874
:28C:00001
:60F:C261201PLN1000,00
:61:2612021202C1230,00N051NONREF
:86:020~00VE02~20Przelew za 5265877635-20250~21826-0100001AF629-AF~32ACME SP. Z O.O.
:61:2612031203C5400,00N051NONREF
:86:020~00VE02~20Zapłata 5265877635-IZ202612-0A1B2C~213D4E5F-61~32BETA S.A.
:61:2612041204C861,00N051NONREF
:86:020~00VE02~20FV 2026/12/014~32GAMMA JAN KOWALSKI
:61:2612051205C2460,00N051NONREF
:86:020~00VE02~205265877635-20261203-010000~2145C1D2-F7~32DELTA SP. J.
:61:2612061206C300,00N051NONREF
:86:020~00VE02~205265877635-20250826-01000~2101AF629-AE~32OMEGA SP. Z O.O.
:61:2612071207D999,00N051NONREF
:86:020~00VE02~207811990046-20261203-01000045C1D2-7E~32DOSTAWCA SP. Z O.O.
:62F:C261207PLN10251,00`;

const SAMPLE_INVOICES = `Numer;Data wystawienia;Nabywca;Brutto;Numer KSeF
FV 2025/08/101;2025-08-26;ACME SP. Z O.O.;1 230,00;5265877635-20250826-0100001AF629-AF
FV 2026/12/003;2026-12-03;DELTA SP. J.;3 000,00;5265877635-20261203-01000045C1D2-F7
FV 2026/12/014;2026-12-04;GAMMA JAN KOWALSKI;861,00;
FV 2026/12/020;2026-12-05;EPSILON SP. Z O.O.;500,00;`;

// Node tests load this file with require(); in the browser it is a plain script and these are globals.
if (typeof module !== 'undefined') {
    module.exports = { crc8, findIds, classify, parseAmount, parse86, parseMT940, parseCSVRows, parseCSV, parseCAMT, parseStatement, parseFA, parseInvoiceCSV, parseInvoiceFile, invoiceRegexes, matchInvoices, searchInvoiceNumber, analyze, SAMPLE, SAMPLE_INVOICES };
}
