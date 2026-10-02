const canonicalize = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value.trim();
    }
  }
  return JSON.stringify(value);
};

const asRequired = (field) => {
  if (field.required === true || field.required === 1 || field.required === '1') return true;
  if (field.required === false || field.required === 0 || field.required === '0') return false;
  return null;
};

const comparableValue = (value) => value === undefined || value === null || value === '' ? null : String(value);

/** Compare two generic field inventories. Stable path is preferred; name-based
 * fallback allows an explicit FIELD_RENAMED result instead of a false add/remove. */
export function compareSchemas(oldFields = [], newFields = []) {
  const oldByPath = new Map(oldFields.map((field) => [field.path || field.name, field]));
  const newByPath = new Map(newFields.map((field) => [field.path || field.name, field]));
  const changes = [];
  const matchedNew = new Set();

  for (const [path, oldField] of oldByPath) {
    const newField = newByPath.get(path);
    if (newField) {
      matchedNew.add(path);
      compareProperty(changes, path, 'TYPE_CHANGED', 'data_type', oldField.data_type, newField.data_type);
      compareProperty(changes, path, 'LENGTH_CHANGED', 'length', oldField.length, newField.length);
      compareProperty(changes, path, 'PRECISION_CHANGED', 'precision', oldField.precision, newField.precision);
      compareProperty(changes, path, 'REQUIRED_CHANGED', 'required', asRequired(oldField), asRequired(newField));
      compareProperty(changes, path, 'CARDINALITY_CHANGED', 'cardinality', `${oldField.min_occurs ?? ''}:${oldField.max_occurs ?? ''}`, `${newField.min_occurs ?? ''}:${newField.max_occurs ?? ''}`);
      compareDomain(changes, path, oldField.domain, newField.domain);
      compareProperty(changes, path, 'PATTERN_CHANGED', 'pattern', oldField.pattern, newField.pattern);
      compareProperty(changes, path, 'STRUCTURE_CHANGED', 'parent_path', oldField.parent_path, newField.parent_path);
      if (oldField.name && newField.name && oldField.name !== newField.name) {
        changes.push(change('FIELD_RENAMED', path, oldField.name, newField.name, 'name'));
      }
      continue;
    }

    // A rename is only inferred when a stable source id explicitly links two paths.
    const explicitRename = newFields.find((field) => field.stable_id && field.stable_id === oldField.stable_id);
    if (explicitRename) {
      matchedNew.add(explicitRename.path || explicitRename.name);
      changes.push(change('FIELD_RENAMED', path, oldField.name || path, explicitRename.name || explicitRename.path, 'name'));
      compareProperty(changes, path, 'TYPE_CHANGED', 'data_type', oldField.data_type, explicitRename.data_type);
      continue;
    }
    changes.push(change('FIELD_REMOVED', path, describeField(oldField), null, 'field'));
  }

  for (const [path, newField] of newByPath) {
    if (oldByPath.has(path) || matchedNew.has(path)) continue;
    const explicitlyRenamedFrom = oldFields.find((field) => field.stable_id && field.stable_id === newField.stable_id);
    if (explicitlyRenamedFrom) continue;
    const kind = asRequired(newField) === true ? 'NEW_REQUIRED_FIELD' : 'FIELD_ADDED';
    changes.push(change(kind, path, null, describeField(newField), 'field'));
  }

  return changes;
}

function compareProperty(changes, path, changeType, field, oldValue, newValue) {
  const previous = comparableValue(oldValue);
  const current = comparableValue(newValue);
  if (previous === current) return;
  changes.push(change(changeType, path, previous, current, field));
}

function compareDomain(changes, path, oldDomain, newDomain) {
  const oldValue = parseDomain(oldDomain);
  const newValue = parseDomain(newDomain);
  if (!oldValue.length && !newValue.length) {
    compareProperty(changes, path, 'DOMAIN_CHANGED', 'domain', oldDomain, newDomain);
    return;
  }
  const oldSet = new Set(oldValue.map(String));
  const newSet = new Set(newValue.map(String));
  for (const item of newSet) {
    if (!oldSet.has(item)) changes.push(change('ENUM_ADDED', path, null, item, 'domain'));
  }
  for (const item of oldSet) {
    if (!newSet.has(item)) changes.push(change('ENUM_REMOVED', path, item, null, 'domain'));
  }
}

function parseDomain(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.keys(value);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed);
  } catch {
    // Domain strings are not assumed to be enum lists; emit DOMAIN_CHANGED instead.
  }
  return [];
}

function describeField(field) {
  return `${field.name || field.path}${field.data_type ? ` (${field.data_type})` : ''}${field.required ? ', obrigatório' : ''}`;
}

function change(type, path, oldValue, newValue, property) {
  return { change_type: type, field_path: path, field: property, old_value: oldValue, new_value: newValue };
}

/**
 * A small transparent text comparator for normative prose. It does not infer
 * legal meaning: it returns line-level additions/removals and keyword cues only.
 */
export function compareNormativeText(oldText = '', newText = '') {
  const oldLines = normalizeLines(oldText);
  const newLines = normalizeLines(newText);
  const removed = oldLines.filter((line) => !newLines.includes(line));
  const added = newLines.filter((line) => !oldLines.includes(line));
  const combined = [...added, ...removed].join(' ').toLocaleLowerCase('pt-BR');
  const cues = [];
  const cueMap = [
    ['deadline', /prazo|dias? úteis|vencimento|data limite|até o dia/],
    ['frequency', /periodicidade|diário|mensal|trimestral|anual/],
    ['population', /instituiç|entidade|controlador|declarante|participante|obrigad/],
    ['format', /xml|json|csv|xsd|leiaute|layout|schema|arquivo|formato/],
    ['business_rule', /deverá|deve|vedado|obrigatório|facultativo|retenção/],
  ];
  for (const [name, pattern] of cueMap) if (pattern.test(combined)) cues.push(name);
  return {
    added,
    removed,
    cues,
    note: 'Comparação lexical de linhas; não substitui interpretação jurídica nem revisão humana.',
  };
}

function normalizeLines(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
