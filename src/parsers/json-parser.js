/**
 * JSON parser: reads JSON payloads (including JSON Schema / OpenAPI style documents) and
 * catalogs only properties that literally exist in the document. Missing metadata stays null.
 */
export function parseJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return { parse_status: 'UNSTRUCTURED', extracted_text: String(text ?? '').slice(0, 200_000), fields: [], notes: 'Payload is not valid JSON; no structure invented.' };
  }
  const fields = [];
  const seen = new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== 'object' || fields.length >= 500) return;
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (node.properties && typeof node.properties === 'object' && key === 'properties') {
        for (const [name, detail] of Object.entries(node.properties)) {
          const namePath = `${path}.${name}`;
          if (seen.has(namePath)) continue;
          seen.add(namePath);
          fields.push({
            name,
            path: namePath,
            data_type: detail && typeof detail === 'object' ? (detail.type || 'UNKNOWN') : 'UNKNOWN',
            required: Array.isArray(node.required) ? node.required.includes(name) : null,
            evidence: JSON.stringify(detail).slice(0, 600),
          });
        }
        walk(node.properties, path);
        continue;
      }
      if (typeof value === 'object') walk(value, nextPath);
    }
  };
  walk(parsed, '');
  return {
    parse_status: fields.length ? 'PARSED_STRUCTURED' : 'PARSED_TEXT',
    extracted_text: JSON.stringify(parsed).slice(0, 200_000),
    fields,
    notes: fields.length ? `${fields.length} JSON properties inventoried from the payload.` : 'Valid JSON without property inventory.',
  };
}
