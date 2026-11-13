// Tests for the checker's core logic (kto-zaplacil.js). Run: `npm test` or `node --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const {
    crc8, findIds, parseAmount, analyze, invoiceRegexes, parseInvoiceCSV, searchInvoiceNumber, SAMPLE, SAMPLE_INVOICES,
} = createRequire(import.meta.url)('../kto-zaplacil.js');

const invoiceRegex = n => invoiceRegexes(n).strict;
const statement = rows => 'Data;Tytuł;Kwota\n' + rows.map(([title, amount]) => `2026-12-10;${title};${amount}`).join('\n') + '\n';

describe('KSeF / IZ numbers', () => {
    it('matches the official docs checksum', () => {
        assert.equal(crc8('5265877635-20250826-0100001AF629'), 'AF');
        assert.deepEqual(findIds('5265877635-20250826-0100001AF629-AF').map(i => i.ok), [true]);
        assert.deepEqual(findIds('1111111111-IZ202607-65ED02180000-E7'), [{ id: '1111111111-IZ202607-65ED02180000-E7', type: 'iz', ok: true }]);
    });

    it('reports a typo but ignores hyphen-less digit runs such as account numbers', () => {
        assert.deepEqual(findIds('5265877635-20250826-0100001AF629-AE'), [{ id: '5265877635-20250826-0100001AF629-AE', type: 'ksef', ok: false }]);
        assert.equal(findIds('PL61109010140000071219812874 61109010140000071219812874123456').length, 0);
    });

    it('survives spaces, line breaks, lowercase and missing hyphens', () => {
        assert.equal(findIds('FV1/2026 5265877635 -20250826-0100001af629-\nAF')[0].ok, true);
        assert.equal(findIds('526587763520250826 0100001AF629AF')[0].ok, true);
    });
});

describe('amounts', () => {
    it('reads Polish and English formats', () => {
        assert.equal(parseAmount('1 230,00 PLN'), 1230);
        assert.equal(parseAmount('1.230,50'), 1230.5);
        assert.equal(parseAmount('1,230.50'), 1230.5);
        assert.equal(parseAmount('-45,10'), -45.1);
    });

    it('reads a lone 3-digit group as thousands, not decimals', () => {
        assert.equal(parseAmount('1,230'), 1230);
        assert.equal(parseAmount('1.230'), 1230);
    });
});

describe('statements', () => {
    it('MT940 sample: 5 incoming, 1 outgoing skipped, numbers split across ~20/~21', () => {
        const r = analyze(SAMPLE);
        assert.equal(r.format, 'MT940');
        assert.partialDeepStrictEqual(r.stats, { incoming: 5, ksef: 2, iz: 1, bad: 1, none: 1, ready: 60 });
        assert.equal(r.incoming[0].name, 'ACME SP. Z O.O.');
        assert.equal(r.incoming[0].amount, 1230);
    });

    it('mBank-style CSV: preamble, #-headers, ; separator, Polish amounts', () => {
        const csv = `mBank S.A.;Lista operacji\n\n#Data operacji;#Opis operacji;#Rachunek;#Kategoria;#Kwota;#Saldo po operacji;\n2026-12-02;"PRZELEW 5265877635-20250826-0100001AF629-AF ACME";PL...;Wpływy;"1 230,00 PLN";"5 000,00 PLN";\n2026-12-03;"ZAKUPY KARTA";PL...;Zakupy;"-45,10 PLN";"4 954,90 PLN";\n`;
        const c = analyze(csv);
        assert.equal(c.format, 'CSV');
        assert.partialDeepStrictEqual(c.stats, { incoming: 1, ksef: 1, iz: 0, bad: 0, none: 0, ready: 100 });
        assert.equal(c.incoming[0].amount, 1230);
    });

    it('CSV with separate credit and debit columns', () => {
        const csv = `Data;Kontrahent;Tytuł;Kwota uznania;Kwota obciążenia\n2026-12-02;Beta;Zapłata 5265877635-IZ202612-0A1B2C3D4E5F-61;5400,00;\n2026-12-03;Sklep;Zakup;;99,00\n`;
        assert.partialDeepStrictEqual(analyze(csv).stats, { incoming: 1, ksef: 0, iz: 1, bad: 0, none: 0, ready: 100 });
    });

    it('CSV without recognisable headers is searched but flagged', () => {
        const r = analyze('a;b\n5265877635-20250826-0100001AF629-AF;x\n');
        assert.ok(r.warning);
        assert.equal(r.stats.ksef, 1);
    });
});

describe('invoice-number regex', () => {
    it('tolerates separators and case, stays strict on boundaries', () => {
        const re = invoiceRegex('FV 2026/12/014');
        for (const ok of ['ZA FV2026-12-014', 'fv 2026 12 014 dzięki', 'FV/2026/12/014']) assert.ok(re.test(ok.toUpperCase()), ok);
        for (const no of ['FV 2026/12/0140', 'FV 2026/12/01', 'XFV 2026/12/014']) assert.ok(!re.test(no), no);
        assert.equal(invoiceRegex('1/2026'), null);
        assert.ok(invoiceRegexes('1/2026').loose.test('FAKTURA 1/2026'));
        assert.ok(!invoiceRegexes('1/2026').loose.test('FAKTURA 21/2026'));
        assert.equal(invoiceRegex('101'), null);
    });
});

describe('matching payments to invoices', () => {
    const invoices = parseInvoiceCSV(SAMPLE_INVOICES);

    it('sample: KSeF, invoice number, partial payment, IZ left unexpanded', () => {
        assert.equal(invoices.length, 4);
        assert.equal(invoices[0].ksef, '5265877635-20250826-0100001AF629-AF');
        const m = analyze(SAMPLE, invoices);
        assert.equal(m.stats.matched, 3);
        assert.deepEqual(Object.fromEntries(m.invoices.map(i => [i.number, [i.status, i.paid]])), {
            'FV 2025/08/101': ['paid', 1230],
            'FV 2026/12/003': ['partial', 2460],
            'FV 2026/12/014': ['paid', 861],
            'FV 2026/12/020': ['unpaid', 0],
        });
        assert.deepEqual(m.incoming.find(t => t.name === 'ACME SP. Z O.O.').matches.map(x => x.by), ['KSeF']);
        assert.deepEqual(m.incoming.find(t => t.name === 'GAMMA JAN KOWALSKI').matches.map(x => x.by), ['numer faktury']);
    });

    it('one transfer pays two invoices, the rest is an overpayment; input is not mutated', () => {
        const two = analyze(statement([['Za FV 2026/12/014 i FV 2026/12/020', '1400,00']]), invoices);
        assert.equal(two.incoming[0].matches.length, 2);
        assert.equal(two.incoming[0].overpaid, 39);
        assert.equal(invoices[0].paid, undefined);
    });

    it('a short transfer fills invoices in title order, not file order', () => {
        const inv = parseInvoiceCSV('Numer;Brutto\nFV 1/2026;1000,00\nFV 2/2026;500,00\n');
        const r = analyze(statement([['FV 2/2026 FV 1/2026', '1000,00']]), inv);
        assert.deepEqual(r.invoices.map(i => [i.number, i.status, i.paid]), [['FV 1/2026', 'partial', 500], ['FV 2/2026', 'paid', 500]]);
    });

    describe('real-world titles', () => {
        const real = parseInvoiceCSV('Numer;Kontrahent;Kwota\nFV/0014/12/2026;A;100,00\nFV 7/2026;B;200,00\nFA/2026/12/0003;C;300,00\nFK 7/2026;D;-50,00\nFV 101;E;10,00\n');
        const hit = (title, amount = '100,00') => {
            const t = analyze(statement([[title, amount]]), real).incoming[0];
            return [t.status, t.matches.map(x => x.inv.number)];
        };

        it('parses all invoices', () => assert.equal(real.length, 5));
        it('a correction with a negative amount is not unpaid', () => {
            const r = analyze('', real);
            assert.equal(r.invoices.find(i => i.number === 'FK 7/2026').status, 'correction');
            assert.equal(r.stats.unpaid, 4);
        });
        it('no prefix, dropped zeros', () => assert.deepEqual(hit('Faktura 14/12/2026'), ['nr', ['FV/0014/12/2026']]));
        it('ambiguous without prefix: both shown', () => assert.deepEqual(hit('zapłata za fakturę 7/2026'), ['nr', ['FV 7/2026', 'FK 7/2026']]));
        it('full number beats the correction FK 7/2026', () => assert.deepEqual(hit('FV 7/2026'), ['nr', ['FV 7/2026']]));
        it('prefix with dropped zeros', () => assert.deepEqual(hit('FA 2026/12/3'), ['nr', ['FA/2026/12/0003']]));
        it('short number with its prefix', () => assert.deepEqual(hit('FV 101'), ['nr', ['FV 101']]));
        it('short number without prefix is noise', () => assert.deepEqual(hit('przelew 101'), ['none', []]));
        it('unknown number', () => assert.deepEqual(hit('okres 17/2026'), ['none', []]));
    });

    describe('loose matches need an invoice word or the exact amount due', () => {
        const inv = parseInvoiceCSV('Numer;Brutto\nFV 1/2026;500,00\nFV 2026/12/014;861,00\n');
        const statusOf = (title, amount) => analyze(statement([[title, amount]]), inv).incoming[0].matches.map(m => m.inv.number);

        it('a month reference is not an invoice', () => assert.deepEqual(statusOf('Czynsz za 01/2026', '800,00'), []));
        it('a date is not an invoice', () => assert.deepEqual(statusOf('Zapłata z dnia 2026-12-14', '300,00'), []));
        it('exact amount due accepts it', () => assert.deepEqual(statusOf('przelew 1/2026', '500,00'), ['FV 1/2026']));
        it('an invoice word accepts it', () => assert.deepEqual(statusOf('faktura 1/2026', '200,00'), ['FV 1/2026']));
        it('a Polish letter after FA is not an invoice word', () => assert.deepEqual(statusOf('FAŁSZYWY 01/2026', '800,00'), []));
        it('bank wording outside the title does not count (PKO export)', () => {
            const pko = '"Data operacji","Data waluty","Typ transakcji","Kwota","Waluta","Saldo po transakcji","Opis transakcji","","",""\n'
                + '"2026-02-01","2026-02-01","Przelew na rachunek","+800.00","PLN","+1800.00","Tytuł: Czynsz za 01/2026","Nazwa nadawcy: JAN NOWAK","Rachunek nadawcy: 12 1020 0000 0000 0000 0000 0000",""\n';
            const r = analyze(pko, inv);
            assert.equal(r.incoming[0].title, 'Tytuł: Czynsz za 01/2026');
            assert.deepEqual([r.incoming[0].matches, r.invoices[0].status], [[], 'unpaid']);
        });
        it('a number without a prefix is not matched by a month or a date column', () => {
            const plain = parseInvoiceCSV('Numer;Brutto\n1/2026;500,00\n14/12/2026;900,00\n');
            const r = analyze('Data;Tytuł;Kwota\n2026-12-10;Czynsz za 01/2026;800,00\n14.12.2026;Wynagrodzenie;50,00\n', plain);
            assert.deepEqual(r.incoming.map(t => t.matches.length), [0, 0]);
            assert.deepEqual(analyze(statement([['Faktura 1/2026', '200,00']]), plain).incoming[0].matches.map(m => m.inv.number), ['1/2026']);
        });
        it('marks the invoice unpaid when the payment was rent', () => {
            assert.equal(analyze(statement([['Czynsz za 01/2026', '500,01']]), inv).invoices[0].status, 'unpaid');
        });
    });
});

describe('search box', () => {
    const invoices = parseInvoiceCSV(SAMPLE_INVOICES);

    it('finds the invoice and its payment', () => {
        const found = searchInvoiceNumber('FV 2026/12/014', analyze(SAMPLE, invoices));
        assert.deepEqual(found.invoices.map(i => [i.number, i.status]), [['FV 2026/12/014', 'paid']]);
        assert.deepEqual(found.payments.map(t => t.name), ['GAMMA JAN KOWALSKI']);
    });

    it('works with invoices only, or with a statement only', () => {
        assert.deepEqual(searchInvoiceNumber('fv2026-12-3', analyze('', invoices)).invoices.map(i => i.number), ['FV 2026/12/003']);
        assert.deepEqual(searchInvoiceNumber('FV 2026/12/014', analyze(SAMPLE, [])).payments.map(t => t.name), ['GAMMA JAN KOWALSKI']);
    });
});
