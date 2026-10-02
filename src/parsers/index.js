/**
 * Parser registry used by the ingestion pipeline. Extension point: drop a new module in this
 * folder and register it in PARSERS. A parser must never invent structure it did not read.
 */
import { parseHtml } from './html-parser.js';
import { parseJson } from './json-parser.js';
import { parseCsv } from './csv-parser.js';
import { parseXml } from './xml-parser.js';
import { parsePdf } from './pdf-parser.js';
import { parseSpreadsheet } from './xlsx-parser.js';

export const PARSERS = Object.freeze({
  html: (bytes) => parseHtml(asText(bytes)),
  json: (bytes) => parseJson(asText(bytes)),
  csv: (bytes) => parseCsv(asText(bytes)),
  xml: (bytes) => parseXml(asText(bytes)),
  pdf: (bytes) => parsePdf(asBytes(bytes)),
  xlsx: (bytes) => parseSpreadsheet(asBytes(bytes)),
  text: (bytes) => {
    const text = asText(bytes).replace(/\u0000/g, '').trim();
    return {
      parse_status: text ? 'PARSED_TEXT' : 'UNSTRUCTURED',
      extracted_text: text ? text.slice(0, 200_000) : null,
      fields: [],
      notes: text ? 'Plain text captured verbatim.' : 'Empty or non-textual payload.',
    };
  },
});

export function parserFor(mimeType, declaredParser) {
  const declared = String(declaredParser || '').trim().toLowerCase();
  if (declared && PARSERS[declared]) return declared;
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('html')) return 'html';
  if (type.includes('json')) return 'json';
  if (type.includes('csv')) return 'csv';
  if (type.includes('xml') || type.includes('xsd')) return 'xml';
  if (type.includes('pdf')) return 'pdf';
  if (type.includes('excel') || type.includes('spreadsheet') || type.includes('ms-excel')) return 'xlsx';
  if (type.startsWith('text/')) return 'text';
  return null;
}

export function parseSnapshot(parserName, bytes, mimeType) {
  const parser = PARSERS[parserName];
  if (!parser) {
    return {
      parser: null,
      parse_status: 'UNSTRUCTURED',
      extracted_text: null,
      fields: [],
      notes: `No parser for media type "${mimeType || 'unknown'}"; raw bytes preserved, nothing inferred.`,
    };
  }
  try {
    const result = parser(bytes);
    return {
      parser: parserName,
      parse_status: result.parse_status,
      extracted_text: sanitizeTextForDatabase(result.extracted_text),
      fields: result.fields || [],
      notes: sanitizeTextForDatabase(result.notes) || '',
    };
  } catch (error) {
    return {
      parser: parserName,
      parse_status: 'FAILED',
      extracted_text: null,
      fields: [],
      notes: `Parser "${parserName}" failed on this payload: ${String(error?.message || error).slice(0, 300)}. Raw snapshot remains authoritative.`,
    };
  }
}

function asText(bytes) {
  return asBytes(bytes).toString('utf8');
}

function asBytes(bytes) {
  if (!bytes) return Buffer.alloc(0);
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}


/**
 * PostgreSQL TEXT cannot contain NUL (0x00). Binary formats such as PDFs may legitimately
 * expose NUL/control bytes during best-effort extraction, so sanitize only the derived text.
 * The immutable raw bytes and their SHA-256 are never modified.
 */
export function sanitizeTextForDatabase(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
