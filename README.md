# 🔀 Scrambler

[![CI](https://github.com/schlangens/scrambler/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/schlangens/scrambler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Mask PII in text or redact PII from PDFs before sharing them with an LLM.

- **Live demo:** https://scramble.scottslab.io
- **Full write-up:** *Stop Feeding Your Secrets to ChatGPT* — https://scottslab.io/posts/scrambler-anonymize-data-llms

## The problem

Pasting a log, a medical record, or a support ticket into a public AI chatbot hands that data to a third party. Even when the vendor promises not to train on it, the text has left your control and becomes a compliance problem. Scrambler replaces sensitive values with synthetic ones before they reach the AI, and permanently removes them from uploaded PDFs.

## How it works

The tool has two modes with a strict split between the browser and the server.

**Text masking — entirely client-side.** `public/index.html` is a shell that loads `public/styles.css` and `public/app.js`. `public/app.js` runs the regular expressions, builds a real→fake mapping in JavaScript memory, and replaces the sensitive substrings. The mapping never leaves the tab. You copy the masked text to the LLM, paste the response back, and the same in-memory mapping restores the original values. No network request is made for text masking.

**PDF redaction — server-side and ephemeral.** The browser uploads the PDF once. The server holds it in memory only (`multer.memoryStorage()` in `src/server.js`), streams the bytes through a Python process, and returns the redacted PDF. Nothing is written to disk, nothing is stored in a database, and the file buffer is cleared after the response is sent.

```
Text mode (browser only)
  input ──► regex detection ──► mask with fake values ──► LLM
                   ▲                          │
                   └──── mappings (memory) ─────┘

PDF mode (one upload, server-side)
  browser ──► upload PDF ──► Node server ──► python3 src/services/redact.py
                ▲                              (stdin/stdout, no disk)
                └────── redacted bytes ────────┘
```

Two PDF endpoints are available. `POST /api/pdf/redact` returns the redacted PDF as a binary `application/pdf` download (`Content-Disposition: attachment; filename="redacted.pdf"`). `POST /api/pdf/analyze` returns the same redacted PDF as `pdfBase64` plus JSON metadata: `detections`, `originalPageCount`, `newPageCount`, `charCount`, and `redactedCharCount`.

## Privacy and threat model

This is the section a security reviewer should read first.

- **What the server receives.** In text mode, the server receives nothing. In PDF mode it receives the PDF bytes for the duration of the request. The file is held in a `multer` memory buffer, passed to the redactor, and both `req.file.buffer` and `result.pdfBuffer` are set to `null` after the response is sent (`src/server.js`).
- **What is stored.** No PII is stored. The real→fake mapping is a JavaScript variable in `public/app.js` (`mappings`) and is gone when the tab closes. The browser's `localStorage` is used only for non-sensitive UI state: the on/off toggles, the selected preset, and the state of the "Remember my custom terms" checkbox. The always-mask and never-mask term lists are only written to `localStorage` if the user explicitly checks that checkbox; by default they are not. There is no database, no `sessionStorage`, no `indexedDB`, no user accounts, and no `data/` directory. `.gitignore` excludes `.env` and `data/` as defense in depth.
- **What is logged.** Server logs contain only the listening port, rate-limiter metadata, and generic error categories such as `PDF processing failed` or `Internal server error`. The Python redactor’s `stderr` is discarded. Request bodies, file contents, detected values, and original text are never logged.
- **What happens client-side.** `public/app.js` performs all detection, mapping, masking, and unmasking in JavaScript. The mapping array lives in the page’s memory and is gone when the tab closes.
- **What this does not protect against.**
  - Detection is regex-based. It will miss PII and it will over-match: plain dates as birthdates; invoice numbers, ticket IDs, and part numbers as driver's licences (`[A-Z]{1,3}\d{6,10}`); and any 16-digit grouped number as a credit card because there is no Luhn validation.
  - Specific gaps: IPv6 addresses; international and non-NANP phone numbers (for example, `+44 20 7946 0958`); passport numbers and national ID numbers of any country; dates written day-first (`DD/MM/YYYY`); and SSNs separated by spaces instead of dashes or dots.
  - Names, company names, codenames, and hostnames cannot be reliably pattern-matched. Add them manually or use the always-mask list.
  - The AI provider still receives the masked text and any surrounding context. You are trusting them with the synthetic version.
  - The real→fake mapping lives in your browser tab. Anyone with access to your unlocked machine while the tab is open can reverse the masking.
  - A hosted instance is only as trustworthy as its operator. Audit the source, run it locally, or use the offline copy.
  - **Scanned or image-only PDFs.** A page that is just a picture of text has no extractable text layer, so the redactor has nothing to search and the page is returned unchanged. A scanned document can report zero detections and still contain personal data in the images.

## Verify it yourself

You do not have to trust the claims. Check them directly.

1. **Text masking makes no network requests.** Open your browser’s DevTools Network tab, paste `My SSN is 555-12-3456` into the Text tab, and click *Mask*. No request is recorded.
2. **No persistent storage of the mapping or custom terms by default.** The real→fake mapping is kept in the `mappings` variable in `public/app.js` and is never written to `localStorage`. The only `localStorage` keys used are `scrambler-toggles`, `scrambler-preset`, and `scrambler-remember-terms`; the custom term lists are only written when the user checks "Remember my custom terms":
   ```bash
   grep -R "sessionStorage\|indexedDB" public/
   ```
   This returns nothing. `grep -E "scrambler-(toggles|preset|remember|always|never)|localStorage" public/app.js` shows the `STORAGE` map and only the `getItem`/`setItem`/`removeItem` helpers, with conditional writes for the custom term lists.
3. **No server-side storage for text.** Confirm the removed routes are gone:
   ```bash
   curl -X POST http://localhost:3057/api/mask  # 404
   curl -X POST http://localhost:3057/api/unmask  # 404
   curl http://localhost:3057/api/mappings  # 404
   curl -X POST http://localhost:3057/auth/login  # 404
   ```
4. **No disk writes in the redactor.** Inspect the source:
   ```bash
   grep -R "require('fs')\|writeFileSync\|readFileSync" src/services/pdf-redactor.js
   ```
   This returns nothing. The redactor uses `spawn` with `stdio: 'pipe'` and streams the PDF through stdin/stdout.
5. **The Python redactor works from bytes.** `src/services/redact.py` opens the file with `fitz.open(stream=pdf_bytes, filetype="pdf")` and writes the output with `doc.tobytes()`. No temporary files are created.
6. **Run the tests.** `node --test "tests/*.test.js"` runs the test suite, which asserts that nothing is written to disk, that the offline file contains no network references, and that redacted PDFs no longer contain the matched strings.

## What is detected

Detection is regex-based. Text mode uses the patterns in `public/app.js`; PDF mode uses the patterns in `src/services/redact.py`. The two paths are maintained independently, so behaviour can differ. The browser side detects driver's licence numbers and treats `policy` as an account keyword; the PDF side does not detect driver's licences and requires a DOB/birth keyword before a date. Both sides catch SSNs, emails, US-style phone numbers, IPv4 addresses, MRNs, account/patient/member IDs, and credit cards. Do not assume parity between the two engines.

| Type | Example input | Text mask | PDF redaction |
|---|---|---|---|
| SSN | `555-12-3456` | `XXX-XX-1000` | `[REDACTED]` or a black bar |
| Email | `alice.smith@example.com` | `alex.smith@contoso.com` | `[REDACTED]` or a black bar |
| Phone | `(555) 987-6543` | `(555) 100-1000` | `[REDACTED]` or a black bar |
| IP address | `10.0.0.1` | `10.0.0.0` | `[REDACTED]` or a black bar |
| Date of birth | `DOB: 11/22/1990` | `XX/XX/1950` | `[DOB REDACTED]` or a black bar |
| MRN | `MRN: 12345678` | `MRN-100000` | `[REDACTED]` or a black bar |
| Account / patient / member ID | `Account: 12345678` | `ACCT-000000` | `[REDACTED]` or a black bar |
| Credit card | `5555-4444-3333-2222` | `XXXX-XXXX-XXXX-1000` | `[REDACTED]` or a black bar |
| Driver's license | `DL1234567` | `DL-100000` | not detected |

The replacement values in text mode rotate through a small pool of synthetic names, companies, domains, and addresses. They are meant to be realistic, not real.

## Tailoring what gets masked

The Text tab exposes per-type on/off switches for each detected type (SSN, Email, Phone, IP, DOB, MRN, Account, Credit Card, and Driver's License). The controls are in `public/index.html`; the masking logic is in `public/app.js`. Below that are two plain-text lists and a preset selector:

- **Always mask** — one term per line. Any occurrence is replaced before the regex pass runs. Use this for names, company names, codenames, hostnames, and project names that no pattern can catch.
- **Never mask** — one term per line. These are copied verbatim and override every other rule.
- **Presets** — quick switches for common jobs. `public/app.js` defines *Everything* (all types), *Technical documentation* (SSN, email, phone, MRN, account, credit card, and driver's license), and *Medical records* (all types, with MRN and DOB emphasised).

**Precedence:** never-mask list > always-mask list > per-type toggles.

The custom term lists are **not saved to the browser** by default. The "Remember my custom terms" checkbox is off, so `public/app.js` removes `scrambler-always-mask` and `scrambler-never-mask` from `localStorage` whenever they are saved. If the user explicitly opts in, the lists are written to `localStorage`. This is deliberate: those lists often contain the exact names, codenames, or hostnames the user is trying to protect, so persisting them by default would create a local record of the secrets.

## Running it completely offline

`public/scrambler-offline.html` is generated, not hand-maintained. `npm run build:offline` runs `node scripts/build-offline.js`, which reads `public/index.html`, `public/styles.css`, and `public/app.js`, inlines the CSS and JavaScript, strips the PDF tab and every PDF-related function, and asserts that the output contains no `fetch`, `XMLHttpRequest`, `WebSocket`, `<script src=`, `<link`, `http://`, or `https://` references. The build fails if any network reference remains.

The checked-in `public/scrambler-offline.html` is regenerated in CI. `.github/workflows/ci.yml` runs `node scripts/build-offline.js` and then `git diff --exit-code public/scrambler-offline.html`, so the committed copy cannot drift from the source. The build is deterministic, so repeated runs produce identical bytes.

Save the file to your own machine, disconnect from the network, and open it straight from disk. It performs the same text masking as the hosted version. PDF redaction is not available offline because it requires the server-side redactor.

To verify it makes no network calls, open DevTools Network and reload the file. No requests appear. You can also search the saved file for `fetch(`, `XMLHttpRequest`, `WebSocket`, `http://`, or `https://`; the build rejects any of these.

## Quick start

Prerequisites: Node.js >=20 and Python 3 with the pinned Python dependencies in `requirements.txt` (`pip install -r requirements.txt`).

Local:

```bash
git clone https://github.com/schlangens/scrambler.git
cd scrambler
pip install -r requirements.txt
npm install
npm start
# open http://localhost:3057
```

In a container:

```bash
docker build -t scrambler .
docker run --rm -p 3057:3057 scrambler
```

Then visit `http://localhost:3057`. The `/health` endpoint should return `{"status":"ok"}`.

## Configuration

The application reads only these environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3057` |
| `SCRAMBLER_REDACT_TIMEOUT_MS` | PDF redactor child timeout in milliseconds | `60000` |
| `SCRAMBLER_MAX_FILE_SIZE` | Maximum PDF payload size (in bytes) that the Python redactor will accept. The Node.js `multer` limit is hardcoded to 10 MB in `src/services/pdf-redactor.js`, so this variable can only lower the effective limit; raising it above 10 MB has no effect. | `10485760` (10 MB) |

There are no database connection strings, authentication secrets, or API keys. The server starts without a `.env` file.

## Security posture

- No database, no user accounts, no login/session state, and no server-side text masking.
- `Content-Security-Policy: default-src 'self'` with no `unsafe-inline` and no external hosts; the UI loads no third-party resources.
- Helmet sets HSTS, frame-ancestors deny, no-sniff, strict referrer, COOP, and CORP.
- PDF endpoints are rate-limited per IP (20 requests per 15 minutes) with `app.set('trust proxy', 1)` so the limiter key is the address supplied by the reverse proxy, not a forged `X-Forwarded-For` left-most value. The limiter fails closed if the client address cannot be determined.
- Uploaded PDFs are validated by magic bytes (`%PDF`) before the redactor runs.
- The redactor spawns `python3 src/services/redact.py` with an argument array and `stdio: 'pipe'`; no shell, no temporary files, and the child is killed on timeout.
- `redact.py` rejects encrypted PDFs, re-opens the output bytes, and verifies that none of the matched strings remain in the text layer. If it cannot locate a detected value geometrically, the request fails closed and no PDF is returned.
- Server errors return generic messages to the client; details stay server-side.

Detailed hardening decisions are in [SECURITY.md](SECURITY.md).

## Project history / transparency note

When Scrambler was open-sourced, the repository included a server-side text-masking route (`/api/mask`) and an SQLite database (`src/services/database.js`) that stored original-to-fake PII mappings. It also contained an unused Passport/Google OAuth and break-glass local authentication layer. That design directly contradicted the claim that nothing a user types is stored on the server, so it was removed in the same cleanup. The current release has no `/api/mask`, `/api/unmask`, `/auth/*`, or `/login` routes, no `database.js`, no `data/` directory, and no SQLite dependency.

## License and credits

MIT License. Copyright Scott Schlangen.

Built as part of [Scott's Lab](https://scottslab.io). Full write-up: [Stop Feeding Your Secrets to ChatGPT](https://scottslab.io/posts/scrambler-anonymize-data-llms).
