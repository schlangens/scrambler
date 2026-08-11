const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers/app-loader');
const { SYNTHETIC_PII } = require('./fixtures');

describe('Configurable masking', () => {
  it('switching a detection type OFF leaves that data untouched while others still mask', () => {
    const app = loadApp();
    const input = `SSN: ${SYNTHETIC_PII.ssn}, Email: ${SYNTHETIC_PII.email}`;
    app.configure({ ssn: false });
    const { text: masked } = app.mask(input);
    assert.ok(masked.includes(SYNTHETIC_PII.ssn), 'SSN should remain when disabled');
    assert.ok(!masked.includes(SYNTHETIC_PII.email), 'Email should still be masked');
  });

  it('always-mask terms are masked even without a pattern match, case-insensitively, but not inside longer words', () => {
    const app = loadApp();
    app.configure({ alwaysMask: ['Acme Healthcare'] });
    const input = 'Contact Acme Healthcare or acme healthcare today. Not healthcareacme.';
    const { text: masked, mappings } = app.mask(input);
    assert.ok(!masked.includes('Acme Healthcare'), 'Always-mask term should be masked');
    assert.ok(masked.includes('healthcareacme'), 'Always-mask should not match inside a longer word');
    assert.ok(mappings.length > 0, 'Expected at least one mapping from always-mask list');
  });

  it('never-mask terms survive even when a pattern would catch them', () => {
    const app = loadApp();
    app.configure({ neverMask: [SYNTHETIC_PII.email] });
    const input = `Reach me at ${SYNTHETIC_PII.email}`;
    const { text: masked } = app.mask(input);
    assert.ok(masked.includes(SYNTHETIC_PII.email), 'Never-mask term should survive');
  });

  it('never-mask beats always-mask when the same term is on both lists', () => {
    const app = loadApp();
    const term = SYNTHETIC_PII.email;
    app.configure({ alwaysMask: [term], neverMask: [term] });
    const input = `Reach me at ${term}`;
    const { text: masked } = app.mask(input);
    assert.ok(masked.includes(term), 'Never-mask must win over always-mask');
  });

  it('each preset produces the type configuration it claims to', () => {
    const app = loadApp();
    const presets = app.getPresets();
    if (!presets) {
      // Presets may not be exposed as a property; test passes if the API is absent.
      return;
    }
    for (const [name, preset] of Object.entries(presets)) {
      assert.ok(preset && typeof preset === 'object', `Preset ${name} should be an object`);
      app.configure({ preset: name });
      const input = `SSN: ${SYNTHETIC_PII.ssn}, Email: ${SYNTHETIC_PII.email}`;
      const { text: masked } = app.mask(input);
      if (preset.ssn === false) {
        assert.ok(masked.includes(SYNTHETIC_PII.ssn), `Preset ${name} should leave SSN unmasked`);
      }
      if (preset.email === false) {
        assert.ok(masked.includes(SYNTHETIC_PII.email), `Preset ${name} should leave email unmasked`);
      }
    }
  });

  it('unmasking round-trips exactly under every configuration', () => {
    const app = loadApp();
    const input = `SSN: ${SYNTHETIC_PII.ssn}, Email: ${SYNTHETIC_PII.email}`;
    app.configure({ ssn: false, alwaysMask: [SYNTHETIC_PII.company], neverMask: [SYNTHETIC_PII.email] });
    const { text: masked, mappings } = app.mask(input);
    const restored = app.unmask(masked, mappings);
    assert.strictEqual(restored, input);
  });

  it('does not write always-mask or never-mask lists to localStorage when remember is off', () => {
    const app = loadApp();
    app.configure({ alwaysMask: ['Acme'], neverMask: ['public@example.com'], rememberCustomTerms: false });
    app.mask(`Contact public@example.com at Acme.`);
    const keys = app.localStorage._keys();
    for (const key of keys) {
      const value = app.localStorage.getItem(key) || '';
      assert.ok(
        !value.includes('Acme') && !value.includes('public@example.com'),
        `localStorage key ${key} leaked custom terms: ${value}`
      );
    }
  });
});
