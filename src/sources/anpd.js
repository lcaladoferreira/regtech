export const anpdAdapter = {
  authority: 'ANPD',
  name: 'anpd',
  regulatorId: 'anpd',
  sourceAuthority: 'Autoridade Nacional de Proteção de Dados',
  discoveryStrategy: 'OFFICIAL_ROOT_PLUS_INCIDENT_CHANNEL',
  notes: 'ANPD portal root and the security-incident communication channel referenced by the regulator.',
  sources: [
    { id: 'mon-anpd-root', url: 'https://www.gov.br/anpd/', title: 'ANPD — official portal (gov.br/ANPD)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 3 },
    { id: 'mon-anpd-cis', url: 'https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis', title: 'ANPD — Comunicado de Incidente de Segurança (CIS) channel', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 1 },
  ],
};
export default anpdAdapter;
