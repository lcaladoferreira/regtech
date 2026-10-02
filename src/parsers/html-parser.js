/**
 * HTML parser: strips scripts/styles/tags to recover readable text. It never invents
 * structure; when the document is only navigation chrome, extraction is still honest text.
 */
export function parseHtml(text) {
  const raw = String(text ?? '');
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const extracted = cleaned.replace(/\s+/g, ' ').trim();
  return {
    parse_status: extracted ? 'PARSED_TEXT' : 'UNSTRUCTURED',
    extracted_text: extracted || null,
    fields: [],
    notes: extracted ? `HTML text extracted (${extracted.length} chars).` : 'No readable text found in HTML payload.',
  };
}
