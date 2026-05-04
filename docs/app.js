// snarkysyndo browser client
// Vanilla JS, no build, no deps. All state lives in localStorage.
// AIDEV-NOTE: any change to the YAML serializer here must keep round-trips
// stable with action/post_messages.py (PyYAML safe_dump). See yamlValue().

const STORAGE_KEY = 'snarkysyndo';
const MAX_LEN = 300;
const FIELD_ORDER = [
  'id',
  'created_at',
  'posted_at',
  'mastodon_url',
  'bluesky_url',
  'mastodon_error',
  'bluesky_error',
];

// -------- settings -----------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
}

// -------- GitHub API ---------------------------------------------------

function ghHeaders(extra = {}) {
  const s = loadSettings();
  const h = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
  if (s && s.pat) h['Authorization'] = `Bearer ${s.pat}`;
  return h;
}

async function ghFetch(path, opts = {}) {
  const url = path.startsWith('http')
    ? path
    : `https://api.github.com${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: ghHeaders(opts.headers || {}),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.message || JSON.stringify(j);
    } catch {
      detail = await resp.text();
    }
    const err = new Error(`GitHub ${resp.status}: ${detail}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

async function ghCheckAuth(s) {
  // Use the supplied settings rather than the saved ones (test before save).
  const url = `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${s.pat}`,
    },
  });
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('PAT rejected (401). Check token value.');
    if (resp.status === 403) throw new Error('PAT lacks permission (403). Need Contents: write.');
    if (resp.status === 404) throw new Error('Repo not found (404). Check owner/name and PAT scope.');
    throw new Error(`GitHub ${resp.status}`);
  }
  const data = await resp.json();
  return { full_name: data.full_name, default_branch: data.default_branch };
}

async function listMessageFiles() {
  const s = loadSettings();
  const path = `messages?ref=${encodeURIComponent(s.branch)}`;
  try {
    const resp = await ghFetch(`/repos/${s.owner}/${s.repo}/contents/${path}`);
    const items = await resp.json();
    return (Array.isArray(items) ? items : [])
      .filter(it => it.type === 'file' && it.name.endsWith('.md'));
  } catch (e) {
    if (e.status === 404) return []; // messages/ doesn't exist yet on a fresh repo
    throw e;
  }
}

async function fetchMessageRaw(path) {
  const s = loadSettings();
  // AIDEV-NOTE: Accept: raw returns the file body directly, no base64 dance.
  const resp = await ghFetch(
    `/repos/${s.owner}/${s.repo}/contents/${path}?ref=${encodeURIComponent(s.branch)}`,
    { headers: { 'Accept': 'application/vnd.github.raw' } },
  );
  return resp.text();
}

async function createMessageFile(filename, content, commitMessage) {
  const s = loadSettings();
  const path = `messages/${filename}`;
  const body = {
    message: commitMessage,
    content: utf8ToBase64(content),
    branch: s.branch,
  };
  const resp = await ghFetch(
    `/repos/${s.owner}/${s.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return resp.json();
}

function utf8ToBase64(str) {
  // Handles unicode correctly (btoa alone does not).
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// -------- frontmatter --------------------------------------------------

// Parse a small subset of YAML sufficient for our flat key:value frontmatter.
// Values may be: null/~/blank, single-quoted, double-quoted, or plain scalar.
function parseFrontmatter(yamlText) {
  const out = {};
  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // strip trailing comment on plain scalars (not inside quotes)
    if (val.startsWith("'") || val.startsWith('"')) {
      // quoted — keep entire value
    } else {
      const c = val.indexOf(' #');
      if (c >= 0) val = val.slice(0, c).trim();
    }
    if (val === '' || val === 'null' || val === '~' || val === 'Null' || val === 'NULL') {
      out[key] = null;
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      out[key] = val.slice(1, -1).replace(/''/g, "'");
    } else if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      out[key] = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Render a YAML scalar matching PyYAML safe_dump's default behavior closely
// enough that round-trips through the action don't churn the diff.
function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  if (s === '') return "''";
  if (needsQuoting(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}

function needsQuoting(s) {
  // Reserved words that would parse as non-strings.
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
  // Numeric-looking
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true;
  // Timestamp-looking (YYYY-MM-DD with optional time)
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return true;
  // Leading char that starts a non-plain scalar in YAML
  if (/^[!&*?|>%@`'"\[\]{},#-]/.test(s)) return true;
  // Indicators within (": " is a key separator, " #" starts a comment)
  if (/: |\s#/.test(s)) return true;
  // Trailing whitespace
  if (/\s$/.test(s)) return true;
  return false;
}

function serializeMessage(fm, body) {
  let out = '---\n';
  const seen = new Set();
  for (const key of FIELD_ORDER) {
    out += `${key}: ${yamlValue(fm[key] ?? null)}\n`;
    seen.add(key);
  }
  for (const [k, v] of Object.entries(fm)) {
    if (!seen.has(k)) out += `${k}: ${yamlValue(v)}\n`;
  }
  out += '---\n' + body.trim() + '\n';
  return out;
}

function splitMessageFile(text) {
  if (!text.startsWith('---\n')) throw new Error('missing frontmatter');
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('unterminated frontmatter');
  return {
    fm: parseFrontmatter(text.slice(4, end)),
    body: text.slice(end + 5).replace(/\s+$/, ''),
  };
}

// -------- id / timestamps ---------------------------------------------

function nowIso() { return new Date().toISOString(); }

function compactStamp(d = new Date()) {
  // 2026-05-03T14:22:01.123Z -> 20260503T142201Z
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

function randomHex(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
  return `${compactStamp()}-${randomHex(4)}`;
}

// -------- timeline state classification --------------------------------

function classify(fm) {
  if (fm.posted_at) return 'posted';
  const successes = [fm.mastodon_url, fm.bluesky_url].filter(Boolean).length;
  const errors = [fm.mastodon_error, fm.bluesky_error].filter(Boolean).length;
  if (successes > 0 && errors > 0) return 'partial';
  if (errors > 0) return 'failed';
  return 'pending';
}

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// -------- DOM ---------------------------------------------------------

const $ = sel => document.querySelector(sel);

function setStatus(el, kind, text) {
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.textContent = text;
}

function showOnboarding(show) {
  $('#onboarding').hidden = !show;
  $('#compose-section').hidden = show;
  $('#timeline-section').hidden = show;
}

function updateCharCount() {
  const n = $('#compose-text').value.length;
  const counter = $('#char-count');
  counter.textContent = `${n} / ${MAX_LEN}`;
  counter.classList.toggle('over-limit', n > MAX_LEN);
  $('#post-btn').disabled = n === 0 || n > MAX_LEN;
}

function renderTimeline(messages) {
  const list = $('#timeline-list');
  if (!messages.length) {
    list.innerHTML = '<p class="muted">No messages yet.</p>';
    return;
  }
  list.innerHTML = '';
  for (const m of messages) {
    const art = document.createElement('article');
    art.className = `msg ${classify(m.fm)}`;

    const body = document.createElement('p');
    body.className = 'body';
    body.textContent = m.body;
    art.appendChild(body);

    const footer = document.createElement('footer');

    const badge = document.createElement('span');
    const status = classify(m.fm);
    badge.className = `badge ${status}`;
    badge.textContent = status;
    footer.appendChild(badge);

    const time = document.createElement('time');
    time.dateTime = m.fm.created_at || '';
    time.textContent = relativeTime(m.fm.created_at);
    footer.appendChild(time);

    if (m.fm.mastodon_url) {
      const a = document.createElement('a');
      a.href = m.fm.mastodon_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Mastodon';
      footer.appendChild(a);
    }
    if (m.fm.bluesky_url) {
      const a = document.createElement('a');
      a.href = m.fm.bluesky_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Bluesky';
      footer.appendChild(a);
    }

    art.appendChild(footer);

    const errs = [];
    if (m.fm.mastodon_error) errs.push(`Mastodon: ${m.fm.mastodon_error}`);
    if (m.fm.bluesky_error) errs.push(`Bluesky: ${m.fm.bluesky_error}`);
    if (errs.length) {
      const e = document.createElement('div');
      e.className = 'error-detail';
      e.textContent = errs.join('\n');
      art.appendChild(e);
    }

    list.appendChild(art);
  }
}

async function refreshTimeline() {
  const list = $('#timeline-list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const files = await listMessageFiles();
    const contents = await Promise.all(
      files.map(async f => {
        try {
          const raw = await fetchMessageRaw(f.path);
          const { fm, body } = splitMessageFile(raw);
          return { name: f.name, fm, body };
        } catch (e) {
          return { name: f.name, fm: { id: f.name }, body: `(could not read: ${e.message})` };
        }
      }),
    );
    contents.sort((a, b) => (b.fm.created_at || '').localeCompare(a.fm.created_at || ''));
    renderTimeline(contents);
  } catch (e) {
    list.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'status err';
    p.textContent = `Could not load timeline: ${e.message}`;
    list.appendChild(p);
  }
}

async function postMessage(ev) {
  ev.preventDefault();
  const text = $('#compose-text').value.trim();
  if (!text || text.length > MAX_LEN) return;

  const status = $('#compose-status');
  const btn = $('#post-btn');
  btn.disabled = true;
  setStatus(status, 'info', 'Committing to GitHub…');

  const id = generateId();
  const fm = {
    id,
    created_at: nowIso(),
    posted_at: null,
    mastodon_url: null,
    bluesky_url: null,
    mastodon_error: null,
    bluesky_error: null,
  };
  const fileText = serializeMessage(fm, text);

  try {
    await createMessageFile(`${id}.md`, fileText, `Post ${id}`);
    $('#compose-text').value = '';
    updateCharCount();
    setStatus(status, 'ok', 'Committed. The action will publish to Mastodon and Bluesky shortly.');
    refreshTimeline();
  } catch (e) {
    setStatus(status, 'err', `Failed: ${e.message}`);
    btn.disabled = false;
  }
}

// -------- settings dialog ---------------------------------------------

function openSettings() {
  const dlg = $('#settings-dialog');
  const s = loadSettings() || { pat: '', owner: '', repo: '', branch: 'main' };
  $('#pat-input').value = s.pat || '';
  $('#owner-input').value = s.owner || '';
  $('#repo-input').value = s.repo || '';
  $('#branch-input').value = s.branch || 'main';
  setStatus($('#settings-status'), '', '');
  dlg.showModal();
}

function readSettingsForm() {
  return {
    pat: $('#pat-input').value.trim(),
    owner: $('#owner-input').value.trim(),
    repo: $('#repo-input').value.trim(),
    branch: ($('#branch-input').value.trim() || 'main'),
  };
}

async function onSettingsTest() {
  const s = readSettingsForm();
  const status = $('#settings-status');
  if (!s.pat || !s.owner || !s.repo) {
    setStatus(status, 'err', 'Fill in PAT, owner, and repo first.');
    return;
  }
  setStatus(status, 'info', 'Testing…');
  try {
    const info = await ghCheckAuth(s);
    setStatus(status, 'ok', `Reached ${info.full_name} (default branch: ${info.default_branch}).`);
  } catch (e) {
    setStatus(status, 'err', e.message);
  }
}

function onSettingsSave(ev) {
  ev.preventDefault();
  const s = readSettingsForm();
  if (!s.pat || !s.owner || !s.repo) {
    setStatus($('#settings-status'), 'err', 'Fill in PAT, owner, and repo first.');
    return;
  }
  saveSettings(s);
  $('#settings-dialog').close();
  showOnboarding(false);
  refreshTimeline();
}

function onSettingsForget() {
  if (!confirm('Forget the saved settings on this device?')) return;
  clearSettings();
  $('#settings-dialog').close();
  showOnboarding(true);
}

// -------- init --------------------------------------------------------

function init() {
  $('#settings-btn').addEventListener('click', openSettings);
  $('#refresh-btn').addEventListener('click', () => refreshTimeline());
  $('#compose-text').addEventListener('input', updateCharCount);
  $('#compose-form').addEventListener('submit', postMessage);
  $('#settings-form').addEventListener('submit', onSettingsSave);
  $('#settings-test').addEventListener('click', onSettingsTest);
  $('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
  $('#settings-forget').addEventListener('click', onSettingsForget);

  if (loadSettings()) {
    showOnboarding(false);
    updateCharCount();
    refreshTimeline();
  } else {
    showOnboarding(true);
  }
}

init();
