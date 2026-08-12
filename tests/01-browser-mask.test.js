const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers/app-loader');
const { SYNTHETIC_PII, FALSE_POSITIVES, sampleParagraph } = require('./fixtures');

describe('Browser-side text masking', () => {
  it('loads the masking source (public/app.js preferred, inline fallback)', () => {
    const app = loadApp();
    assert(app.exists, 'No masking source found (expected public/app.js or inline script in public/index.html)');
    assert(['app.js', 'inline', 'offline'].includes(app.source), `Unexpected source: ${app.source}`);
  });

  it('masks every supported PII type and removes the original values', () => {
    const app = loadApp();
    const input = sampleParagraph();
    const { text, mappings } = app.mask(input);

    assert.strictEqual(app.networkCalls.length, 0, 'Masking must not make any network request');
    assert.ok(text.length > 0, 'Masked text should not be empty');

    const originals = mappings.map((m) => m.original);
    for (const value of originals) {
      assert.ok(!text.includes(value), `Masked output still contains original value: ${value}`);
    }

    // Specific supported types.
    assert.ok(text.includes('SSN:'), 'Expected SSN label to remain in output');
    assert.ok(mappings.some((m) => m.type === 'SSN' || m.type === 'ssn'), 'Expected an SSN mapping');
    assert.ok(mappings.some((m) => m.type === 'Email' || m.type === 'email'), 'Expected an email mapping');
    assert.ok(mappings.some((m) => m.type === 'Phone' || m.type === 'phone'), 'Expected a phone mapping');
    assert.ok(mappings.some((m) => m.type === 'IP' || m.type === 'ip'), 'Expected an IP mapping');
    assert.ok(mappings.some((m) => m.type === 'DOB' || m.type === 'dob'), 'Expected a DOB mapping');
    assert.ok(mappings.some((m) => m.type === 'MRN' || m.type === 'mrn'), 'Expected an MRN mapping');
    assert.ok(mappings.some((m) => m.type === 'Account' || m.type === 'account' || m.type === 'Account #' || m.type === 'accountNumber'), 'Expected an account mapping');
    assert.ok(mappings.some((m) => m.type === 'CC' || m.type === 'cc' || m.type === 'Credit Card' || m.type === 'creditCard' || m.type === 'CreditCard'), 'Expected a credit card mapping');
    assert.ok(mappings.some((m) => m.type === 'DL' || m.type === 'dl' || m.type === "Driver's License" || m.type === 'driversLicense' || m.type === 'License' || m.type === 'Driver'), 'Expected a driver license mapping');
  });

  it('is consistent: the same input maps to the same fake values within one session', () => {
    const app = loadApp();
    const input = `SSN: ${SYNTHETIC_PII.ssn}, Email: ${SYNTHETIC_PII.email}`;
    const first = app.mask(input).text;
    const second = app.mask(input).text;
    assert.strictEqual(first, second, 'Masking should be deterministic for identical input in the same session');
  });

  it('unmasks restored text exactly', () => {
    const app = loadApp();
    const input = sampleParagraph();
    const { text: masked, mappings } = app.mask(input);
    const restored = app.unmask(masked, mappings);
    assert.strictEqual(restored, input, 'Unmasking should restore the original text exactly');
  });

  it('handles overlapping and adjacent matches without corrupting surrounding text', () => {
    const app = loadApp();
    const input = `A: ${SYNTHETIC_PII.email} B: ${SYNTHETIC_PII.email} C: ${SYNTHETIC_PII.phone}`;
    const { text: masked, mappings } = app.mask(input);
    const restored = app.unmask(masked, mappings);
    assert.strictEqual(restored, input);
    assert.ok(!masked.includes(SYNTHETIC_PII.email), 'Original email should be removed');
    assert.ok(!masked.includes(SYNTHETIC_PII.phone), 'Original phone should be removed');
  });

  it('passes non-PII text through unchanged', () => {
    const app = loadApp();
    const input = 'The quick brown fox jumps over the lazy dog. Version 1.2.3 is stable.';
    const { text, mappings } = app.mask(input);
    assert.strictEqual(text, input);
    assert.strictEqual(mappings.length, 0);
  });

  it('masks email addresses that start with ., +, % or -', () => {
    const app = loadApp();
    const input = [
      'Lead: .dot@acme.com',
      'Lead: +plus@acme.com',
      'Lead: %pct@acme.com',
      'Lead: -dash@acme.com',
    ].join('\n');
    const { text: masked, mappings } = app.mask(input);

    assert.strictEqual(app.networkCalls.length, 0, 'Masking must not make any network request');
    for (const lead of ['.', '+', '%', '-']) {
      assert.ok(!masked.includes('Lead: ' + lead), `Masked text still contains a leading '${lead}' on an email line`);
      assert.ok(!masked.includes(lead + 'acme'), `Masked text still contains stray '${lead}' before an email`);
    }
    assert.ok(!masked.includes('@acme.com'), 'Masked text still contains the original email domain');
    assert.strictEqual(mappings.length, 4, `Expected 4 email mappings, found ${mappings.length}`);

    const restored = app.unmask(masked, mappings);
    assert.strictEqual(restored, input, 'Unmasking should restore the original text exactly');
  });

  it('masks a phone glued to a word and skips phones glued to letters', () => {
    const app = loadApp();
    const input = 'Call: call(415) 555-0199 now\nNot a phone: x415-555-0199';
    const { text: masked, mappings } = app.mask(input);

    assert.strictEqual(app.networkCalls.length, 0, 'Masking must not make any network request');
    assert.ok(!masked.includes('(('), 'Masked text still contains a stray parenthesis from the original glued phone');
    assert.ok(!masked.includes('415) 555-0199'), 'Masked text still contains the glued phone number');
    assert.ok(masked.includes('x415-555-0199'), 'Identifier-style number should not have been masked');
    assert.ok(mappings.some((m) => m.type === 'Phone' || m.type === 'phone'), 'Expected a phone mapping');

    const restored = app.unmask(masked, mappings);
    assert.strictEqual(restored, input, 'Unmasking should restore the original text exactly');
  });

  it('does not treat false-positive traps as PII', () => {
    const app = loadApp();
    const input = [
      FALSE_POSITIVES.ordinaryLongNumber,
      FALSE_POSITIVES.versionString,
      FALSE_POSITIVES.notDob,
      FALSE_POSITIVES.notMrn,
      FALSE_POSITIVES.notAccount,
    ].join(' ');
    const { text, mappings } = app.mask(input);
    assert.strictEqual(text, input, 'False-positive traps should pass through unchanged');
    assert.strictEqual(mappings.length, 0, 'False-positive traps should produce no mappings');
  });
});
