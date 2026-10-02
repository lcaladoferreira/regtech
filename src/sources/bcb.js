export const bcbAdapter = {
  authority: 'BCB',
  name: 'bcb',
  regulatorId: 'bcb',
  sourceAuthority: 'Banco Central do Brasil',
  discoveryStrategy: 'CURATED_OFFICIAL_PAGES_AND_FILES',
  notes: 'Official SCR/Cosif documentation pages and published layout/manual files. Monitored for real content changes; no normative interpretation is performed by the adapter.',
  sources: [
    { id: 'mon-bcb-leiaute-page', url: 'https://www.bcb.gov.br/estabilidadefinanceira/leiautedocumentos', title: 'BCB — Leiaute de documentos (catálogo oficial)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 2 },
    { id: 'mon-bcb-scr3040-page', url: 'https://www.bcb.gov.br/estabilidadefinanceira/scrdoc3040', title: 'BCB — SCR Documento 3040 (leiaute, instruções, validador)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 1 },
    { id: 'mon-bcb-scr3040-layout', url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/Leiaute_de_documentos/scrdoc3040/SCR3040_Leiaute.xls', title: 'BCB — SCR3040_Leiaute.xls (layout, official file)', sourceType: 'LAYOUT', parser: 'xlsx', priority: 1 },
    { id: 'mon-bcb-scr3040-manual', url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/Leiaute_de_documentos/scrdoc3040/SCR_InstrucoesDePreenchimento_Doc3040.pdf', title: 'BCB — SCR Doc 3040 filling instructions (PDF)', sourceType: 'MANUAL', parser: 'pdf', priority: 1 },
    { id: 'mon-bcb-cosif-deadlines', url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/supervisao/Prazos_Nao_contabeis_Cosif.pdf', title: 'BCB — Cosif non-accounting submission deadline calendar (PDF)', sourceType: 'DEADLINE', parser: 'pdf', priority: 1 },
    { id: 'mon-bcb-4111-manual', url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/Documents/Leiaute_de_documentos/saldosDiariosInstrucoesPreenchimentoV2.pdf', title: 'BCB — Documento 4111 daily balances instructions (PDF)', sourceType: 'MANUAL', parser: 'pdf', priority: 1 },
  ],
};
export default bcbAdapter;
