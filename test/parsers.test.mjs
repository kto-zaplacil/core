// Basic tests for the statement and invoice parsers in kto-zaplacil.js. Run: `npm test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DOMParser } from '@xmldom/xmldom';

// The XML parsers use the browser's DOMParser; xmldom stands in for it under Node.
globalThis.DOMParser = DOMParser;

const {
    findIds, parse86, parseMT940, parseCSVRows, parseCSV, parseCAMT, parseStatement, parseFA, parseInvoiceCSV, parseInvoiceFile, SAMPLE,
} = createRequire(import.meta.url)('../kto-zaplacil.js');

const KSEF = '5265877635-20250826-0100001AF629-AF';

describe('parse86 (MT940 :86: details)', () => {
    it('joins title fields ~20..~26 and name fields ~32..~33', () => {
        assert.deepEqual(
            { ...parse86('020~00VE02~20Przelew za FV 1~21/2026~32ACME SP~33. Z O.O.'), text: undefined },
            { title: 'Przelew za FV 1/2026', name: 'ACME SP. Z O.O.', text: undefined },
        );
    });

    it('detects other separators', () => {
        for (const sep of ['^', '<', '?']) {
            const r = parse86(`020${sep}20Tytul${sep}32Nadawca`);
            assert.deepEqual([r.title, r.name], ['Tytul', 'Nadawca'], sep);
        }
    });

    it('falls back to name fields ~27..~29', () => {
        assert.equal(parse86('020~20Tytul~27JAN ~28KOWALSKI').name, 'JAN KOWALSKI');
    });

    it('takes unstructured text as the title', () => {
        assert.deepEqual(parse86('PRZELEW FV 1/2026\nACME'), { title: 'PRZELEW FV 1/2026ACME', name: '', text: 'PRZELEW FV 1/2026ACME' });
    });

    it('keeps the raw text searchable', () => {
        assert.ok(parse86('020~20Tytul~32Nadawca').text.includes('Nadawca'));
    });
});

describe('parseMT940', () => {
    const { txs } = parseMT940(SAMPLE);

    it('reads every :61: line with its :86: details', () => {
        assert.equal(txs.length, 6);
        assert.deepEqual(txs.map(t => [t.date, t.credit, t.amount]), [
            ['2026-12-02', true, 1230],
            ['2026-12-03', true, 5400],
            ['2026-12-04', true, 861],
            ['2026-12-05', true, 2460],
            ['2026-12-06', true, 300],
            ['2026-12-07', false, 999],
        ]);
        assert.equal(txs[2].title, 'FV 2026/12/014');
        assert.equal(txs[2].name, 'GAMMA JAN KOWALSKI');
    });

    it('treats a reversed debit (RD) as money in and a reversed credit (RC) as money out', () => {
        const { txs } = parseMT940(':61:2612021202RD10,00N051NONREF\n:61:2612021202RC20,00N051NONREF');
        assert.deepEqual(txs.map(t => t.credit), [true, false]);
    });

    it('handles CRLF, a missing entry date and a :86: spread over lines', () => {
        const { txs } = parseMT940(':20:X\r\n:61:261202C15,50NTRFNONREF\r\n:86:020~20Zaplata za\r\n FV 1/2026~32ACME\r\n:62F:C261202PLN15,50');
        assert.equal(txs.length, 1);
        assert.deepEqual([txs[0].date, txs[0].amount, txs[0].title, txs[0].name], ['2026-12-02', 15.5, 'Zaplata za FV 1/2026', 'ACME']);
    });

    it('does not let a second :86: overwrite the first', () => {
        const { txs } = parseMT940(':61:261202C1,00N051NONREF\n:86:020~20pierwszy\n:86:020~20drugi');
        assert.equal(txs[0].title, 'pierwszy');
    });
});

describe('parseCSVRows', () => {
    it('handles quotes, escaped quotes, delimiters and newlines inside quotes', () => {
        assert.deepEqual(parseCSVRows('a;"b;c";"say ""hi"""\r\n"multi\nline";x', ';'), [['a', 'b;c', 'say "hi"'], ['multi\nline', 'x']]);
    });

    it('keeps a last row without a trailing newline', () => {
        assert.deepEqual(parseCSVRows('a,b\nc,d', ','), [['a', 'b'], ['c', 'd']]);
    });
});

describe('parseCSV (bank statement)', () => {
    it('guesses the delimiter and the columns', () => {
        for (const d of [';', '\t', ',']) {
            const csv = ['Data', 'Kontrahent', 'Tytuł', 'Kwota'].join(d) + '\n' + ['2026-12-02', 'ACME', 'FV 1', '"100.50"'].join(d) + '\n';
            const { txs, warning } = parseCSV(csv);
            assert.equal(warning, undefined, JSON.stringify(d));
            assert.deepEqual(txs.map(t => [t.date, t.name, t.title, t.amount, t.credit]), [['2026-12-02', 'ACME', 'FV 1', 100.5, true]], JSON.stringify(d));
        }
    });

    it('signs amounts from separate credit/debit columns', () => {
        const { txs } = parseCSV('Data;Opis;Uznania;Obciążenia\n2026-12-02;a;100,00;\n2026-12-03;b;;40,00\n');
        assert.deepEqual(txs.map(t => [t.amount, t.credit]), [[100, true], [-40, false]]);
    });

    it('reads the direction from a single Credit/Debit column', () => {
        const { txs } = parseCSV('Date;Description;Credit/Debit;Amount\n2026-12-02;FV 1;Credit;100.00\n2026-12-03;b;Debit;40.00\n');
        assert.deepEqual(txs.map(t => [t.amount, t.credit]), [[100, true], [-40, false]]);
    });

    it('skips rows without an amount', () => {
        assert.equal(parseCSV('Data;Tytuł;Kwota\n2026-12-02;a;10,00\n;Saldo końcowe;\n').txs.length, 1);
    });

    it('prefers a "Tytuł" column over "Opis"', () => {
        assert.equal(parseCSV('Data;Opis;Tytuł;Kwota\n2026-12-02;PRZELEW;FV 1;10,00\n').txs[0].title, 'FV 1');
    });

    it('without headers: every row is searched and a warning is shown', () => {
        const { txs, warning } = parseCSV('x;y\nz;w\n');
        assert.ok(warning);
        assert.deepEqual(txs.map(t => [t.title, t.credit]), [['x y', null], ['z w', null]]);
    });
});

describe('parseCAMT (CAMT.053 XML)', () => {
    const camt = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Ntry>
    <Amt Ccy="PLN">1230.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-12-02</Dt></BookgDt>
    <NtryDtls><TxDtls>
      <RltdPties><Dbtr><Nm>ACME SP. Z O.O.</Nm></Dbtr><Cdtr><Nm>MY FIRM</Nm></Cdtr></RltdPties>
      <RmtInf><Ustrd>Przelew za</Ustrd><Ustrd>${KSEF}</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
  </Ntry>
  <Ntry>
    <Amt Ccy="PLN">99.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><DtTm>2026-12-03T10:00:00</DtTm></BookgDt>
    <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>DOSTAWCA</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
    <AddtlNtryInf>Zakup materiałów</AddtlNtryInf>
  </Ntry>
</Stmt></BkToCstmrStmt></Document>`;

    it('reads each entry: date, direction, signed amount, counterparty, title', () => {
        const { txs } = parseCAMT(camt);
        assert.deepEqual(txs.map(t => [t.date, t.credit, t.amount, t.name, t.title]), [
            ['2026-12-02', true, 1230, 'ACME SP. Z O.O.', `Przelew za ${KSEF}`],
            ['2026-12-03', false, -99, 'DOSTAWCA', 'Zakup materiałów'],
        ]);
    });

    it('is picked by parseStatement, even after a BOM', () => {
        assert.equal(parseStatement('﻿' + camt).format, 'CAMT.053');
    });

    it('finds a number in minified XML when the previous field ends in a digit', () => {
        const entry = details => parseCAMT(`<Document><Ntry><Amt>1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Refs><EndToEndId>123</EndToEndId></Refs>${details}</Ntry></Document>`).txs[0];
        for (const details of [
            `<AddtlTxInf>${KSEF}</AddtlTxInf>`,
            `<RmtInf><Ustrd>${KSEF.slice(0, 20)}</Ustrd><Ustrd>${KSEF.slice(20)}</Ustrd></RmtInf>`,
        ]) assert.deepEqual(findIds(entry(details).text).map(i => [i.id, i.ok]), [[KSEF, true]]);
    });
});

describe('parseStatement (format detection)', () => {
    it('picks MT940 by its :61: tag and CSV otherwise', () => {
        assert.equal(parseStatement(SAMPLE).format, 'MT940');
        assert.equal(parseStatement('Data;Tytuł;Kwota\n').format, 'CSV');
    });
});

describe('parseFA (KSeF FA(3) invoice XML)', () => {
    const fa = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1><DaneIdentyfikacyjne><NIP>5265877635</NIP><Nazwa>MY FIRM</Nazwa></DaneIdentyfikacyjne></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>ACME SP. Z O.O.</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa>${body}</Fa>
</Faktura>`;

    it('reads number, date, gross, buyer, and the KSeF number from the file name', () => {
        assert.deepEqual(parseFA(fa('<P_1>2025-08-26</P_1><P_2>FV 2025/08/101</P_2><P_15>1230.00</P_15>'), `${KSEF}.xml`), [
            { number: 'FV 2025/08/101', date: '2025-08-26', gross: 1230, buyer: 'ACME SP. Z O.O.', ksef: KSEF },
        ]);
    });

    it('takes the buyer from Podmiot2, not the seller', () => {
        assert.equal(parseFA(fa('<P_2>FV 1</P_2><P_15>1</P_15>'), 'x.xml')[0].buyer, 'ACME SP. Z O.O.');
    });

    it('leaves the KSeF number empty when the file name has none', () => {
        assert.equal(parseFA(fa('<P_2>FV 1</P_2><P_15>1</P_15>'), 'faktura.xml')[0].ksef, '');
    });

    it('returns nothing for XML without an invoice number', () => {
        assert.deepEqual(parseFA('<Inny><P_15>1</P_15></Inny>', 'x.xml'), []);
    });
});

describe('parseInvoiceCSV', () => {
    it('picks the number, gross, buyer and KSeF columns, not their look-alikes', () => {
        const csv = 'Lp;Numer KSeF;NIP nabywcy;Nabywca;Numer faktury;Data wystawienia;Kwota netto;Kwota brutto\n'
            + `1;${KSEF};1111111111;ACME;FV 1/2026;2026-01-05;1000,00;1 230,00\n`;
        assert.deepEqual(parseInvoiceCSV(csv), [{ number: 'FV 1/2026', date: '2026-01-05', gross: 1230, buyer: 'ACME', ksef: KSEF }]);
    });

    it('drops an invalid KSeF number and rows without a number', () => {
        const csv = 'Numer;Brutto;KSeF\nFV 1;10,00;5265877635-20250826-0100001AF629-AE\n;20,00;\n';
        assert.deepEqual(parseInvoiceCSV(csv).map(i => [i.number, i.ksef]), [['FV 1', '']]);
    });

    it('returns nothing when no header is found', () => {
        assert.deepEqual(parseInvoiceCSV('a;b\nc;d\n'), []);
    });
});

describe('parseInvoiceFile', () => {
    it('sends XML to parseFA and anything else to parseInvoiceCSV', () => {
        assert.equal(parseInvoiceFile('﻿<Faktura><Fa><P_2>FV 9</P_2><P_15>9</P_15></Fa></Faktura>', 'a.xml')[0].number, 'FV 9');
        assert.equal(parseInvoiceFile('Numer;Brutto\nFV 8;8,00\n', 'a.csv')[0].number, 'FV 8');
    });
});
