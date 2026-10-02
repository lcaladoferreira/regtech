export const coafAdapter = {
  authority: 'COAF',
  name: 'coaf',
  regulatorId: 'coaf',
  sourceAuthority: 'Conselho de Controle de Atividades Financeiras',
  discoveryStrategy: 'OFFICIAL_ROOT_PLUS_FAQ',
  notes: 'COAF portal root and the FAQ page that anchors record-keeping and communication guidance. Normative conclusions require review of the linked law.',
  sources: [
    { id: 'mon-coaf-root', url: 'https://www.gov.br/coaf/', title: 'COAF — official portal (gov.br/COAF)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 3 },
    { id: 'mon-coaf-faq', url: 'https://www.gov.br/coaf/pt-br/acesso-a-informacao/perguntas-frequentes-3', title: 'COAF — Perguntas Frequentes (obligations overview)', sourceType: 'FAQ', parser: 'html', priority: 2 },
  ],
};
export default coafAdapter;
