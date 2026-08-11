const Database = require('better-sqlite3');
const path = require('path');
const { nanoid } = require('nanoid');

const db = new Database(process.env.DB_PATH || path.join(__dirname, '../../data/scrambler.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS mappings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    original TEXT NOT NULL,
    masked TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mappings_user ON mappings(user_id);
  CREATE INDEX IF NOT EXISTS idx_mappings_session ON mappings(session_id);
`);

// Microsoft-style fake data pools
const FAKE_DATA = {
  companies: ['Contoso', 'Fabrikam', 'Northwind', 'Adventure Works', 'Woodgrove', 'Tailspin', 'Litware', 'Proseware'],
  firstNames: ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Sam', 'Jamie'],
  lastNames: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Moore', 'Clark'],
  domains: ['contoso.com', 'fabrikam.com', 'example.org', 'test.com', 'sample.net'],
  streets: ['Main St', 'Oak Ave', 'Elm Dr', 'Park Blvd', 'Cedar Ln', 'Maple Way', '1st Ave', '2nd St'],
  cities: ['Springfield', 'Riverside', 'Fairview', 'Madison', 'Georgetown', 'Clinton', 'Salem', 'Bristol']
};

let counters = {};

function getNext(type) {
  if (!counters[type]) counters[type] = 0;
  return counters[type]++;
}

function generateFake(type) {
  switch(type) {
    case 'email':
      const fn = FAKE_DATA.firstNames[getNext('fn') % FAKE_DATA.firstNames.length].toLowerCase();
      const ln = FAKE_DATA.lastNames[getNext('ln') % FAKE_DATA.lastNames.length].toLowerCase();
      const dom = FAKE_DATA.domains[getNext('dom') % FAKE_DATA.domains.length];
      return `${fn}.${ln}@${dom}`;
    case 'phone':
      return `(555) ${100 + getNext('phone') % 900}-${1000 + getNext('phone2') % 9000}`;
    case 'ssn':
      return `XXX-XX-${(1000 + getNext('ssn') % 9000)}`;
    case 'name':
      return `${FAKE_DATA.firstNames[getNext('name') % FAKE_DATA.firstNames.length]} ${FAKE_DATA.lastNames[getNext('name2') % FAKE_DATA.lastNames.length]}`;
    case 'company':
      return FAKE_DATA.companies[getNext('company') % FAKE_DATA.companies.length];
    case 'address':
      return `${100 + getNext('addr') % 900} ${FAKE_DATA.streets[getNext('street') % FAKE_DATA.streets.length]}, ${FAKE_DATA.cities[getNext('city') % FAKE_DATA.cities.length]}`;
    case 'ip':
      return `10.0.${getNext('ip') % 256}.${getNext('ip2') % 256}`;
    case 'date':
      return `2024-0${1 + getNext('date') % 9}-${10 + getNext('date2') % 20}`;
    case 'mrn': // Medical Record Number
      return `MRN-${100000 + getNext('mrn') % 900000}`;
    case 'dob':
      return `XX/XX/${1950 + getNext('dob') % 50}`;
    case 'account':
      return `ACCT-${getNext('acct') % 10000}`.padStart(10, '0');
    case 'cc':
      return `XXXX-XXXX-XXXX-${1000 + getNext('cc') % 9000}`;
    case 'dl':
      return `DL-${String.fromCharCode(65 + getNext('dl') % 26)}${100000 + getNext('dl2') % 900000}`;
    default:
      return `[REDACTED-${nanoid(4).toUpperCase()}]`;
  }
}

// PII Detection patterns
const PII_PATTERNS = [
  // SSN - Social Security Number (XXX-XX-XXXX format with optional separators)
  { type: 'ssn', regex: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, label: 'SSN' },
  
  // Email addresses
  { type: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: 'Email' },
  
  // Phone numbers - US format with optional country code
  { type: 'phone', regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, label: 'Phone' },
  
  // IP Address - IPv4 format
  { type: 'ip', regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, label: 'IP Address' },
  
  // Date of Birth - CONTEXT-AWARE (only matches dates near DOB indicators)
  // Matches: "DOB: 01/15/1985", "Date of Birth: 1/5/1990", "Born: 01-15-1985", "Birthday: January 15, 1985"
  { type: 'dob', regex: /\b(?:DOB|D\.O\.B\.?|Date of Birth|Birth\s*Date|Born|Birthday)[:\s]*(?:0?[1-9]|1[0-2])[\/-](?:0?[1-9]|[12]\d|3[01])[\/-](?:19|20)\d{2}\b/gi, label: 'DOB (with label MM/DD/YYYY)' },
  { type: 'dob', regex: /\b(?:DOB|D\.O\.B\.?|Date of Birth|Birth\s*Date|Born|Birthday)[:\s]*(?:19|20)\d{2}[\/-](?:0?[1-9]|1[0-2])[\/-](?:0?[1-9]|[12]\d|3[01])\b/gi, label: 'DOB (with label YYYY-MM-DD)' },
  { type: 'dob', regex: /\b(?:DOB|D\.O\.B\.?|Date of Birth|Birth\s*Date|Born|Birthday)[:\s]*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(?:19|20)\d{2}\b/gi, label: 'DOB (with label Month DD, YYYY)' },
  
  // Medical Record Number - CONTEXT-AWARE (requires MRN indicator prefix)
  { type: 'mrn', regex: /\b(?:MRN|MR#|MR\s*#|Medical Record(?:\s*(?:Number|No|#))?|Med\s*Rec)[:\s#]*\d{5,10}\b/gi, label: 'Medical Record #' },
  
  // Account/Patient/Member IDs
  { type: 'account', regex: /\b(?:account|acct|patient id|member id)[:\s#]*\d{4,12}\b/gi, label: 'Account #' },
  
  // Credit Card Numbers (basic pattern - 13-19 digits with optional separators)
  { type: 'cc', regex: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g, label: 'Credit Card' },
  
  // Driver's License (state-prefixed or generic patterns)
  { type: 'dl', regex: /\b(?:DL|Driver'?s?\s*(?:License|Lic))[:\s#]*[A-Z0-9]{5,15}\b/gi, label: "Driver's License" },
];

module.exports = {
  resetCounters() {
    counters = {};
  },

  createMapping(userId, sessionId, original, type) {
    // Check if mapping already exists for this session
    const existing = db.prepare('SELECT * FROM mappings WHERE user_id = ? AND session_id = ? AND original = ?').get(userId, sessionId, original);
    if (existing) return existing;
    
    const id = nanoid(12);
    const masked = generateFake(type);
    
    db.prepare(`INSERT INTO mappings (id, user_id, session_id, original, masked, type) VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, sessionId, original, masked, type);
    return { id, original, masked, type };
  },

  getMappings(userId, sessionId) {
    if (sessionId) {
      return db.prepare('SELECT * FROM mappings WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC').all(userId, sessionId);
    }
    return db.prepare('SELECT * FROM mappings WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId);
  },

  clearSession(userId, sessionId) {
    return db.prepare('DELETE FROM mappings WHERE user_id = ? AND session_id = ?').run(userId, sessionId).changes;
  },

  // Auto-detect and mask PII in text
  autoMask(userId, sessionId, text) {
    this.resetCounters();
    let result = text;
    const detected = [];

    // Apply each pattern
    for (const pattern of PII_PATTERNS) {
      const matches = text.match(pattern.regex) || [];
      const unique = [...new Set(matches)];
      
      for (const match of unique) {
        const mapping = this.createMapping(userId, sessionId, match, pattern.type);
        detected.push({ type: pattern.label, original: match, masked: mapping.masked });
      }
    }

    // Replace all detected items (longest first)
    const mappings = this.getMappings(userId, sessionId);
    const sorted = [...mappings].sort((a, b) => b.original.length - a.original.length);
    
    for (const m of sorted) {
      result = result.split(m.original).join(m.masked);
    }

    return { text: result, detected, mappings };
  },

  // Manually add a mapping
  addManualMapping(userId, sessionId, original, type = 'text') {
    return this.createMapping(userId, sessionId, original, type);
  },

  // Unmask text using session mappings
  unmask(userId, sessionId, text) {
    const mappings = this.getMappings(userId, sessionId);
    let result = text;
    
    // Sort by masked length (longest first)
    const sorted = [...mappings].sort((a, b) => b.masked.length - a.masked.length);
    
    for (const m of sorted) {
      result = result.split(m.masked).join(m.original);
    }

    return { text: result };
  },

  deleteMapping(userId, id) {
    return db.prepare('DELETE FROM mappings WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }
};
