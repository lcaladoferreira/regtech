const NAV_GROUPS = [
  { title: 'Workspace', items: [
    ['/dashboard', 'Overview', 'OV'],
    ['/obligations', 'Obligation registry', 'OB'],
    ['/regulators', 'Regulators', 'RG'],
    ['/changes', 'Change feed', 'CH'],
    ['/schemas', 'Schema registry', 'SC'],
    ['/norm-diff', 'Norm diff', 'ND'],
  ] },
  { title: 'Data intelligence', items: [
    ['/impact', 'Impact explorer', 'IM'],
    ['/mapping', 'Mapping studio', 'MP'],
    ['/catalog', 'Canonical catalog', 'CT'],
    ['/lineage', 'Data lineage', 'LN'],
    ['/dq', 'Data quality', 'DQ'],
    ['/matrix', 'Impact matrix', 'MX'],
  ] },
  { title: 'Controls & operations', items: [
    ['/calendar', 'Deadline calendar', 'CA'],
    ['/submissions', 'Submissions', 'SB'],
    ['/controls', 'Controls', 'CO'],
    ['/evidence', 'Evidence center', 'EV'],
    ['/regulatory', 'Regulatory ops', 'RO'],
    ['/engineering', 'Engineering impact', 'EN'],
    ['/cases', 'Reference cases', 'CS'],
  ] },
  { title: 'System', items: [
    ['/system/jobs', 'Jobs & runs', 'JR'],
    ['/system/errors', 'Ingestion errors', 'ER'],
  ] },
];

const PAGE_META = {
  '/dashboard': ['Overview', 'Cross-regulator inventory and operational signals'],
  '/obligations': ['Obligation registry', 'Search and compare sourced requirements across regulators'],
  '/impact': ['Impact explorer', 'Trace a regulatory obligation into schemas, data, controls and evidence'],
  '/regulators': ['Regulators', 'Shared inventory for the six configured Brazilian authorities'],
  '/changes': ['Regulatory change feed', 'Source-linked change records and deterministic technical impacts'],
  '/schemas': ['Schema registry', 'Version, parse scope, fields and explicit gaps in technical coverage'],
  '/norm-diff': ['Norm diff', 'Lexical document comparison; human legal interpretation remains required'],
  '/mapping': ['Mapping studio', 'Connect sourced regulatory fields to internal data and canonical concepts'],
  '/catalog': ['Canonical catalog', 'Reusable business concepts linked to source fields and mappings'],
  '/lineage': ['Data lineage', 'Navigate stored paths between internal data and obligations'],
  '/dq': ['Data quality', 'Executable checks with visible DEMO DATA fixtures and failure results'],
  '/calendar': ['Deadline calendar', 'Keep regulator-published due dates distinct from internal targets'],
  '/submissions': ['Submission runs', 'Generated artifacts and local validation; never a regulator filing'],
  '/controls': ['Control library', 'Controls linked to requirements, owners and evidence'],
  '/evidence': ['Evidence center', 'Source, mapping, validation and artifact traceability'],
  '/regulatory': ['Regulatory operations', 'Norms, effective dates, sources and applicability inventory'],
  '/engineering': ['Engineering impact', 'Catalogued schemas, mappings, pipelines and DQ coverage'],
  '/matrix': ['Impact matrix', 'Obligations connected to systems, datasets, pipelines and owners'],
  '/cases': ['Reference cases', 'Concrete implementation slices and limitations by regulator'],
  '/system/jobs': ['Jobs & runs', 'Source collection, parsing, impact, DQ and demo-pipeline runs'],
  '/system/errors': ['Ingestion errors', 'Failures are persisted, visible and retryable where possible'],
  '/search': ['Global search', 'Search obligations, regulations, fields, sources and changes'],
};

const state = {
  renderId: 0,
  mappingEditor: null,
  mappingQuery: '',
  mappingStatus: '',
  showDeadlineForm: false,
  showControlForm: false,
  latestPipeline: null,
  toast: null,
  toastTimer: null,
};

function routeState() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!raw) return { path: '/dashboard', params: new URLSearchParams() };
  const [path, query = ''] = raw.split('?');
  return { path: path || '/dashboard', params: new URLSearchParams(query) };
}

function navigate(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, value);
  const next = `#${path}${query.size ? `?${query.toString()}` : ''}`;
  if (location.hash === next) renderApp();
  else location.hash = next;
}

async function api(path, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  if (request.body && typeof request.body !== 'string') {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(request.body);
  }
  const response = await fetch(path, request);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload?.error;
    throw error;
  }
  return payload;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeHref(value) {
  const text = String(value || '');
  if (text.startsWith('#/')) return text;
  if (text.startsWith('/api/') && !text.startsWith('//')) return text;
  if (text.startsWith('/') && !text.startsWith('//')) return `#${text}`;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
  } catch { /* not a URL */ }
  return '#';
}

function badge(value, override = '') {
  const label = String(value ?? 'NOT AVAILABLE');
  const lookup = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const classes = {
    high: 'high', critical: 'critical', fail: 'fail', overdue: 'overdue',
    medium: 'medium', 'review-required': 'review', review: 'review', pending: 'pending',
    low: 'low', pass: 'pass', active: 'active', current: 'current', succeeded: 'succeeded', verified: 'verified',
    info: 'info', official: 'official', mapped: 'mapped', ready: 'ready', 'parsed-text': 'parsed',
    demo: 'demo', internal: 'internal', unstructured: 'unstructured', 'not-run': 'not-run',
    unknown: 'neutral', upcoming: 'info', discovered: 'neutral', 'fetch-error': 'fail', 'raw-captured': 'verified',
    'raw-unchanged': 'verified', unassessed: 'unassessed', 'completed-with-failures': 'review', failed: 'fail',
    partial: 'review', 'reference-only': 'neutral', 'reference-implemented': 'pass', 'reference-structured': 'info',
    'excerpt-verified': 'verified', 'ready-for-review': 'info', deprecated: 'neutral',
  };
  const cls = override || classes[lookup] || 'neutral';
  return `<span class="badge ${esc(cls)}">${esc(label.replaceAll('_', ' '))}</span>`;
}

function tag(value) { return `<span class="tag">${esc(value)}</span>`; }
function panel(title, body, options = {}) {
  const description = options.description ? `<p class="panel-description">${esc(options.description)}</p>` : '';
  const action = options.action || '';
  const head = title ? `<div class="panel-head"><div><h2 class="panel-title">${esc(title)}</h2>${description}</div>${action}</div>` : '';
  return `<section class="panel">${head}<div class="panel-body${options.flush ? ' flush' : ''}">${body}</div></section>`;
}
function table(headers, rows, empty = 'No records available.') {
  if (!rows.length) return `<div class="empty-state"><span class="empty-mark">—</span><strong class="empty-title">No matching records</strong><span class="empty-copy">${esc(empty)}</span></div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function pageHead(title, subtitle, actions = '') {
  return `<header class="page-head"><div><div class="breadcrumb">LCF / Regulatory Data Intelligence</div><h1 class="page-title">${esc(title)}</h1><p class="page-subtitle">${esc(subtitle)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
}
function metric(label, value, note, icon, color = '') {
  return `<article class="metric-card ${esc(color)}"><span class="metric-accent">${esc(icon)}</span><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></article>`;
}
function progress(value, note = '') {
  const percent = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
  return `<div class="progress-wrap"><div class="progress-meta"><span>${percent}%</span><span>${esc(note)}</span></div><div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div></div>`;
}
function dateText(value) {
  if (!value) return 'NOT AVAILABLE';
  const date = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  return date;
}
function number(value) { return new Intl.NumberFormat('en-US').format(Number(value || 0)); }
function extLink(url, label = 'Open official source') {
  if (!url) return '<span class="cell-secondary">Source URL not available</span>';
  return `<a class="source-url" href="${esc(safeHref(url))}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}
function obligationLink(id, label) { return `<a href="#/impact?id=${encodeURIComponent(id || '')}">${esc(label || id || 'Obligation')}</a>`; }
function emptyState(title, detail) {
  return `<div class="empty-state"><span class="empty-mark">RDI</span><strong class="empty-title">${esc(title)}</strong><span class="empty-copy">${esc(detail)}</span></div>`;
}
function valueBox(label, value) {
  return `<div class="value-box"><div class="value-label">${esc(label)}</div><div class="value-text">${esc(value || 'NOT AVAILABLE')}</div></div>`;
}

function shellMarkup(route) {
  const meta = PAGE_META[route.path] || PAGE_META['/dashboard'];
  const nav = NAV_GROUPS.map((group) => `<section class="nav-group"><h2 class="nav-heading">${esc(group.title)}</h2>${group.items.map(([path, label, icon]) => {
    const active = route.path === path || (path === '/impact' && route.path === '/impact') || (path === '/regulators' && route.path === '/regulators');
    return `<button class="nav-link ${active ? 'active' : ''}" type="button" data-route="${esc(path)}" aria-current="${active ? 'page' : 'false'}"><span class="nav-icon">${esc(icon)}</span><span class="nav-link-label">${esc(label)}</span></button>`;
  }).join('')}</section>`).join('');
  const toast = state.toast ? `<div class="toast ${esc(state.toast.type)}" role="status">${esc(state.toast.message)}</div>` : '';
  return `<div class="app-shell">
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand-block"><span class="brand-mark">LCF</span><div class="brand-copy"><div class="brand-name">Regulatory Data<br>Intelligence</div><div class="brand-subtitle">Compliance workspace</div></div></div>
      <nav class="nav-scroll">${nav}</nav>
      <div class="sidebar-footer"><div class="sidebar-status"><span class="status-dot"></span>Local SQLite workspace</div><div class="sidebar-version">DEMO BUILD · 0.1.0</div></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="topbar-context"><strong>${esc(meta[0])}</strong><span>${esc(meta[1])}</span></div>
        <form class="global-search" id="global-search-form" role="search"><span class="search-glyph" aria-hidden="true">⌕</span><input id="global-search-input" name="q" type="search" placeholder="Search regulations, fields, sources…" aria-label="Global search"><kbd class="kbd">Ctrl K</kbd></form>
        <div class="topbar-right"><span class="top-pill">SQLite · LOCAL DEMO</span></div>
      </header>
      <div class="demo-banner"><span><strong>DEMO DATA</strong> · Synthetic internal fixtures and curated regulatory excerpts. No regulator submission or official validation is performed.</span><a href="#/regulatory">Source & provenance notes</a></div>
      <div id="page-content"><div class="loading-line"></div><div class="page"><p class="page-subtitle">Loading workspace data…</p></div></div>
    </div>
    ${toast}
  </div>`;
}

async function renderApp() {
  const current = routeState();
  const renderId = ++state.renderId;
  document.title = `${PAGE_META[current.path]?.[0] || 'Workspace'} · LCF Regulatory Data Intelligence`;
  document.getElementById('app').innerHTML = shellMarkup(current);
  try {
    const html = await renderRoute(current);
    if (renderId !== state.renderId) return;
    const target = document.getElementById('page-content');
    if (target) target.innerHTML = html;
  } catch (error) {
    if (renderId !== state.renderId) return;
    const target = document.getElementById('page-content');
    if (target) target.innerHTML = `<main class="page">${pageHead('Workspace error', 'The request failed; existing data remains unchanged.')}<div class="alert danger"><strong>${esc(error.code || 'REQUEST_FAILED')}</strong> · ${esc(error.message || 'Unexpected error')}</div><button class="button" data-action="refresh">Retry request</button></main>`;
  }
}

async function renderRoute(route) {
  switch (route.path) {
    case '/dashboard': return renderDashboard();
    case '/obligations': return renderObligations(route.params);
    case '/impact': return route.params.get('id') ? renderObligationDetail(route.params.get('id')) : renderImpactIndex();
    case '/regulators': return route.params.get('regulator') ? renderRegulatorDetail(route.params.get('regulator')) : renderRegulators();
    case '/changes': return renderChanges(route.params);
    case '/schemas': return route.params.get('id') ? renderSchemaDetail(route.params.get('id')) : renderSchemas(route.params);
    case '/norm-diff': return renderNormDiff();
    case '/mapping': return renderMapping();
    case '/catalog': return renderCatalog(route.params);
    case '/lineage': return renderLineage(route.params);
    case '/dq': return renderDq();
    case '/calendar': return renderCalendar();
    case '/submissions': return renderSubmissions();
    case '/controls': return renderControls();
    case '/evidence': return renderEvidence();
    case '/regulatory': return renderRegulatory();
    case '/engineering': return renderEngineering();
    case '/matrix': return renderMatrix();
    case '/cases': return renderCases();
    case '/system/jobs': return renderJobs();
    case '/system/errors': return renderErrors();
    case '/search': return renderSearch(route.params);
    default: return `<main class="page">${pageHead('Page not found', 'Select a module from the navigation.')}<a class="button" href="#/dashboard">Return to overview</a></main>`;
  }
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  const { counts, data_trust: trust } = data;
  const cards = `<div class="metric-grid">
    ${metric('Active obligations', number(counts.obligation_count), 'Across configured regulators', 'OB')}
    ${metric('Official deadlines ahead', number(counts.deadline_count), 'Published/source-backed records only', 'DL', 'amber')}
    ${metric('Catalogued fields', number(counts.field_count), 'Curated structured inventory', 'SF', 'blue')}
    ${metric('Mappings in use', number(counts.mapped_field_count), `${number(counts.unmapped_field_count)} active fields need mapping`, 'MP', 'red')}
  </div>`;
  const changes = data.top_changes.map((change) => `<div class="change-card"><div class="change-top"><div><div class="change-title">${esc(change.summary)}</div><div class="cell-secondary">${esc(change.regulator?.acronym || 'Authority pending')} · ${esc(change.change_type)} · ${dateText(change.detected_at)}</div></div>${badge(change.severity, change.severity === 'UNASSESSED' ? 'unassessed' : '')}</div><div class="change-summary">${esc(change.field || 'Source-level change')} ${change.obligation ? `· ${obligationLink(change.obligation.id, change.obligation.code)}` : ''}</div></div>`).join('');
  const deadlines = data.upcoming_deadlines.map((item) => `<div class="status-item"><div><div class="status-name">${obligationLink(item.obligation_id, `${item.regulator_acronym} · ${item.obligation_code}`)}</div><div class="status-detail">${esc(item.reference_period)} · ${esc(item.calculation_basis || '')}</div></div><div class="nowrap">${badge(item.deadline_type, 'official')}<div class="cell-secondary">${dateText(item.due_date)}</div></div></div>`).join('');
  const obligations = data.obligations_preview.map((item) => `<tr><td>${tag(item.regulator_acronym)}</td><td><div class="cell-primary">${obligationLink(item.id, item.title)}</div><span class="cell-secondary mono">${esc(item.code)}</span></td><td>${esc(item.frequency || 'UNKNOWN')}</td><td>${item.field_count ? number(item.mapped_field_count) + ' / ' + number(item.field_count) : '—'}</td><td>${badge(item.impact_level || 'LOW', 'neutral')}</td></tr>`);
  const provenance = `<div class="alert warning"><strong>Source boundary.</strong> ${number(trust.official_source_excerpts)} stored curated excerpts · ${number(trust.raw_remote_snapshots)} raw remote snapshots. Curated-excerpt SHA-256 values are not hashes of original source bytes. The source collector has not populated a live snapshot in this workspace.</div>`;
  return `<main class="page">${pageHead('Regulatory data intelligence', 'A sourced, cross-regulator view from obligation to data, control and evidence.', `<a class="button primary" href="#/obligations">Browse obligation registry</a>`)}${cards}${provenance}
    <div class="dashboard-grid"><div>${panel('Recent sourced changes', changes || emptyState('No changes recorded', 'No source-backed changes have been added yet.'), { description: 'Technical impact is deterministic; it is not a legal severity rating.', action: '<a class="panel-link" href="#/changes">View change feed →</a>', flush: true })}${panel('Obligation inventory', table(['Authority','Obligation','Cadence','Mapped fields','Footprint'], obligations, 'No obligations match this view.'), { description: 'Footprint is an inventory heuristic, not legal materiality.', action: '<a class="panel-link" href="#/obligations">Open registry →</a>', flush: true })}</div>
    <div>${panel('Upcoming official deadlines', deadlines || emptyState('No upcoming deadlines', 'Source-backed official due dates appear here; internal targets are shown separately in Calendar.'), { description: 'Regulatory due dates only. Internal targets are never merged into this list.', flush: true })}${panel('Coverage & trust', `<div class="status-list"><div class="status-item"><div><div class="status-name">Configured authorities</div><div class="status-detail">Multi-regulator registry</div></div><strong class="mono">${number(counts.regulator_count)} / 6</strong></div><div class="status-item"><div><div class="status-name">Structured field coverage</div><div class="status-detail">${number(counts.mapped_field_count)} of ${number(counts.field_count)} mapped fields</div></div><strong class="mono">${counts.field_count ? Math.round((counts.mapped_field_count/counts.field_count)*100) : 0}%</strong></div><div class="status-item"><div><div class="status-name">Raw regulatory snapshots</div><div class="status-detail">Original bytes stored immutably</div></div>${badge(number(counts.raw_snapshots), counts.raw_snapshots ? 'pass' : 'review')}</div><div class="status-item"><div><div class="status-name">Open ingestion errors</div><div class="status-detail">Visible and retryable where source-linked</div></div>${badge(number(counts.ingestion_error_count), counts.ingestion_error_count ? 'fail' : 'pass')}</div></div>`, { description: 'Metadata coverage; no client production estate is connected.' })}</div></div></main>`;
}

async function renderObligations(params = new URLSearchParams()) {
  const [obligations, regulators] = await Promise.all([api(`/api/obligations?${params.toString()}`), api('/api/regulators')]);
  const options = regulators.map((r) => `<option value="${esc(r.id)}" ${params.get('regulator') === r.id ? 'selected' : ''}>${esc(r.acronym)} · ${esc(r.name)}</option>`).join('');
  const rows = obligations.map((item) => `<tr><td>${tag(item.regulator_acronym)}</td><td><div class="cell-primary">${obligationLink(item.id, item.title)}</div><span class="cell-secondary mono">${esc(item.code)} · ${esc(item.regulation_number)}</span></td><td>${esc(item.frequency || 'UNKNOWN')}</td><td>${number(item.field_count)} field(s)<span class="cell-secondary">${number(item.requirement_count)} req · ${number(item.document_count)} docs</span></td><td>${item.field_count ? progress(item.mapping_coverage, `${item.mapped_field_count}/${item.field_count}`) : '—'}</td><td class="nowrap">${item.next_official_deadline ? `${dateText(item.next_official_deadline)}<span class="cell-secondary">OFFICIAL</span>` : 'NOT AVAILABLE'}</td><td>${badge(item.impact_level || 'LOW', 'neutral')}<span class="cell-secondary">footprint only</span></td></tr>`);
  return `<main class="page">${pageHead('Obligation registry', 'The generic regulatory_obligation inventory is the primary product object—not a regulator-specific report catalog.', `<a class="button soft" href="#/impact">Open impact explorer</a>`)}${panel('Filter obligations', `<form class="toolbar" data-form="obligation-filter"><input class="input" name="q" value="${esc(params.get('q') || '')}" placeholder="Search title, code, regulation…"><select name="regulator"><option value="">All regulators</option>${options}</select><select name="frequency"><option value="">All cadences</option>${['DAILY','MONTHLY','ANNUAL','EVENT_DRIVEN','CONTINUOUS','ON_DEMAND','UNKNOWN'].map((value)=>`<option ${params.get('frequency')===value?'selected':''}>${value}</option>`).join('')}</select><button class="button primary" type="submit">Apply</button><a class="button" href="#/obligations">Reset</a></form>${table(['Regulator','Regulatory obligation','Cadence','Technical scope','Mapping coverage','Next official due','Inventory footprint'], rows, 'No obligation matches these filters.')}`, { description: `${number(obligations.length)} active obligation records across six authorities.`, flush: true })}<div class="alert">Scope, affected entities and deadlines are anchored to stored regulatory sources. “UNKNOWN” and “NOT AVAILABLE” are intentional when an applicable population or rule has not been verified.</div></main>`;
}

async function renderImpactIndex() {
  const obligations = await api('/api/obligations');
  const rows = obligations.map((item) => `<tr><td>${tag(item.regulator_acronym)}</td><td><div class="cell-primary">${obligationLink(item.id,item.title)}</div><span class="cell-secondary">${esc(item.code)}</span></td><td>${number(item.requirement_count)} requirements</td><td>${number(item.field_count)} catalogued fields</td><td>${number(item.mapped_field_count)} mapped</td><td>${number(item.dq_field_count)} with DQ</td><td><a class="button compact" href="#/impact?id=${encodeURIComponent(item.id)}">Trace impact</a></td></tr>`);
  return `<main class="page">${pageHead('Impact explorer', 'Select any regulatory obligation and inspect its requirement-to-data chain, including explicit gaps.', `<a class="button" href="#/lineage">Open reverse lineage</a>`)}${panel('Obligation-to-data coverage', table(['Regulator','Obligation','Requirements','Schema fields','Mappings','DQ coverage',''], rows, 'No inventory rows are available.'), { description: 'Coverage counts reflect stored metadata and DEMO DATA mappings, not production implementation assurance.', flush: true })}</main>`;
}

async function renderObligationDetail(id) {
  const detail = await api(`/api/obligations/${encodeURIComponent(id)}`);
  const o = detail.obligation;
  const official = detail.deadlines.filter((d) => d.deadline_type === 'OFFICIAL');
  const internal = detail.deadlines.filter((d) => d.deadline_type === 'INTERNAL');
  const fields = detail.fields.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td>${esc(f.name)}</td><td>${esc(f.data_type)}${f.length ? ` · ${esc(f.length)}` : ''}${f.precision ? ` · ${esc(f.precision)},${esc(f.scale ?? 0)}` : ''}</td><td>${f.required === null ? 'UNKNOWN' : f.required ? 'Yes' : 'No'}<span class="cell-secondary">${esc(f.required_condition || '')}</span></td><td>${esc(f.source_reference)}</td></tr>`);
  const requirements = detail.requirements.map((r) => `<div class="status-item"><div><div class="status-name">${tag(r.requirement_type)} ${esc(r.description)}</div><div class="status-detail">Effective from ${dateText(r.effective_from)} · ${esc(r.source_title || r.source_reference)}</div>${r.source_url ? extLink(r.source_url, 'Verify requirement at source') : ''}</div>${badge(r.status || 'ACTIVE','active')}</div>`).join('');
  const documents = detail.documents.map((d) => `<div class="status-item"><div><div class="status-name">${esc(d.code)} · ${esc(d.name)}</div><div class="status-detail">${esc(d.document_type)} · ${esc(d.frequency || 'UNKNOWN')} · ${esc(d.output_format || 'UNKNOWN')}</div>${d.schema_version_id ? `<a class="source-url" href="#/schemas?id=${encodeURIComponent(d.schema_version_id)}">Schema ${esc(d.version)} · ${esc(d.parse_status)} ↗</a>` : ''}</div>${badge(d.schema_version_id ? d.parse_status : 'NOT AVAILABLE', d.schema_version_id ? (d.parse_status === 'UNSTRUCTURED' ? 'unstructured' : 'verified') : 'neutral')}</div>`).join('');
  const mappings = detail.mappings.slice(0, 20).map((m) => `<tr><td class="mono">${esc(m.regulatory_field_path || m.regulatory_field_name)}</td><td>${esc(m.source_field || 'UNMAPPED')}<span class="cell-secondary">${esc(m.dataset_name || '')}</span></td><td>${badge(m.mapping_status, m.mapping_status === 'VALIDATED' ? 'pass' : m.mapping_status === 'REVIEW_REQUIRED' ? 'review' : 'neutral')}</td><td>${esc(m.pipeline_name || 'No dependency recorded')}</td></tr>`);
  const sourceCards = detail.sources.map((s) => `<div class="source-card"><div><div class="source-title">${esc(s.source_title)}</div><div class="source-meta">${esc(s.source_authority)} · ${esc(s.source_type)} · ${esc(s.version || 'Version NOT AVAILABLE')} · Published ${dateText(s.publication_date)} · excerpt verified ${dateText(s.excerpt_verified_at)}</div><div class="source-meta">${s.content_hash ? `Stored text hash (${esc(s.content_hash_scope)}):` : 'Hash NOT AVAILABLE'}</div>${s.content_hash ? `<div class="hash-line">${esc(s.content_hash)}</div>` : ''}<div class="source-meta">Raw snapshots: ${number(s.raw_snapshot_count || 0)}. ${s.content_hash_scope === 'CURATED_EXCERPT_SHA256' ? 'Hash is over the curated excerpt, not original source bytes.' : 'No source-byte claim.'}</div>${extLink(s.source_url)}</div>${badge(s.status || 'DISCOVERED', s.status === 'EXCERPT_VERIFIED' ? 'verified' : 'neutral')}</div>`).join('');
  const deadlineRows = (items, internalMode) => items.map((d) => `<tr><td>${internalMode ? badge('INTERNAL', 'internal') : badge('OFFICIAL','official')}</td><td>${esc(d.reference_period)}</td><td class="nowrap">${dateText(d.due_date)}</td><td>${esc(d.owner || 'NOT AVAILABLE')}</td><td>${esc(d.calculation_basis || 'NOT AVAILABLE')}<span class="cell-secondary">${internalMode ? 'Operator-entered target; not regulatory.' : d.source_url ? extLink(d.source_url, 'Official due-date source') : 'Official source URL not available.'}</span></td></tr>`);
  const pipelineResult = state.latestPipeline?.submission?.obligation_id === id ? `<div class="alert success"><strong>DEMO DATA artifact generated.</strong> It was not submitted; local configured checks are not an official regulator validator. <a href="${esc(safeHref(state.latestPipeline.submission.artifact_url))}">Download ${esc(o.code)} artifact ↗</a> · ${badge(state.latestPipeline.validation.status,'ready')}</div>` : '';
  const actions = `<a class="button" href="#/mapping">Open mapping studio</a>${id === 'obl-bcb-4111' ? '<button class="button primary" data-action="run-pipeline" data-obligation="obl-bcb-4111">Run 4111 demo pipeline</button>' : ''}`;
  return `<main class="page">${pageHead(o.title, `${o.regulator_acronym} · ${o.code} · ${o.regulation_number} · ${o.regulation_title}`, actions)}
    <div class="alert warning"><strong>Applicability & severity.</strong> ${esc(o.affected_entities || 'UNKNOWN')} The inventory footprint (${esc(o.impact_score)} / ${esc(o.impact_level)}) is a structural heuristic—not legal severity or an applicability determination.</div>${pipelineResult}
    <div class="kv-grid"><div class="kv"><div class="kv-label">Regulator</div><div class="kv-value">${esc(o.regulator_name)} (${esc(o.regulator_acronym)})</div></div><div class="kv"><div class="kv-label">Frequency</div><div class="kv-value">${esc(o.frequency || 'UNKNOWN')}</div></div><div class="kv"><div class="kv-label">Output format</div><div class="kv-value">${esc(o.output_format || 'UNKNOWN')}</div></div><div class="kv"><div class="kv-label">Submission method</div><div class="kv-value">${esc(o.submission_method || 'UNKNOWN')}</div></div><div class="kv"><div class="kv-label">Owner</div><div class="kv-value">${esc(o.owner || 'NOT AVAILABLE')}</div></div><div class="kv"><div class="kv-label">Configuration</div><div class="kv-value">${detail.is_demo_configuration ? badge('DEMO CONFIGURATION','demo') : 'Official-reference metadata only'}</div></div></div>
    ${panel('End-to-end trace', `<div class="chain-list">${detail.chain.map((step) => `<span class="chain-step ${step.available ? 'available' : ''}"><span class="chain-check">${step.available ? '✓' : '—'}</span>${esc(step.label)}</span>`).join('')}</div>`, { description: 'A missing step indicates a real coverage gap, not a successful implementation.' })}
    <div class="split-grid">${panel('Requirements & rule references', requirements || emptyState('No requirement rows', 'The obligation has no separately structured requirements yet.'), { flush: true })}${panel('Documents & schema versions', documents || emptyState('No documents', 'No document record is linked to this obligation.'), { flush: true })}</div>
    <div class="split-grid">${panel('Regulatory fields', fields.length ? table(['Field path','Name','Type / constraints','Required','Source reference'], fields, 'No structured fields captured for this obligation.') : emptyState('No structured field inventory', 'The official material is catalogued as unstructured; the platform will not fabricate a schema.'), { description: `${number(detail.fields.length)} catalogued fields; requiredness may remain UNKNOWN.`, flush: true })}${panel('Mappings to internal data', table(['Regulatory field','Internal source','Mapping status','Pipeline'], mappings, 'No internal mappings recorded for this obligation.'), { description: 'Internal assets are synthetic DEMO DATA in this build.', action: '<a class="panel-link" href="#/mapping">Edit mappings →</a>', flush: true })}</div>
    ${panel('Official and internal deadlines — separate records', `<h3 class="panel-title">Official regulatory deadlines</h3>${official.length ? table(['Type','Period','Due date','Owner','Basis / source'], deadlineRows(official,false), 'No published official deadline is recorded.') : emptyState('No official date captured', 'Do not infer a regulatory deadline from an internal target.') }<div style="height:10px"></div><h3 class="panel-title">Internal planning targets</h3>${internal.length ? table(['Type','Period','Due date','Owner','Basis'], deadlineRows(internal,true), 'No internal target recorded.') : emptyState('No internal target', 'Add an internal target from the Calendar module; it will remain explicitly non-regulatory.')}`, { flush: true })}
    <div class="split-grid">${panel('Controls', detail.controls.length ? table(['Control','Owner','Frequency','Result'], detail.controls.map((c) => `<tr><td>${esc(c.control_name)}<span class="cell-secondary">${esc(c.evidence_type)}</span></td><td>${esc(c.owner)}</td><td>${esc(c.frequency)}</td><td>${badge(c.result || 'NOT_RUN')}</td></tr>`), 'No controls linked.') : emptyState('No controls linked','Create a control record before claiming operational coverage.'), { flush: true })}${panel('Evidence', detail.evidence.length ? table(['Evidence','Type','Collected','Status'], detail.evidence.map((e) => `<tr><td>${esc(e.title)}</td><td>${tag(e.evidence_type)}</td><td>${dateText(e.collected_at)}</td><td>${badge(e.status)}</td></tr>`), 'No evidence linked.') : emptyState('No evidence linked','Stored source references are shown separately below.'), { action: '<a class="panel-link" href="#/evidence">Evidence center →</a>', flush: true })}</div>
    ${panel('Source provenance', sourceCards || emptyState('No source links', 'Add and review an official source record before formalizing regulatory content.'), { description: 'Authority, version/date, stored hash scope and raw-snapshot count are explicit. URLs open in a new tab.' })}</main>`;
}

async function renderRegulators() {
  const rows = await api('/api/regulators');
  const cards = rows.map((r) => `<article class="regulator-card" data-regulator="${esc(r.id)}" tabindex="0" role="button" aria-label="Open ${esc(r.acronym)} regulator page"><span class="regulator-monogram">${esc(r.acronym)}</span><div><div class="regulator-name">${esc(r.name)}</div><div class="regulator-sector">${esc(r.sector)} · ${esc(r.jurisdiction)}</div></div><div><div class="regulator-stats"><span>${number(r.obligation_count)} obligations</span><span>${number(r.source_count)} sources</span></div><span class="cell-secondary">${number(r.regulation_count)} norms</span></div></article>`).join('');
  return `<main class="page">${pageHead('Regulator inventory', 'One shared obligation and source model across the authorities; no regulator-specific application architecture.')}${panel('Configured authorities', `<div class="regulator-grid">${cards}</div>`, { description: `${rows.length} authorities configured. Select one for its norms, obligations and source register.` })}<div class="alert">A regulator page is populated from the common source, regulation, obligation and change tables. Empty source or schema coverage remains visible rather than being filled with invented records.</div></main>`;
}

async function renderRegulatorDetail(regulatorId) {
  const [regulators, obligations, regulations, sources, changes] = await Promise.all([
    api('/api/regulators'), api(`/api/obligations?regulator=${encodeURIComponent(regulatorId)}`), api('/api/regulations'), api(`/api/sources?regulator=${encodeURIComponent(regulatorId)}`), api('/api/changes'),
  ]);
  const regulator = regulators.find((r) => r.id === regulatorId || r.acronym === regulatorId.toUpperCase());
  if (!regulator) throw new Error(`Regulator ${regulatorId} was not found.`);
  const norms = regulations.filter((r) => r.regulator_id === regulator.id).map((r) => `<tr><td>${tag(r.type)}</td><td><div class="cell-primary">${esc(r.number)}</div><span class="cell-secondary">${esc(r.title)}</span></td><td>${dateText(r.publication_date)}</td><td>${dateText(r.effective_date)}</td><td>${number(r.obligation_count)}</td><td>${extLink(r.source_url,'Open cited source')}</td></tr>`);
  const obs = obligations.map((o) => `<tr><td>${obligationLink(o.id,o.code)}</td><td>${esc(o.title)}</td><td>${esc(o.frequency)}</td><td>${number(o.field_count)}</td><td>${badge(o.impact_level || 'LOW','neutral')}</td></tr>`);
  const changeRows = changes.filter((c) => c.regulator?.id === regulator.id).map((c) => `<div class="change-card"><div class="change-top"><div class="change-title">${esc(c.summary)}</div>${badge(c.severity,c.severity === 'UNASSESSED' ? 'unassessed' : '')}</div><div class="change-summary">${esc(c.change_type)} · ${dateText(c.detected_at)} · ${c.obligation ? obligationLink(c.obligation.id,c.obligation.code) : 'No obligation linked'}</div></div>`);
  return `<main class="page">${pageHead(regulator.acronym, regulator.name, `<a class="button" href="#/regulators">All regulators</a>`)}<div class="alert">${esc(regulator.sector)} · ${esc(regulator.jurisdiction)} · ${number(regulator.obligation_count)} active obligations · ${number(sources.length)} sourced references.</div>
    ${panel('Normative inventory', table(['Type','Norm','Published','Effective','Obligations','Source'], norms,'No norm records configured for this regulator.'), { flush: true })}
    ${panel('Obligations', table(['Code','Requirement','Cadence','Fields','Inventory footprint'], obs,'No obligations configured.'), { flush: true })}
    <div class="split-grid">${panel('Regulatory changes', changeRows || emptyState('No changes linked','No source-backed change records currently link to this regulator.'), { flush: true })}${panel('Official source register', sources.map((s) => `<div class="source-card"><div><div class="source-title">${esc(s.source_title)}</div><div class="source-meta">${esc(s.source_authority)} · ${esc(s.version || 'Version NOT AVAILABLE')} · published ${dateText(s.publication_date)} · excerpt verified ${dateText(s.excerpt_verified_at)}</div><div class="source-meta">${esc(s.content_hash_scope || 'Hash scope NOT AVAILABLE')} · ${number(s.raw_snapshot_count)} raw snapshots</div>${s.content_hash ? `<div class="hash-line">${esc(s.content_hash)}</div>` : ''}${extLink(s.source_url)}</div>${badge(s.status,s.status==='EXCERPT_VERIFIED'?'verified':'neutral')}</div>`).join('') || emptyState('No source references','No source records configured.'), { flush: true })}</div></main>`;
}

async function renderChanges(params = new URLSearchParams()) {
  const [changes, regulators] = await Promise.all([api(`/api/changes${params.get('severity') ? `?severity=${encodeURIComponent(params.get('severity'))}` : ''}`), api('/api/regulators')]);
  const q = (params.get('q') || '').toLowerCase();
  const selectedReg = params.get('regulator') || '';
  const filtered = changes.filter((c) => (!q || `${c.summary} ${c.field || ''} ${c.change_type} ${c.regulator?.acronym || ''}`.toLowerCase().includes(q)) && (!selectedReg || c.regulator?.id === selectedReg));
  const cards = filtered.map((c) => `<article class="change-card"><div class="change-top"><div><div class="change-title">${esc(c.summary)}</div><div class="cell-secondary">${tag(c.regulator?.acronym || 'UNLINKED')} ${esc(c.change_type)} · ${dateText(c.detected_at)} · ${esc(c.confidence || 'Confidence not available')}</div></div>${badge(c.severity || 'UNASSESSED',c.severity==='UNASSESSED'?'unassessed':'')}</div><div class="change-summary">${esc(c.field || 'Source/document-level update')} ${c.obligation ? `· ${obligationLink(c.obligation.id,c.obligation.title)}` : '· Obligation link not established'}</div><div class="change-values">${valueBox('Before',c.old_value)}${valueBox('After',c.new_value)}</div><div class="change-summary">${esc(c.source_reference || 'Source reference NOT AVAILABLE')}</div>${extLink(c.source_url,'Open cited official source')}${c.impacts?.length ? `<div class="callout-row" style="margin-top:8px">${c.impacts.map((i) => `<span class="tag">${esc(i.impact_type)} · ${esc(i.severity)} · ${esc(i.score)}pt</span>`).join('')}</div>` : '<div class="cell-secondary">No automatic technical impact entries.</div>'}<div class="cell-secondary">Technical impact scores support deterministic engineering triage; they are not legal severity or an official regulator interpretation.</div></article>`).join('');
  const regOptions = regulators.map((r) => `<option value="${esc(r.id)}" ${selectedReg===r.id?'selected':''}>${esc(r.acronym)}</option>`).join('');
  return `<main class="page">${pageHead('Regulatory change feed', 'Each change stays tied to its source, version statement and review confidence.', `<a class="button" href="#/norm-diff">Compare normative text</a>`)}<div class="alert warning"><strong>Interpretation boundary.</strong> A changed source hash is not a semantic regulatory change. Lexical comparisons and technical impact rules require human review; no legal outcome is inferred.</div>${panel('Registered changes', `<form class="toolbar" data-form="change-filter"><input class="input" name="q" value="${esc(params.get('q')||'')}" placeholder="Search changes…"><select name="regulator"><option value="">All regulators</option>${regOptions}</select><select name="severity"><option value="">All technical impact levels</option>${['LOW','MEDIUM','HIGH','CRITICAL','UNASSESSED'].map((v)=>`<option ${params.get('severity')===v?'selected':''}>${v}</option>`).join('')}</select><button class="button primary" type="submit">Filter</button></form>${cards || emptyState('No change records match','Use the source collector or add a sourced record for human review.')}`, { description: `${filtered.length} registered change events. Severity is technical triage only.`, flush: true })}</main>`;
}

async function renderSchemas(params = new URLSearchParams()) {
  const schemas = await api(`/api/schemas${params.get('q')?`?q=${encodeURIComponent(params.get('q'))}`:''}`);
  const rows = schemas.map((s) => `<tr><td>${tag(s.regulator_acronym)}</td><td><div class="cell-primary"><a href="#/schemas?id=${encodeURIComponent(s.id)}">${esc(s.document_code)} · ${esc(s.document_name)}</a></div><span class="cell-secondary">${esc(s.obligation_title)}</span></td><td>${esc(s.version)}</td><td>${esc(s.schema_type)}</td><td>${s.fields_count === null ? 'NOT AVAILABLE' : number(s.fields_count)}<span class="cell-secondary">${number(s.catalogued_fields)} actually catalogued</span></td><td>${badge(s.parse_status,s.parse_status==='UNSTRUCTURED'?'unstructured':'verified')}<span class="cell-secondary">${esc(s.field_inventory_scope)}</span></td><td>${s.content_hash ? `<span class="mono">${esc(s.content_hash.slice(0,12))}…</span><span class="cell-secondary">${esc(s.content_hash_scope)}</span>` : 'No hash'}</td></tr>`);
  return `<main class="page">${pageHead('Schema registry', 'Schema metadata records preserve versions and field scope; partial and unstructured records are first-class states.')}${panel('Versioned documents', `<form class="toolbar" data-form="schema-search"><input class="input" name="q" value="${esc(params.get('q')||'')}" placeholder="Search schema, version, regulator…"><button class="button primary">Search</button><a class="button" href="#/schemas">Reset</a></form>${table(['Authority','Document / obligation','Version','Representation','Declared / catalogued','Parse scope','Excerpt hash'], rows,'No schemas match the query.')}`, { description: `${schemas.length} schema-version entries; an unavailable field count remains blank, not zero-filled.`, flush: true })}<div class="alert">Structured-field counts refer to curated extracted inventories, not a byte-for-byte parse of the complete regulator schema. An excerpt SHA-256 is not the hash of the original official document.</div></main>`;
}

async function renderSchemaDetail(id) {
  const detail = await api(`/api/schemas/${encodeURIComponent(id)}`);
  const s = detail.schema;
  const fields = detail.fields.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td>${esc(f.name)}<span class="cell-secondary">${esc(f.description)}</span></td><td>${esc(f.data_type)}${f.length?` · length ${esc(f.length)}`:''}${f.precision?` · ${esc(f.precision)},${esc(f.scale ?? 0)}`:''}</td><td>${f.required===null?'UNKNOWN':f.required?'Required':'Optional'}<span class="cell-secondary">${esc(f.required_condition || '')}</span></td><td>${esc(f.domain || 'NOT AVAILABLE')}</td><td>${esc(f.source_reference)}</td></tr>`);
  const changes = detail.changes.map((c) => `<div class="change-card"><div class="change-title">${esc(c.summary)}</div><div class="change-summary">${esc(c.change_type)} · ${esc(c.field || '')} · ${dateText(c.detected_at)}</div>${valueBox('New value',c.new_value)}</div>`).join('');
  return `<main class="page">${pageHead(`${s.document_code} · ${s.version}`, `${s.regulator_acronym} · ${s.obligation_title}`, `<a class="button" href="#/schemas">Schema registry</a>`)}<div class="kv-grid"><div class="kv"><div class="kv-label">Representation</div><div class="kv-value">${esc(s.schema_type)}</div></div><div class="kv"><div class="kv-label">Parser status</div><div class="kv-value">${badge(s.parse_status,s.parse_status==='UNSTRUCTURED'?'unstructured':'verified')}</div></div><div class="kv"><div class="kv-label">Inventory scope</div><div class="kv-value">${esc(s.field_inventory_scope)}</div></div><div class="kv"><div class="kv-label">Declared field count</div><div class="kv-value">${s.fields_count===null?'NOT AVAILABLE':number(s.fields_count)}</div></div><div class="kv"><div class="kv-label">Catalogued rows</div><div class="kv-value">${number(detail.fields.length)}</div></div><div class="kv"><div class="kv-label">Adapter</div><div class="kv-value">${detail.adapter_configured?'Configured generic local adapter':'NOT AVAILABLE'}</div></div></div>${s.content_hash?`<div class="alert warning"><strong>${esc(s.content_hash_scope)}.</strong> This is a hash of stored curated excerpt text, not of the complete source payload. <div class="hash-line">${esc(s.content_hash)}</div></div>`:''}
    ${panel('Official source', `<div class="source-title">${esc(s.source_title || 'Source title not available')}</div><div class="source-meta">${esc(s.version)} · ${esc(s.source_url || 'URL NOT AVAILABLE')}</div>${extLink(s.source_url)}`, { description: 'Consult the regulator-hosted document directly before implementing a production schema.' })}
    ${panel('Field inventory', fields.length ? table(['Path','Name / description','Type / limits','Requiredness','Domain','Source reference'], fields, 'No fields captured.') : emptyState('No structured fields captured', `This ${s.parse_status.toLowerCase()} record is intentionally not expanded into an invented API schema or field list.`), { description: `${detail.fields.length} fields in this curated inventory.`, flush: true })}
    ${panel('Linked change events', changes || emptyState('No change event linked','No exact version diff is available for this schema record.'), { flush: true })}${detail.adapter_configured?panel('Generic adapter configuration', `<pre class="code-block">${esc(JSON.stringify(detail.adapter_config,null,2))}</pre>`, { description: 'Internal demonstration configuration only; it is not a regulator-certified payload schema.' }):''}</main>`;
}

async function renderNormDiff() {
  const data = await api('/api/norm-diff');
  const changes = data.changes.map((c) => `<div class="status-item"><div><div class="status-name">${esc(c.summary)}</div><div class="status-detail">${esc(c.regulator?.acronym || 'Unlinked')} · ${esc(c.old_version || 'NOT AVAILABLE')} → ${esc(c.new_version || 'NOT AVAILABLE')} · ${esc(c.confidence || 'Confidence unknown')}</div>${extLink(c.source_url,'Review official source')}</div>${badge(c.review_status || 'REVIEW_REQUIRED','review')}</div>`).join('');
  return `<main class="page">${pageHead('Norm diff & version review', 'Compare versioned text without claiming legal interpretation or semantic equivalence.')}${panel('Lexical text comparison', `<form data-form="norm-diff"><div class="form-grid"><div class="field-control"><label for="old-text">Prior version text</label><textarea id="old-text" name="old_text" placeholder="Paste source text from the prior version…" required></textarea></div><div class="field-control"><label for="new-text">Current version text</label><textarea id="new-text" name="new_text" placeholder="Paste source text from the current version…" required></textarea></div></div><div class="form-actions"><button class="button primary" type="submit">Compare text</button><span class="form-note">Up to 50 KB per text. Comparison is line-based and lexical.</span></div><div id="norm-diff-result"></div></form>`, { description: data.method })}${panel('Source-backed version events', changes || emptyState('No registered version events','A source collector can capture raw snapshots; candidate extraction remains human-reviewed.'), { description: 'Hash-only changes remain unassessed until a semantic diff and review are recorded.' })}</main>`;
}

async function renderMapping() {
  const [mappings, internal] = await Promise.all([api('/api/mappings'), api('/api/internal-data')]);
  let rows = mappings;
  const q = state.mappingQuery.toLowerCase();
  if (state.mappingStatus) rows = rows.filter((m) => m.mapping_status === state.mappingStatus);
  if (q) rows = rows.filter((m) => `${m.regulator_acronym} ${m.obligation_code} ${m.regulatory_field_path} ${m.regulatory_field_name} ${m.source_field} ${m.dataset_name}`.toLowerCase().includes(q));
  const editorHtml = (m) => {
    const key = m.id || m.regulatory_field_id;
    if (state.mappingEditor !== key) return '';
    const fieldOptions = internal.fields.map((f) => `<option value="${esc(f.id)}" ${m.data_field_id===f.id?'selected':''}>${esc(f.system_name)} · ${esc(f.dataset_name)}.${esc(f.name)} (${esc(f.data_type)}) · DEMO DATA</option>`).join('');
    const canonicalOptions = internal.canonical_elements.map((c) => `<option value="${esc(c.id)}" ${m.canonical_element_id===c.id?'selected':''}>${esc(c.qualified_name)}</option>`).join('');
    const statuses = ['UNMAPPED','REVIEW_REQUIRED','MAPPED','VALIDATED'].map((s) => `<option value="${s}" ${m.mapping_status===s?'selected':''}>${s.replaceAll('_',' ')}</option>`).join('');
    return `<tr class="editor-row"><td colspan="7"><form class="mapping-editor" data-form="mapping" data-mapping-id="${esc(m.id || '')}" data-regulatory-field-id="${esc(m.regulatory_field_id)}"><div class="form-grid"><div class="field-control"><label>Internal data field · all records are DEMO DATA</label><select name="data_field_id"><option value="">— Leave unmapped —</option>${fieldOptions}</select></div><div class="field-control"><label>Mapping status</label><select name="mapping_status">${statuses}</select></div><div class="field-control"><label>Canonical element</label><select name="canonical_element_id"><option value="">— No canonical link —</option>${canonicalOptions}</select></div><div class="field-control"><label>Transformation</label><input class="input" name="transformation" value="${esc(m.transformation || 'IDENTITY')}"></div><div class="field-control"><label>Owner</label><input class="input" name="owner" value="${esc(m.owner || 'Unassigned')}"></div><div class="field-control"><label>Business rule / review note</label><input class="input" name="business_rule" value="${esc(m.business_rule || '')}"></div></div><div class="form-actions"><button class="button primary" type="submit">Save mapping</button><button class="button" type="button" data-action="cancel-mapping">Cancel</button><span class="form-note">Changes are audit-logged. This demo editor maps only synthetic internal fields.</span></div></form></td></tr>`;
  };
  const tableRows = rows.map((m) => {
    const key = m.id || m.regulatory_field_id;
    return `<tr><td>${tag(m.regulator_acronym)}</td><td><a class="mono" href="#/impact?id=${encodeURIComponent(m.obligation_id)}">${esc(m.obligation_code)}</a><span class="cell-secondary">${esc(m.obligation_title)}</span></td><td class="mono">${esc(m.regulatory_field_path)}</td><td>${esc(m.source_field || 'UNMAPPED')}<span class="cell-secondary">${esc(m.dataset_name || 'No internal dataset')}</span></td><td>${badge(m.mapping_status,m.mapping_status==='VALIDATED'?'pass':m.mapping_status==='REVIEW_REQUIRED'?'review':m.mapping_status==='MAPPED'?'mapped':'neutral')}</td><td>${esc(m.canonical_name || '—')}<span class="cell-secondary">${esc(m.pipeline_name || 'No pipeline dependency')}</span></td><td><button class="button compact" data-action="edit-mapping" data-editor-key="${esc(key)}">${m.id?'Edit':'Map field'}</button></td></tr>${editorHtml(m)}`;
  });
  const counts = { total: mappings.length, mapped: mappings.filter((m) => ['MAPPED','VALIDATED'].includes(m.mapping_status)).length, review: mappings.filter((m) => m.mapping_status === 'REVIEW_REQUIRED').length, unmapped: mappings.filter((m) => m.mapping_status === 'UNMAPPED').length };
  return `<main class="page">${pageHead('Mapping studio', 'Map obligations into real data paths. Current internal systems, fields and sample records are synthetic demonstration fixtures.', `<a class="button" href="#/catalog">Canonical catalog</a>`)}<div class="metric-grid">${metric('Field rows',number(counts.total),'Active and mapped schema fields','FD')}${metric('Mapped / validated',number(counts.mapped),'Status on stored mapping rows','OK','blue')}${metric('Review required',number(counts.review),'Business approval remains open','RV','amber')}${metric('Unmapped',number(counts.unmapped),'No internal source attached','—','red')}</div><div class="alert warning"><strong>DEMO DATA.</strong> No production data source is connected. “Validated” refers to this workspace’s mapping review status only—not to a regulator’s validation.</div>${panel('Regulatory-to-internal field mappings', `<form class="toolbar" data-form="mapping-search"><input class="input" name="q" value="${esc(state.mappingQuery)}" placeholder="Search authority, field, dataset…"><select name="status"><option value="">All statuses</option>${['UNMAPPED','REVIEW_REQUIRED','MAPPED','VALIDATED'].map((s)=>`<option value="${s}" ${state.mappingStatus===s?'selected':''}>${s.replaceAll('_',' ')}</option>`).join('')}</select><button class="button primary">Filter</button><button class="button" type="button" data-action="clear-mapping-filter">Reset</button></form>${table(['Authority','Obligation','Regulatory field path','Internal data source','Status','Canonical / pipeline',''], tableRows,'No fields match these filters.')}`, { description: `${rows.length} row(s) shown from ${number(internal.fields.length)} synthetic internal fields.`, flush: true })}</main>`;
}

async function renderCatalog(params = new URLSearchParams()) {
  const elements = await api(`/api/catalog${params.get('q')?`?q=${encodeURIComponent(params.get('q'))}`:''}`);
  const rows = elements.map((e) => `<tr><td>${tag(e.domain)}</td><td><div class="cell-primary mono">${esc(e.qualified_name)}</div><span class="cell-secondary">${esc(e.description)}</span></td><td>${esc(e.data_type)}</td><td>${esc(e.classification)}</td><td>${number(e.internal_source_count)}<span class="cell-secondary">synthetic source field(s)</span></td><td>${number(e.regulatory_field_count)}<span class="cell-secondary">${esc(e.regulators || 'No regulator mapping')}</span></td><td>${number(e.obligation_count)}</td><td><a class="button compact" href="#/lineage?q=${encodeURIComponent(e.qualified_name)}">Trace</a></td></tr>`);
  return `<main class="page">${pageHead('Canonical data catalog', 'Shared semantic concepts bridge internal data models and regulator-specific fields; classifications are preserved.', `<a class="button" href="#/lineage">Explore lineage</a>`)}${panel('Canonical elements', `<form class="toolbar" data-form="catalog-search"><input class="input" name="q" value="${esc(params.get('q')||'')}" placeholder="Search domain, concept…"><button class="button primary">Search</button><a class="button" href="#/catalog">Reset</a></form>${table(['Domain','Qualified name','Type','Classification','Internal sources','Regulatory fields','Obligations',''], rows,'No canonical elements match.')}`, { description: `${elements.length} canonical concepts; associations are derived from persisted mapping records.`, flush: true })}<div class="alert">Sensitive classes (e.g. PERSONAL, CONFIDENTIAL) are metadata labels for this sample model. Do not load live personal data into the demo environment.</div></main>`;
}

async function renderLineage(params = new URLSearchParams()) {
  const query = params.get('q') || '';
  const data = await api(`/api/lineage${query?`?q=${encodeURIComponent(query)}`:''}`);
  const nodes = data.nodes;
  const edges = data.edges.map((edge) => {
    const from = nodes.find((n) => n.id === edge.from);
    const to = nodes.find((n) => n.id === edge.to);
    return `<tr><td>${tag(from?.type || 'NODE')}<span class="cell-secondary">${esc(from?.label || edge.from)}</span></td><td>${esc(edge.label)}</td><td>${tag(to?.type || 'NODE')}<span class="cell-secondary">${esc(to?.label || edge.to)}</span></td></tr>`;
  });
  return `<main class="page">${pageHead('Data lineage', 'Bidirectional navigation is represented as persisted edges across system → dataset → field → mapping → obligation.', `<a class="button" href="#/mapping">Open mapping studio</a>`)}<div class="alert warning"><strong>DEMO DATA lineage.</strong> This is the graph stored in configured sample mappings; no production source or runtime telemetry is connected.</div>${panel('Filter lineage edges', `<form class="toolbar" data-form="lineage-search"><input class="input" name="q" value="${esc(query)}" placeholder="Search system, field, obligation…"><button class="button primary">Search</button><a class="button" href="#/lineage">Reset</a><span class="form-note">${number(data.nodes.length)} nodes · ${number(data.edges.length)} edges · ${number(data.mappings_count)} mappings</span></form>${table(['From node','Relationship','To node'], edges,'No stored lineage edges match this filter.')}`, { description: data.note, flush: true })}</main>`;
}

async function renderDq() {
  const data = await api('/api/dq');
  const rules = data.rules.map((r) => `<tr><td>${tag(r.regulator_acronym)}</td><td>${esc(r.name)}<span class="cell-secondary">${esc(r.description)}</span></td><td>${tag(r.rule_type)}</td><td>${esc(r.field_path)}</td><td>${badge(r.severity,r.severity==='HIGH'?'high':'neutral')}</td><td>${badge(r.mapping_status || 'NOT MAPPED')}</td><td>${extLink(r.source,'Source reference')}</td></tr>`);
  const results = data.latest_results.map((r) => `<tr><td>${esc(r.rule_name)}</td><td>${esc(r.dataset_row_key || '—')}</td><td>${esc(r.actual_value || 'NOT AVAILABLE')}</td><td>${badge(r.status,r.status==='FAIL'?'fail':r.status==='PASS'?'pass':'neutral')}</td><td>${esc(r.message)}</td></tr>`);
  const latest = data.latest ? `<div class="callout-row"><span class="tag">Run ${esc(data.latest.id)}</span>${badge(data.latest.status,data.latest.status==='COMPLETED_WITH_FAILURES'?'review':'pass')}<span class="tag">${number(data.latest.rules_evaluated)} checks</span><span class="tag">${number(data.latest.passed)} pass</span><span class="tag">${number(data.latest.fail_count || 0)} fail</span></div>` : emptyState('No DQ run yet','Run the configured checks to evaluate the explicit demo fixture rows.');
  return `<main class="page">${pageHead('Data quality', 'Rule execution, result trace and source references. Synthetic fixtures only.', `<button class="button primary" data-action="run-dq">Run demo DQ checks</button>`)}<div class="alert warning"><strong>DEMO DATA ONLY.</strong> One intentionally invalid CNPJ fixture is a negative control. A resulting failure is expected and is not evidence of a real filing defect.</div>${panel('Latest execution', latest, { description: 'A run can finish with failures and still persist every row-level result.' })}${panel('Latest row results', table(['Rule','Fixture row','Actual value','Result','Message'], results,'No row-level results. Run DQ checks to create one.'), { flush: true })}${panel('Configured rule inventory', table(['Regulator','Rule','Type','Regulatory field','Rule severity','Mapping status','Basis'], rules,'No DQ rules configured.'), { description: `${data.rules.length} stored rules. Source-derived rules remain distinct from internal demonstration checks.`, flush: true })}</main>`;
}

async function renderCalendar() {
  const [deadlines, obligations] = await Promise.all([api('/api/deadlines'), api('/api/obligations')]);
  const official = deadlines.filter((d) => d.deadline_type === 'OFFICIAL');
  const internal = deadlines.filter((d) => d.deadline_type === 'INTERNAL');
  const form = state.showDeadlineForm ? `<form data-form="internal-deadline"><div class="alert warning"><strong>Internal planning target only.</strong> It is not an official regulatory due date and will not alter regulator-published records.</div><div class="form-grid cols-3"><div class="field-control full"><label>Obligation</label><select name="obligation_id" required>${obligations.map((o)=>`<option value="${esc(o.id)}">${esc(o.regulator_acronym)} · ${esc(o.code)} · ${esc(o.title)}</option>`).join('')}</select></div><div class="field-control"><label>Reference period</label><input class="input" name="reference_period" placeholder="e.g. 2026-09" required></div><div class="field-control"><label>Internal target date</label><input class="input" type="date" name="due_date" required></div><div class="field-control"><label>Owner</label><input class="input" name="owner" placeholder="Team or role" required></div><div class="field-control full"><label>Planning basis</label><input class="input" name="calculation_basis" value="Internal planning target entered by an operator; not a regulatory due date."></div></div><div class="form-actions"><button class="button primary">Save internal target</button><button class="button" type="button" data-action="toggle-deadline-form">Cancel</button></div></form>` : '';
  const rows = (items, internalMode) => items.map((d)=>`<tr><td>${tag(d.regulator_acronym)}</td><td><div class="cell-primary">${obligationLink(d.obligation_id,d.obligation_code)}</div><span class="cell-secondary">${esc(d.obligation_title)}</span></td><td>${esc(d.reference_period)}</td><td class="nowrap"><strong>${dateText(d.due_date)}</strong><span class="cell-secondary">${esc(d.daysRemaining)} days ${esc(d.status.toLowerCase())}</span></td><td>${badge(internalMode?'INTERNAL':'OFFICIAL',internalMode?'internal':'official')}</td><td>${esc(d.owner || 'NOT AVAILABLE')}<span class="cell-secondary">${esc(d.calculation_basis || '')}</span></td><td>${internalMode ? '<span class="cell-secondary">No regulatory source—internal only</span>' : extLink(d.source_url,'Open official deadline source')}</td></tr>`);
  return `<main class="page">${pageHead('Deadline calendar', 'Deadline types are explicit. Official dates are source-backed; internal targets are operator-entered.', `<button class="button primary" data-action="toggle-deadline-form">${state.showDeadlineForm?'Close form':'Add internal target'}</button>`)}<div class="alert warning"><strong>Never conflate due dates.</strong> Official and internal records use separate sections and type badges. The demo business-day calendar is limited; source-published calendars take precedence.</div>${form ? panel('Create internal planning target', form) : ''}${panel('Official regulatory deadlines', rows(official,false).length ? table(['Authority','Obligation','Period','Due date','Type','Owner / calculation basis','Source'], rows(official,false), 'No official deadline recorded.') : emptyState('No official deadline records','No regulatory due date will be inferred.'), { description: `${official.length} source-backed official record(s).`, flush: true })}${panel('Internal planning targets', rows(internal,true).length ? table(['Authority','Obligation','Period','Target date','Type','Owner / basis','Source boundary'], rows(internal,true), 'No internal targets recorded.') : emptyState('No internal targets recorded','Use “Add internal target” to create an operational planning date that remains separate from regulatory deadlines.'), { description: `${internal.length} operator-entered internal record(s); explicitly non-regulatory.`, flush: true })}</main>`;
}

async function renderSubmissions() {
  const [submissions, schemas] = await Promise.all([api('/api/submissions'), api('/api/schemas')]);
  const configuredSchemas = schemas.filter((s) => Boolean(s.adapter_config_json));
  const availableObligations = [...new Map(configuredSchemas.map((s) => [s.obligation_id, s])).values()];
  const rows = submissions.map((s) => {
    const validation = s.validation_summary || {};
    const artifactName = String(s.artifact_path || '').split('/').pop();
    const download = artifactName ? `<a class="button compact" href="/api/artifacts/${encodeURIComponent(artifactName)}">Download artifact</a>` : 'NOT AVAILABLE';
    return `<tr><td><div class="cell-primary">${obligationLink(s.obligation_id,s.obligation_code)}</div><span class="cell-secondary">${esc(s.obligation_title)}</span></td><td>${esc(s.reference_period)}</td><td>${tag(s.output_format)}</td><td>${badge(s.status,s.status==='READY'?'ready':s.status==='INVALID'?'fail':'info')}</td><td>${dateText(s.generated_at)}</td><td>${validation.official_regulator_validator===false?badge('LOCAL ONLY','demo'):badge('NOT AVAILABLE','neutral')}<span class="cell-secondary">${esc(validation.ready_means || validation.mode || 'Validation status not recorded')}</span></td><td>${s.is_demo?badge('DEMO DATA','demo'):badge('NON-DEMO','neutral')}</td><td>${download}</td></tr>`;
  });
  const options = availableObligations.map((s)=>`<option value="${esc(s.obligation_id)}">${esc(s.regulator_acronym)} · ${esc(s.document_code)} · ${esc(s.obligation_title)} (${esc(s.schema_type)})</option>`).join('');
  const configuredRows = configuredSchemas.map((s)=>{
    let config={};try{config=JSON.parse(s.adapter_config_json||'{}')}catch{}
    return `<div class="status-item"><div><div class="status-name">${tag(s.regulator_acronym)} ${esc(s.document_code)} · ${esc(s.version)}</div><div class="status-detail">${esc(s.obligation_title)} · ${esc(s.schema_type)} · ${esc(s.parse_status)}</div></div>${badge(config.kind || s.schema_type,'info')}</div>`;
  }).join('');
  const form = configuredSchemas.length ? `<form data-form="submission-run"><div class="form-grid"><div class="field-control"><label>Configured obligation / adapter</label><select name="obligation_id">${options}</select></div><div class="field-control"><label>Reference period</label><input class="input" name="reference_period" value="${new Date().toISOString().slice(0,10)}" placeholder="Reference period"></div></div><div class="form-actions"><button class="button primary">Run generic demo pipeline</button><span class="form-note">Every artifact is DEMO DATA, locally checked and not submitted.</span></div></form>` : emptyState('No generic adapter configured','The platform will not fabricate an adapter where the regulator layout is not captured.');
  return `<main class="page">${pageHead('Submission runs', 'Inspect generic adapter configurations, generated artifacts and local checks. No external regulator submission endpoint is configured.')}${panel('Configured adapters', configuredRows || emptyState('No adapters configured','No structured adapter configuration is stored.'), { description: 'A configured local adapter does not imply an official schema validator or delivery channel.' })}${panel('Run an explicitly synthetic submission pipeline', form, { description: 'The selected fixture is loaded from DEMO DATA, projected through persisted mappings, locally validated and saved as a downloadable artifact.' })}<div class="alert warning"><strong>Not a filing.</strong> “READY” means ready for internal review only. No document is transmitted to BCB, CVM, SUSEP, ANPD, COAF or RFB. Only local configured checks run.</div>${panel('Generated submissions', table(['Obligation','Reference period','Adapter','Local status','Generated','Validator boundary','Data class','Artifact'], rows,'No artifacts generated yet. Run a generic demo pipeline to create a local artifact.'), { description: `${submissions.length} record(s). Artifact hashes and audits are stored with DEMO DATA evidence.`, flush: true })}</main>`;
}

async function renderControls() {
  const [controls, obligations, requirements] = await Promise.all([api('/api/controls'),api('/api/obligations'),api('/api/requirements')]);
  const rows = controls.map((c)=>`<tr><td><div class="cell-primary">${esc(c.control_name)}</div><span class="cell-secondary">${obligationLink(c.obligation_id,c.obligation_code)} · ${esc(c.obligation_title)}${c.requirement_description?`<br>${esc(c.requirement_description)}`:''}</span></td><td>${esc(c.owner)}</td><td>${esc(c.frequency)}</td><td>${esc(c.evidence_type)}</td><td>${badge(c.status)}</td><td>${badge(c.result || 'NOT_RUN')}</td><td>${number(c.evidence_count)} evidence item(s)</td><td>${c.is_demo?badge('DEMO DATA','demo'):badge('INTERNAL','neutral')}</td></tr>`);
  const form = state.showControlForm ? `<form data-form="control"><div class="form-grid cols-3"><div class="field-control full"><label>Control name</label><input class="input" name="control_name" required maxlength="200" placeholder="e.g. Required field completeness check"></div><div class="field-control"><label>Obligation</label><select name="obligation_id" required>${obligations.map((o)=>`<option value="${esc(o.id)}">${esc(o.regulator_acronym)} · ${esc(o.code)} · ${esc(o.title)}</option>`).join('')}</select></div><div class="field-control"><label>Requirement (optional)</label><select name="requirement_id"><option value="">— Not linked to one requirement —</option>${requirements.map((r)=>`<option value="${esc(r.id)}">${esc(r.regulator_acronym)} · ${esc(r.obligation_code)} · ${esc(r.requirement_type)}: ${esc(r.description)}</option>`).join('')}</select><span class="field-help">Selected requirement must belong to the selected obligation.</span></div><div class="field-control"><label>Owner</label><input class="input" name="owner" required maxlength="120" placeholder="Team or accountable role"></div><div class="field-control"><label>Frequency / cadence</label><input class="input" name="frequency" required maxlength="64" placeholder="Per submission, daily, event-driven…"></div><div class="field-control"><label>Evidence expectation</label><input class="input" name="evidence_type" required maxlength="120" placeholder="Validation record, reconciliation…"></div></div><div class="form-actions"><button class="button primary">Create demo control</button><button class="button" type="button" data-action="toggle-control-form">Cancel</button><span class="form-note">Creates an ACTIVE control definition with NOT_RUN result; no test is claimed.</span></div></form>` : '';
  return `<main class="page">${pageHead('Control library', 'Controls are linked to obligations and requirements. A configured control is not evidence that an operational control has run.', `<button class="button primary" data-action="toggle-control-form">${state.showControlForm?'Close':'Create control'}</button>`)}${form?panel('New control definition',form):''}${panel('Regulatory controls', table(['Control / obligation / requirement','Owner','Cadence','Evidence expectation','Status','Last result','Evidence','Class'], rows,'No regulatory controls configured.'), { description: `${controls.length} control record(s); the current controls have not been executed on client production data.`, flush: true })}<div class="alert">Run history and evidence lineage are kept separately. The demo pipeline may update the explicitly synthetic BCB 4111 control result when invoked.</div></main>`;
}

async function renderEvidence() {
  const [items, obligations, controls] = await Promise.all([api('/api/evidence'), api('/api/obligations'), api('/api/controls')]);
  const rows = items.map((e)=>`<tr><td><div class="cell-primary">${esc(e.title)}</div><span class="cell-secondary">${e.obligation_id?obligationLink(e.obligation_id,e.obligation_code):'Not linked to an obligation'}</span></td><td>${tag(e.evidence_type)}</td><td>${dateText(e.collected_at)}</td><td>${esc(e.source_reference || 'NOT AVAILABLE')}</td><td>${e.content_hash ? `<span class="mono">${esc(e.content_hash.slice(0,16))}…</span>` : 'NOT AVAILABLE'}</td><td>${badge(e.status)}</td><td>${e.is_demo?badge('DEMO DATA','demo'):badge('OFFICIAL REFERENCE','official')}</td></tr>`);
  const form = `<form data-form="evidence"><div class="form-grid cols-3"><div class="field-control"><label>Evidence title</label><input class="input" name="title" placeholder="Describe the evidence record" required></div><div class="field-control"><label>Evidence type</label><select name="evidence_type"><option>CONTROL_TEST</option><option>OFFICIAL_SOURCE_EXCERPT</option><option>SCHEMA_METADATA</option><option>MAPPING_REVIEW</option><option>DEMO_DATA_FIXTURE</option><option>OTHER</option></select></div><div class="field-control"><label>Related obligation</label><select name="obligation_id"><option value="">— Not linked —</option>${obligations.map((o)=>`<option value="${esc(o.id)}">${esc(o.regulator_acronym)} · ${esc(o.code)}</option>`).join('')}</select></div><div class="field-control"><label>Related control (optional)</label><select name="control_id"><option value="">— None —</option>${controls.map((c)=>`<option value="${esc(c.id)}">${esc(c.regulator_acronym)} · ${esc(c.control_name)}</option>`).join('')}</select></div><div class="field-control"><label>Source/reference URL or identifier</label><input class="input" name="source_reference" placeholder="Official URL or internal evidence reference"></div><div class="field-control"><label>Content SHA-256 (if bytes captured)</label><input class="input" name="content_hash" placeholder="NOT AVAILABLE until actual bytes are captured"></div></div><div class="form-actions"><button class="button primary">Add evidence metadata</button><span class="form-note">No binary upload in this prototype. Entering a URL does not mean a file was captured.</span></div></form>`;
  return `<main class="page">${pageHead('Evidence center', 'Record source and control evidence while preserving its actual hash scope and demo/official boundary.')}${panel('Add evidence metadata', form, { description: 'Evidence metadata is audit-logged. Avoid describing a source excerpt as a captured original file.' })}${panel('Evidence register', table(['Evidence record','Type','Collected','Reference','Hash prefix','Status','Data class'], rows,'No evidence records exist.'), { description: `${items.length} record(s); synthetic sample evidence is explicitly labeled DEMO DATA.`, flush: true })}</main>`;
}

async function renderRegulatory() {
  const [data, regulations, sources] = await Promise.all([api('/api/regulatory'), api('/api/regulations'), api('/api/sources')]);
  const rows = regulations.map((r)=>`<tr><td>${tag(r.regulator_acronym)}</td><td>${tag(r.type)}</td><td><div class="cell-primary">${esc(r.number)}</div><span class="cell-secondary">${esc(r.title)}</span></td><td>${dateText(r.publication_date)}</td><td>${dateText(r.effective_date)}</td><td>${esc(r.status)}</td><td>${extLink(r.source_url,'Open official source')}</td></tr>`);
  const coverage = `<div class="status-list"><div class="status-item"><div><div class="status-name">Active regulations</div><div class="status-detail">From generic regulatory inventory</div></div><strong class="mono">${number(data.regulations)}</strong></div><div class="status-item"><div><div class="status-name">Active obligations</div><div class="status-detail">Across all configured regulators</div></div><strong class="mono">${number(data.obligations)}</strong></div><div class="status-item"><div><div class="status-name">Upcoming effective dates</div><div class="status-detail">Only explicit dates in the obligation record</div></div><strong class="mono">${number(data.upcoming_effective_dates)}</strong></div><div class="status-item"><div><div class="status-name">Unresolved change reviews</div><div class="status-detail">Human review queue</div></div><strong class="mono">${number(data.change_review_queue)}</strong></div></div>`;
  return `<main class="page">${pageHead('Regulatory operations', 'Source discovery, version dates, effective dates and applicability are preserved as separate facts.')}<div class="metric-grid">${metric('Regulations',number(data.regulations),'Active normative records','NR')}${metric('Obligations',number(data.obligations),'Structured obligation inventory','OB','blue')}${metric('Effective dates ahead',number(data.upcoming_effective_dates),'Explicit dates only','ED','amber')}${metric('Change review queue',number(data.change_review_queue),'Requires human review','RV','red')}</div>${panel('Normative inventory', table(['Authority','Type','Regulation','Published','Effective','Status','Source'], rows,'No regulations configured.'), { description: 'A missing effective date is displayed as NOT AVAILABLE; dates are never assumed.', flush: true })}<div class="split-grid">${panel('Coverage',coverage)}${panel('Source capture status', `<div class="alert warning"><strong>${number(data.source_excerpts)} curated excerpts · ${number(data.sources_not_raw_captured)} excerpt hashes · ${number(sources.reduce((sum,s)=>sum+(s.raw_snapshot_count||0),0))} raw snapshots.</strong><br>${esc(data.note)}</div><div class="status-item"><span class="status-name">Exact source-byte hashes available</span>${badge('NOT AVAILABLE','neutral')}</div><div class="status-item"><span class="status-name">Live official source collection</span><a class="button compact" href="#/system/jobs">Inspect jobs</a></div>`, { description: 'Official source URLs and stored excerpt provenance are available for inspection.' })}</div></main>`;
}

async function renderEngineering() {
  const d = await api('/api/engineering');
  const rows = d.mapping_statuses.map((r)=>`<div class="status-item"><div class="status-name">${esc(r.mapping_status)}</div><strong class="mono">${number(r.count)}</strong></div>`).join('');
  const changes = d.change_types.map((r)=>`<div class="status-item"><div class="status-name">${esc(r.change_type)}</div><strong class="mono">${number(r.count)}</strong></div>`).join('');
  return `<main class="page">${pageHead('Engineering impact', 'Metadata-derived indicators for schema, mapping, pipeline and DQ work. Not a production-estate assessment.', `<a class="button" href="#/mapping">Review mappings</a>`)}<div class="metric-grid">${metric('Schema field rows',number(d.field_count),'Catalogued structured field records','SF')}${metric('Mapped field ids',number(d.mapped_fields),'Mapped or locally validated','MP','blue')}${metric('Pipeline definitions',number(d.pipelines),`${number(d.pipeline_dependencies)} stored dependencies`,'PL','amber')}${metric('DQ rules',number(d.dq_rules),'Executable rule definitions','DQ','red')}</div><div class="alert warning">${esc(d.note)}</div><div class="split-grid">${panel('Mapping status',rows || emptyState('No mapping rows','No mappings recorded.'))}${panel('Registered change classes',changes || emptyState('No changes','No change events stored.'))}</div>${panel('Engineering gaps', `<div class="kv-grid"><div class="kv"><div class="kv-label">Unmapped or review status rows</div><div class="kv-value">${number(d.unmapped_or_review_mappings)}</div></div><div class="kv"><div class="kv-label">Estimated technical debt</div><div class="kv-value">${number(d.technical_debt)} unmapped catalogued field row(s)</div></div><div class="kv"><div class="kv-label">Submissions at risk</div><div class="kv-value">${number(d.submissions_at_risk)} official due-window(s) without a ready/accepted local record</div></div></div>`, { description: 'All derived from current inventory records, with no extrapolation to systems not connected here.' })}</main>`;
}

async function renderMatrix() {
  const data = await api('/api/matrix');
  const rows = data.obligations.map((o)=>`<tr><td>${tag(o.regulator_acronym)}</td><td><div class="cell-primary">${obligationLink(o.id,o.code)}</div><span class="cell-secondary">${esc(o.title)}</span></td><td>${o.systems.map(tag).join(' ') || 'No mapped system'}</td><td>${o.datasets.map(tag).join(' ') || 'No mapped dataset'}</td><td>${o.pipelines.map(tag).join(' ') || 'No pipeline link'}</td><td>${o.teams.map(esc).join(', ') || 'NOT ASSIGNED'}</td><td>${o.is_demo?badge('DEMO DATA','demo'):badge('No internal map','neutral')}</td></tr>`);
  return `<main class="page">${pageHead('Obligation impact matrix', 'Impact is joined from recorded mapping and pipeline dependencies, so unmapped obligations remain visible.', `<a class="button" href="#/impact">Open trace explorer</a>`)}<div class="alert warning">${esc(data.note)}</div>${panel('Obligation-to-system matrix', table(['Authority','Obligation','Systems','Datasets','Pipelines','Owners / teams','Classification'], rows,'No obligations available.'), { description: `${data.obligations.length} rows · ${data.assets.systems.length} connected synthetic systems · ${data.assets.datasets.length} datasets.`, flush: true })}</main>`;
}

async function renderCases() {
  const cases = await api('/api/cases');
  const cards = cases.map((c)=>`<article class="case-card"><div class="case-code">${esc(c.code)} · ${esc(c.regulator_acronym)} · ${badge(c.status,c.status==='REFERENCE_IMPLEMENTED'?'pass':'info')}</div><div class="case-title">${esc(c.title)}</div><div class="case-description">${esc(c.scenario)}</div><div class="case-note"><strong>Limitations:</strong> ${esc(c.implementation_notes)}</div><div class="case-note">Obligation: ${c.obligation_id?obligationLink(c.obligation_id,c.obligation_code):'Not linked'}<br>${extLink(c.source_url,'Open official reference')}</div></article>`).join('');
  return `<main class="page">${pageHead('Reference cases', 'Small implementation slices show the intended generic product model without claiming a complete regulatory adapter.')}${panel('Case library', `<div class="three-grid">${cards}</div>`, { description: `${cases.length} source-linked cases across multiple regulators. Every incomplete schema or adapter is stated.` })}</main>`;
}

async function renderJobs() {
  const data = await api('/api/jobs');
  const buttons = data.available.map((job)=>`<article class="case-card"><div class="case-code">${esc(job.name)}</div><div class="case-description">${esc(job.description)}</div><div class="case-note">Last run: ${job.last_run ? `${dateText(job.last_run.started_at)} · ${badge(job.last_run.status)}` : 'NOT RUN'}</div><div class="form-actions"><button class="button compact ${job.name==='run_quality'?'soft':''}" data-action="run-job" data-job="${esc(job.name)}">Run ${esc(job.name)}</button></div></article>`).join('');
  const runs = data.runs.map((r)=>`<tr><td class="mono">${esc(r.job_name)}</td><td>${dateText(r.started_at)}<span class="cell-secondary">${r.finished_at ? `finished ${dateText(r.finished_at)}` : 'still running'}</span></td><td>${badge(r.status,r.status==='SUCCEEDED'?'pass':r.status==='FAILED'?'fail':'review')}</td><td>${number(r.records_processed)}</td><td>${number(r.records_created)}</td><td>${r.errors ? esc(typeof r.errors==='string'?r.errors.slice(0,160):JSON.stringify(r.errors).slice(0,160)) : '—'}</td></tr>`);
  return `<main class="page">${pageHead('Jobs & runs', 'Run bounded source/processing tasks and inspect immutable run outcomes.', `<a class="button" href="#/system/errors">Ingestion errors</a>`)}<div class="alert warning"><strong>External network access is environment-dependent.</strong> Source collection is limited to HTTPS official-host allowlists, validates redirect targets, stores raw bytes and hashes them on success. PDF parsing may remain UNSTRUCTURED.</div>${panel('Available operations', `<div class="three-grid">${buttons}</div>`, { description: 'Extraction produces low-confidence review candidates only; it never auto-publishes obligations or schemas.' })}${panel('Execution history', table(['Job','Started','Status','Records','Created','Errors'],runs,'No job runs recorded.'), { flush: true })}</main>`;
}

async function renderErrors() {
  const errors = await api('/api/errors');
  const rows = errors.map((e)=>`<tr><td>${dateText(e.timestamp)}</td><td>${esc(e.source_title || e.source)}</td><td>${tag(e.error_type)}</td><td>${esc(e.message)}</td><td>${e.resolved?badge('RESOLVED','pass'):badge('OPEN','fail')}</td><td>${number(e.retry_count)}</td><td>${e.resolved?'—':e.source_id?`<button class="button compact" data-action="retry-error" data-error-id="${esc(e.id)}">Retry source</button>`:'Not retryable'}</td></tr>`);
  return `<main class="page">${pageHead('Ingestion errors', 'Failures do not erase prior snapshots. Retry is available only when a source record is linked.', `<a class="button" href="#/system/jobs">Jobs & runs</a>`)}${panel('Persisted ingestion errors', table(['Timestamp','Source','Error type','Message','Status','Retries','Action'], rows,'No ingestion errors have been recorded.'), { flush: true })}</main>`;
}

async function renderSearch(params = new URLSearchParams()) {
  const query = params.get('q') || '';
  const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
  const results = data.results.map((r)=>{
    const href = r.external ? safeHref(r.url) : safeHref(r.url);
    const target = r.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<article class="search-result"><div>${tag(r.type)}<span class="cell-secondary">${esc(r.regulator || '')}</span></div><div><a class="search-result-title" href="${esc(href)}"${target}>${esc(r.title || r.code)}</a><div class="search-result-snippet">${esc(r.snippet || '')}</div></div><span class="mono">${esc(r.code || '')}</span></article>`;
  }).join('');
  return `<main class="page">${pageHead('Global search', 'Search configured norms, obligations, schema fields, sources and change records.')}${panel('Search the regulatory workspace', `<form class="toolbar" data-form="global-search-page"><input class="input" name="q" value="${esc(query)}" placeholder="Enter at least two characters…"><button class="button primary">Search</button></form>${query.length < 2 ? emptyState('Enter at least two characters','Search scans the current curated workspace inventory.') : results || emptyState('No matches','Try an authority acronym, source term, obligation code or field path.')}`, { description: query.length < 2 ? data.note : `${number(data.total)} matching record(s).`, flush: true })}</main>`;
}

async function handleClick(event) {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) { navigate(routeButton.dataset.route); return; }
  const regulatorCard = event.target.closest('[data-regulator]');
  if (regulatorCard) { navigate('/regulators',{regulator:regulatorCard.dataset.regulator}); return; }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const name = action.dataset.action;
  try {
    if (name === 'refresh') { await renderApp(); return; }
    if (name === 'edit-mapping') { state.mappingEditor = action.dataset.editorKey; await renderApp(); return; }
    if (name === 'cancel-mapping') { state.mappingEditor = null; await renderApp(); return; }
    if (name === 'clear-mapping-filter') { state.mappingQuery='';state.mappingStatus='';state.mappingEditor=null;await renderApp();return; }
    if (name === 'toggle-deadline-form') { state.showDeadlineForm=!state.showDeadlineForm;await renderApp();return; }
    if (name === 'toggle-control-form') { state.showControlForm=!state.showControlForm;await renderApp();return; }
    if (name === 'run-dq') {
      action.disabled = true;
      const result = await api('/api/dq/run',{method:'POST',body:{}});
      notify(`DQ run finished: ${result.passed} pass · ${result.failed} fail. The negative-control failure is intentional.`,result.failed?'error':'success');
      await renderApp(); return;
    }
    if (name === 'run-pipeline') {
      action.disabled = true;
      const result = await api('/api/pipelines/run',{method:'POST',body:{obligationId:action.dataset.obligation,referencePeriod:new Date().toISOString().slice(0,10),actor:'workspace-user'}});
      state.latestPipeline=result;
      notify(`DEMO DATA pipeline ${result.status.toLowerCase()}. Artifact was not submitted.`,result.status==='SUCCEEDED'?'success':'error');
      await renderApp(); return;
    }
    if (name === 'run-job') {
      action.disabled = true;
      const job=action.dataset.job;
      const result=job==='collect_sources'
        ? await api('/api/jobs/collect_sources',{method:'POST',body:{limit:4}})
        : job==='run_quality'
          ? await api('/api/dq/run',{method:'POST',body:{}})
          : job==='generate_submissions'
            ? await api('/api/pipelines/run',{method:'POST',body:{actor:'workspace-user'}})
            : await api(`/api/jobs/${encodeURIComponent(job)}/run`,{method:'POST',body:{}});
      const status=result.status || result.validation?.status || 'completed';
      notify(`${job}: ${String(status).toLowerCase()} · ${result.processed ?? result.records_processed ?? 0} record(s) processed.`,status==='FAILED'?'error':'success');
      await renderApp(); return;
    }
    if (name === 'retry-error') {
      action.disabled=true;
      const result=await api(`/api/errors/${encodeURIComponent(action.dataset.errorId)}/retry`,{method:'POST',body:{}});
      notify(`Retry completed with ${result.retry_result.errors} error(s).`,result.retry_result.errors?'error':'success');
      await renderApp(); return;
    }
  } catch (error) {
    notify(error.message || 'Action failed.', 'error');
    await renderApp();
  }
}

async function handleSubmit(event) {
  const form = event.target.closest('form');
  if (!form) return;
  const type = form.dataset.form;
  if (!type && form.id !== 'global-search-form') return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === 'global-search-form' || type === 'global-search-page') {
      const query=String(values.q||'').trim();
      navigate('/search',{q:query});
      return;
    }
    if (type === 'obligation-filter') { navigate('/obligations',values); return; }
    if (type === 'change-filter') { navigate('/changes',values); return; }
    if (type === 'schema-search') { navigate('/schemas',values); return; }
    if (type === 'catalog-search') { navigate('/catalog',values); return; }
    if (type === 'lineage-search') { navigate('/lineage',values); return; }
    if (type === 'mapping-search') { state.mappingQuery=String(values.q||'').trim();state.mappingStatus=values.status||'';state.mappingEditor=null;await renderApp();return; }
    if (type === 'norm-diff') {
      if (values.old_text.length>50000 || values.new_text.length>50000) throw new Error('Each text must be 50 KB or less.');
      const result=await api('/api/norm-diff/compare',{method:'POST',body:{old_text:values.old_text,new_text:values.new_text}});
      const target=document.getElementById('norm-diff-result');
      if (target) target.innerHTML=`<div style="height:12px"></div><div class="callout-row">${result.cues.map((cue)=>tag(cue)).join('') || tag('No keyword cues detected')}<span class="tag">${number(result.added.length)} additions</span><span class="tag">${number(result.removed.length)} removals</span></div><div class="alert warning">${esc(result.note)}</div><div class="diff-columns"><div><div class="value-label">Added lines</div><ul class="diff-list added">${result.added.map((line)=>`<li>${esc(line)}</li>`).join('') || '<li>None</li>'}</ul></div><div><div class="value-label">Removed lines</div><ul class="diff-list removed">${result.removed.map((line)=>`<li>${esc(line)}</li>`).join('') || '<li>None</li>'}</ul></div></div>`;
      return;
    }
    if (type === 'mapping') {
      const mappingId=form.dataset.mappingId;
      const body={
        regulatory_field_id:form.dataset.regulatoryFieldId,
        data_field_id:values.data_field_id || null,
        canonical_element_id:values.canonical_element_id || null,
        transformation:values.transformation || 'IDENTITY',
        owner:values.owner || 'Unassigned',
        business_rule:values.business_rule || null,
        mapping_status:values.mapping_status,
        is_demo:true,
        actor:'workspace-user',
      };
      const result=mappingId
        ? await api(`/api/mappings/${encodeURIComponent(mappingId)}`,{method:'PUT',body})
        : await api('/api/mappings',{method:'POST',body});
      state.mappingEditor=null;
      notify(`Mapping saved as ${String(result.mapping_status || body.mapping_status).toLowerCase().replaceAll('_',' ')}.`, 'success');
      await renderApp(); return;
    }
    if (type === 'submission-run') {
      const result=await api('/api/pipelines/run',{method:'POST',body:{obligationId:values.obligation_id,referencePeriod:values.reference_period,actor:'workspace-user'}});
      state.latestPipeline=result;
      notify(`DEMO DATA pipeline ${result.status.toLowerCase()}. Artifact was not submitted.`,'success');
      await renderApp(); return;
    }
    if (type === 'internal-deadline') {
      await api('/api/deadlines/internal',{method:'POST',body:{...values,actor:'workspace-user'}});
      state.showDeadlineForm=false;
      notify('Internal target saved. It is separate from official regulatory due dates.','success');
      await renderApp(); return;
    }
    if (type === 'control') {
      await api('/api/controls',{method:'POST',body:{...values,actor:'workspace-user',is_demo:true}});
      state.showControlForm=false;
      notify('Demo control definition created with NOT_RUN status.','success');
      await renderApp(); return;
    }
    if (type === 'evidence') {
      const body={...values,actor:'workspace-user',is_demo:true};
      await api('/api/evidence',{method:'POST',body});
      notify('Evidence metadata added and audit-logged. No binary file was uploaded.','success');
      await renderApp(); return;
    }
  } catch (error) {
    notify(error.message || 'Form submission failed.','error');
    if (type !== 'norm-diff') await renderApp();
  }
}

function notify(message,type='success') {
  state.toast={message,type};
  const shell=document.querySelector('.app-shell');
  if(shell){
    shell.querySelector('.toast')?.remove();
    const element=document.createElement('div');
    element.className=`toast ${type}`;
    element.setAttribute('role','status');
    element.textContent=message;
    shell.appendChild(element);
  }
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer=setTimeout(()=>{state.toast=null;renderApp();},4200);
}

document.addEventListener('click', handleClick);
document.addEventListener('submit', handleSubmit);
window.addEventListener('hashchange', renderApp);
window.addEventListener('keydown',(event)=>{
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='k') {
    event.preventDefault();
    document.getElementById('global-search-input')?.focus();
  }
  if (event.key==='Enter' && event.target.matches('[data-regulator]')) navigate('/regulators',{regulator:event.target.dataset.regulator});
});

renderApp();
