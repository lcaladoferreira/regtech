/**
 * XML/XSD parser: inventories literal <xs:element>/<xsd:element> declarations for schemas and
 * top-level element names for plain XML. Cardinality/type values are only recorded when present.
 */
export function parseXml(text) {
  const raw = String(text ?? '');
  const fields = [];
  const isSchema = /<(?:xs|xsd):schema\b/i.test(raw);
  if (isSchema) {
    const regex = /<(?:xs|xsd):element\b([^>]*?)\/?>/gi;
    for (const match of raw.matchAll(regex)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((item) => [item[1], item[2]]));
      if (!attrs.name) continue;
      fields.push({
        name: attrs.name,
        path: attrs.name,
        data_type: attrs.type || 'UNKNOWN',
        required: attrs.minOccurs === undefined ? null : attrs.minOccurs === '1' ? 1 : 0,
        min_occurs: attrs.minOccurs ?? null,
        max_occurs: attrs.maxOccurs ?? null,
        length: attrs.length ?? null,
        pattern: attrs.pattern ?? null,
        evidence: match[0].slice(0, 600),
      });
    }
  } else {
    const names = new Set();
    const elementRegex = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/g;
    for (const match of raw.matchAll(elementRegex)) {
      if (names.size >= 300) break;
      names.add(match[1]);
    }
    for (const name of names) fields.push({ name, path: name, data_type: 'UNKNOWN', required: null, evidence: `<${name}>` });
  }
  const textOnly = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    parse_status: fields.length ? 'PARSED_STRUCTURED' : textOnly ? 'PARSED_TEXT' : 'UNSTRUCTURED',
    extracted_text: textOnly.slice(0, 200_000) || null,
    fields,
    notes: isSchema
      ? `${fields.length} XSD element declaration(s) inventoried; unlisted facets remain UNKNOWN.`
      : `${fields.length} distinct XML element name(s) inventoried; no layout semantics inferred.`,
  };
}
