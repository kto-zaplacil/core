# kto-zaplacil core

The logic behind [kto-zaplacil.pl](https://kto-zaplacil.pl): it finds KSeF and IZ numbers in bank statements (MT940, CAMT.053, CSV) and matches payments to sales invoices (FA(3) XML or CSV). It runs in the browser as a plain script; under Node it loads with `require()`.

```sh
npm install
npm test
```

License: AGPL-3.0-only, see [LICENSE](LICENSE).
