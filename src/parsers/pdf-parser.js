/**
 * PDF parser: best-effort text extraction from uncompressed or Flate-compressed content
 * streams. It never fabricates content: when no reliable text layer exists (scanned PDFs,
 * unusual filters, encryption) the result is UNSTRUCTURED and the raw bytes remain the record.
 */
import { inflateSync } from 'node:zlib';

export function parsePdf(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!buffer.subarray(0, 5).includes('%PDF-')) {
    return { parse_status: 'UNSTRUCTURED', extracted_text: null, fields: [], notes: 'Payload is not a PDF document.' };
  }
  const chunks = [];
  let corrupted = false;
  const streamRegex = /stream\r?\n?/gi;
  let match;
  while ((match = streamRegex.exec(buffer.toString('latin1'))) !== null) {
    const start = match.index + match[0].length;
    const end = buffer.indexOf(Buffer.from('endstream'), start);
    if (end === -1) { corrupted = true; break; }
    const raw = buffer.subarray(start, end);
    let decoded = null;
    try { decoded = inflateSync(raw); } catch { decoded = raw; }
    chunks.push(decoded);
  }
  let text = '';
  for (const chunk of chunks) {
    const content = chunk.toString('latin1');
    if (!/(Tj|TJ)\s*$/m.test(content) && !content.includes('BT')) continue;
    for (const piece of content.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      text += decodePdfLiteral(piece[0]) + ' ';
    }
    for (const piece of content.matchAll(/<([0-9A-Fa-f\s]{4,})>\s*Tj/g)) {
      const hex = piece[1].replace(/\s+/g, '');
      if (hex.length % 4 === 0) {
        let decodedText = '';
        for (let i = 0; i < hex.length; i += 4) {
          const code = parseInt(hex.slice(i, i + 4), 16);
          if (code >= 32 || code === 10) decodedText += String.fromCharCode(code);
        }
        text += `${decodedText} `;
      }
    }
  }
  const extracted = text.replace(/\s+/g, ' ').trim();
  if (extracted.length >= 200) {
    return {
      parse_status: 'PARSED_TEXT',
      extracted_text: extracted.slice(0, 200_000),
      fields: [],
      notes: `Best-effort PDF text layer extracted (${extracted.length} chars). Accents/kerning may be lossy; the immutable PDF remains the authoritative snapshot.`,
    };
  }
  return {
    parse_status: 'UNSTRUCTURED',
    extracted_text: extracted ? extracted.slice(0, 20_000) : null,
    fields: [],
    notes: corrupted
      ? 'PDF stream boundaries could not be parsed; content left UNSTRUCTURED.'
      : 'No reliable PDF text layer found (scanned image, unusual filters or encryption). parse_status=UNSTRUCTURED; nothing was inferred.',
  };
}

function decodePdfLiteral(literal) {
  return literal
    .slice(1, -1)
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_m, octal) => String.fromCharCode(parseInt(octal, 8)));
}
