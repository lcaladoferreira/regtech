export const douAdapter = {
  authority: 'DOU',
  name: 'dou',
  regulatorId: 'dou',
  sourceAuthority: 'Diário Oficial da União — Imprensa Nacional',
  discoveryStrategy: 'OFFICIAL_PORTAL_AND_SEARCH_PAGE',
  notes: 'DOU is the primary publication venue for federal normative acts (resolutions, INs, circulars, decrees). The search page and portal are monitored as discovery sources; individual publications become sources only when a confirmed need links them. The adapter does not assert that any mention is an obligation.',
  sources: [
    { id: 'mon-dou-root', url: 'https://www.in.gov.br/', title: 'DOU — Diário Oficial da União portal (Imprensa Nacional)', sourceType: 'SYSTEM_PAGE', parser: 'html', priority: 1 },
    { id: 'mon-dou-search-legislacao', url: 'https://www.in.gov.br/consulta/-/query?q=&types=54964&sortDateDesc=true', title: 'DOU — advanced search, legislative section', sourceType: 'DISCOVERY', parser: 'html', priority: 1 },
  ],
};
export default douAdapter;
