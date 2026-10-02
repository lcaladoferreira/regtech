/**
 * XLS/XLSX parser: detects spreadsheet payloads. Full BIFF/XLSX sheet parsing is NOT
 * implemented, so honest behavior is UNSTRUCTURED with a stable detection note — the raw
 * workbook stays captured and reviewable. No layout/fields are ever invented here.
 */
export function parseSpreadsheet(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const isZip = buffer.subarray(0, 2).toString('latin1') === 'PK';
  const isOle = buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
  return {
    parse_status: 'UNSTRUCTURED',
    extracted_text: null,
    fields: [],
    notes: isZip
      ? 'OOXML workbook (zip container) detected; sheet parsing not implemented — layout stays NEEDS_REVIEW against the raw file.'
      : isOle
        ? 'Legacy OLE2 workbook (BIFF/XLS) detected; sheet parsing not implemented — layout stays NEEDS_REVIEW against the raw file.'
        : 'Unknown spreadsheet binary; not parsed.',
  };
}
