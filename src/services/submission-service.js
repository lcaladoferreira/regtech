import { createHash, randomUUID } from 'node:crypto';
import { evaluateRule } from '../engines/dq-engine.js';
import { applyMappingTransformation } from '../engines/mapping-engine.js';
import { getPath, serializeWithAdapter, validateConfiguredPayload } from '../engines/submission-adapters.js';
import { startJobRun, finishJobRun } from '../engines/ingestion.js';
import { createStorage } from '../storage.js';

const ARTIFACT_PREFIX = 'demo-artifacts';
const MIME_BY_EXT = { xml: 'application/xml', csv: 'text/csv', json: 'application/json', txt: 'text/plain' };

export class SubmissionError extends Error {
  constructor(message, statusCode = 400, code = 'SUBMISSION_ERROR') {
    super(message);
    this.name = 'SubmissionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function generateSubmission(db, { obligationId, referencePeriod, actor = 'demo-user', storage: injectedStorage = null } = {}) {
  if (!obligationId) throw new SubmissionError('obligation_id is required.');
  const obligation = await db.prepare(`SELECT o.*, r.acronym FROM regulatory_obligations o JOIN regulators r ON r.id = o.regulator_id WHERE o.id = ?`).get(obligationId);
  if (!obligation) throw new SubmissionError('Obligation not found.', 404, 'OBLIGATION_NOT_FOUND');
  const schema = await db.prepare(`SELECT sv.*, rd.output_format AS document_output_format, rd.code AS document_code
    FROM regulatory_documents rd JOIN schema_versions sv ON sv.document_id = rd.id
    WHERE rd.obligation_id = ? AND sv.status = 'CURRENT' ORDER BY sv.version DESC LIMIT 1`).get(obligationId);
  if (!schema?.adapter_config_json) {
    throw new SubmissionError('A versioned schema with a configured generic adapter is not available for this obligation. The system will not fabricate a layout.', 409, 'ADAPTER_NOT_AVAILABLE');
  }
  const config = JSON.parse(schema.adapter_config_json);
  const adapter = config.kind || schema.schema_type;
  const payloadResult = await buildPayloadFromMappings(db, schema, config);
  const validation = validateConfiguredPayload(payloadResult.payload, config);
  if (validation.errors.length) {
    throw new SubmissionError(`Cannot generate: ${validation.errors.join(' ')}`, 422, 'MAPPING_OR_PAYLOAD_INVALID');
  }
  const content = serializeWithAdapter(adapter, payloadResult.payload, config);
  const submissionId = randomUUID();
  const extension = extensionFor(adapter);
  const storage = injectedStorage || await createStorage({ db });
  const filename = `demo-${safeFilename(obligation.code)}-${submissionId}.${extension}`;
  const artifactKey = `${ARTIFACT_PREFIX}/${filename}`;
  const savedArtifact = await storage.save(artifactKey, Buffer.from(content, 'utf8'), { contentType: MIME_BY_EXT[extension] || 'application/octet-stream' });
  const artifactHash = createHash('sha256').update(content, 'utf8').digest('hex');
  const artifactPath = `${savedArtifact.provider}:${artifactKey}`;
  const generatedAt = new Date().toISOString();
  const period = referencePeriod || payloadResult.payload.dataBase || new Date().toISOString().slice(0, 10);

  await db.prepare(`INSERT INTO submissions
    (id, obligation_id, reference_period, schema_version_id, generated_at, status, artifact_path, output_format, payload_json, validation_summary, is_demo)
    VALUES (?, ?, ?, ?, ?, 'GENERATED', ?, ?, ?, ?, 1)`)
    .run(submissionId, obligationId, period, schema.id, generatedAt, artifactPath, adapter, JSON.stringify(payloadResult.payload), JSON.stringify({ mode: 'DEMO_ONLY', local_validator: 'NOT_RUN', official_regulator_validator: false, mapping_source_rows: payloadResult.rowsUsed }));

  await db.prepare(`INSERT INTO evidence_items
    (id, obligation_id, evidence_type, title, artifact_path, collected_at, source_reference, content_hash, status, is_demo)
    VALUES (?, ?, 'DEMO_SUBMISSION_ARTIFACT', ?, ?, ?, ?, ?, 'AVAILABLE', 1)`)
    .run(`evidence-${submissionId}`, obligationId, `DEMO DATA — arquivo ${obligation.code}`, artifactPath, generatedAt, schema.schema_url || 'No official schema URL', artifactHash);
  await db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, action, old_value, new_value, created_at, actor)
    VALUES (?, 'SUBMISSION', ?, 'GENERATED_DEMO_ARTIFACT', NULL, ?, ?, ?)`)
    .run(randomUUID(), submissionId, JSON.stringify({ path: artifactPath, sha256: artifactHash, adapter, demo: true }), generatedAt, actor);

  return {
    submission_id: submissionId,
    obligation_id: obligationId,
    status: 'GENERATED',
    is_demo: true,
    output_format: adapter,
    artifact_path: artifactPath,
    artifact_url: `/api/artifacts/${encodeURIComponent(filename)}`,
    artifact_sha256: artifactHash,
    payload: payloadResult.payload,
    source_rows: payloadResult.rowsUsed,
    notice: 'Artefato exclusivamente sintético. Não foi submetido ao regulador e não é validado por ferramenta oficial.',
  };
}

export async function validateSubmission(db, { submissionId, actor = 'demo-user', storage: injectedStorage = null } = {}) {
  if (!submissionId) throw new SubmissionError('submission_id is required.');
  const submission = await db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!submission) throw new SubmissionError('Submission not found.', 404, 'SUBMISSION_NOT_FOUND');
  const schema = await db.prepare('SELECT * FROM schema_versions WHERE id = ?').get(submission.schema_version_id);
  if (!schema?.adapter_config_json) throw new SubmissionError('No configured validation metadata for this submission.', 409, 'VALIDATION_NOT_AVAILABLE');
  const config = JSON.parse(schema.adapter_config_json);
  const payload = safeParse(submission.payload_json, {});
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.prepare('DELETE FROM validation_results WHERE submission_id = ?').run(submissionId);
  const insert = await db.prepare(`INSERT INTO validation_results
    (id, submission_id, validation_type, rule, status, message, created_at, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);

  const configured = validateConfiguredPayload(payload, config);
  const artifact = await safeReadArtifact(submission.artifact_path, injectedStorage || await createStorage({ db }));
  const xmlCheck = String(submission.output_format).toUpperCase() === 'XML'
    ? checkXmlEnvelope(artifact)
    : { status: 'PASS', message: `${submission.output_format} artifact was generated from configured adapter.` };
  await insert.run(randomUUID(), submissionId, 'SCHEMA_METADATA', 'CONFIGURED_SCHEMA_CONSTRAINTS', configured.errors.length ? 'FAIL' : 'PASS', configured.errors.length ? configured.errors.join('; ') : `Passou ${config.constraints?.length || 0} constraints internos; sem validação contra XSD oficial.`, createdAt);
  await insert.run(randomUUID(), submissionId, 'SERIALIZATION', 'ARTIFACT_STRUCTURE', xmlCheck.status, xmlCheck.message, createdAt);
  const dqResults = await evaluateMappedDq(db, schema.id, config, payload);
  for (const result of dqResults) {
    await insert.run(randomUUID(), submissionId, 'DATA_QUALITY', result.rule, result.status, result.message, createdAt);
  }
  if (!dqResults.length) {
    await insert.run(randomUUID(), submissionId, 'DATA_QUALITY', 'NO_RULES_CONFIGURED', 'NOT_RUN', 'Nenhuma regra DQ vinculada ao schema atual.', createdAt);
  }
  const failing = configured.errors.length > 0 || xmlCheck.status !== 'PASS' || dqResults.some((result) => result.status === 'FAIL');
  const status = failing ? 'INVALID' : 'READY';
  const summary = {
    local_checks: true,
    official_regulator_validator: false,
    status,
    schema_errors: configured.errors,
    serialization: xmlCheck,
    dq_rules_evaluated: dqResults.length,
    dq_failures: dqResults.filter((result) => result.status === 'FAIL').length,
    demo_only: true,
    ready_means: 'Ready for internal review only; not submitted and not regulator-certified.',
  };
  await db.prepare('UPDATE submissions SET status = ?, validation_summary = ? WHERE id = ?').run(status, JSON.stringify(summary), submissionId);
  await db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, action, old_value, new_value, created_at, actor)
    VALUES (?, 'SUBMISSION', ?, 'LOCAL_VALIDATION', ?, ?, ?, ?)`)
    .run(randomUUID(), submissionId, submission.status, JSON.stringify(summary), createdAt, actor);
  return { submission_id: submissionId, status, results: await db.prepare('SELECT * FROM validation_results WHERE submission_id = ? ORDER BY validation_type, rule').all(submissionId), summary };
}

export async function runDemoPipeline(db, { obligationId = 'obl-bcb-4111', referencePeriod, actor = 'demo-user', storage: injectedStorage = null } = {}) {
  const pipeline = await db.prepare("SELECT * FROM pipelines WHERE id = 'pipeline-regulatory-demo'").get();
  if (!pipeline) throw new SubmissionError('Demo pipeline is not configured.', 500, 'PIPELINE_NOT_CONFIGURED');
  const runId = randomUUID();
  const jobRun = await startJobRun(db, 'generate_submissions');
  const startedAt = new Date().toISOString();
  const stages = [
    { name: 'RAW', status: 'RUNNING', description: 'Load explicitly labeled synthetic source records.' },
    { name: 'STANDARDIZED', status: 'PENDING', description: 'Normalize types and date/identifier representation.' },
    { name: 'CANONICAL', status: 'PENDING', description: 'Resolve canonical mappings.' },
    { name: 'REGULATORY', status: 'PENDING', description: 'Project through mapping rows into the selected schema configuration.' },
    { name: 'VALIDATED', status: 'PENDING', description: 'Run configured schema metadata and DQ checks.' },
    { name: 'OUTPUT', status: 'PENDING', description: 'Write a DEMO DATA artifact using the generic adapter.' },
  ];
  await db.prepare(`INSERT INTO pipeline_runs (id, pipeline_id, started_at, status, records_processed, records_created, stages_json, is_demo)
    VALUES (?, ?, ?, 'RUNNING', 0, 0, ?, 1)`).run(runId, pipeline.id, startedAt, JSON.stringify(stages));
  try {
    stages[0].status = 'SUCCEEDED';
    stages[0].records = 1;
    stages[1].status = 'SUCCEEDED';
    stages[2].status = 'SUCCEEDED';
    stages[3].status = 'RUNNING';
    const generated = await generateSubmission(db, { obligationId, referencePeriod, actor, storage: injectedStorage });
    stages[3].status = 'SUCCEEDED';
    stages[3].payload_fields = Object.keys(generated.payload);
    stages[4].status = 'RUNNING';
    const validation = await validateSubmission(db, { submissionId: generated.submission_id, actor, storage: injectedStorage });
    stages[4].status = validation.status === 'READY' ? 'SUCCEEDED' : 'FAILED';
    stages[4].validation = validation.summary;
    stages[5].status = validation.status === 'READY' ? 'SUCCEEDED' : 'FAILED';
    const status = validation.status === 'READY' ? 'SUCCEEDED' : 'FAILED';
    stages.forEach((stage) => { if (stage.status === 'PENDING') stage.status = 'SKIPPED'; });
    const finishedAt = new Date().toISOString();
    await db.prepare(`UPDATE pipeline_runs SET finished_at = ?, status = ?, records_processed = 1, records_created = 1, stages_json = ? WHERE id = ?`)
      .run(finishedAt, status, JSON.stringify(stages), runId);
    await updateDemoControl(db, obligationId, status === 'SUCCEEDED' ? 'PASS' : 'FAIL', finishedAt);
    await finishJobRun(db, jobRun.id, { status, processed: 1, created: 1, updated: 0, errors: status === 'FAILED' ? JSON.stringify(validation.summary) : null, result: { pipeline_run_id: runId, submission_id: generated.submission_id, stages } });
    return { pipeline_run_id: runId, job_run_id: jobRun.id, status, stages, submission: generated, validation };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    stages.forEach((stage) => { if (stage.status === 'RUNNING') stage.status = 'FAILED'; if (stage.status === 'PENDING') stage.status = 'SKIPPED'; });
    await db.prepare(`UPDATE pipeline_runs SET finished_at = ?, status = 'FAILED', error = ?, stages_json = ? WHERE id = ?`)
      .run(finishedAt, String(error?.message || error), JSON.stringify(stages), runId);
    await finishJobRun(db, jobRun.id, { status: 'FAILED', processed: 0, result: { pipeline_run_id: runId, stages }, errors: String(error?.message || error) });
    throw error;
  }
}

/**
 * Reads a generated DEMO pipeline artifact through the durable storage abstraction.
 * Accepts a provider-prefixed key ("filesystem:demo-artifacts/x.xml"), a bare
 * "demo-artifacts/..." path or a bare filename.
 */
export async function readArtifact(storage, relativePath) {
  const key = normalizeArtifactKey(relativePath);
  if (!key) return null;
  const body = await storage.read(key);
  return body ? { body: Buffer.from(body), filename: key.split('/').pop() } : null;
}

function normalizeArtifactKey(value) {
  const text = String(value || '').replaceAll('\\', '/').replace(/^\w+:/, '');
  if (!text.startsWith(`${ARTIFACT_PREFIX}/`)) {
    if (text.includes('/') || text.includes('..')) return null;
    return `${ARTIFACT_PREFIX}/${text}`;
  }
  if (text.includes('..')) return null;
  return text;
}

async function buildPayloadFromMappings(db, schema, config) {
  const payload = {};
  const rowsUsed = [];
  const mappings = new Map();
  for (const projection of config.projection || []) {
    if (Object.hasOwn(projection, 'constant')) {
      assignPath(payload, projection.target, projection.constant);
      continue;
    }
    if (projection.value !== undefined) {
      assignPath(payload, projection.target, projection.value);
      continue;
    }
    const mapping = await db.prepare(`SELECT m.*, df.name AS field_name, df.dataset_id, df.data_type AS source_type
      FROM data_mappings m JOIN data_fields df ON df.id = m.data_field_id
      WHERE m.regulatory_field_id = ? AND m.is_demo = 1 AND df.is_demo = 1 ORDER BY CASE m.mapping_status WHEN 'VALIDATED' THEN 0 WHEN 'MAPPED' THEN 1 ELSE 2 END LIMIT 1`).get(projection.regulatoryFieldId);
    if (!mapping || !['MAPPED','VALIDATED'].includes(mapping.mapping_status)) {
      throw new SubmissionError(`No approved/usable data mapping for regulatory field ${projection.regulatoryFieldId}.`, 409, 'FIELD_UNMAPPED');
    }
    const sourceRow = await db.prepare(`SELECT * FROM demo_data WHERE dataset_id = ? AND is_demo = 1
      ORDER BY CASE scenario WHEN 'happy_path' THEN 0 ELSE 1 END, row_key LIMIT 1`).get(mapping.dataset_id);
    if (!sourceRow) throw new SubmissionError(`No DEMO DATA fixture for ${mapping.field_name}.`, 409, 'DEMO_FIXTURE_NOT_AVAILABLE');
    const record = safeParse(sourceRow.data_json, {});
    const value = record[mapping.field_name];
    if (value === undefined) throw new SubmissionError(`DEMO DATA row has no ${mapping.field_name} value.`, 422, 'DEMO_FIELD_VALUE_MISSING');
    const transformedValue = applyMappingTransformation(value, mapping.transformation);
    assignPath(payload, projection.target, transformedValue);
    rowsUsed.push({ dataset_id: mapping.dataset_id, row_key: sourceRow.row_key, scenario: sourceRow.scenario, is_demo: true, regulatory_field_id: projection.regulatoryFieldId, target: projection.target, transformation: mapping.transformation });
    mappings.set(projection.regulatoryFieldId, mapping.id);
  }
  return { payload, rowsUsed: uniqueRows(rowsUsed), mappings: Object.fromEntries(mappings) };
}

async function evaluateMappedDq(db, schemaVersionId, config, payload) {
  const rules = await db.prepare(`SELECT q.*, f.path AS regulatory_path, f.id AS field_id
    FROM dq_rules q JOIN regulatory_fields f ON f.id = q.regulatory_field_id
    WHERE f.schema_version_id = ? ORDER BY q.id`).all(schemaVersionId);
  const projectionMap = new Map((config.projection || []).filter((item) => item.regulatoryFieldId).map((item) => [item.regulatoryFieldId, item.target]));
  return rules.map((rule) => {
    const target = projectionMap.get(rule.field_id);
    const value = target ? getPath(payload, target) : undefined;
    if (!target) return { rule: rule.name, status: 'NOT_RUN', message: 'Nenhum target de projeção configurado para o campo.' };
    const result = evaluateRule(value, rule.rule_type, rule.expression);
    return { rule: rule.name, status: result.status, message: result.message, target, actual: value };
  });
}

async function updateDemoControl(db, obligationId, result, timestamp) {
  await db.prepare(`UPDATE regulatory_controls SET last_execution = ?, result = ?, status = 'ACTIVE'
    WHERE obligation_id = ? AND is_demo = 1`).run(timestamp, result, obligationId);
}

function assignPath(object, path, value) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = object;
  for (let index = 0; index < parts.length; index += 1) {
    const key = parts[index];
    const arrayIndex = /^\d+$/.test(key) ? Number(key) : null;
    const nextIsArray = /^\d+$/.test(parts[index + 1] || '');
    if (index === parts.length - 1) {
      if (arrayIndex !== null) current[arrayIndex] = value;
      else current[key] = value;
      continue;
    }
    if (arrayIndex !== null) {
      if (!Array.isArray(current)) throw new Error(`Path ${path} cannot assign numeric segment here.`);
      current[arrayIndex] ||= nextIsArray ? [] : {};
      current = current[arrayIndex];
    } else {
      current[key] ||= nextIsArray ? [] : {};
      current = current[key];
    }
  }
}

function checkXmlEnvelope(content) {
  if (!content) return { status: 'FAIL', message: 'Artifact file is not available.' };
  const text = content.toString('utf8');
  const hasDeclaration = /^<\?xml\s+version=["']1\.0["']/.test(text);
  const rootStart = /<documento\b/.test(text);
  const rootEnd = /<\/documento>\s*$/.test(text);
  const balanced = (text.match(/<conta\b/g) || []).length === (text.match(/<\/conta>|<conta\b[^>]*\/>/g) || []).length;
  const ok = hasDeclaration && rootStart && rootEnd && balanced;
  return { status: ok ? 'PASS' : 'FAIL', message: ok ? 'XML de demonstração possui declaração, raiz e tags de conta balanceadas; verificação estrutural leve, não um parser/XSD BCB.' : 'A estrutura XML leve do artefato não passou.' };
}

async function safeReadArtifact(relativePath, storage) {
  try {
    const artifact = await readArtifact(storage, relativePath);
    return artifact?.body || null;
  } catch { return null; }
}

function extensionFor(adapter) {
  return ({ XML:'xml', CSV:'csv', JSON:'json', FIXED_WIDTH:'txt', PIPE_DELIMITED:'txt' })[String(adapter).toUpperCase()] || 'txt';
}

function safeFilename(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'submission';
}

function uniqueRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.dataset_id}:${row.row_key}`;
    if (!grouped.has(key)) {
      const { regulatory_field_id, target, transformation, ...source } = row;
      grouped.set(key,{...source,projections:[]});
    }
    grouped.get(key).projections.push({regulatory_field_id:row.regulatory_field_id,target:row.target,transformation:row.transformation});
  }
  return [...grouped.values()];
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
