export const DQ_TYPES = Object.freeze([
  'NOT_NULL', 'TYPE', 'LENGTH', 'RANGE', 'DOMAIN', 'REGEX',
  'REFERENTIAL_INTEGRITY', 'UNIQUENESS', 'RECONCILIATION', 'FRESHNESS',
  'COMPLETENESS', 'BUSINESS_RULE', 'CROSS_FIELD', 'SCHEMA',
]);

export function evaluateRule(value, ruleType, expression = {}, context = {}) {
  const config = parseExpression(expression);
  const missing = value === null || value === undefined || value === '';

  switch (ruleType) {
    case 'NOT_NULL':
      return result(!missing, missing ? 'Valor obrigatório ausente.' : 'Valor presente.', 'NOT NULL');
    case 'TYPE': {
      const expected = String(config.type || config.expected || 'string').toLowerCase();
      const pass = matchesType(value, expected);
      return result(pass, pass ? `Tipo compatível com ${expected}.` : `Tipo incompatível; esperado ${expected}.`, expected);
    }
    case 'LENGTH': {
      const length = missing ? 0 : String(value).length;
      const min = config.min ?? 0;
      const max = config.max ?? Number.POSITIVE_INFINITY;
      const pass = length >= min && length <= max;
      return result(pass, pass ? `Comprimento ${length} dentro de ${min}–${max === Infinity ? '∞' : max}.` : `Comprimento ${length}; esperado entre ${min} e ${max === Infinity ? '∞' : max}.`, `${min}..${max}`);
    }
    case 'RANGE': {
      const number = numericValue(value);
      const pass = Number.isFinite(number) && (config.min === undefined || number >= config.min) && (config.max === undefined || number <= config.max);
      return result(pass, pass ? `Valor ${number} dentro dos limites.` : `Valor não numérico ou fora do intervalo ${config.min ?? '-∞'}–${config.max ?? '∞'}.`, `${config.min ?? '-∞'}..${config.max ?? '∞'}`);
    }
    case 'DOMAIN': {
      const values = Array.isArray(config.values) ? config.values.map(String) : [];
      const pass = values.includes(String(value));
      return result(pass, pass ? 'Valor pertence ao domínio permitido.' : `Valor fora do domínio catalogado${values.length ? ` (${values.join(', ')})` : ''}.`, values);
    }
    case 'REGEX': {
      const pattern = config.pattern || ruleRegexFallback(context);
      let pass = false;
      try { pass = new RegExp(pattern, config.flags || '').test(String(value ?? '')); } catch { /* invalid rule remains fail-closed */ }
      return result(pass, pass ? 'Valor atende ao padrão.' : 'Valor não atende ao padrão configurado.', pattern);
    }
    case 'REFERENTIAL_INTEGRITY': {
      const refs = (context.referenceValues || config.referenceValues || []).map(String);
      const pass = refs.includes(String(value));
      return result(pass, pass ? 'Referência encontrada.' : 'Referência não localizada no conjunto relacionado.', refs);
    }
    case 'UNIQUENESS': {
      const values = context.values || [];
      const duplicates = values.filter((item) => String(item) === String(value)).length > 1;
      return result(!duplicates, duplicates ? 'Valor duplicado no conjunto avaliado.' : 'Valor único no conjunto avaliado.', 'UNIQUE');
    }
    case 'RECONCILIATION': {
      const left = numericValue(context.left ?? value);
      const right = numericValue(context.right ?? config.compareTo);
      const tolerance = Number(config.tolerance ?? 0);
      const pass = Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
      return result(pass, pass ? 'Valores conciliados dentro da tolerância.' : `Diferença acima da tolerância ${tolerance}.`, { tolerance, left, right });
    }
    case 'FRESHNESS': {
      const timestamp = Date.parse(value);
      const maxAgeMinutes = Number(config.maxAgeMinutes ?? 1440);
      const ageMinutes = (context.now ?? Date.now()) - timestamp;
      const pass = Number.isFinite(timestamp) && ageMinutes >= 0 && ageMinutes <= maxAgeMinutes * 60_000;
      return result(pass, pass ? `Dado atualizado há ${Math.floor(ageMinutes / 60_000)} minutos.` : `Dado ausente, futuro ou mais antigo que ${maxAgeMinutes} minutos.`, `${maxAgeMinutes} minutes`);
    }
    case 'COMPLETENESS': {
      const values = context.values || [value];
      const present = values.filter((item) => item !== null && item !== undefined && item !== '').length;
      const percentage = values.length ? (present / values.length) * 100 : 0;
      const threshold = Number(config.minimumPercent ?? 100);
      const pass = percentage >= threshold;
      return result(pass, pass ? `Completude ${percentage.toFixed(1)}%.` : `Completude ${percentage.toFixed(1)}%; mínimo ${threshold}%.`, `${threshold}%`);
    }
    case 'BUSINESS_RULE': {
      const op = config.operator || 'not_null';
      const other = context.otherValue;
      const numeric = numericValue(value);
      const otherNumber = numericValue(other);
      let pass = false;
      if (op === 'not_null') pass = !missing;
      else if (op === 'gt') pass = Number.isFinite(numeric) && numeric > Number(config.value);
      else if (op === 'gte') pass = Number.isFinite(numeric) && numeric >= Number(config.value);
      else if (op === 'lt') pass = Number.isFinite(numeric) && numeric < Number(config.value);
      else if (op === 'lte') pass = Number.isFinite(numeric) && numeric <= Number(config.value);
      else if (op === 'equals') pass = String(value) === String(config.value);
      else if (op === 'not_equals') pass = String(value) !== String(config.value);
      else if (op === 'lte_field') pass = Number.isFinite(numeric) && Number.isFinite(otherNumber) && numeric <= otherNumber;
      const expectation = config.value ?? (op === 'lte_field' ? `<= ${other}` : op);
      return result(pass, pass ? 'Regra de negócio atendida.' : `Regra de negócio não atendida (${op}).`, expectation);
    }
    case 'CROSS_FIELD': {
      const other = context.otherValue;
      const op = config.operator || 'equals';
      const pass = op === 'equals'
        ? String(value) === String(other)
        : op === 'not_equals'
          ? String(value) !== String(other)
          : op === 'lte'
            ? numericValue(value) <= numericValue(other)
            : op === 'gte'
              ? numericValue(value) >= numericValue(other)
              : false;
      return result(pass, pass ? 'Regra entre campos atendida.' : 'Regra entre campos não atendida.', `${op} ${other}`);
    }
    case 'SCHEMA': {
      const required = Array.isArray(config.required) ? config.required : [];
      const object = value && typeof value === 'object' ? value : context.record;
      const missingKeys = required.filter((key) => object?.[key] === undefined || object[key] === null || object[key] === '');
      const pass = Boolean(object) && missingKeys.length === 0;
      return result(pass, pass ? 'Campos obrigatórios do schema presentes.' : `Objeto ausente ou campos faltantes: ${missingKeys.join(', ') || 'payload'}.`, required);
    }
    default:
      return { status: 'UNKNOWN', message: `Tipo de regra ${ruleType} ainda não executável.`, expected: null };
  }
}

export async function runDqAgainstSeededData(db, { runId, now = Date.now() } = {}) {
  const startedAt = new Date(now).toISOString();
  const dqRunId = runId || cryptoId();
  const rules = await db.prepare(`
    SELECT r.*, m.data_field_id, df.name AS data_field_name, ds.id AS dataset_id
    FROM dq_rules r
    LEFT JOIN data_mappings m ON m.id = r.mapping_id
    LEFT JOIN data_fields df ON df.id = m.data_field_id
    LEFT JOIN datasets ds ON ds.id = df.dataset_id
    ORDER BY r.id
  `).all();

  await db.prepare(`INSERT INTO dq_runs (id, started_at, status, is_demo) VALUES (?, ?, 'RUNNING', 1)`).run(dqRunId, startedAt);
  const insertResult = db.prepare(`
    INSERT INTO dq_run_results
    (id, dq_run_id, dq_rule_id, dataset_row_key, status, actual_value, expected, message, created_at, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  let passed = 0;
  let failed = 0;
  let evaluated = 0;

  for (const rule of rules) {
    if (!rule.data_field_id || !rule.dataset_id) {
      await insertResult.run(cryptoId(), dqRunId, rule.id, null, 'NOT_RUN', null, null, 'Regra sem mapping para dado interno; requer configuração.', new Date().toISOString());
      continue;
    }
    const rows = await db.prepare('SELECT row_key, data_json FROM demo_data WHERE dataset_id = ? AND is_demo = 1 ORDER BY row_key').all(rule.dataset_id);
    if (!rows.length) {
      await insertResult.run(cryptoId(), dqRunId, rule.id, null, 'NOT_RUN', null, null, 'Nenhuma linha DEMO DATA disponível para avaliação.', new Date().toISOString());
      continue;
    }
    for (const row of rows) {
      let record;
      try { record = JSON.parse(row.data_json); } catch { record = {}; }
      const value = record[rule.data_field_name];
      const evaluatedResult = evaluateRule(value, rule.rule_type, rule.expression, { record, now });
      const status = evaluatedResult.status;
      if (status === 'PASS') passed += 1;
      if (status === 'FAIL') failed += 1;
      if (status === 'PASS' || status === 'FAIL') evaluated += 1;
      await insertResult.run(
        cryptoId(), dqRunId, rule.id, row.row_key, status,
        value === undefined ? null : String(value),
        safeJson(evaluatedResult.expected), evaluatedResult.message,
        new Date().toISOString(),
      );
    }
  }
  const finishedAt = new Date().toISOString();
  const finalStatus = failed ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED';
  await db.prepare(`UPDATE dq_runs SET finished_at = ?, status = ?, rules_evaluated = ?, passed = ?, failed = ? WHERE id = ?`)
    .run(finishedAt, finalStatus, evaluated, passed, failed, dqRunId);
  return { id: dqRunId, started_at: startedAt, finished_at: finishedAt, status: finalStatus, rules_evaluated: evaluated, passed, failed };
}

function matchesType(value, type) {
  if (value === null || value === undefined) return false;
  if (type === 'string') return typeof value === 'string';
  if (type === 'number' || type === 'decimal') return Number.isFinite(numericValue(value));
  if (type === 'integer') return Number.isInteger(Number(value));
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date') return Number.isFinite(Date.parse(value));
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  return false;
}

function numericValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const text = value.trim().replace(/\s+/g, '');
  // Preserve ordinary JavaScript/JSON decimals (e.g. "1234.56"), while
  // accepting Brazilian formatted input ("1.234,56" or "1234,56").
  const normalized = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  return Number(normalized);
}

function parseExpression(expression) {
  if (!expression) return {};
  if (typeof expression === 'object') return expression;
  try { return JSON.parse(expression); } catch { return {}; }
}

function ruleRegexFallback(context) {
  return context.pattern || '^.*$';
}

function result(pass, message, expected) {
  return { status: pass ? 'PASS' : 'FAIL', message, expected: safeJson(expected) };
}

function safeJson(value) {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
