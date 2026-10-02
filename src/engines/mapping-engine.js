const TRANSFORMATIONS = Object.freeze(['IDENTITY', 'UPPERCASE', 'ISO_DATE', 'DDMMYYYY', 'BRL_DECIMAL_2']);

/** Apply only explicit, bounded transformations. Mapping expressions are never eval'd. */
export function applyMappingTransformation(value, expression = 'IDENTITY') {
  const transform = String(expression || 'IDENTITY').trim().toUpperCase();
  if (value === null || value === undefined) return value;
  if (transform === 'IDENTITY') return value;
  if (transform === 'UPPERCASE') return String(value).toUpperCase();
  const leftPad = /^LEFT_PAD\((\d{1,3})\)$/.exec(transform) || /^PAD_LEFT_(\d{1,3})$/.exec(transform);
  if (leftPad) {
    const width = Number(leftPad[1]);
    const text = String(value);
    if (text.length > width) throw new RangeError(`Value length ${text.length} exceeds LEFT_PAD width ${width}.`);
    return text.padStart(width, '0');
  }
  const decimal = /^DECIMAL\((\d{1,2})\)$/.exec(transform);
  if (decimal) return fixedDecimal(value, Number(decimal[1]));
  if (transform === 'BRL_DECIMAL_2') return fixedDecimal(value, 2);
  if (transform === 'ISO_DATE') return formatDate(value, 'ISO');
  if (transform === 'DDMMYYYY') return formatDate(value, 'DDMMYYYY');
  if (!TRANSFORMATIONS.includes(transform)) throw new Error(`Transformation ${transform} is not in the safe mapping allowlist.`);
  return value;
}

function fixedDecimal(value, scale) {
  const number = numericValue(value);
  if (!Number.isFinite(number)) throw new TypeError(`Cannot apply DECIMAL(${scale}) to a non-numeric value.`);
  return number.toFixed(scale);
}

function numericValue(value) {
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(/\s+/g, '');
  if (!text) return Number.NaN;
  return Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
}

function formatDate(value, format) {
  const text = String(value);
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    date = new Date(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new TypeError(`Invalid calendar date ${text}.`);
  } else {
    const millis = Date.parse(text);
    if (!Number.isFinite(millis)) throw new TypeError(`Cannot parse date ${text}.`);
    date = new Date(millis);
  }
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return format === 'ISO' ? `${yyyy}-${mm}-${dd}` : `${dd}${mm}${yyyy}`;
}
