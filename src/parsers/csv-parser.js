/**
 * CSV / delimited text parser: catalogs the literal header row and counts samples.
 * Delimiter sniffing is limited to ; tab , | and never guesses additional layout semantics.
 */
export function parseCsv(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.trim().length);
  if (!lines.length) return { parse_status: 'UNSTRUCTURED', extracted_text: null, fields: [], notes: 'Empty delimited file.' };
  const header = lines[0];
  const delimiter = header.includes(';') ? ';' : header.includes('\t') ? '\t' : header.includes('|') ? '|' : ',';
  const names = header.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''));
  const fields = names.filter(Boolean).map((name, index) => ({
    name,
    path: `column[${index}]`,
    data_type: 'UNKNOWN',
    required: null,
    evidence: header.slice(0, 600),
  }));
  return {
    parse_status: 'PARSED_STRUCTURED',
    extracted_text: normalized.slice(0, 200_000),
    fields,
    notes: `Delimited text: ${fields.length} header column(s), ${Math.max(0, lines.length - 1)} data line(s). Column types are not inferred.`,
  };
}
