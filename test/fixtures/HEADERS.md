# Header policy

Every hand-written source file carries the Fin project header:

- `src/**/*.ts` — server implementation
- `test/**/*.ts` — unit and integration tests
- `test/tools/smoke.js` — the CI entry-point check
- `test/fixtures/fake-finc.js` — the stand-in compiler used by failure tests

Generated or non-source files do not: `package.json`, `package-lock.json`, `dist/`,
`*.md`, `.gitignore`, `.github/workflows/ci.yml`, and `LICENSE`.

## Exception: byte-exact `.fin` fixtures

`test/fixtures/ascii.fin`, `crlf.fin`, and `unicode.fin` are **input data**, not
source. They are paired with the captured compiler reports in `test/fixtures/finc-*.jsonl`,
and their byte layout is the thing under test:

- `crlf.fin` must keep CRLF terminators, because the point of that fixture is that a
  CRLF document converts to the same ranges as an LF one;
- `unicode.fin` must keep its emoji and `é`, because the point of that fixture is that
  the compiler's byte columns differ from UTF-16 columns;
- `ascii.fin` is the baseline those two are compared against.

Inserting a comment header changes every byte offset and would make the captured
diagnostics describe a different file. They are deliberately skipped.

## Re-running the tool

```sh
python3 fin_header.py --repo fin-lsp --license MIT src test
git checkout -- test/fixtures/*.fin   # the three data files are not source
python3 fin_header.py --repo fin-lsp --license MIT --check src test
```

The `--check src test` run is expected to report zero changes; checking `.` would
report these three data files and nothing else.
