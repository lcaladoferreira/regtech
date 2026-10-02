export const rfbAdapter = {
  authority: 'RFB',
  name: 'rfb',
  regulatorId: 'rfb',
  sourceAuthority: 'Receita Federal do Brasil',
  discoveryStrategy: 'OFFICIAL_ROOT_PLUS_LAYOUT_MANUALS',
  notes: 'RFB portal root and the DeCripto layout manual currently published by the tax authority.',
  sources: [
    { id: 'mon-rfb-root', url: 'https://www.gov.br/receitafederal/', title: 'RFB — official portal (gov.br/ReceitaFederal)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 3 },
    { id: 'mon-rfb-decripto', url: 'https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/manual-orientacao-leiaute-criptoativos/manual-de-orientacao-do-leiaute-da-decripto-v1.pdf', title: 'RFB — Manual de Orientação do Leiaute da DeCripto (PDF)', sourceType: 'LAYOUT', parser: 'pdf', priority: 1 },
  ],
};
export default rfbAdapter;
