/**
 * Source adapter registry. Each adapter declares, for one authority:
 *   authority, sourceName, sourceUrl, sourceType, parser, pollingFrequency, discoveryStrategy.
 * Institutional fetch logic lives here and nowhere else, so engines stay regulator-neutral.
 *
 * Adding an authority = new module + import below. Adapters may only declare HTTPS URLs on
 * official domains (validated again at fetch time by the ingestion allowlist).
 */
import { randomUUID } from 'node:crypto';
import { bcbAdapter } from './bcb.js';
import { cvmAdapter } from './cvm.js';
import { susepAdapter } from './susep.js';
import { anpdAdapter } from './anpd.js';
import { coafAdapter } from './coaf.js';
import { rfbAdapter } from './rfb.js';
import { douAdapter } from './dou.js';
import { planaltoAdapter } from './planalto.js';

export const ADAPTERS = Object.freeze([bcbAdapter, cvmAdapter, susepAdapter, anpdAdapter, coafAdapter, rfbAdapter, douAdapter, planaltoAdapter]);

export const OFFICIAL_REGULATORS = Object.freeze([
  { id: 'bcb', name: 'Banco Central do Brasil', acronym: 'BCB', sector: 'Financial Services', website: 'https://www.bcb.gov.br/' },
  { id: 'cvm', name: 'Comissão de Valores Mobiliários', acronym: 'CVM', sector: 'Capital Markets', website: 'https://www.gov.br/cvm/' },
  { id: 'susep', name: 'Superintendência de Seguros Privados', acronym: 'SUSEP', sector: 'Insurance', website: 'https://www.gov.br/susep/' },
  { id: 'anpd', name: 'Autoridade Nacional de Proteção de Dados', acronym: 'ANPD', sector: 'Data Protection', website: 'https://www.gov.br/anpd/' },
  { id: 'coaf', name: 'Conselho de Controle de Atividades Financeiras', acronym: 'COAF', sector: 'AML / CFT', website: 'https://www.gov.br/coaf/' },
  { id: 'rfb', name: 'Receita Federal do Brasil', acronym: 'RFB', sector: 'Tax', website: 'https://www.gov.br/receitafederal/' },
  { id: 'dou', name: 'Diário Oficial da União — Imprensa Nacional', acronym: 'DOU', sector: 'Official Gazette', website: 'https://www.in.gov.br/' },
  { id: 'planalto', name: 'Presidência da República — Portal da Legislação', acronym: 'PLANALTO', sector: 'Federal Legislation', website: 'https://www.planalto.gov.br/' },
]);

/** Minutes between polls: priority 1 = volatile/operational, 2 = documentation, 3 = portals. */
export function pollingFrequencyMinutes(priority) {
  if (priority === 1) return 180;
  if (priority === 2) return 720;
  return 1440;
}

/**
 * Ensures the official registry exists and keeps monitored sources in sync with adapter
 * declarations. Upserts only configuration fields; captured hashes/status/timestamps are
 * never reset. Idempotent and safe to call on every job run.
 */
export async function syncOfficialRegistry(db) {
  let regulators = 0;
  for (const regulator of OFFICIAL_REGULATORS) {
    await db.prepare(`INSERT INTO regulators (id, name, acronym, jurisdiction, sector, website, active)
      VALUES (?, ?, ?, 'Brazil', ?, ?, 1) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website`)
      .run(regulator.id, regulator.name, regulator.acronym, regulator.sector, regulator.website);
    regulators += 1;
  }
  let synced = 0;
  let created = 0;
  for (const adapter of ADAPTERS) {
    for (const declared of adapter.sources) {
      const existing = await db.prepare('SELECT id FROM regulatory_sources WHERE source_url = ? AND version = ?').get(declared.url, '');
      const values = [
        declared.id, adapter.regulatorId, declared.url, declared.title, adapter.sourceAuthority, declared.sourceType,
        adapter.authority, adapter.name, declared.parser ?? 'html',
        pollingFrequencyMinutes(declared.priority), adapter.discoveryStrategy, new Date().toISOString(),
      ];
      if (existing) {
        await db.prepare(`UPDATE regulatory_sources SET source_title = ?, source_authority = ?, source_type = ?, authority = ?,
            adapter = ?, parser = ?, polling_frequency_minutes = ?, discovery_strategy = ?, enabled = 1 WHERE id = ?`)
          .run(declared.title, adapter.sourceAuthority, declared.sourceType, adapter.authority, adapter.name,
            declared.parser ?? 'html', pollingFrequencyMinutes(declared.priority), adapter.discoveryStrategy, declared.id);
      } else {
        await db.prepare(`INSERT INTO regulatory_sources (id, regulator_id, source_url, source_title, source_authority, source_type,
            authority, adapter, parser, polling_frequency_minutes, discovery_strategy, version, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'MONITORED', ?) ON CONFLICT (source_url, version) DO NOTHING`)
          .run(...values);
        created += 1;
      }
      synced += 1;
    }
  }
  return { regulators, sources_synced: synced, sources_created: created, run_id: randomUUID().slice(0, 8) };
}
