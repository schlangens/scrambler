// Synthetic PII test fixtures
// Every value in this file is obviously fake and generated for testing only.

const SYNTHETIC_PII = {
  ssn: '555-12-3456',
  ssnNoDashes: '555123456',
  ssnDots: '555.12.3456',
  email: 'alice.smith@example.com',
  phone: '(555) 987-6543',
  phonePlain: '555-987-6543',
  ip: '10.0.0.1',
  ip2: '192.168.1.1',
  dob: '11/22/1990',
  dobWithLabel: 'DOB: 03/15/1985',
  mrn: 'MRN: 123456789',
  account: 'Account: 87654321',
  accountAlt: 'acct 12345678',
  creditCard: '5555-4444-3333-2222',
  creditCardSpaces: '5555 4444 3333 2222',
  driversLicense: 'D12345678',
  name: 'Alice Smith',
  company: 'Acme Healthcare',
  address: '123 Main St, Springfield',
};

// Values that must NOT be detected as PII (false-positive traps)
const FALSE_POSITIVES = {
  ordinaryLongNumber: '12345678901234567890',
  versionString: 'Version 1.2.3.4.5',
  notDob: 'The meeting is on 03/15/2025.',
  notMrn: 'Room number 12345',
  notAccount: 'Invoice 1234',
};

// A sample paragraph containing all supported PII types (browser-side).
function sampleParagraph() {
  return `Patient ${SYNTHETIC_PII.name} (SSN: ${SYNTHETIC_PII.ssn}) called from ${SYNTHETIC_PII.phone} regarding their account at ${SYNTHETIC_PII.company}. Email: ${SYNTHETIC_PII.email}. IP: ${SYNTHETIC_PII.ip}. DOB: ${SYNTHETIC_PII.dob}. MRN: ${SYNTHETIC_PII.mrn}. Account: ${SYNTHETIC_PII.account}. CC: ${SYNTHETIC_PII.creditCard}. DL: ${SYNTHETIC_PII.driversLicense}.`;
}

// A PDF-safe paragraph containing only the PII types the PDF redactor supports.
function pdfParagraph() {
  return `Confidential report.\nSSN: ${SYNTHETIC_PII.ssn}\nEmail: ${SYNTHETIC_PII.email}\nPhone: ${SYNTHETIC_PII.phone}\nIP: ${SYNTHETIC_PII.ip}\nDOB: ${SYNTHETIC_PII.dob}\nMRN: ${SYNTHETIC_PII.mrn}\nAccount: ${SYNTHETIC_PII.account}\nCC: ${SYNTHETIC_PII.creditCard}\nEnd.`;
}

// Values the current PDF redactor is expected to remove from the text layer.
function pdfDetectableValues() {
  return [
    SYNTHETIC_PII.ssn,
    SYNTHETIC_PII.email,
    SYNTHETIC_PII.phone,
    SYNTHETIC_PII.ip,
    SYNTHETIC_PII.dob,
    SYNTHETIC_PII.mrn,
    SYNTHETIC_PII.account,
    SYNTHETIC_PII.creditCard,
  ];
}

// All values we expect the redactor to remove from output.
function allDetectableValues() {
  return [
    SYNTHETIC_PII.ssn,
    SYNTHETIC_PII.email,
    SYNTHETIC_PII.phone,
    SYNTHETIC_PII.ip,
    SYNTHETIC_PII.dob,
    SYNTHETIC_PII.mrn,
    SYNTHETIC_PII.account,
    SYNTHETIC_PII.creditCard,
    SYNTHETIC_PII.driversLicense,
    SYNTHETIC_PII.name,
    SYNTHETIC_PII.company,
  ];
}

module.exports = {
  SYNTHETIC_PII,
  FALSE_POSITIVES,
  sampleParagraph,
  pdfParagraph,
  allDetectableValues,
  pdfDetectableValues,
};
