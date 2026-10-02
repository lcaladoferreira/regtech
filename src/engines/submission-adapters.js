export const SUPPORTED_ADAPTERS = Object.freeze(['XML', 'CSV', 'JSON', 'FIXED_WIDTH', 'PIPE_DELIMITED']);

export function serializeWithAdapter(adapter, payload, config = {}) {
  const normalizedAdapter = String(adapter || config.kind || '').toUpperCase();
  if (!SUPPORTED_ADAPTERS.includes(normalizedAdapter)) {
    throw new Error(`Adapter ${normalizedAdapter || '(empty)'} is not supported. Supported: ${SUPPORTED_ADAPTERS.join(', ')}.`);
  }
  if (normalizedAdapter === 'JSON') return `${JSON.stringify(payload, null, 2)}\n`;
  if (normalizedAdapter === 'XML') return serializeXml(payload, config);
  if (normalizedAdapter === 'CSV') return serializeCsv(payload, config);
  if (normalizedAdapter === 'FIXED_WIDTH') return serializeFixedWidth(payload, config);
  if (normalizedAdapter === 'PIPE_DELIMITED') return serializePipeDelimited(payload, config);
  throw new Error(`No serializer registered for ${normalizedAdapter}.`);
}

export function serializeXml(payload, config = {}) {
  const rootName = config.rootName || 'document';
  const attrs = renderAttributes(config.rootAttributes || {}, payload);
  const children = (config.children || []).map((child) => renderXmlChild(child, payload)).join('');
  const body = children || escapeXmlText(config.textPath ? getPath(payload, config.textPath) ?? '' : '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}${attrs}>${body ? `${body}</${rootName}>` : `</${rootName}>`}\n`;
}

function renderXmlChild(child, payload) {
  if (child.itemsPath) {
    const items = getPath(payload, child.itemsPath);
    if (!Array.isArray(items)) return `<${child.name}/>`;
    const inner = items.map((item) => {
      const attributes = renderAttributes(child.itemAttributes || {}, item);
      const nested = (child.children || []).map((nestedChild) => renderXmlChild(nestedChild, item)).join('');
      return nested ? `<${child.itemName || 'item'}${attributes}>${nested}</${child.itemName || 'item'}>` : `<${child.itemName || 'item'}${attributes}/>`;
    }).join('');
    return `<${child.name}>${inner}</${child.name}>`;
  }
  const value = child.path ? getPath(payload, child.path) : child.value;
  if (value === undefined || value === null) return `<${child.name}/>`;
  return `<${child.name}>${escapeXmlText(value)}</${child.name}>`;
}

function renderAttributes(attributeConfig, source) {
  return Object.entries(attributeConfig).map(([name, valueConfig]) => {
    const value = resolveValue(valueConfig, source);
    return value === undefined || value === null ? '' : ` ${name}="${escapeXmlAttribute(value)}"`;
  }).join('');
}

export function serializeCsv(payload, config = {}) {
  const rows = normalizeRows(payload, config);
  const delimiter = config.delimiter || ',';
  const lines = [];
  if (config.headers !== false) lines.push((config.columns || inferColumns(rows)).map((column) => csvEscape(column.label || column.key, delimiter)).join(delimiter));
  for (const row of rows) {
    const columns = config.columns || inferColumns(rows);
    lines.push(columns.map((column) => csvEscape(getPath(row, column.path || column.key) ?? '', delimiter)).join(delimiter));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function serializeFixedWidth(payload, config = {}) {
  const rows = normalizeRows(payload, config);
  const fields = config.fields || [];
  if (!fields.length) throw new Error('FIXED_WIDTH adapter requires fields with an explicit width.');
  const lines = rows.map((row) => fields.map((field) => {
    const value = String(getPath(row, field.path || field.name) ?? '');
    const width = Number(field.width);
    if (!Number.isInteger(width) || width < 1) throw new Error(`Invalid fixed-width length for ${field.name}.`);
    if (value.length > width) throw new Error(`Value for ${field.name} exceeds configured width ${width}.`);
    return field.align === 'right' ? value.padStart(width, field.padChar || ' ') : value.padEnd(width, field.padChar || ' ');
  }).join(''));
  return `${lines.join('\r\n')}\r\n`;
}

export function serializePipeDelimited(payload, config = {}) {
  const delimiter = config.delimiter || '|';
  const lineEnding = config.lineEnding || '\r\n';
  let records;
  if (Array.isArray(config.records)) {
    records = config.records.map((record) => record.fields.map((field) => {
      const value = resolveValue(field, payload);
      return pipeEscape(value ?? '', delimiter);
    }).join(delimiter));
  } else {
    const rows = normalizeRows(payload, config);
    const fields = config.fields || inferColumns(rows).map((column) => ({ name: column.key, path: column.path || column.key }));
    records = rows.map((row) => fields.map((field) => pipeEscape(getPath(row, field.path || field.name) ?? '', delimiter)).join(delimiter));
  }
  return `${records.join(lineEnding)}${lineEnding}`;
}

export function validateConfiguredPayload(payload, config = {}) {
  const errors = [];
  for (const path of config.requiredPaths || []) {
    const value = getPath(payload, path);
    if (value === undefined || value === null || value === '') errors.push(`Required path missing: ${path}`);
  }
  for (const constraint of config.constraints || []) {
    const value = getPath(payload, constraint.path);
    if (value === undefined || value === null) {
      if (constraint.required) errors.push(`Required path missing: ${constraint.path}`);
      continue;
    }
    if (constraint.type === 'string' && typeof value !== 'string') errors.push(`${constraint.path} must be a string.`);
    if (constraint.type === 'number' && !Number.isFinite(Number(value))) errors.push(`${constraint.path} must be numeric.`);
    if (constraint.length !== undefined && String(value).length !== constraint.length) errors.push(`${constraint.path} must have length ${constraint.length}.`);
    if (constraint.maxLength !== undefined && String(value).length > constraint.maxLength) errors.push(`${constraint.path} exceeds ${constraint.maxLength} characters.`);
    if (constraint.regex && !new RegExp(constraint.regex).test(String(value))) errors.push(`${constraint.path} does not match the configured pattern.`);
    if (constraint.allowed && !constraint.allowed.map(String).includes(String(value))) errors.push(`${constraint.path} is outside the configured domain.`);
  }
  return { status: errors.length ? 'INVALID' : 'VALIDATED', errors };
}

export function getPath(object, path) {
  if (!path) return undefined;
  if (typeof path !== 'string') return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = object;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function resolveValue(descriptor, source) {
  if (descriptor && typeof descriptor === 'object' && Object.hasOwn(descriptor, 'constant')) return descriptor.constant;
  if (descriptor && typeof descriptor === 'object' && descriptor.path) return getPath(source, descriptor.path);
  if (typeof descriptor === 'string' && descriptor.startsWith('$')) return getPath(source, descriptor.slice(1));
  return descriptor;
}

function normalizeRows(payload, config) {
  const value = config.rowsPath ? getPath(payload, config.rowsPath) : payload;
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.rows)) return value.rows;
  if (value && typeof value === 'object') return [value];
  return [];
}

function inferColumns(rows) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  return keys.map((key) => ({ key, path: key }));
}

function csvEscape(value, delimiter) {
  const text = String(value ?? '');
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pipeEscape(value, delimiter) {
  const text = String(value ?? '');
  if (text.includes(delimiter) || text.includes('\r') || text.includes('\n')) {
    throw new Error(`Delimited value contains a forbidden delimiter or line break (${delimiter}).`);
  }
  return text;
}

function escapeXmlText(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
