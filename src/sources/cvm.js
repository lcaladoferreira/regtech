export const cvmAdapter = {
  authority: 'CVM',
  name: 'cvm',
  regulatorId: 'cvm',
  sourceAuthority: 'Comissão de Valores Mobiliários',
  discoveryStrategy: 'OFFICIAL_ROOT_PLUS_CONSOLIDATED_NORMS',
  notes: 'CVM portal root and the consolidated Resolução CVM 80 PDF referenced by the regulator itself. Monitored for hash changes; obligation content requires human review.',
  sources: [
    { id: 'mon-cvm-root', url: 'https://www.gov.br/cvm/', title: 'CVM — official portal (gov.br/CVM)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 3 },
    { id: 'mon-cvm-res80', url: 'https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/resolucoes/anexos/001/resol080consolid.pdf', title: 'CVM — Resolução CVM 80 consolidated text (PDF)', sourceType: 'RESOLUTION', parser: 'pdf', priority: 1 },
  ],
};
export default cvmAdapter;
