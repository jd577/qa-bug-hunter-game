/* ==========================================================================
   QA BUG HUNTER — game.js
   --------------------------------------------------------------------------
   A fully client-side QA testing game. The player tests a simulated web app
   ("EmpHub"), reproduces seeded defects, files bug reports and scores points.

   Structure:
     1.  Configuration
     2.  Utilities
     3.  Sound engine (Web Audio, no external files)
     4.  Simulated app data
     5.  Bug + round definitions (the "test plan")
     6.  Game state
     7.  HUD, toasts, overlays
     8.  Dialog system (bug report modal)
     9.  Timer
     10. Inspector mode
     11. Application-under-test renderers + interactions
     12. Bug report resolution + scoring
     13. Round flow + final report
     14. Event wiring + init
   ========================================================================== */

(() => {
  'use strict';

  /* ======================================================================
     1. CONFIGURATION
     Single place to tweak profile links, scoring and balance.
     ====================================================================== */

  const CONFIG = {
    profile: {
      name: 'Jawad Akhter',
      role: 'Software Quality Assurance Engineer',
      links: {
        portfolio: 'https://jd577.github.io/portfolio/',
        github: 'https://github.com/jd577',
        linkedin: 'https://www.linkedin.com/in/jawad-akhter',
        game: 'https://jd577.github.io/qa-bug-hunter-game/',
      },
    },
    scoring: {
      correct: 100,        // confirmed defect (Medium / Low severity)
      correctHigh: 150,    // confirmed Critical / High severity defect
      incorrect: -50,      // false or unreproducible report (multiplied by difficulty)
      triageBonus: 25,     // player's category + severity both match the actual defect
      allFoundBonus: 250,  // every defect in a round found
      timeBonusPerSec: 1,  // awarded per second left on the clock (all found)
      hintCost: 75,        // cost of a scoped clue
    },
    difficulties: {
      relaxed:  { label: 'Relaxed',  timeMult: 1.5, penaltyMult: 1, desc: '+50% time on every round' },
      standard: { label: 'Standard', timeMult: 1,   penaltyMult: 1, desc: 'The intended QA pacing' },
      hardcore: { label: 'Hardcore', timeMult: 0.7, penaltyMult: 2, desc: '−30% time · double penalties' },
    },
    storageKey: 'qabh-sound',
    diffKey: 'qabh-diff',
    historyKey: 'qabh-history',
  };

  const CATEGORIES = ['Functional', 'Validation', 'UI', 'Data', 'Security', 'Usability', 'Performance'];
  const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
  const PAGE_SIZE = 5; // employees per page in the directory
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // what the app *should* enforce
  const FILED_TAG = '<span class="filed-tag">✓ Filed</span>';

  /* ======================================================================
     2. UTILITIES
     ====================================================================== */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

  const fmtTime = (totalSec) => {
    const s = Math.max(0, Math.floor(totalSec));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const reducedMotion = () => {
    try {
      return typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) { return false; }
  };

  const raf = (cb) =>
    (window.requestAnimationFrame ? window.requestAnimationFrame(cb) : setTimeout(cb, 16));

  const sevClass = (sev) => 's-' + String(sev).toLowerCase();

  const cloneEmployees = (list) => list.map((e) => ({ ...e }));

  /* ======================================================================
     3. SOUND ENGINE
     Tiny synthesized blips via Web Audio. No files, fully optional.
     ====================================================================== */

  const SoundFX = {
    ctx: null,
    enabled: true,

    _ensure() {
      if (!this.ctx) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        } catch (_) { this.ctx = null; }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    },

    _tone(freq, dur, delay, type, vol) {
      const ctx = this.ctx;
      if (!ctx) return;
      const t0 = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.14 * (vol || 1), t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    },

    play(name) {
      if (!this.enabled) return;
      if (!this._ensure()) return;
      switch (name) {
        case 'click':   this._tone(700, 0.05, 0, 'sine', 0.5); break;
        case 'toggle':  this._tone(520, 0.06, 0, 'triangle', 0.6); this._tone(740, 0.06, 0.06, 'triangle', 0.5); break;
        case 'success': this._tone(523.25, 0.11, 0, 'sine', 0.9); this._tone(783.99, 0.16, 0.1, 'sine', 0.9); break;
        case 'error':   this._tone(196, 0.2, 0, 'sawtooth', 0.45); break;
        case 'bonus':   [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this._tone(f, 0.13, i * 0.085, 'sine', 0.8)); break;
        case 'round':   [392, 493.88, 587.33].forEach((f) => this._tone(f, 0.32, 0, 'sine', 0.4)); break;
        default: break;
      }
    },

    restore() {
      try {
        const saved = window.localStorage.getItem(CONFIG.storageKey);
        if (saved !== null) this.enabled = saved === 'on';
      } catch (_) { /* storage unavailable — keep default */ }
    },

    persist() {
      try {
        window.localStorage.setItem(CONFIG.storageKey, this.enabled ? 'on' : 'off');
      } catch (_) { /* ignore */ }
    },
  };

  /* ======================================================================
     4. SIMULATED APP DATA
     ====================================================================== */

  const EMPLOYEES = [
    { id: 'EMP-001', name: 'Ayesha Khan',   email: 'ayesha.khan@emphub.io',   dept: 'Engineering',      salary: 95000, status: 'Active' },
    { id: 'EMP-002', name: 'Bilal Ahmed',   email: 'bilal.ahmed@emphub.io',   dept: 'Design',          salary: 68000, status: 'Active' },
    { id: 'EMP-003', name: 'Fatima Noor',   email: 'fatima.noor@emphub.io',   dept: 'Marketing',       salary: 72000, status: 'Active' },
    { id: 'EMP-004', name: 'Hamza Sheikh',  email: 'hamza.sheikh@emphub.io',  dept: 'Engineering',     salary: 88000, status: 'On Leave' },
    // EMP-005 carries a data/display mismatch — the seeded "status badge" defect.
    { id: 'EMP-005', name: 'Zainab Ali',    email: 'zainab.ali@emphub.io',    dept: 'Human Resources', salary: 61000, status: 'Inactive', displayStatus: 'Active' },
    { id: 'EMP-006', name: 'Sara Malik',    email: 'sara.malik@emphub.io',    dept: 'Finance',         salary: 79000, status: 'Inactive' },
    { id: 'EMP-007', name: 'Usman Tariq',   email: 'usman.tariq@emphub.io',   dept: 'Marketing',       salary: 83000, status: 'Active' },
    { id: 'EMP-008', name: 'Mahnoor Iqbal', email: 'mahnoor.iqbal@emphub.io', dept: 'Design',          salary: 70000, status: 'Active' },
  ];

  const initialsOf = (name) =>
    String(name || '').trim().split(/\s+/).map((w) => w[0] || '').filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

  const badgeClassOf = (status) =>
    status === 'Active' ? 'b-active' : status === 'On Leave' ? 'b-leave' : 'b-inactive';

  /* ----- Round 4 fixtures: captured API traffic (deep-cloned per session) ----- */

  const API_REQUESTS = [
    {
      id: 'login', method: 'POST', path: '/api/auth/login', status: 200, statusText: 'OK', ms: 118,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-8f21a' },
      body: { success: true, token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYS50ZXN0ZXIifQ.demo', issuedAt: '2026-09-23T09:12:44Z', expiresAt: '2026-09-23T17:12:44Z' },
    },
    {
      id: 'me', method: 'GET', path: '/api/users/me', status: 200, statusText: 'OK', ms: 61,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { id: 42, username: 'qa.tester', role: 'QA Engineer', email: 'qa.tester@emphub.io', passwordHash: '$2b$12$Xk9wQ2pLmR4vTn8jHf3KZe6Yb0aC7dW1eS5gU2hJ8iM6nO4qP7rTu', lastLogin: '2026-09-23T09:12:44Z' },
    },
    {
      id: 'list', method: 'GET', path: '/api/employees?page=1&limit=5', status: 200, statusText: 'OK', ms: 142,
      headers: { 'Content-Type': 'application/json', 'X-Total-Count': '8' },
      body: {
        page: 1, limit: 5, total: 8,
        employees: [
          { id: 'EMP-001', name: 'Ayesha Khan', email: 'ayesha.khan@emphub.io', department: 'Engineering', salary: 95000, status: 'Active', statusLabel: 'Active' },
          { id: 'EMP-002', name: 'Bilal Ahmed', email: 'bilal.ahmed@emphub.io', department: 'Design', salary: 68000, status: 'Active', statusLabel: 'Active' },
          { id: 'EMP-011', name: 'Nadia Farooq', email: 'nadia.farooq@emphub.io', department: 'Finance', salary: 57500, status: 'Inactive', statusLabel: 'Active' },
          { id: 'EMP-004', name: 'Hamza Sheikh', email: 'hamza.sheikh@emphub.io', department: 'Engineering', salary: 88000, status: 'On Leave', statusLabel: 'On Leave' },
          { id: 'EMP-007', name: 'Usman Tariq', email: 'usman.tariq@emphub.io', department: 'Marketing', salary: 83000, status: 'Active', statusLabel: 'Active' },
        ],
      },
    },
    {
      id: 'emp7', method: 'GET', path: '/api/employees/EMP-007', status: 200, statusText: 'OK', ms: 89,
      headers: { 'Content-Type': 'application/json', 'ETag': 'W/"4f2a9c"' },
      body: { id: 'EMP-007', name: 'Usman Tariq', dept: 'Marketing', salary: 83000, status: 'Active' },
    },
    {
      id: 'del', method: 'DELETE', path: '/api/employees/EMP-003', status: 200, statusText: 'OK', ms: 204,
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, error: 'Employee not found', deletedId: 'EMP-003', attemptedAt: '2026-09-23T09:31:02Z' },
    },
    {
      id: 'export', method: 'POST', path: '/api/reports/export', status: 202, statusText: 'Accepted', ms: 30142,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
      body: { success: true, message: 'Export queued for processing', jobId: 'job-e71b', downloadUrl: null },
    },
    {
      id: 'search', method: 'GET', path: '/api/employees/search?q=ayesha', status: 200, statusText: 'OK', ms: 96,
      headers: { 'Content-Type': 'application/json' },
      body: { query: 'ayesha', count: 1, results: [{ id: 'EMP-001', name: 'Ayesha Khan', email: 'ayesha.khan@emphub.io', department: 'Engineering', salary: 95000, status: 'Active' }] },
    },
  ];

  const cloneBody = (value) => {
    if (Array.isArray(value)) return value.map(cloneBody);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach((k) => { out[k] = cloneBody(value[k]); });
      return out;
    }
    return value;
  };

  const cloneRequests = () => API_REQUESTS.map((r) => ({ ...r, headers: { ...r.headers }, body: cloneBody(r.body) }));

  /* Renders a JS value as syntax-highlighted, fully escaped JSON markup. */
  function jsonHTML(value, depth) {
    const d = depth || 0;
    const pad = '  '.repeat(d);
    const padIn = '  '.repeat(d + 1);
    if (value === null) return '<span class="j-null">null</span>';
    if (typeof value === 'string') return `<span class="j-str">"${esc(value)}"</span>`;
    if (typeof value === 'number' || typeof value === 'boolean') return `<span class="j-num">${value}</span>`;
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      const items = value.map((v) => padIn + jsonHTML(v, d + 1)).join(',\n');
      return `[\n${items}\n${pad}]`;
    }
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const items = keys.map((k) => `${padIn}<span class="j-key">"${esc(k)}"</span>: ${jsonHTML(value[k], d + 1)}`).join(',\n');
    return `{\n${items}\n${pad}}`;
  }

  /* ======================================================================
     5. BUG + ROUND DEFINITIONS
     Every bug targets element keys (data-key attributes inside the AUT).
     "active" decides whether the defect is currently reproducible —
     behavioural defects only become reportable once the player has
     actually triggered them.
     ====================================================================== */

  const ROUNDS = [
    /* ---------------- ROUND 1 — LOGIN & AUTHENTICATION ---------------- */
    {
      key: 'login',
      name: 'Login & Authentication',
      build: 'v1.2.0',
      url: 'emphub.app/login',
      duration: 150,
      brief: 'A fresh EmpHub build is deployed to the QA environment. Verify the authentication module: field behaviour, credential handling and navigation elements.',
      scope: ['Login form', 'Credential validation', 'Links & navigation'],
      testData: 'Test account — qa.tester / Qa@12345',
      tips: [
        'Start with the happy path using the test account, then test around it.',
        'Some defects only appear after you interact — click everything.',
        'Press I (or use the toolbar) to toggle the Inspector, then click an element to report it.',
        'Need a breather? Press P to pause the clock.',
      ],
      createData: () => ({}),
      render: renderLoginApp,
      bugs: [
        {
          id: 'r1-empty-login', title: 'Login succeeds with empty credentials',
          category: 'Validation', severity: 'Critical',
          hint: "The login form only validates when something is typed. What happens if you submit it completely empty?",
          description: "Submitting the login form with both fields empty shows 'Login successful' and starts a session. Expected: required-field validation should block submission and display error messages.",
          targets: ['r1-login-btn'],
          active: (r) => !!r.flags.emptyLogin,
        },
        {
          id: 'r1-password-plaintext', title: 'Password input displays characters in plain text',
          category: 'Security', severity: 'High',
          hint: 'Type into both login fields and watch carefully how each one displays what you entered.',
          description: "Typed credentials are rendered as readable text instead of being masked. Expected: the input should mask characters (type 'password'). Risk: credential exposure to shoulder-surfing and screen capture.",
          targets: ['r1-password', 'r1-password-label'],
        },
        {
          id: 'r1-dead-link', title: "'Forgot password?' control is unresponsive",
          category: 'Functional', severity: 'Medium',
          hint: 'Authentication screens usually offer account recovery. Try every navigation control on the login card.',
          description: "Clicking 'Forgot password?' triggers no navigation, no request and no feedback of any kind. Expected: the control should open the password-recovery flow or show a status message.",
          targets: ['r1-forgot'],
        },
        {
          id: 'r1-typo', title: "Misspelled field label 'Userrname'",
          category: 'UI', severity: 'Low',
          hint: 'Read the labels on the login form carefully, letter by letter.',
          description: "The username field label reads 'Userrname' (doubled 'r'). Expected: 'Username'. A visible text/copy defect on the login screen.",
          targets: ['r1-username-label', 'r1-username'],
        },
      ],
    },

    /* ---------------- ROUND 2 — EMPLOYEE DIRECTORY ---------------- */
    {
      key: 'directory',
      name: 'Employee Directory',
      build: 'v1.3.0',
      url: 'emphub.app/directory',
      duration: 210,
      brief: 'Regression-test the employee directory. Verify search, filters, sorting and on-screen data — including what happens after destructive actions.',
      scope: ['Search', 'Filters', 'Status data', 'Stats', 'Pagination'],
      tips: [
        'Cross-check the same data in more than one place (table, filters, stat cards).',
        'Test destructive actions — and watch what happens afterwards.',
        'Boundary values matter — check what happens at the edges.',
      ],
      createData: () => ({
        employees: cloneEmployees(EMPLOYEES),
        query: '', dept: 'all', status: 'all',
        sortKey: null, sortDir: 1, page: 1,
        totalDisplay: EMPLOYEES.length, // stat value rendered by the app (goes stale — seeded defect)
      }),
      render: renderDirectoryApp,
      bugs: [
        {
          id: 'r2-search-miss', title: 'Search returns no results for an existing employee',
          category: 'Functional', severity: 'High',
          hint: "The search box works for some names. Search for employees you can see in the table — all of them.",
          description: "Searching the directory for 'Fatima' — an employee visible in the table — returns 'No matching employees found'. Expected: search should match existing records by name, email or department.",
          targets: ['r2-search'],
          active: (r) => !!r.flags.searchMiss,
        },
        {
          id: 'r2-stale-count', title: 'Employee count does not update after deletion',
          category: 'UI', severity: 'Medium',
          hint: "Delete an employee, then compare the numbers at the top of the dashboard with the rows left in the table.",
          description: "After deleting an employee, the 'Total Employees' stat still shows the old value while every other figure refreshes. Expected: the count should recompute after any data change.",
          targets: ['r2-stat-total'],
          active: (r) => !!r.flags.deleted,
        },
        {
          id: 'r2-status-badge', title: "Inactive employee displayed with an 'Active' badge",
          category: 'Data', severity: 'Medium',
          hint: "Apply the status filter and cross-check every badge against the filter you selected.",
          description: "Filtering by status 'Inactive' reveals Zainab Ali with an 'Active' badge. The stored status is 'Inactive', so the badge does not reflect the actual record data.",
          targets: ['badge-EMP-005', 'row-EMP-005'],
        },
        {
          id: 'r2-pagination', title: "'Next' navigates past the last page to an empty page",
          category: 'Functional', severity: 'Low',
          hint: "Walk the directory to its very last page — then try going one step further.",
          description: "On the last page the 'Next' button stays enabled and navigates to page 3 of 2, showing an empty table and an out-of-range range ('Showing 11–15 of 8'). Expected: 'Next' should be disabled on the last page.",
          targets: ['r2-pagination', 'r2-page-next'],
          active: (r) => !!r.flags.overPaged,
        },
      ],
    },

    /* ---------------- ROUND 3 — FORMS & DATA HANDLING ---------------- */
    {
      key: 'forms',
      name: 'Form Validation & Data Handling',
      build: 'v1.4.0',
      url: 'emphub.app/employees',
      duration: 240,
      brief: 'The data-entry module is ready for testing. Exercise the Add and Edit forms with valid, invalid and duplicate data — negative testing encouraged.',
      scope: ['Form validation', 'Negative input', 'Data integrity', 'Edit flow'],
      tips: [
        'Negative testing: try empty, invalid and extreme values.',
        'Test data integrity — can the same record exist twice?',
        'Verify every button performs its documented action.',
      ],
      createData: () => ({
        employees: cloneEmployees(EMPLOYEES.slice(0, 5)),
        nextId: 6, mode: 'add', editingId: null,
      }),
      render: renderFormsApp,
      bugs: [
        {
          id: 'r3-broken-save', title: "'Save Changes' button performs no action",
          category: 'Functional', severity: 'High',
          hint: "Enter edit mode for any employee, change something, and try to save.",
          description: "In edit mode the 'Save Changes' button appears enabled, but clicking it produces no request, no feedback and no data change. Expected: clicking Save should persist the edited record or show an error.",
          targets: ['r3-submit'],
          active: (r) => !!r.flags.editSaveTried,
        },
        {
          id: 'r3-empty-name', title: 'Employee can be created without a name',
          category: 'Validation', severity: 'Critical',
          hint: "The form enforces two required fields — but is the name field really one of them? Submit and see.",
          description: "The form accepts an empty 'Full Name' and creates a record with a blank name. Expected: name is a required field and submission should be blocked with a validation message.",
          targets: ['r3-name', 'r3-submit'],
          active: (r) => !!r.flags.addedEmptyName,
        },
        {
          id: 'r3-bad-email', title: 'Invalid email address accepted',
          category: 'Validation', severity: 'High',
          hint: 'The email check accepts strings no mail server would deliver. Try an address with no domain after the "@".',
          description: "The form accepts clearly invalid email addresses such as 'jawad@' (no domain). Expected: email format should be validated before saving.",
          targets: ['r3-email', 'r3-submit'],
          active: (r) => !!r.flags.addedBadEmail,
        },
        {
          id: 'r3-negative-salary', title: 'Negative salary accepted',
          category: 'Validation', severity: 'High',
          hint: "Numbers can be negative. Can the salary field?",
          description: "The salary field accepts negative values such as -50000 and non-numeric text without any validation. Expected: salary must be a non-negative number.",
          targets: ['r3-salary', 'r3-submit'],
          active: (r) => !!r.flags.addedBadSalary,
        },
        {
          id: 'r3-duplicate', title: 'Duplicate employee can be added',
          category: 'Data', severity: 'Medium',
          hint: 'Try adding an employee who already exists — same name, different email.',
          description: 'The same employee (matching name) can be added to the directory twice — no duplicate check is performed. Expected: the form should reject or warn about potential duplicate records.',
          targets: ['r3-table'],
          active: (r) => !!r.flags.addedDuplicate,
        },
      ],
    },

    /* ---------------- ROUND 4 — API & NETWORK TESTING ---------------- */
    {
      key: 'api',
      name: 'API & Network Testing',
      build: 'v1.5.0',
      url: 'emphub.app/console',
      duration: 240,
      brief: 'Final module: the API layer. A network console has captured live traffic between the app and the server. Inspect each request and response against the documented API contract and the 5-second SLA.',
      scope: ['Status codes', 'Response payloads', 'Data consistency', 'Sensitive data', 'Performance'],
      testData: 'API contract: id, name, email, department, salary, status · SLA ≤ 5000 ms',
      tips: [
        'A 2xx status code does not guarantee the operation succeeded — read the response body.',
        'Cross-check response fields against the documented contract shown in your brief.',
        'Response times are part of the contract too — check them against the SLA.',
      ],
      createData: () => ({
        selected: null,
        viewed: {},
        requests: cloneRequests(),
      }),
      render: renderApiApp,
      bugs: [
        {
          id: 'r4-status-mismatch', title: 'DELETE returns 200 OK for a failed deletion',
          category: 'Functional', severity: 'High',
          hint: 'A successful status code does not always mean the operation succeeded. Open the DELETE request and read its body.',
          description: "DELETE /api/employees/EMP-003 responds with HTTP 200 OK, yet the body reports { success: false, error: 'Employee not found' }. Expected: a failed deletion should return 404 (or an appropriate error status), not 200.",
          targets: ['r4-req-del'],
          active: (r) => !!r.data.viewed.del,
        },
        {
          id: 'r4-field-mismatch', title: 'API returns contradictory status fields for one employee',
          category: 'Data', severity: 'Medium',
          hint: 'In the employee list response, compare each record\u2019s status field against its statusLabel field.',
          description: 'GET /api/employees returns Nadia Farooq with "status": "Inactive" but "statusLabel": "Active" — two fields on the same record contradicting each other. Expected: derived display fields must agree with the source data.',
          targets: ['r4-req-list', 'r4-body-list'],
          active: (r) => !!r.data.viewed.list,
        },
        {
          id: 'r4-sensitive-data', title: 'Password hash exposed in user profile response',
          category: 'Security', severity: 'Critical',
          hint: 'The profile endpoint returns everything it knows about the current user. Should it?',
          description: 'GET /api/users/me includes a passwordHash field in the response body. Expected: credential material must never be returned to the client — even hashed. Sensitive data exposure risk.',
          targets: ['r4-req-me', 'r4-body-me'],
          active: (r) => !!r.data.viewed.me,
        },
        {
          id: 'r4-missing-field', title: 'Employee response is missing the documented email field',
          category: 'Functional', severity: 'Medium',
          hint: 'The API contract in your brief lists six fields for employee records. Check what actually arrives for EMP-007.',
          description: 'GET /api/employees/EMP-007 returns id, name, dept, salary and status — but no email, which the API contract lists as a required field on every employee record. Expected: the response should include email.',
          targets: ['r4-req-emp7', 'r4-body-emp7'],
          active: (r) => !!r.data.viewed.emp7,
        },
        {
          id: 'r4-slow-endpoint', title: 'Export endpoint far exceeds response-time SLA',
          category: 'Performance', severity: 'Medium',
          hint: 'Response times are part of the contract. Compare each request\u2019s duration against the 5-second SLA.',
          description: 'POST /api/reports/export takes 30,142 ms to respond — six times the 5,000 ms SLA. Expected: the endpoint should respond within the SLA (or return 202 immediately and process asynchronously).',
          targets: ['r4-req-export'],
        },
      ],
    },
  ];

  const TOTAL_BUGS = ROUNDS.reduce((n, rd) => n + rd.bugs.length, 0);

  /* ======================================================================
     6. GAME STATE
     ====================================================================== */

  const Game = {
    screen: 'start', // start | intro | playing | summary | results
    roundIndex: 0,
    score: 0,
    falseStreak: 0,
    difficulty: 'standard',
    paused: false,
    totals: { correct: 0, incorrect: 0, foundIds: [], timeUsedMs: 0, hints: 0 },
    round: null, // active round runtime
  };

  const diffDef = () => CONFIG.difficulties[Game.difficulty] || CONFIG.difficulties.standard;
  const roundDurationMs = (def) => Math.round(def.duration * diffDef().timeMult) * 1000;

  /* ======================================================================
     7. DOM REFERENCES, HUD, TOASTS, OVERLAYS
     ====================================================================== */

  const els = {};
  let toastTimers = [];

  function cacheDom() {
    els.app = $('#app');
    els.aut = $('#aut');
    els.frame = $('#browser-frame');
    els.autUrl = $('#aut-url');
    els.buildInfo = $('#build-info');
    els.hudScore = $('#hud-score');
    els.hudRound = $('#hud-round');
    els.hudFound = $('#hud-found');
    els.hudRemaining = $('#hud-remaining');
    els.chipScore = $('#chip-score');
    els.chipTimer = $('#chip-timer');
    els.hudTimer = $('#hud-timer');
    els.progressFill = $('#progress-fill');
    els.btnSound = $('#btn-sound');
    els.btnInspector = $('#btn-inspector');
    els.btnFinish = $('#btn-finish');
    els.btnPause = $('#btn-pause');
    els.btnHint = $('#btn-hint');
    els.hintCost = $('#hint-cost');
    els.objective = $('#objective-body');
    els.trackerList = $('#tracker-list');
    els.trackerCount = $('#tracker-count');
    els.tipsList = $('#tips-list');
    els.footerName = $('#footer-name');
    els.footerRole = $('#footer-role');
    els.footerLinks = $('#footer-links');
    els.overlayRoot = $('#overlay-root');
    els.modalRoot = $('#modal-root');
    els.toastRoot = $('#toast-root');
  }

  function isFound(bugId) { return !!Game.round && Game.round.found.has(bugId); }

  function updateHUD() {
    els.hudScore.textContent = Game.score.toLocaleString('en-US');
    if (Game.round) {
      const total = Game.round.def.bugs.length;
      const found = Game.round.found.size;
      els.hudRound.textContent = `${Game.roundIndex + 1}/${ROUNDS.length}`;
      els.hudFound.textContent = `${found}/${total}`;
      els.hudRemaining.textContent = String(total - found);
    } else {
      els.hudRound.textContent = `—/${ROUNDS.length}`;
      els.hudFound.textContent = '0/0';
      els.hudRemaining.textContent = '—';
    }
  }

  function bumpScoreChip() {
    if (reducedMotion()) return;
    els.chipScore.classList.remove('bump');
    void els.chipScore.offsetWidth; // restart the animation
    els.chipScore.classList.add('bump');
  }

  function floatPoints(delta) {
    if (reducedMotion()) return;
    const tag = document.createElement('span');
    tag.className = 'float-pts ' + (delta >= 0 ? 'pos' : 'neg');
    tag.textContent = (delta >= 0 ? '+' : '') + delta;
    els.chipScore.appendChild(tag);
    setTimeout(() => tag.remove(), 1050);
  }

  function animateNumber(element, to, duration) {
    const from = Number(String(element.dataset.value || '0').replace(/,/g, '')) || 0;
    element.dataset.value = String(to);
    if (reducedMotion() || from === to) { element.textContent = to.toLocaleString('en-US'); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      element.textContent = Math.round(from + (to - from) * eased).toLocaleString('en-US');
      if (p < 1) raf(step);
    };
    raf(step);
  }

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast t-' + (type || 'info');
    el.textContent = message;
    els.toastRoot.appendChild(el);
    while (els.toastRoot.children.length > 4) els.toastRoot.firstChild.remove();
    const timer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 3400);
    toastTimers.push(timer);
  }

  function clearToasts() {
    toastTimers.forEach(clearTimeout);
    toastTimers = [];
    els.toastRoot.innerHTML = '';
  }

  function showOverlay(html) {
    els.overlayRoot.innerHTML = `<div class="overlay" role="region" aria-label="Game screen"><div class="overlay-card">${html}</div></div>`;
    try { els.app.setAttribute('inert', ''); } catch (_) { /* older browsers */ }
    const primary = els.overlayRoot.querySelector('button, a');
    if (primary) primary.focus();
  }

  function hideOverlay() {
    els.overlayRoot.innerHTML = '';
    try { els.app.removeAttribute('inert'); } catch (_) { /* ignore */ }
  }

  function creditBlock() {
    const links = CONFIG.profile.links;
    return `
      <div class="credit-block">
        <p class="credit">Built by <strong>${esc(CONFIG.profile.name)}</strong> · <span>${esc(CONFIG.profile.role)}</span></p>
        <nav class="footer-links" aria-label="Profile links">
          <a href="${esc(links.portfolio)}" target="_blank" rel="noopener noreferrer">Portfolio</a>
          <a href="${esc(links.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="${esc(links.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>
        </nav>
      </div>`;
  }

  /* ======================================================================
     8. DIALOG SYSTEM (bug report + confirmations + round summary)
     ====================================================================== */

  const Modal = {
    dismissible: false,
    prevFocus: null,
    onKeyDown(e) {
      if (e.key === 'Escape' && Modal.dismissible) { Modal.close(); return; }
      if (e.key === 'Tab') Modal._trap(e);
    },
    _trap(e) {
      const modal = els.modalRoot.querySelector('.modal');
      if (!modal) return;
      const focusables = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', modal)
        .filter((el) => !el.disabled && el.offsetParent !== null || el === document.activeElement);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
    open(html, opts) {
      const options = opts || {};
      this.dismissible = !!options.dismissible;
      this.onClose = options.onClose || null;
      this.prevFocus = document.activeElement;
      els.modalRoot.innerHTML =
        `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</div></div>`;
      try { els.app.setAttribute('inert', ''); } catch (_) { /* older browsers */ }
      document.addEventListener('keydown', Modal.onKeyDown);
      const first = els.modalRoot.querySelector('button, input, select, textarea');
      if (first) first.focus();
    },
    close() {
      const onClose = this.onClose;
      els.modalRoot.innerHTML = '';
      this.onClose = null;
      this.dismissible = false;
      document.removeEventListener('keydown', Modal.onKeyDown);
      try { els.app.removeAttribute('inert'); } catch (_) { /* ignore */ }
      if (this.prevFocus && this.prevFocus.focus) this.prevFocus.focus();
      if (onClose) onClose();
    },
  };

  /* ======================================================================
     9. TIMER
     The clock pauses whenever a dialog is open — writing a good bug
     report should never cost testing time.
     ====================================================================== */

  const Timer = {
    handle: null,

    begin() {
      this.stop();
      const r = Game.round;
      r.remainingMs = r.durationMs;
      r.deadline = Date.now() + r.remainingMs;
      this.handle = setInterval(() => this.tick(), 200);
      this.paint();
    },

    pause() {
      const r = Game.round;
      if (!r || r.ended) return;
      if (r.deadline != null) {
        r.remainingMs = Math.max(0, r.deadline - Date.now());
        r.deadline = null;
      }
    },

    resume() {
      const r = Game.round;
      if (!r || r.ended || Game.screen !== 'playing') return;
      if (r.deadline == null && r.remainingMs > 0) r.deadline = Date.now() + r.remainingMs;
    },

    stop() { if (this.handle) { clearInterval(this.handle); this.handle = null; } },

    tick() {
      const r = Game.round;
      if (!r || r.deadline == null) return;
      r.remainingMs = Math.max(0, r.deadline - Date.now());
      this.paint();
      if (r.remainingMs <= 0) endRound('timeout');
    },

    paint() {
      const r = Game.round;
      if (!r) return;
      const sec = Math.ceil(r.remainingMs / 1000);
      const frac = r.remainingMs / r.durationMs;
      els.hudTimer.textContent = fmtTime(sec);
      els.progressFill.style.width = (frac * 100).toFixed(1) + '%';
      els.chipTimer.classList.toggle('warn', frac <= 0.25 && frac > 0.1);
      els.chipTimer.classList.toggle('crit', frac <= 0.1);
      els.progressFill.classList.toggle('warn', frac <= 0.25 && frac > 0.1);
      els.progressFill.classList.toggle('crit', frac <= 0.1);
    },
  };

  /* ======================================================================
     10. INSPECTOR MODE
     When ON, clicks inside the AUT open a bug report instead of
     driving the application — like picking an element in DevTools.
     ====================================================================== */

  const Inspector = {
    on: false,

    toggle(force) {
      if (Game.screen !== 'playing' || Game.paused) return;
      this.on = (typeof force === 'boolean') ? force : !this.on;
      this.sync();
      SoundFX.play('toggle');
      if (this.on) toast('Inspector ON — click any element to file a defect report.', 'info');
    },

    sync() {
      const on = this.on;
      $$('[data-inspect]', els.aut).forEach((el) => {
        if (on) {
          el.setAttribute('tabindex', '0');
          el.setAttribute('role', 'button');
          el.setAttribute('aria-label', 'Inspect: ' + (el.dataset.inspect || 'element'));
        } else {
          el.removeAttribute('tabindex');
          el.removeAttribute('role');
        }
      });
      els.aut.classList.toggle('inspecting', on);
      els.frame.classList.toggle('inspecting', on);
      els.btnInspector.setAttribute('aria-pressed', String(on));
      els.btnInspector.classList.toggle('active', on);
      const state = els.btnInspector.querySelector('.toggle-state');
      if (state) state.textContent = on ? 'ON' : 'OFF';
    },
  };

  /* ======================================================================
     11. APPLICATION UNDER TEST — RENDERERS + INTERACTIONS
     NOTE: everything the player types is escaped before it touches HTML.
     ====================================================================== */

  /* ------------------------- Round 1: login ------------------------- */

  function renderLoginApp(root) {
    root.innerHTML = `
      <div class="app">
        <div class="app-topbar">
          <span class="app-logo" data-inspect="EmpHub logo" data-key="r1-logo"><span class="lg">EH</span> EmpHub</span>
          <span class="app-crumb">/ <b>Sign in</b></span>
          <span class="app-user"><span class="u-dot">QT</span> qa-tester</span>
        </div>
        <div class="login-wrap">
          <div class="login-card">
            <div class="login-logo"><span class="lg">EH</span> EmpHub</div>
            <h2>Sign in to your workspace</h2>
            <p class="login-sub">Use the test account provided in your session brief.</p>
            <div class="field">
              <label for="r1-username" data-inspect="Username field label" data-key="r1-username-label">Userrname</label>
              <input class="app-input" id="r1-username" type="text" autocomplete="off"
                     placeholder="e.g. qa.tester" data-inspect="Username input" data-key="r1-username">
            </div>
            <div class="field">
              <label for="r1-password" data-inspect="Password field label" data-key="r1-password-label">Password</label>
              <input class="app-input" id="r1-password" type="text" autocomplete="off"
                     placeholder="••••••••" data-inspect="Password input" data-key="r1-password">
            </div>
            <label class="check" data-inspect="Remember me checkbox" data-key="r1-remember">
              <input type="checkbox" id="r1-remember"> Remember me for 30 days
            </label>
            <button class="app-btn" id="r1-login-btn" type="button" data-action="login"
                    data-inspect="Login button" data-key="r1-login-btn">Sign In</button>
            <p class="login-status" id="r1-status" role="status" aria-live="polite"></p>
            <div class="login-links">
              <button class="linklike" id="r1-forgot" type="button" data-action="forgot"
                      data-inspect="'Forgot password?' link" data-key="r1-forgot">Forgot password?</button>
            </div>
          </div>
          <p class="app-footer" data-inspect="Application footer" data-key="r1-footer">EmpHub v1.2.0 · Internal QA demo environment</p>
        </div>
      </div>`;
  }

  function actionLogin() {
    const username = $('#r1-username', els.aut);
    const password = $('#r1-password', els.aut);
    const status = $('#r1-status', els.aut);
    const u = username.value.trim();
    const p = password.value;

    if (u === '' && p === '') {
      // Seeded defect: completely empty submission "succeeds".
      Game.round.flags.emptyLogin = true;
      status.className = 'login-status ok';
      status.textContent = "✓ Login successful — session started for '' (no credentials provided)";
    } else if (u === 'qa.tester' && p === 'Qa@12345') {
      status.className = 'login-status ok';
      status.textContent = '✓ Login successful — welcome back, qa.tester';
    } else {
      status.className = 'login-status err';
      status.textContent = '✗ Invalid username or password';
    }
  }

  /* ------------------------- Round 2: directory ------------------------- */

  function r2Filtered(d) {
    let list = d.employees;
    if (d.dept !== 'all') list = list.filter((e) => e.dept === d.dept);
    if (d.status !== 'all') list = list.filter((e) => e.status === d.status);
    const q = d.query.trim().toLowerCase();
    if (q) {
      // Seeded defect: a known employee becomes unfindable via search.
      if (q.includes('fatima')) {
        list = [];
      } else {
        list = list.filter((e) =>
          e.name.toLowerCase().includes(q) ||
          e.email.toLowerCase().includes(q) ||
          e.dept.toLowerCase().includes(q));
      }
    }
    if (d.sortKey === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name) * d.sortDir);
    if (d.sortKey === 'salary') list = [...list].sort((a, b) => (a.salary - b.salary) * d.sortDir);
    return list;
  }

  function r2Pages(d) {
    return Math.max(1, Math.ceil(r2Filtered(d).length / PAGE_SIZE));
  }

  function statCard(key, label, value, bugId) {
    const filed = bugId && isFound(bugId);
    return `<div class="stat-card${filed ? ' filed-host' : ''}" data-inspect="Stat card — ${esc(label)}" data-key="${key}">
      ${filed ? FILED_TAG : ''}
      <span class="stat-num">${esc(value)}</span>
      <span class="stat-label">${esc(label)}</span>
    </div>`;
  }

  function r2StatsHTML(d) {
    const active = d.employees.filter((e) => e.status === 'Active').length;
    const depts = new Set(d.employees.map((e) => e.dept)).size;
    const payroll = d.employees.reduce((sum, e) => sum + (e.salary || 0), 0);
    return (
      statCard('r2-stat-total', 'Total Employees', d.totalDisplay, 'r2-stale-count') +
      statCard('r2-stat-active', 'Active', active) +
      statCard('r2-stat-depts', 'Departments', depts) +
      statCard('r2-stat-payroll', 'Monthly Payroll', '$' + payroll.toLocaleString('en-US'))
    );
  }

  function r2RowsHTML(list, d) {
    if (!list.length) {
      const overPaged = d.page > r2Pages(d);
      const msg = d.query.trim()
        ? `No matching employees found${d.query.trim().length < 40 ? ' for "' + esc(d.query.trim()) + '"' : ''}.`
        : overPaged ? 'No employees to display on this page.' : 'No employees found.';
      return `<tr><td colspan="6"><div class="empty-state">${msg}</div></td></tr>`;
    }
    return list.map((e) => {
      const shown = e.displayStatus || e.status; // badge uses the (buggy) display value
      const badgeFiled = e.id === 'EMP-005' && isFound('r2-status-badge');
      const rowFiled = e.id === 'EMP-005' && isFound('r2-status-badge');
      return `<tr data-inspect="Employee row — ${esc(e.name)}" data-key="row-${e.id}" class="${rowFiled ? 'filed-host' : ''}">
        <td class="cell-id">${esc(e.id)}</td>
        <td><div class="emp-cell"><span class="avatar">${esc(initialsOf(e.name))}</span><div><b>${esc(e.name)}</b><small>${esc(e.email)}</small></div></div></td>
        <td>${esc(e.dept)}</td>
        <td class="cell-salary">$${Number(e.salary).toLocaleString('en-US')}</td>
        <td><span class="badge ${badgeClassOf(shown)}${badgeFiled ? ' filed-host' : ''}" data-inspect="Status badge — ${esc(e.name)} (${esc(shown)})" data-key="badge-${e.id}">${esc(shown)}${badgeFiled ? FILED_TAG : ''}</span></td>
        <td class="cell-actions"><button class="btn-mini danger" type="button" data-action="delete" data-id="${e.id}" data-inspect="Delete button — ${esc(e.name)}" data-key="del-${e.id}">Delete</button></td>
      </tr>`;
    }).join('');
  }

  function r2PaginationHTML(d) {
    const total = r2Filtered(d).length;
    const pages = r2Pages(d);
    const start = (d.page - 1) * PAGE_SIZE + 1;
    const overPaged = d.page > pages;
    // When the app over-pages it renders an out-of-range range — part of the defect.
    const end = overPaged ? start + PAGE_SIZE - 1 : Math.min(d.page * PAGE_SIZE, total);
    const showing = total > 0 ? `Showing ${start}–${end} of ${total}` : `Showing 0 of ${total}`;
    return `
      <span class="showing-label">${showing}</span>
      <span class="page-label">Page ${d.page} of ${pages}</span>
      <button class="btn-mini" type="button" data-action="page-prev" data-inspect="Previous page button" data-key="r2-page-prev" ${d.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <button class="btn-mini" type="button" data-action="page-next" data-inspect="Next page button" data-key="r2-page-next">Next ›</button>`;
  }

  function r2Refresh() {
    const r = Game.round;
    const d = r.data;
    $('#r2-stats', els.aut).innerHTML = r2StatsHTML(d);
    const list = r2Filtered(d);
    const pageList = list.slice((d.page - 1) * PAGE_SIZE, d.page * PAGE_SIZE);
    $('#r2-tbody', els.aut).innerHTML = r2RowsHTML(pageList, d);
    $('#r2-pagination', els.aut).innerHTML = r2PaginationHTML(d);
    Inspector.sync();
  }

  function renderDirectoryApp(root) {
    root.innerHTML = `
      <div class="app">
        <div class="app-topbar">
          <span class="app-logo"><span class="lg">EH</span> EmpHub</span>
          <span class="app-crumb">/ <b>Directory</b></span>
          <span class="app-user"><span class="u-dot">QT</span> qa-tester</span>
        </div>
        <div class="app-body">
          <div class="stats-row" id="r2-stats"></div>
          <div class="table-card">
            <div class="table-toolbar">
              <div class="search-wrap">
                <input class="app-input" id="r2-search" type="search" placeholder="Search by name, email or department…"
                       aria-label="Search employees" data-inspect="Search input" data-key="r2-search">
              </div>
              <select class="app-select" id="r2-filter-dept" aria-label="Filter by department"
                      data-inspect="Department filter" data-key="r2-filter-dept">
                <option value="all">All departments</option>
                <option>Engineering</option><option>Design</option><option>Marketing</option>
                <option>Human Resources</option><option>Finance</option>
              </select>
              <select class="app-select" id="r2-filter-status" aria-label="Filter by status"
                      data-inspect="Status filter" data-key="r2-filter-status">
                <option value="all">All statuses</option>
                <option>Active</option><option>On Leave</option><option>Inactive</option>
              </select>
            </div>
            <p class="app-notice" id="r2-notice" role="status" aria-live="polite"></p>
            <div class="table-scroll">
              <table class="emp-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col"><button class="th-sort" type="button" data-action="sort" data-sort="name" data-inspect="Column header — Employee (sortable)" data-key="r2-sort-name">Employee <span class="arr"></span></button></th>
                    <th scope="col">Department</th>
                    <th scope="col"><button class="th-sort" type="button" data-action="sort" data-sort="salary" data-inspect="Column header — Salary (sortable)" data-key="r2-sort-salary">Salary <span class="arr"></span></button></th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody id="r2-tbody"></tbody>
              </table>
            </div>
            <div class="pagination" id="r2-pagination" data-inspect="Pagination controls" data-key="r2-pagination"></div>
          </div>
        </div>
      </div>`;

    $('#r2-search', els.aut).addEventListener('input', (e) => {
      const d = Game.round.data;
      d.query = e.target.value;
      d.page = 1;
      if (e.target.value.trim().toLowerCase().includes('fatima')) Game.round.flags.searchMiss = true;
      r2Refresh();
    });
    $('#r2-filter-dept', els.aut).addEventListener('change', (e) => {
      Game.round.data.dept = e.target.value; Game.round.data.page = 1; r2Refresh();
    });
    $('#r2-filter-status', els.aut).addEventListener('change', (e) => {
      Game.round.data.status = e.target.value; Game.round.data.page = 1; r2Refresh();
    });
    r2Refresh();
  }

  let noticeTimer = null;
  function appNotice(id, message, ok) {
    const el = $('#' + id, els.aut);
    if (!el) return;
    el.textContent = message;
    el.className = 'app-notice show ' + (ok ? 'ok' : 'err');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.textContent = ''; el.className = 'app-notice'; }, 2800);
  }

  function actionDelete(id) {
    const d = Game.round.data;
    const victim = d.employees.find((e) => e.id === id);
    d.employees = d.employees.filter((e) => e.id !== id);
    Game.round.flags.deleted = true; // reproducible defect: count goes stale
    d.page = Math.min(d.page, r2Pages(d));
    r2Refresh();
    appNotice('r2-notice', `Employee deleted — ${victim ? victim.name : id} removed.`, true);
  }

  function actionSort(key) {
    const d = Game.round.data;
    if (d.sortKey === key) d.sortDir = -d.sortDir;
    else { d.sortKey = key; d.sortDir = 1; }
    $$('.th-sort .arr', els.aut).forEach((a) => { a.textContent = ''; });
    const btn = $(`.th-sort[data-sort="${key}"] .arr`, els.aut);
    if (btn) btn.textContent = d.sortDir === 1 ? '▲' : '▼';
    r2Refresh();
  }

  function actionPage(step) {
    const d = Game.round.data;
    d.page = Math.max(1, d.page + step);
    if (d.page > r2Pages(d)) Game.round.flags.overPaged = true; // reproducible defect: page overflow
    r2Refresh();
  }

  /* ------------------------- Round 3: forms ------------------------- */

  function r3RowsHTML(d) {
    if (!d.employees.length) {
      return `<tr><td colspan="7"><div class="empty-state">No employees yet — add one with the form above.</div></td></tr>`;
    }
    return d.employees.map((e) => {
      const salary = typeof e.salary === 'number'
        ? '$' + e.salary.toLocaleString('en-US')
        : '$' + String(e.salary);
      const nameCell = e.name ? esc(e.name) : '—';
      return `<tr data-inspect="Employee row — ${esc(e.name || e.id)}" data-key="row-${e.id}">
        <td class="cell-id">${esc(e.id)}</td>
        <td><div class="emp-cell"><span class="avatar">${esc(initialsOf(e.name))}</span><div><b>${nameCell}</b></div></div></td>
        <td>${esc(e.email)}</td>
        <td>${esc(e.dept)}</td>
        <td class="cell-salary">${esc(salary)}</td>
        <td><span class="badge ${badgeClassOf(e.status)}" data-inspect="Status badge — ${esc(e.name || e.id)}" data-key="badge-${e.id}">${esc(e.status)}</span></td>
        <td class="cell-actions">
          <button class="btn-mini primary" type="button" data-action="edit" data-id="${e.id}" data-inspect="Edit button — ${esc(e.name || e.id)}" data-key="edit-${e.id}">Edit</button>
          <button class="btn-mini danger" type="button" data-action="delete" data-id="${e.id}" data-inspect="Delete button — ${esc(e.name || e.id)}" data-key="del-${e.id}">Delete</button>
        </td>
      </tr>`;
    }).join('');
  }

  function r3Refresh() {
    const d = Game.round.data;
    $('#r3-tbody', els.aut).innerHTML = r3RowsHTML(d);
    $('#r3-count', els.aut).textContent = `Team Size: ${d.employees.length}`;
    Inspector.sync();
  }

  function renderFormsApp(root) {
    root.innerHTML = `
      <div class="app">
        <div class="app-topbar">
          <span class="app-logo"><span class="lg">EH</span> EmpHub</span>
          <span class="app-crumb">/ Employees / <b>New</b></span>
          <span class="app-user"><span class="u-dot">QT</span> qa-tester</span>
        </div>
        <div class="app-body">
          <div class="form-card" id="r3-form-card">
            <h3 id="r3-form-title">Add New Employee</h3>
            <p class="edit-hint" id="r3-edit-hint" hidden>Editing an existing record. Changes should persist when you press Save.</p>
            <div class="form-grid">
              <div class="field">
                <label for="r3-name">Full Name</label>
                <input class="app-input" id="r3-name" type="text" autocomplete="off" placeholder="e.g. Jawad Akhter"
                       data-inspect="Full name input" data-key="r3-name">
              </div>
              <div class="field">
                <label for="r3-email">Email</label>
                <input class="app-input" id="r3-email" type="text" autocomplete="off" placeholder="e.g. name@company.com"
                       data-inspect="Email input" data-key="r3-email">
                <p class="field-err" id="r3-email-err" hidden>Email is required</p>
              </div>
              <div class="field">
                <label for="r3-dept">Department</label>
                <select class="app-select" id="r3-dept" data-inspect="Department select" data-key="r3-dept">
                  <option>Engineering</option><option>Design</option><option>Marketing</option>
                  <option>Human Resources</option><option>Finance</option>
                </select>
              </div>
              <div class="field">
                <label for="r3-salary">Salary</label>
                <input class="app-input" id="r3-salary" type="text" inputmode="decimal" autocomplete="off" placeholder="e.g. 65000"
                       data-inspect="Salary input" data-key="r3-salary">
                <p class="field-err" id="r3-salary-err" hidden>Salary is required</p>
              </div>
              <div class="field">
                <label for="r3-status">Status</label>
                <select class="app-select" id="r3-status" data-inspect="Status select" data-key="r3-status">
                  <option>Active</option><option>On Leave</option><option>Inactive</option>
                </select>
              </div>
            </div>
            <div class="form-actions">
              <button class="btn-secondary" id="r3-reset" type="button" data-action="reset-form"
                      data-inspect="Reset form button" data-key="r3-reset">Reset</button>
              <button class="app-btn" id="r3-submit" type="button" data-action="submit-emp"
                      data-inspect="Submit button" data-key="r3-submit">Add Employee</button>
              <button class="linklike" id="r3-cancel" type="button" data-action="cancel-edit" hidden
                      data-inspect="Cancel edit button" data-key="r3-cancel">Cancel edit</button>
            </div>
          </div>

          <div class="table-card">
            <div class="table-head">
              <h3>Employees</h3>
              <span class="count-chip" id="r3-count" data-inspect="Team size counter" data-key="r3-count">Team Size: 5</span>
            </div>
            <p class="app-notice" id="r3-notice" role="status" aria-live="polite"></p>
            <div class="table-scroll" data-inspect="Employees table" data-key="r3-table">
              <table class="emp-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th><th scope="col">Name</th><th scope="col">Email</th>
                    <th scope="col">Department</th><th scope="col">Salary</th>
                    <th scope="col">Status</th><th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody id="r3-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;

    ['r3-name', 'r3-email', 'r3-salary'].forEach((id) => {
      const input = $('#' + id, els.aut);
      input.addEventListener('input', () => {
        input.classList.remove('invalid');
        const err = $('#' + id + '-err', els.aut);
        if (err) err.hidden = true;
      });
    });
    r3Refresh();
  }

  function r3ClearErrors() {
    ['r3-email', 'r3-salary'].forEach((id) => {
      const input = $('#' + id, els.aut);
      const err = $('#' + id + '-err', els.aut);
      if (input) input.classList.remove('invalid');
      if (err) err.hidden = true;
    });
  }

  function r3ShowError(id) {
    const input = $('#' + id, els.aut);
    const err = $('#' + id + '-err', els.aut);
    if (input) input.classList.add('invalid');
    if (err) err.hidden = false;
  }

  function actionSubmitEmployee() {
    const r = Game.round;
    const d = r.data;

    if (d.mode === 'edit') {
      // Seeded defect: the enabled Save button performs no action at all.
      r.flags.editSaveTried = true;
      return;
    }

    const name = $('#r3-name', els.aut).value;
    const email = $('#r3-email', els.aut).value.trim();
    const dept = $('#r3-dept', els.aut).value;
    const salary = $('#r3-salary', els.aut).value.trim();
    const status = $('#r3-status', els.aut).value;

    r3ClearErrors();
    let blocked = false;
    if (!email) { r3ShowError('r3-email'); blocked = true; }
    if (!salary) { r3ShowError('r3-salary'); blocked = true; }
    if (blocked) return;

    // ---- Seeded validation defects (the app's broken checks) ----
    if (!name.trim()) r.flags.addedEmptyName = true;
    if (!EMAIL_RE.test(email)) r.flags.addedBadEmail = true;
    const salNum = parseFloat(salary);
    if (!(Number.isFinite(salNum) && salNum >= 0)) r.flags.addedBadSalary = true;
    const cleanName = name.trim().toLowerCase();
    if (cleanName && d.employees.some((e) => e.name.trim().toLowerCase() === cleanName)) {
      r.flags.addedDuplicate = true;
    }

    d.employees.push({
      id: 'EMP-' + String(d.nextId++).padStart(3, '0'),
      name: name.trim(), email, dept, salary, status,
    });
    r3Refresh();
    appNotice('r3-notice', 'Employee added successfully.', true);
  }

  function actionEditEmployee(id) {
    const d = Game.round.data;
    const emp = d.employees.find((e) => e.id === id);
    if (!emp) return;
    d.mode = 'edit';
    d.editingId = id;
    $('#r3-name', els.aut).value = emp.name || '';
    $('#r3-email', els.aut).value = emp.email || '';
    $('#r3-dept', els.aut).value = emp.dept || 'Engineering';
    $('#r3-salary', els.aut).value = String(emp.salary ?? '');
    $('#r3-status', els.aut).value = emp.status || 'Active';
    $('#r3-form-title', els.aut).textContent = 'Edit Employee — ' + emp.id;
    $('#r3-submit', els.aut).textContent = 'Save Changes';
    $('#r3-cancel', els.aut).hidden = false;
    $('#r3-reset', els.aut).hidden = true;
    $('#r3-edit-hint', els.aut).hidden = false;
    r3ClearErrors();
  }

  function r3ExitEditMode() {
    const d = Game.round.data;
    d.mode = 'add';
    d.editingId = null;
    $('#r3-name', els.aut).value = '';
    $('#r3-email', els.aut).value = '';
    $('#r3-salary', els.aut).value = '';
    $('#r3-form-title', els.aut).textContent = 'Add New Employee';
    $('#r3-submit', els.aut).textContent = 'Add Employee';
    $('#r3-cancel', els.aut).hidden = true;
    $('#r3-reset', els.aut).hidden = false;
    $('#r3-edit-hint', els.aut).hidden = true;
    r3ClearErrors();
  }

  function actionResetForm() {
    $('#r3-name', els.aut).value = '';
    $('#r3-email', els.aut).value = '';
    $('#r3-salary', els.aut).value = '';
    r3ClearErrors();
  }

  function actionDeleteEmployee(id) {
    const d = Game.round.data;
    d.employees = d.employees.filter((e) => e.id !== id);
    if (d.editingId === id) r3ExitEditMode();
    r3Refresh();
    appNotice('r3-notice', 'Employee removed.', true);
  }

  /* ------------------------- Round 4: API console ------------------------- */

  function apiRowHTML(req, selected) {
    const slow = req.ms > 5000;
    return `
      <button class="api-row${selected ? ' selected' : ''}" type="button" data-action="view-req" data-req="${req.id}"
              data-inspect="API request — ${req.method} ${req.path}" data-key="r4-req-${req.id}"
              aria-pressed="${selected ? 'true' : 'false'}">
        <span class="m-chip m-${req.method.toLowerCase()}">${req.method}</span>
        <span class="api-path">${esc(req.path)}</span>
        <span class="s-chip s-ok">${req.status} ${esc(req.statusText)}</span>
        <span class="api-ms${slow ? ' slow' : ''}">${req.ms.toLocaleString('en-US')} ms</span>
      </button>`;
  }

  function apiDetailHTML(req) {
    const headers = Object.keys(req.headers).map((h) =>
      `<li><b>${esc(h)}:</b> ${esc(req.headers[h])}</li>`).join('');
    return `
      <div class="api-detail-card">
        <div class="api-detail-head">
          <span class="m-chip m-${req.method.toLowerCase()}">${req.method}</span>
          <span>${esc(req.path)}</span>
          <span class="s-chip s-ok">${req.status} ${esc(req.statusText)}</span>
          <span class="api-ms">${req.ms.toLocaleString('en-US')} ms</span>
        </div>
        <div class="api-grid">
          <section class="api-section" data-inspect="Response payload — ${req.method} ${req.path}" data-key="r4-body-${req.id}">
            <h4>Response Body</h4>
            <pre class="json-view">${jsonHTML(req.body)}</pre>
          </section>
          <section class="api-section" data-inspect="Response headers — ${req.method} ${req.path}" data-key="r4-headers-${req.id}">
            <h4>Response Headers</h4>
            <ul class="hdr-list">${headers}</ul>
          </section>
        </div>
      </div>`;
  }

  function r4Select(id) {
    const r = Game.round;
    if (!r) return;
    r.data.selected = id;
    r.data.viewed[id] = true; // the payload has been seen — body-evident defects become reproducible
    const list = $('#r4-list', els.aut);
    const detail = $('#r4-detail', els.aut);
    if (!list || !detail) return;
    $$('.api-row', list).forEach((row) => {
      const isSel = row.dataset.req === id;
      row.classList.toggle('selected', isSel);
      row.setAttribute('aria-pressed', isSel ? 'true' : 'false');
    });
    const req = r.data.requests.find((q) => q.id === id);
    detail.innerHTML = req ? apiDetailHTML(req) : '';
    Inspector.sync();
  }

  function renderApiApp(root) {
    const d = Game.round.data;
    root.innerHTML = `
      <div class="app">
        <div class="app-topbar">
          <span class="app-logo"><span class="lg">EH</span> EmpHub</span>
          <span class="app-crumb">/ <b>API Console</b></span>
          <span class="app-user"><span class="u-dot">QT</span> qa-tester</span>
        </div>
        <div class="app-body">
          <div class="api-head">
            <div>
              <h3>Network Activity</h3>
              <p class="api-sub">Requests captured between the app and the server during your test session. Select a request to inspect its payload — file a report if anything violates the contract.</p>
            </div>
            <span class="count-chip">${d.requests.length} requests</span>
          </div>
          <div class="api-list" id="r4-list" role="list" aria-label="Captured API requests">
            ${d.requests.map((req) => apiRowHTML(req, req.id === d.selected)).join('')}
          </div>
          <div id="r4-detail" aria-live="polite">
            <div class="api-detail-card"><p class="api-empty">Select a request above to inspect its request and response details.</p></div>
          </div>
          <p class="api-foot">API docs: emphub.app/docs · Contract: id, name, email, department, salary, status · SLA: 5000 ms</p>
        </div>
      </div>`;
  }

  /* ------------------------- Action router ------------------------- */

  function handleAction(el) {
    const r = Game.round;
    if (!r || r.ended) return;
    switch (el.dataset.action) {
      case 'login': actionLogin(); break;
      case 'forgot': break; // seeded defect: dead control — no handler
      case 'sort': actionSort(el.dataset.sort); break;
      case 'delete':
        if (r.def.key === 'directory') actionDelete(el.dataset.id);
        else actionDeleteEmployee(el.dataset.id);
        break;
      case 'page-prev': actionPage(-1); break;
      case 'page-next': actionPage(1); break;
      case 'submit-emp': actionSubmitEmployee(); break;
      case 'reset-form': actionResetForm(); break;
      case 'cancel-edit': r3ExitEditMode(); break;
      case 'edit': actionEditEmployee(el.dataset.id); break;
      case 'view-req': r4Select(el.dataset.req); break;
      default: break;
    }
  }

  /* ======================================================================
     12. BUG REPORT RESOLUTION + SCORING
     ====================================================================== */

  const bugIsActive = (bug) => (bug.active ? bug.active(Game.round) : true);

  function openBugReport(targetEl) {
    if (!Game.round || Game.round.ended) return;
    Timer.pause();
    const label = targetEl.dataset.inspect || 'Selected element';
    const key = targetEl.dataset.key || targetEl.id || '';
    SoundFX.play('click');

    Modal.open(`
      <div class="modal-head">
        <h2 class="modal-title" id="modal-title">🐛 File Bug Report</h2>
        <p class="modal-sub">Describe the defect you believe you have reproduced on this element.</p>
        <span class="target-pill">Selected: ${esc(label)}</span>
      </div>
      <div class="report-form">
        <div>
          <label for="rep-title">Bug title</label>
          <input class="app-input-dark" id="rep-title" type="text" value="Defect on: ${esc(label)}">
        </div>
        <div class="field-pair">
          <div>
            <label for="rep-cat">Category</label>
            <select id="rep-cat">
              <option value="">— Select —</option>
              ${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div>
            <label for="rep-sev">Severity</label>
            <select id="rep-sev">
              <option value="">— Select —</option>
              ${SEVERITIES.map((s) => `<option value="${s}">${s}</option>`).join('')}
            </select>
          </div>
        </div>
        <div>
          <label for="rep-desc">Description <span style="font-weight:400">(optional)</span></label>
          <textarea id="rep-desc" placeholder="Steps to reproduce, expected result vs. actual result…"></textarea>
        </div>
        <p class="form-hint" id="rep-hint" role="alert"></p>
        <div class="report-actions">
          <button class="btn btn-outline" type="button" id="rep-cancel">Cancel</button>
          <button class="btn btn-primary" type="button" id="rep-submit">Submit Finding</button>
        </div>
      </div>`,
      {
        dismissible: true,
        onClose: () => {
          if (Game.screen === 'playing') {
            Timer.resume();
            maybeAllFound();
          }
        },
      });

    $('#rep-cancel').addEventListener('click', () => Modal.close());
    $('#rep-submit').addEventListener('click', () => {
      const cat = $('#rep-cat').value;
      const sev = $('#rep-sev').value;
      const hint = $('#rep-hint');
      if (!cat || !sev) {
        hint.textContent = 'Please choose a category and a severity before submitting.';
        if (!reducedMotion()) {
          const m = els.modalRoot.querySelector('.modal');
          m.classList.remove('shake'); void m.offsetWidth; m.classList.add('shake');
        }
        return;
      }
      submitReport(key, cat, sev);
    });
  }

  function submitReport(key, chosenCat, chosenSev) {
    const round = Game.round;
    const candidates = round.def.bugs.filter((b) => b.targets.includes(key));
    const activeUnfound = candidates.filter((b) => !round.found.has(b.id) && bugIsActive(b));

    if (activeUnfound.length > 0) {
      confirmBug(activeUnfound[0], chosenCat, chosenSev);
    } else if (candidates.some(bugIsActive)) {
      showReportResult('dup');
    } else if (candidates.length > 0) {
      rejectReport('notrepro');
    } else {
      rejectReport('clean');
    }
  }

  function confirmBug(bug, chosenCat, chosenSev) {
    const S = CONFIG.scoring;
    const base = (bug.severity === 'Critical' || bug.severity === 'High') ? S.correctHigh : S.correct;
    const triage = (chosenCat === bug.category && chosenSev === bug.severity) ? S.triageBonus : 0;

    Game.round.found.add(bug.id);
    Game.round.reports.correct++;
    Game.round.points.bugs += base;
    Game.round.points.triage += triage;
    Game.totals.correct++;
    Game.totals.foundIds.push(bug.id);
    Game.falseStreak = 0;

    addScore(base + triage);
    markFiled(bug);
    addTrackerItem(bug, base + triage);
    updateHUD();
    SoundFX.play('success');

    const triageLine = triage > 0
      ? `<p class="triage-line good">✓ Accurate triage — your category and severity matched (+${triage} bonus)</p>`
      : `<p class="triage-line">Your triage: ${esc(chosenCat)} / ${esc(chosenSev)} · Actual: ${esc(bug.category)} / ${esc(bug.severity)}</p>`;

    showReportResult('ok', `
      <div class="bug-card">
        <h4>${esc(bug.title)}</h4>
        <div class="bug-meta">
          <span class="m">Category: ${esc(bug.category)}</span>
          <span class="m">Severity: ${esc(bug.severity)}</span>
        </div>
        <p class="bug-desc">${esc(bug.description)}</p>
      </div>
      ${triageLine}
      <div class="pts-line"><span>Points awarded</span><b>+${base + triage}</b></div>
    `);
  }

  function rejectReport(kind) {
    const S = CONFIG.scoring;
    const penalty = S.incorrect * diffDef().penaltyMult;
    Game.round.reports.incorrect++;
    Game.totals.incorrect++;
    Game.falseStreak++;
    addScore(penalty);
    updateHUD();
    SoundFX.play('error');

    if (Game.falseStreak === 3) {
      toast('Tip: reproduce a defect before reporting — false positives cost points and accuracy.', 'info');
    }

    const msg = kind === 'notrepro'
      ? 'Not reproducible — this element is not defective in the current app state. Defects often only appear after specific actions, so keep testing and try again.'
      : 'Working as intended — no defect found on this element. Unverified reports reduce your score and accuracy.';

    showReportResult('err', `
      <p class="result-msg">${msg}</p>
      <div class="pts-line neg"><span>Score adjustment</span><b>${penalty}</b></div>
    `);
  }

  function showReportResult(kind, extraHTML) {
    const heads = {
      ok: ['✓', 'DEFECT CONFIRMED'],
      err: ['✗', 'REPORT REJECTED'],
      dup: ['●', 'ALREADY FILED'],
    };
    const [icon, title] = heads[kind];
    const body = kind === 'dup'
      ? '<p class="result-msg">This defect is already recorded in your tracker for the current round. No points lost — keep hunting.</p>'
      : extraHTML;

    els.modalRoot.querySelector('.modal').innerHTML = `
      <div class="result-view res-${kind}">
        <div class="result-head"><span class="rx" aria-hidden="true">${icon}</span><h3 id="modal-title">${title}</h3></div>
        ${body}
        <div class="report-actions">
          <button class="btn btn-primary" type="button" id="rep-continue">Continue Testing</button>
        </div>
      </div>`;
    $('#rep-continue').focus();
    $('#rep-continue').addEventListener('click', () => Modal.close());
  }

  function addScore(delta) {
    Game.score += delta;
    animateNumber(els.hudScore, Game.score, 550);
    bumpScoreChip();
    floatPoints(delta);
  }

  function markFiled(bug) {
    bug.targets.forEach((key) => {
      const el = $(`[data-key="${key}"]`, els.aut);
      if (!el) return;
      // Table-structure elements cannot host an absolutely-positioned tag directly;
      // their filed state is re-rendered by the round renderers instead.
      if (/^(TR|TABLE|TBODY|THEAD)$/.test(el.tagName)) { el.classList.add('filed-host'); return; }
      const host = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
        ? (el.closest('.field') || el.parentElement)
        : el;
      if (!host || host.querySelector('.filed-tag')) return;
      host.classList.add('filed-host');
      host.insertAdjacentHTML('beforeend', FILED_TAG);
    });
  }

  function addTrackerItem(bug, pts) {
    const empty = $('.tracker-empty', els.trackerList);
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = 'tracker-item ' + sevClass(bug.severity);
    li.innerHTML = `
      <span class="sev-dot" aria-hidden="true"></span>
      <div><b>${esc(bug.title)}</b><small>${esc(bug.category)} · ${esc(bug.severity)}</small></div>
      <span class="pts">+${pts}</span>`;
    els.trackerList.appendChild(li);
    els.trackerCount.textContent = String(Game.round.found.size);
  }

  function resetTracker() {
    els.trackerList.innerHTML =
      '<li class="tracker-empty">No defects filed yet. Toggle the Inspector, then click a suspicious element.</li>';
    els.trackerCount.textContent = '0';
  }

  /* ======================================================================
     12b. HINTS, PAUSE, SESSION HISTORY & SHARING
     ====================================================================== */

  function requestHint() {
    const r = Game.round;
    if (!r || r.ended || Game.paused) return;
    const unfound = r.def.bugs.filter((b) => !r.found.has(b.id));
    if (!unfound.length) {
      toast('Nothing left to hint — every defect in this build is already found.', 'info');
      return;
    }
    // Prefer a hint for a defect that is currently reproducible.
    const active = unfound.filter(bugIsActive);
    const target = (active.length ? active : unfound)[0];
    const cost = CONFIG.scoring.hintCost;

    Timer.pause();
    Game.totals.hints++;
    addScore(-cost);
    SoundFX.play('click');

    Modal.open(`
      <div class="modal-head">
        <h2 class="modal-title" id="modal-title">💡 Hint — Round ${Game.roundIndex + 1}</h2>
        <p class="modal-sub">A nudge toward one unfound defect. It never names the exact element.</p>
      </div>
      <div class="confirm-box">
        <p class="result-msg" style="font-size:15px">${esc(target.hint || 'Re-examine every element in the current test scope.')}</p>
        <div class="pts-line neg"><span>Hint cost</span><b>−${cost}</b></div>
        <div class="report-actions">
          <button class="btn btn-primary" type="button" id="hint-close">Back to Testing</button>
        </div>
      </div>`,
      {
        dismissible: true,
        onClose: () => { if (Game.screen === 'playing' && !Game.paused) Timer.resume(); },
      });
    $('#hint-close').addEventListener('click', () => Modal.close());
  }

  function togglePause(force) {
    if (Game.screen !== 'playing' || !Game.round || Game.round.ended) return;
    if (els.modalRoot.childElementCount > 0) return; // never pause behind an open dialog
    const target = (typeof force === 'boolean') ? force : !Game.paused;
    if (target === Game.paused) return;
    Game.paused = target;
    SoundFX.play('toggle');
    if (target) {
      Timer.pause();
      const r = Game.round;
      showOverlay(`
        <div style="text-align:center">
          <p class="round-kicker">SESSION PAUSED</p>
          <h2 class="round-title">⏸ Clock stopped</h2>
          <p class="intro-brief" style="margin-top:10px">Round ${Game.roundIndex + 1} — ${esc(r.def.name)}. Your timer, score and findings are safe.</p>
          <div class="pause-stats">
            <span class="meta-chip">Score: ${Game.score.toLocaleString('en-US')}</span>
            <span class="meta-chip">Bugs found: ${r.found.size}/${r.def.bugs.length}</span>
            <span class="meta-chip">Time left: ${fmtTime(r.remainingMs / 1000)}</span>
          </div>
          <div class="cta-row" style="justify-content:center">
            <button class="btn btn-primary btn-lg" type="button" id="btn-resume">▶ Resume Testing</button>
          </div>
        </div>`);
      $('#btn-resume').addEventListener('click', () => togglePause(false));
    } else {
      hideOverlay();
      Timer.resume();
    }
  }

  /* ----- Session history (localStorage, personal bests only — no leaderboards) ----- */

  function readHistory() {
    try {
      const raw = window.localStorage.getItem(CONFIG.historyKey);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  function saveHistoryEntry() {
    try {
      const t = Game.totals;
      const reports = t.correct + t.incorrect;
      const entry = {
        score: Game.score,
        found: t.foundIds.length,
        total: TOTAL_BUGS,
        accuracy: reports ? Math.round((t.correct / reports) * 100) : null,
        mode: Game.difficulty,
        hints: t.hints,
        date: new Date().toISOString().slice(0, 10),
      };
      const list = readHistory();
      list.unshift(entry);
      window.localStorage.setItem(CONFIG.historyKey, JSON.stringify(list.slice(0, 10)));
    } catch (_) { /* storage unavailable — history is optional */ }
  }

  function bestLineHTML() {
    const list = readHistory();
    if (!list.length) return '';
    const best = list.reduce((a, b) => (b.score > a.score ? b : a), list[0]);
    const label = (CONFIG.difficulties[best.mode] || CONFIG.difficulties.standard).label;
    return `<p class="best-line">🎯 Personal best: <b>${best.score.toLocaleString('en-US')}</b> (${label}) · Sessions played: ${list.length}</p>`;
  }

  /* ----- Shareable session summary ----- */

  function buildShareText() {
    const t = Game.totals;
    const reports = t.correct + t.incorrect;
    const acc = reports ? Math.round((t.correct / reports) * 100) + '%' : '—';
    return [
      '🐛 QA Bug Hunter — Test Session Report',
      `Score: ${Game.score.toLocaleString('en-US')} · Bugs found: ${t.foundIds.length}/${TOTAL_BUGS} · Accuracy: ${acc}`,
      `Mode: ${diffDef().label} · Hints used: ${t.hints} · Time: ${fmtTime(t.timeUsedMs / 1000)}`,
      `Play it: ${CONFIG.profile.links.game}`,
    ].join('\n');
  }

  function copyShareText() {
    const text = buildShareText();
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Session summary copied to clipboard.', 'success'); }
      catch (_) { toast('Could not access the clipboard — select and copy the summary manually.', 'error'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast('Session summary copied to clipboard.', 'success'))
        .catch(fallback);
    } else {
      fallback();
    }
  }

  /* ======================================================================
     13. ROUND FLOW + FINAL REPORT
     ====================================================================== */

  function maybeAllFound() {
    const r = Game.round;
    if (!r || r.ended || r.bannerShown) return;
    if (r.found.size < r.def.bugs.length) return;
    r.bannerShown = true;
    Timer.pause();

    const S = CONFIG.scoring;
    const secondsLeft = Math.round(r.remainingMs / 1000);
    r.points.bonus = S.allFoundBonus;
    r.points.time = secondsLeft * S.timeBonusPerSec;
    addScore(S.allFoundBonus + r.points.time);
    SoundFX.play('bonus');

    const banner = document.createElement('div');
    banner.className = 'allfound-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <div class="allfound-card">
        <h2>ALL DEFECTS FOUND</h2>
        <p>Every seeded defect in this build has been confirmed.</p>
        <span class="big-bonus">+${S.allFoundBonus} round bonus · +${r.points.time} time bonus</span>
      </div>`;
    document.body.appendChild(banner);
    setTimeout(() => {
      banner.remove();
      endRound('complete');
    }, reducedMotion() ? 600 : 2100);
  }

  function endRound(reason) {
    const r = Game.round;
    if (!r || r.ended) return;
    r.ended = true;
    Timer.pause();
    Timer.stop();

    const usedMs = Math.min(r.durationMs, Math.max(0, r.durationMs - r.remainingMs));
    Game.totals.timeUsedMs += usedMs;
    Game.screen = 'summary';
    Inspector.on = false;
    Inspector.sync();
    els.btnFinish.disabled = true;
    els.btnInspector.disabled = true;
    els.btnPause.disabled = true;
    els.btnHint.disabled = true;
    SoundFX.play('round');

    const roundNo = Game.roundIndex + 1;
    const total = r.def.bugs.length;
    const found = r.found.size;
    const missed = r.def.bugs.filter((b) => !r.found.has(b.id));
    const roundTotal = r.points.bugs + r.points.triage + r.points.bonus + r.points.time;
    const reasonText = {
      complete: 'All defects found — excellent session',
      timeout: 'Time expired',
      submitted: 'Session submitted by tester',
    }[reason] || 'Round complete';

    const missedHTML = missed.length
      ? `<div class="missed-list">${missed.map((b) => `
          <div class="missed-item">
            <span class="round-tag">R${roundNo}</span>
            <span class="sev-chip ${b.severity.toLowerCase()}">${b.severity}</span>
            <span>${esc(b.title)}</span>
          </div>`).join('')}
        </div>`
      : '<p class="missed-none">None — you found every defect in this build. 🎯</p>';

    const isLast = Game.roundIndex >= ROUNDS.length - 1;

    showOverlay(`
      <p class="round-kicker">ROUND ${roundNo} OF ${ROUNDS.length} · ${esc(reasonText.toUpperCase())}</p>
      <h2 class="round-title">${esc(r.def.name)} — Complete</h2>
      <div class="meta-row">
        <span class="meta-chip">Build ${esc(r.def.build)}</span>
        <span class="meta-chip">Mode: ${esc(diffDef().label)}</span>
        <span class="meta-chip">Defects found: ${found}/${total}</span>
        <span class="meta-chip">Accuracy: ${r.reports.correct + r.reports.incorrect > 0
          ? Math.round((r.reports.correct / (r.reports.correct + r.reports.incorrect)) * 100) + '%' : '—'}</span>
      </div>
      <div class="summary-points">
        <div class="row"><span>Confirmed defects</span><b>+${r.points.bugs}</b></div>
        ${r.points.triage ? `<div class="row"><span>Accurate triage bonus</span><b>+${r.points.triage}</b></div>` : ''}
        ${r.points.bonus ? `<div class="row"><span>All-defects bonus</span><b>+${r.points.bonus}</b></div>` : ''}
        ${r.points.time ? `<div class="row"><span>Time bonus (${Math.round(r.remainingMs / 1000)}s left)</span><b>+${r.points.time}</b></div>` : ''}
        <div class="row"><span>False reports</span><b style="color:${r.reports.incorrect ? 'var(--red)' : 'inherit'}">${r.reports.incorrect}</b></div>
        <div class="row total"><span>Round total</span><b>+${roundTotal}</b></div>
      </div>
      <div class="perf-section">
        <h3>Defects you missed</h3>
        ${missedHTML}
      </div>
      <div class="cta-row">
        <button class="btn btn-primary btn-lg" type="button" id="btn-continue">${isLast ? 'View Final QA Report' : 'Continue to Round ' + (roundNo + 1)}</button>
      </div>
    `);

    $('#btn-continue').addEventListener('click', () => {
      SoundFX.play('click');
      if (isLast) showResults();
      else showRoundIntro(Game.roundIndex + 1);
    });
  }

  function showRoundIntro(index) {
    Game.roundIndex = index;
    const def = ROUNDS[index];
    Game.screen = 'intro';
    updateHUD();

    showOverlay(`
      <p class="round-kicker">ROUND ${index + 1} OF ${ROUNDS.length}</p>
      <h2 class="round-title">${esc(def.name)}</h2>
      <div class="meta-row">
        <span class="meta-chip">Build ${esc(def.build)}</span>
        <span class="meta-chip">${esc(def.url)}</span>
        <span class="meta-chip">Time box: ${fmtTime(roundDurationMs(def) / 1000)}</span>
        <span class="meta-chip">Mode: ${esc(diffDef().label)}</span>
        <span class="meta-chip">Suspected defects: ${def.bugs.length}</span>
      </div>
      <p class="intro-brief">${esc(def.brief)}</p>
      <div class="intro-panel">
        <h3>Test scope</h3>
        <div class="scope-chips">${def.scope.map((s) => `<span class="scope-chip">${esc(s)}</span>`).join('')}</div>
        ${def.testData ? `<div class="testdata">${esc(def.testData)}</div>` : ''}
      </div>
      <div class="cta-row">
        <button class="btn btn-primary btn-lg" type="button" id="btn-start-round">Start Testing · ${fmtTime(roundDurationMs(def) / 1000)}</button>
      </div>
    `);

    $('#btn-start-round').addEventListener('click', () => {
      SoundFX.play('click');
      hideOverlay();
      beginRound(index);
    });
  }

  function beginRound(index) {
    const def = ROUNDS[index];
    Game.screen = 'playing';
    Game.paused = false;
    Game.round = {
      def,
      durationMs: roundDurationMs(def),
      found: new Set(),
      flags: {},
      data: def.createData(),
      reports: { correct: 0, incorrect: 0 },
      points: { bugs: 0, triage: 0, bonus: 0, time: 0 },
      remainingMs: roundDurationMs(def),
      deadline: null,
      ended: false,
      bannerShown: false,
    };

    els.buildInfo.textContent = `Build ${def.build} · ${def.name} · ${diffDef().label}`;
    els.autUrl.textContent = def.url;
    els.btnFinish.disabled = false;
    els.btnInspector.disabled = false;
    els.btnPause.disabled = false;
    els.btnHint.disabled = false;
    resetTracker();
    updateObjective(def);
    updateHUD();
    def.render(els.aut, Game.round);
    Inspector.sync();
    Timer.begin();

    toast(`Round ${index + 1} started — ${def.bugs.length} suspected defects in this build.`, 'info');
    if (index === 0) {
      if (!reducedMotion()) {
        els.btnInspector.classList.add('flash');
        setTimeout(() => els.btnInspector.classList.remove('flash'), 4500);
      }
      toast('Interact with the app first, then toggle the Inspector to report defects.', 'info');
    }
  }

  function updateObjective(def) {
    els.objective.innerHTML = `
      <h3>${esc(def.name)}</h3>
      <p class="obj-build">Build ${esc(def.build)} · ${esc(def.url)}</p>
      <p class="obj-muted">${esc(def.brief)}</p>
      <div class="scope-chips">${def.scope.map((s) => `<span class="scope-chip">${esc(s)}</span>`).join('')}</div>
      ${def.testData ? `<div class="testdata">${esc(def.testData)}</div>` : ''}`;
    els.tipsList.innerHTML = def.tips.map((t) => `<li>${esc(t)}</li>`).join('');
  }

  /* ------------------------- Final report ------------------------- */

  function performanceFor(score, accuracy) {
    const accNote = accuracy !== null ? ` Report accuracy: ${accuracy}%.` : '';
    if (score >= 2800) {
      return {
        title: '🏆 Outstanding Testing Session',
        msg: 'Exceptional attention to detail. You reproduced, triaged and documented defects like a senior QA engineer. The build does not stand a chance against you.' + accNote,
      };
    }
    if (score >= 2000) {
      return {
        title: '⭐ Excellent Testing Session',
        msg: 'You demonstrated strong attention to detail and methodical test thinking across every module. With a little more coverage, no defect would escape you.' + accNote,
      };
    }
    if (score >= 1200) {
      return {
        title: '✅ Good Testing Session',
        msg: 'Solid testing instincts — you found real defects and filed focused reports. Review the missed defects below: edge cases are where quality lives.' + accNote,
      };
    }
    return {
      title: '📋 Testing Session Complete',
      msg: 'Every expert tester started with missed edge cases. Re-run the session, test more aggressively with negative inputs, and hunt again.' + accNote,
    };
  }

  function showResults() {
    Game.screen = 'results';
    saveHistoryEntry();
    const foundSet = new Set(Game.totals.foundIds);
    const allBugs = ROUNDS.flatMap((rd, i) => rd.bugs.map((b) => ({ ...b, roundNo: i + 1 })));
    const missed = allBugs.filter((b) => !foundSet.has(b.id));

    const catOrder = ['Functional', 'Validation', 'UI', 'Data', 'Security', 'Performance'];
    const catRows = catOrder
      .map((cat) => {
        const bugs = allBugs.filter((b) => b.category === cat);
        if (!bugs.length) return '';
        const found = bugs.filter((b) => foundSet.has(b.id)).length;
        const pct = Math.round((found / bugs.length) * 100);
        return `<div class="cat-row">
          <span class="cat-label">${esc(cat)}</span>
          <div class="bar-track"><div class="bar-fill${found ? '' : ' zero'}" data-pct="${pct}"></div></div>
          <span class="cat-count">${found}/${bugs.length}</span>
        </div>`;
      })
      .join('');

    const totalReports = Game.totals.correct + Game.totals.incorrect;
    const accuracy = totalReports ? Math.round((Game.totals.correct / totalReports) * 100) : null;
    const perf = performanceFor(Game.score, accuracy);
    const missedHTML = missed.length
      ? `<div class="missed-list">${missed.map((b) => `
          <div class="missed-item">
            <span class="round-tag">R${b.roundNo}</span>
            <span class="sev-chip ${b.severity.toLowerCase()}">${b.severity}</span>
            <span>${esc(b.title)}</span>
          </div>`).join('')}</div>`
      : '<p class="missed-none">None — a perfect defect detection rate. 🎯</p>';

    showOverlay(`
      <div class="results-score-wrap">
        <p class="results-kicker">TEST SESSION COMPLETE</p>
        <p class="score-big" id="final-score">0</p>
        <p class="score-caption">Final QA Score</p>
      </div>
      <div class="stat-chips">
        <div class="stat-chip"><span class="v neutral">${Game.totals.foundIds.length} / ${TOTAL_BUGS}</span><span class="l">Bugs Found</span></div>
        <div class="stat-chip"><span class="v ${accuracy !== null && accuracy >= 70 ? 'good' : accuracy !== null && accuracy < 50 ? 'bad' : 'neutral'}">${accuracy === null ? '—' : accuracy + '%'}</span><span class="l">Report Accuracy</span></div>
        <div class="stat-chip"><span class="v neutral">${fmtTime(Game.totals.timeUsedMs / 1000)}</span><span class="l">Time Used</span></div>
        <div class="stat-chip"><span class="v ${Game.totals.incorrect > 3 ? 'bad' : 'neutral'}">${Game.totals.incorrect}</span><span class="l">False Reports</span></div>
        <div class="stat-chip"><span class="v neutral">${esc(diffDef().label)}</span><span class="l">Mode</span></div>
        <div class="stat-chip"><span class="v ${Game.totals.hints > 3 ? 'bad' : 'neutral'}">${Game.totals.hints}</span><span class="l">Hints Used</span></div>
      </div>

      <div class="message-card">
        <h3>${esc(perf.title)}</h3>
        <p>${esc(perf.msg)}</p>
      </div>

      <div class="perf-section">
        <h3>QA Performance</h3>
        ${catRows}
        <div class="extra-rows" style="margin-top:13px">
          <div class="extra-row">Verified reports: <b>${Game.totals.correct}</b></div>
          <div class="extra-row">Incorrect findings: <b>${Game.totals.incorrect}</b></div>
          <div class="extra-row">Hints used: <b>${Game.totals.hints}</b></div>
          <div class="extra-row">Missed bugs: <b>${missed.length}</b></div>
        </div>
      </div>

      <div class="perf-section">
        <h3>Missed Defects</h3>
        ${missedHTML}
      </div>

      <div class="cta-row" style="margin-bottom:22px">
        <button class="btn btn-primary btn-lg" type="button" id="btn-play-again">Play Again</button>
        <button class="btn btn-outline" type="button" id="btn-copy-summary">📋 Copy Session Summary</button>
        <button class="btn btn-outline" type="button" id="btn-back-start">Back to Start Screen</button>
      </div>
      ${creditBlock()}
    `);

    animateNumber($('#final-score'), Game.score, 1100);
    requestAnimationFrame(() => {
      $$('.bar-fill', els.overlayRoot).forEach((bar) => {
        bar.style.width = bar.dataset.pct + '%';
      });
    });

    $('#btn-play-again').addEventListener('click', () => {
      SoundFX.play('click');
      resetGame();
      showRoundIntro(0);
    });
    $('#btn-copy-summary').addEventListener('click', () => {
      SoundFX.play('click');
      copyShareText();
    });
    $('#btn-back-start').addEventListener('click', () => {
      SoundFX.play('click');
      resetGame();
      showStartScreen();
    });
  }

  /* ------------------------- Start screen ------------------------- */

  function showStartScreen() {
    Game.screen = 'start';
    const S = CONFIG.scoring;
    const diffBtn = (key) => {
      const d = CONFIG.difficulties[key];
      const sel = Game.difficulty === key;
      return `<button class="diff-btn${sel ? ' selected' : ''}" type="button" data-diff="${key}" aria-pressed="${sel}">
        ${d.label}<small>${esc(d.desc)}</small>
      </button>`;
    };
    showOverlay(`
      <span class="hero-badge">PORTFOLIO PROJECT · SOFTWARE QA</span>
      <h2 class="hero-title">QA Bug Hunter</h2>
      <p class="hero-sub">Find the bugs. Break the build. Prove your QA skills.</p>

      <div class="steps-grid">
        <div class="step-card"><span class="step-num">1</span><b>Test the app</b><p>Interact with a simulated web application — log in, search, filter, add records and inspect live API traffic like a real tester.</p></div>
        <div class="step-card"><span class="step-num">2</span><b>File bug reports</b><p>Toggle the Inspector and click any suspicious element to file a defect report with category and severity.</p></div>
        <div class="step-card"><span class="step-num">3</span><b>Score points</b><p>Earn points for confirmed defects, lose points for false reports, and finish with a full QA session report.</p></div>
      </div>

      <div class="diff-box">
        <h3>Testing Mode</h3>
        <div class="diff-selector" role="group" aria-label="Testing mode">
          ${diffBtn('relaxed')}
          ${diffBtn('standard')}
          ${diffBtn('hardcore')}
        </div>
        ${bestLineHTML()}
      </div>

      <div class="scoring-card">
        <h3>Scoring</h3>
        <table class="score-table">
          <tr><td>Confirmed defect (Medium / Low)</td><td class="pos">+${S.correct}</td></tr>
          <tr><td>Confirmed Critical / High defect</td><td class="pos">+${S.correctHigh}</td></tr>
          <tr><td>Accurate triage (category + severity match)</td><td class="pos">+${S.triageBonus}</td></tr>
          <tr><td>False or unreproducible report</td><td class="neg">${S.incorrect}</td></tr>
          <tr><td>All defects in a round</td><td class="pos">+${S.allFoundBonus}</td></tr>
          <tr><td>Fast completion (per second left)</td><td class="pos">+${S.timeBonusPerSec}</td></tr>
          <tr><td>Hint (scoped clue)</td><td class="neg">−${S.hintCost}</td></tr>
        </table>
      </div>

      <div class="cta-row">
        <button class="btn btn-primary btn-lg" type="button" id="btn-start-session">▶ Start Testing Session</button>
        <span class="cta-note">${ROUNDS.length} rounds · ${TOTAL_BUGS} seeded defects · no login, no server — runs entirely in your browser.</span>
      </div>
      <p class="shortcuts-line">Shortcuts: <kbd>I</kbd> toggle inspector · <kbd>P</kbd> pause · <kbd>Esc</kbd> close dialog</p>
      <div style="height:22px"></div>
      ${creditBlock()}
    `);

    $$('.diff-btn', els.overlayRoot).forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.diff;
        if (!CONFIG.difficulties[key]) return;
        Game.difficulty = key;
        try { window.localStorage.setItem(CONFIG.diffKey, key); } catch (_) { /* ignore */ }
        SoundFX.play('click');
        $$('.diff-btn', els.overlayRoot).forEach((b) => {
          const sel = b.dataset.diff === key;
          b.classList.toggle('selected', sel);
          b.setAttribute('aria-pressed', String(sel));
        });
      });
    });

    $('#btn-start-session').addEventListener('click', () => {
      SoundFX.play('click');
      hideOverlay();
      showRoundIntro(0);
    });
  }

  /* ------------------------- Reset ------------------------- */

  function resetGame() {
    Game.score = 0;
    Game.falseStreak = 0;
    Game.paused = false;
    Game.totals = { correct: 0, incorrect: 0, foundIds: [], timeUsedMs: 0, hints: 0 };
    Game.round = null;
    Game.roundIndex = 0;
    Game.screen = 'start';
    Timer.stop();
    Inspector.on = false;
    Inspector.sync();
    clearToasts();
    hideOverlay();
    els.modalRoot.innerHTML = '';
    try { els.app.removeAttribute('inert'); } catch (_) { /* ignore */ }
    els.aut.innerHTML = `
      <div class="aut-placeholder">
        <p><strong>No active session</strong></p>
        <p>Start a testing session to load the application under test.</p>
      </div>`;
    els.buildInfo.textContent = 'No active session';
    els.autUrl.textContent = 'emphub.app';
    els.btnFinish.disabled = true;
    els.btnInspector.disabled = true;
    els.btnPause.disabled = true;
    els.btnHint.disabled = true;
    els.hudTimer.textContent = '—:—';
    els.progressFill.style.width = '0%';
    els.chipTimer.classList.remove('warn', 'crit');
    els.progressFill.classList.remove('warn', 'crit');
    els.objective.innerHTML = '<p class="obj-muted">Your test brief will appear here once a session starts.</p>';
    els.tipsList.innerHTML = '<li>Start a session to receive your test brief.</li>';
    resetTracker();
    els.hudScore.dataset.value = '0';
    updateHUD();
  }

  /* ======================================================================
     14. EVENT WIRING + INIT
     ====================================================================== */

  function confirmFinishRound() {
    Timer.pause();
    Modal.open(`
      <div class="modal-head">
        <h2 class="modal-title" id="modal-title">Finish this round?</h2>
      </div>
      <div class="confirm-box">
        <p>Ending the round early will submit your current findings. Any unfound defects will be reported as missed — and no time bonus is awarded.</p>
        <div class="report-actions">
          <button class="btn btn-outline" type="button" id="cf-cancel">Keep Testing</button>
          <button class="btn btn-primary" type="button" id="cf-confirm">End Round</button>
        </div>
      </div>`,
      {
        dismissible: true,
        onClose: () => { if (Game.screen === 'playing') Timer.resume(); },
      });
    $('#cf-cancel').addEventListener('click', () => Modal.close());
    $('#cf-confirm').addEventListener('click', () => {
      Modal.close();
      endRound('submitted');
    });
  }

  function wireEvents() {
    // Delegated interactions inside the AUT.
    els.aut.addEventListener('click', (e) => {
      if (Game.screen !== 'playing' || !Game.round || Game.round.ended) return;
      if (Inspector.on) {
        // Inspect mode captures the click for element reporting.
        const target = e.target.closest('[data-inspect]');
        e.preventDefault();
        if (target) openBugReport(target);
        return;
      }
      const actionEl = e.target.closest('[data-action]');
      if (actionEl) { e.preventDefault(); handleAction(actionEl); }
    });

    els.aut.addEventListener('keydown', (e) => {
      if (!Inspector.on || Game.screen !== 'playing') return;
      if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target.closest ? e.target.closest('[data-inspect]') : null;
        if (target) { e.preventDefault(); openBugReport(target); }
      }
    });

    els.btnInspector.addEventListener('click', () => Inspector.toggle());
    els.btnPause.addEventListener('click', () => togglePause());
    els.btnHint.addEventListener('click', () => {
      if (Game.screen === 'playing') requestHint();
    });
    els.btnFinish.addEventListener('click', () => {
      if (Game.screen === 'playing') { SoundFX.play('click'); confirmFinishRound(); }
    });

    els.btnSound.addEventListener('click', () => {
      SoundFX.enabled = !SoundFX.enabled;
      SoundFX.persist();
      els.btnSound.setAttribute('aria-pressed', String(SoundFX.enabled));
      els.btnSound.setAttribute('aria-label', SoundFX.enabled ? 'Sound is on. Turn sound off' : 'Sound is off. Turn sound on');
      if (SoundFX.enabled) SoundFX.play('toggle');
      toast(SoundFX.enabled ? 'Sound on.' : 'Sound off.', 'info');
    });

    // Keyboard shortcuts: "i" toggles the Inspector, "p" pauses/resumes.
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      if (Game.screen !== 'playing') return;
      if (e.key === 'i' && !Game.paused) {
        Inspector.toggle();
      } else if (e.key === 'p') {
        togglePause();
      }
    });
  }

  function init() {
    cacheDom();
    SoundFX.restore();
    els.btnSound.setAttribute('aria-pressed', String(SoundFX.enabled));

    // Restore the player's preferred testing mode (local only — never transmitted).
    try {
      const savedDiff = window.localStorage.getItem(CONFIG.diffKey);
      if (savedDiff && CONFIG.difficulties[savedDiff]) Game.difficulty = savedDiff;
    } catch (_) { /* storage unavailable — keep default */ }
    els.hintCost.textContent = String(CONFIG.scoring.hintCost);

    // Footer is rendered from the single CONFIG source of truth.
    els.footerName.textContent = CONFIG.profile.name;
    els.footerRole.textContent = CONFIG.profile.role;
    els.footerLinks.innerHTML = `
      <a href="${esc(CONFIG.profile.links.portfolio)}" target="_blank" rel="noopener noreferrer">Portfolio</a>
      <a href="${esc(CONFIG.profile.links.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>
      <a href="${esc(CONFIG.profile.links.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`;

    wireEvents();
    showStartScreen();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Debug / automated-testing hook (read-only convenience for curious devs). */
  window.QABugHunter = {
    CONFIG,
    ROUNDS,
    TOTAL_BUGS,
    get game() { return Game; },
    api: {
      beginRound, endRound, showRoundIntro, showResults, resetGame,
      openBugReport, toggleInspector: () => Inspector.toggle(),
      submitReport,
    },
  };

})();
