export const susepAdapter = {
  authority: 'SUSEP',
  name: 'susep',
  regulatorId: 'susep',
  sourceAuthority: 'Superintendência de Seguros Privados',
  discoveryStrategy: 'OFFICIAL_ROOT_PLUS_DATA_SUBMISSION_DOCS',
  notes: 'SUSEP portal root, the official data-submission responsibility page and current submission manuals. Changes create review candidates only.',
  sources: [
    { id: 'mon-susep-root', url: 'https://www.gov.br/susep/', title: 'SUSEP — official portal (gov.br/SUSEP)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 3 },
    { id: 'mon-susep-areas-dados', url: 'https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/areas-responsaveis-pelos-dados', title: 'SUSEP — Áreas Responsáveis pelos Dados (submission responsibility catalog)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 1 },
    { id: 'mon-susep-manual-envio', url: 'https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/arquivos/manual_orientacao_envio_dados_Mar2026.pdf/@@display-file/file', title: 'SUSEP — Manual de Orientação para Envio de Dados (PDF)', sourceType: 'MANUAL', parser: 'pdf', priority: 1 },
    { id: 'mon-susep-openinsurance', url: 'https://www.gov.br/susep/pt-br/assuntos/open-insurance/arquivos/copy_of_Manual_de_Escopo_de_Dados_e_Servicos_v6.7.pdf/@@display-file/file', title: 'SUSEP — Open Insurance Manual de Escopo de Dados e Serviços v6.7 (PDF)', sourceType: 'MANUAL', parser: 'pdf', priority: 2 },
  ],
};
export default susepAdapter;
