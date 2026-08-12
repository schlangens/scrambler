# Contributing to Scrambler

Thanks for helping make Scrambler safer and simpler.

## Running it locally

You need Node.js >= 20 and Python 3 with PyMuPDF.

```bash
git clone https://github.com/schlangens/scrambler.git
cd scrambler
pip install -r requirements.txt
npm install
npm start
```

Visit `http://localhost:3057`. The `/health` endpoint should return `{"status":"ok"}`.

You can also build the offline copy:

```bash
npm run build:offline
```

This writes `public/scrambler-offline.html`, a single self-contained file for
text masking only.

## Running the tests

```bash
npm test
```

The test suite checks that text masking makes no network calls, that the
offline file has no external references, and that PDF redaction never writes
the uploaded file to disk.

## What makes a good pull request

- Keep the change focused. One logical fix or feature per PR.
- Explain the security or privacy impact in the PR description, even if the
  change seems small.
- Include the exact commands you ran and their real output for manual checks,
  especially when the change touches packaging, CI, or the offline build.
- Make sure `npm run build:offline` regenerates `public/scrambler-offline.html`
  and that the committed copy matches the freshly built one.
- Do not introduce new dependencies unless the standard library or an
  already-installed package cannot do the job.

## One hard rule

**Never commit real personal data.** Use only synthetic PII in tests, fixtures,
screenshots, and documentation. The project exists to help people protect data,
not to leak it.
