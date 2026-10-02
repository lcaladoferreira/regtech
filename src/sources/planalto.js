export const planaltoAdapter = {
  authority: 'PLANALTO',
  name: 'planalto',
  regulatorId: 'planalto',
  sourceAuthority: 'Presidência da República — Portal da Legislação',
  discoveryStrategy: 'CONSOLIDATED_LAW_PAGES',
  notes: 'Planalto hosts the consolidated official law texts. Changes to consolidated texts create review candidates only; they are never auto-published as regulatory changes.',
  sources: [
    { id: 'mon-planalto-root', url: 'https://www.planalto.gov.br/ccivil_03/', title: 'Planalto — Civil House legislation portal', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 3 },
    { id: 'mon-planalto-l9613', url: 'https://www.planalto.gov.br/ccivil_03/leis/l9613.htm', title: 'Lei nº 9.613/1998 (PLD/COAF law) — official text', sourceType: 'LAW', parser: 'html', priority: 2 },
    { id: 'mon-planalto-lgpd', url: 'https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm', title: 'Lei nº 13.709/2018 (LGPD) — official text', sourceType: 'LAW', parser: 'html', priority: 2 },
  ],
};
export default planaltoAdapter;
