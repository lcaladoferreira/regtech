/**
 * DEVELOPMENT / TEST FIXTURES ONLY.
 *
 * This module seeds explicitly synthetic demo content (internal systems, mappings, fixtures)
 * and curated regulatory excerpts with their provenance notes. It is NEVER executed in
 * production: production databases start empty and are populated exclusively by real
 * official-source ingestion (src/engines/ingestion.js) and operator-confirmed records.
 * `seedAllowed()` is the single gate; `openDatabase()` enforces it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { calculateImpacts, scoreObligationFootprint } from './engines/impact-engine.js';

export const DEMO_FIXTURES = 'DEMO_FIXTURES';

export function seedAllowed(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
  if (production) return false;
  return env.LCF_ALLOW_SEED !== 'false';
}

const isoNow = () => new Date().toISOString();
const stableInsert = async (db, table, row) => {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map((key) => row[key] === undefined ? null : row[key]);
  await db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`).run(...values);
};

const sources = [
  {
    id: 'src-bcb-3040-page', regulator_id: 'bcb', regulation_id: 'reg-cmn-5037',
    source_url: 'https://www.bcb.gov.br/estabilidadefinanceira/scrdoc3040',
    source_title: 'Documento 3040 e Documento 3026 — Leiaute, instruções e validador', source_authority: 'Banco Central do Brasil', source_type: 'SYSTEM_PAGE',
    version: 'Página oficial consultada em 2026-10-02', mime_type: 'text/html',
    excerpt: 'A página oficial do BCB disponibiliza o Leiaute do documento 3040 (XLS), instruções de preenchimento (PDF), manuais e aplicativo validador. A descrição oficial informa que o leiaute contém campos e domínios do documento 3040 — Dados de Risco de Crédito.',
  },
  {
    id: 'src-bcb-3040-layout', regulator_id: 'bcb', regulation_id: 'reg-cmn-5037',
    source_url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/Leiaute_de_documentos/scrdoc3040/SCR3040_Leiaute.xls',
    source_title: 'Leiaute do documento 3040 — Dados Individualizados de Risco de Crédito', source_authority: 'Banco Central do Brasil', source_type: 'LAYOUT',
    version: 'Versão publicada na página oficial (sem versão explícita no trecho extraído)', mime_type: 'application/vnd.ms-excel',
    excerpt: 'No leiaute oficial do documento 3040, a linha “Código do cliente” descreve o atributo Cd como identificação do cliente (CPF, CNPJ de 8 dígitos ou outro código); “Tipo do cliente” (Tp) é A1; “IPOC” é A67; e “Contrt” é o código interno identificador do contrato. O cabeçalho identifica Doc3040 e inclui DtBase e CNPJ.',
  },
  {
    id: 'src-bcb-3040-manual', regulator_id: 'bcb', regulation_id: 'reg-cmn-5037',
    source_url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/Leiaute_de_documentos/scrdoc3040/SCR_InstrucoesDePreenchimento_Doc3040.pdf',
    source_title: 'SCR — Documento 3040 — Instruções de Preenchimento', source_authority: 'Banco Central do Brasil', source_type: 'MANUAL',
    version: 'Documento oficial consultado em 2026-10-02', mime_type: 'application/pdf',
    excerpt: 'O documento 3040 é de caráter individual e deve ser remetido mensalmente para cada instituição financeira. O leiaute e as instruções vinculam as operações de crédito ao art. 3º da Resolução CMN nº 5.037, de 29 de setembro de 2022.',
  },
  {
    id: 'src-bcb-3040-deadlines', regulator_id: 'bcb', regulation_id: 'reg-cmn-5037',
    source_url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/supervisao/Prazos_Nao_contabeis_Cosif.pdf',
    source_title: 'Cosif — Prazos de entrega dos documentos não contábeis (calendário 2026)', source_authority: 'Banco Central do Brasil', source_type: 'DEADLINE',
    version: 'Calendário oficial 2026', mime_type: 'application/pdf',
    excerpt: 'Na tabela oficial de 2026 para SCR (doc. 3040), o calendário lista, entre outras, as datas 14/10/2026, 13/11/2026, 11/12/2026 e 14/01/2027. As datas são preservadas como calendário publicado; o sistema não as recalcula como prazo regulatório genérico.',
  },
  {
    id: 'src-bcb-4111-manual', regulator_id: 'bcb', regulation_id: 'reg-bcb-208',
    source_url: 'https://www.bcb.gov.br/content/estabilidadefinanceira/Documents/Leiaute_de_documentos/saldosDiariosInstrucoesPreenchimentoV2.pdf',
    source_title: 'Saldos Contábeis Diários — Documento 4111 — Instruções de Preenchimento', source_authority: 'Banco Central do Brasil', source_type: 'MANUAL',
    publication_date: null, version: 'Instruções vigentes a partir da data-base 2025-01-02; revisão listada em 2026-05-07', mime_type: 'application/pdf',
    excerpt: 'O Documento 4111 destina-se à remessa diária de saldos contábeis. O prazo de envio é o 3º dia útil subsequente à data-base; o arquivo é XML e é transmitido pelo STA com o código ACOS111. Na revisão de 07/05/2026, o histórico registra ajuste do campo CNPJ para formato alfanumérico; a descrição vigente define CNPJ obrigatório com 8 caracteres alfanuméricos.',
  },
  {
    id: 'src-cvm-res80', regulator_id: 'cvm', regulation_id: 'reg-cvm-80',
    source_url: 'https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/resolucoes/anexos/001/resol080consolid.pdf',
    source_title: 'Resolução CVM nº 80, de 29 de março de 2022 — texto consolidado', source_authority: 'Comissão de Valores Mobiliários', source_type: 'RESOLUTION',
    publication_date: '2022-03-29', version: 'Texto consolidado indicado pela CVM; alterações listadas até 2025', mime_type: 'application/pdf',
    excerpt: 'Art. 24: o emissor atualiza o formulário cadastral em até 7 dias úteis da alteração e confirma anualmente a validade até 31 de maio. Art. 25: o Formulário de Referência atualizado é entregue anualmente em até 5 meses do encerramento do exercício social. Art. 22 prevê envio por sistema eletrônico da CVM.',
  },
  {
    id: 'src-susep-responsaveis', regulator_id: 'susep', regulation_id: 'reg-susep-648',
    source_url: 'https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/areas-responsaveis-pelos-dados',
    source_title: 'Áreas Responsáveis pelos Dados — SUSEP', source_authority: 'Superintendência de Seguros Privados', source_type: 'SYSTEM_PAGE',
    publication_date: null, version: 'Página oficial modificada em 2022-09-14', mime_type: 'text/html',
    excerpt: 'A tabela oficial informa: FIP em .MDB, envio mensal por sistema próprio FIPSUSEP, para seguradoras, EAPP, capitalização, resseguradoras locais/admitidas e corretoras de resseguro, sob Circular SUSEP nº 648. FIP Estatístico é .TXT, mensal, enviado pelo FIPSUSEP, com a população indicada na tabela.',
  },
  {
    id: 'src-susep-manual', regulator_id: 'susep', regulation_id: 'reg-susep-627',
    source_url: 'https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/arquivos/manual_orientacao_envio_dados_Mar2026.pdf/@@display-file/file',
    source_title: 'Manual de Orientação para Envio de Dados — SUSEP', source_authority: 'Superintendência de Seguros Privados', source_type: 'MANUAL',
    version: '02/2026 — revisão 27/03/2026', mime_type: 'application/pdf',
    excerpt: 'O manual 02/2026 determina que as sociedades seguradoras enviem anualmente, até 31 de março, os arquivos R_COMP.DBF e S_COMP.DBF com dados de seguros compreensivos. Os arquivos são DBF compactados em ZIP. A tabela R_COMP.DBF lista 18 colunas, incluindo COD_SEG, PROCESSO, APOLICE, INICIO_VIG, FIM_VIG, IMP_SEG e PREMIO.',
  },
  {
    id: 'src-susep-openinsurance', regulator_id: 'susep', regulation_id: 'reg-susep-openinsurance',
    source_url: 'https://www.gov.br/susep/pt-br/assuntos/open-insurance/arquivos/copy_of_Manual_de_Escopo_de_Dados_e_Servicos_v6.7.pdf/@@display-file/file',
    source_title: 'Manual de Escopo de Dados e Serviços do Open Insurance', source_authority: 'Superintendência de Seguros Privados', source_type: 'MANUAL',
    publication_date: '2024-08-19', version: '6.7', mime_type: 'application/pdf',
    excerpt: 'O manual de escopo versão 6.7 (19/08/2024) detalha campos de dados e serviços do Open Insurance e declara que o compartilhamento segue escopo mínimo normativo. O histórico da versão 6.7 registra inclusão de coberturas em tabelas de domínio para automóvel (Tabela 51) e transportes (Tabela 59).',
  },
  {
    id: 'src-anpd-cis', regulator_id: 'anpd', regulation_id: 'reg-anpd-15',
    source_url: 'https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis',
    source_title: 'Comunicação de Incidente de Segurança — ANPD', source_authority: 'Autoridade Nacional de Proteção de Dados', source_type: 'SYSTEM_PAGE',
    publication_date: null, version: 'Página oficial consultada em 2026-10-02', mime_type: 'text/html',
    excerpt: 'A página da ANPD informa que o incidente deve ser confirmado, envolver dados pessoais sujeitos à LGPD e poder acarretar risco ou dano relevante. A comunicação à ANPD e aos titulares deve ocorrer em três dias úteis, ressalvada legislação específica. O envio é por peticionamento eletrônico no SEI!ANPD.',
  },
  {
    id: 'src-anpd-res15', regulator_id: 'anpd', regulation_id: 'reg-anpd-15',
    source_url: 'https://www.in.gov.br/en/web/dou/-/resolucao-cd/anpd-n-15-de-24-de-abril-de-2024-556243024',
    source_title: 'Resolução CD/ANPD nº 15, de 24 de abril de 2024 — DOU', source_authority: 'Autoridade Nacional de Proteção de Dados / Diário Oficial da União', source_type: 'RESOLUTION',
    publication_date: '2024-04-24', version: '15/2024', mime_type: 'text/html',
    excerpt: 'Referência normativa utilizada pela própria página da ANPD para os prazos dos arts. 6º e 9º do Regulamento de Comunicação de Incidente de Segurança.',
  },
  {
    id: 'src-coaf-faq', regulator_id: 'coaf', regulation_id: 'reg-law-9613',
    source_url: 'https://www.gov.br/coaf/pt-br/acesso-a-informacao/perguntas-frequentes-3',
    source_title: 'Perguntas Frequentes — COAF', source_authority: 'Conselho de Controle de Atividades Financeiras', source_type: 'FAQ',
    publication_date: null, version: 'Página oficial modificada em 2026-09-23', mime_type: 'text/html',
    excerpt: 'O COAF informa que os arts. 10 e 11 da Lei nº 9.613/1998 abrangem identificar clientes, manter registros e comunicar operações. O prazo mínimo para guarda de documentos é de cinco anos. O Siscoaf permite habilitação e envio de comunicações de operações e de não ocorrência; pessoas supervisionadas por outros órgãos observam o regulador próprio.',
  },
  {
    id: 'src-coaf-law', regulator_id: 'coaf', regulation_id: 'reg-law-9613',
    source_url: 'https://www.planalto.gov.br/ccivil_03/leis/l9613.htm',
    source_title: 'Lei nº 9.613, de 3 de março de 1998 — texto oficial', source_authority: 'Presidência da República — Planalto', source_type: 'LAW',
    publication_date: '1998-03-03', version: 'Texto oficial; recorte não capturado', mime_type: 'text/html', status: 'DISCOVERED', excerpt: null,
  },
  {
    id: 'src-rfb-decripto', regulator_id: 'rfb', regulation_id: 'reg-rfb-2291',
    source_url: 'https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/manual-orientacao-leiaute-criptoativos/manual-de-orientacao-do-leiaute-da-decripto-v1.pdf',
    source_title: 'Manual de Orientação do Leiaute da DeCripto', source_authority: 'Receita Federal do Brasil', source_type: 'LAYOUT',
    version: '1.01 (Ago/2026)', mime_type: 'application/pdf',
    excerpt: 'O manual declara que a IN RFB nº 2.291/2025 instituiu a DeCripto com vigência a partir de 01/07/2026 em substituição à sistemática da IN RFB nº 1.888/2019. O arquivo deve ser texto UTF-8, com campos delimitados por pipe. A versão 1.01, de agosto de 2026, acrescentou instruções para arquivos volumosos e corrigiu exemplo do registro 0850. O registro 0110 descreve operação de compra e venda e contém OperacaoData, OperacaoValor, CriptoativoSimbolo e identificação de comprador/vendedor.',
  },
];

const obligations = [
  {
    id: 'obl-bcb-scr-3040', regulation_id: 'reg-cmn-5037', regulator_id: 'bcb', code: 'BCB-SCR-3040',
    title: 'Dados de Risco de Crédito — Documento 3040',
    description: 'Remeter ao SCR informações sobre operações de crédito, com dados individualizados e agregados conforme instruções vigentes do documento 3040.',
    affected_entities: 'Instituições financeiras e demais entidades sujeitas ao envio de informações ao SCR; aplicabilidade depende da norma e do enquadramento.',
    sector: 'Financial Services', category: 'Regulatory Reporting', frequency: 'MONTHLY',
    deadline_rule: 'Calendário oficial BCB 2026 para doc. 3040; referência mensal. Para a data-base 2026-09, vencimento publicado em 2026-10-14.',
    submission_method: 'Arquivo XML pelo canal vigente do SCR/BCB', submission_system: 'SCR / página oficial do Documento 3040', output_format: 'XML', status: 'ACTIVE', criticality: 'HIGH', owner: 'Regulatory Reporting',
  },
  {
    id: 'obl-bcb-4111', regulation_id: 'reg-bcb-208', regulator_id: 'bcb', code: 'BCB-4111',
    title: 'Saldos Contábeis Diários — Documento 4111',
    description: 'Enviar diariamente os saldos contábeis das contas indicadas para as entidades e segmentos prudenciais especificados nas instruções oficiais.',
    affected_entities: 'Entidades descritas nas instruções do BCB, inclusive determinados segmentos prudenciais e categorias de instituições de pagamento.',
    sector: 'Financial Services', category: 'Financial Reporting', frequency: 'DAILY',
    deadline_rule: 'Até o 3º dia útil subsequente à data-base; arquivo XML via STA. Regra e população devem ser avaliadas contra a versão vigente das instruções.',
    effective_date: '2025-01-02', submission_method: 'XML pelo Sistema de Transferência de Arquivos (STA), código ACOS111', submission_system: 'STA / Cosif', output_format: 'XML', status: 'ACTIVE', criticality: 'HIGH', owner: 'Finance Data',
  },
  {
    id: 'obl-cvm-fre', regulation_id: 'reg-cvm-80', regulator_id: 'cvm', code: 'CVM-RC80-FRE',
    title: 'Formulário de Referência anual',
    description: 'Emissor de valores mobiliários deve entregar anualmente o Formulário de Referência atualizado, cujo conteúdo reflete o Anexo C da Resolução CVM 80.',
    affected_entities: 'Emissores registrados na CVM, observado o escopo e as exceções da Resolução CVM nº 80.',
    sector: 'Capital Markets', category: 'Regulatory Reporting', frequency: 'ANNUAL',
    deadline_rule: 'Até 5 meses contados do encerramento do exercício social; datas concretas dependem do exercício de cada emissor.',
    submission_method: 'Sistema eletrônico da CVM', submission_system: 'Sistema eletrônico CVM (nome específico não inferido)', output_format: 'Electronic form', status: 'ACTIVE', criticality: 'HIGH', owner: 'CVM Reporting',
  },
  {
    id: 'obl-cvm-cadastral', regulation_id: 'reg-cvm-80', regulator_id: 'cvm', code: 'CVM-RC80-CADASTRO',
    title: 'Atualização do Formulário Cadastral',
    description: 'Atualizar os dados do formulário cadastral quando houver alteração e confirmar anualmente a sua validade.',
    affected_entities: 'Emissores sujeitos à Resolução CVM nº 80.',
    sector: 'Capital Markets', category: 'Governance', frequency: 'EVENT_DRIVEN',
    deadline_rule: 'Até 7 dias úteis contados do fato que causou alteração; confirmação anual até 31 de maio.',
    submission_method: 'Sistema eletrônico da CVM', submission_system: 'Sistema eletrônico CVM (nome específico não inferido)', output_format: 'Electronic form', status: 'ACTIVE', criticality: 'HIGH', owner: 'Corporate Governance',
  },
  {
    id: 'obl-susep-fip', regulation_id: 'reg-susep-648', regulator_id: 'susep', code: 'SUSEP-FIP-MENSAL',
    title: 'Formulário de Informações Periódicas (FIP)',
    description: 'Transmitir mensalmente arquivos .MDB com quadros de informações cadastrais e contábeis pelo sistema próprio da SUSEP.',
    affected_entities: 'Seguradoras, EAPP, sociedades de capitalização, resseguradoras locais/admitidas e corretoras de resseguro, conforme tabela oficial.',
    sector: 'Insurance', category: 'Financial Reporting', frequency: 'MONTHLY',
    deadline_rule: 'Periodicidade mensal confirmada. Dia-limite específico não consta no recorte oficial armazenado; NOT AVAILABLE.',
    submission_method: 'Transmissão em sistema próprio FIPSUSEP', submission_system: 'FIPSUSEP', output_format: 'MDB', status: 'ACTIVE', criticality: 'HIGH', owner: 'SUSEP Reporting',
  },
  {
    id: 'obl-susep-rcomp', regulation_id: 'reg-susep-627', regulator_id: 'susep', code: 'SUSEP-RCOMP-ANUAL',
    title: 'Dados de Seguros Compreensivos — R_COMP.DBF',
    description: 'Enviar os dados estatísticos anuais das apólices/endossos de seguros compreensivos nos arquivos R_COMP.DBF e S_COMP.DBF.',
    affected_entities: 'Sociedades seguradoras que tenham operado no ramo no ano anterior, conforme quadro oficial da SUSEP.',
    sector: 'Insurance', category: 'Regulatory Reporting', frequency: 'ANNUAL',
    deadline_rule: 'Até 31 de março de cada ano, conforme Manual de Orientação para Envio de Dados versão 02/2026.',
    submission_method: 'Arquivos DBF compactados em ZIP pelo Sistema de Envio de Arquivos', submission_system: 'Sistema de Envio de Arquivos SUSEP', output_format: 'DBF/ZIP', status: 'ACTIVE', criticality: 'HIGH', owner: 'Insurance Reporting',
  },
  {
    id: 'obl-susep-open-insurance', regulation_id: 'reg-susep-openinsurance', regulator_id: 'susep', code: 'SUSEP-OPEN-INSURANCE-SHARING',
    title: 'Compartilhamento de dados padronizados — Open Insurance',
    description: 'Compartilhar dados e serviços cobertos no Open Insurance com base nos campos e escopo mínimo descritos no manual oficial, observadas as regras de consentimento e aplicabilidade.',
    affected_entities: 'Sociedades participantes definidas na regulamentação vigente; os escopos e fases dependem dos normativos e guias técnicos aplicáveis.',
    sector: 'Insurance', category: 'API', frequency: 'ON_DEMAND',
    deadline_rule: 'Escopo técnico disponível no Manual 6.7; cronograma/fase e prazo individual não são inferidos neste recorte.',
    submission_method: 'Compartilhamento por APIs do Open Insurance', submission_system: 'Open Insurance APIs (endpoints/versões técnicas não capturados)', output_format: 'JSON / REST API', status: 'ACTIVE', criticality: 'HIGH', owner: 'Open Insurance Data',
  },
  {
    id: 'obl-anpd-cis', regulation_id: 'reg-anpd-15', regulator_id: 'anpd', code: 'ANPD-CIS-INCIDENTE',
    title: 'Comunicação de incidente de segurança com dados pessoais',
    description: 'Controlador comunica à ANPD e aos titulares incidente confirmado que envolva dados pessoais e possa acarretar risco ou dano relevante.',
    affected_entities: 'Controladores sujeitos à LGPD; comunicação ao titular também é prevista para os casos cobertos pelo regulamento.',
    sector: 'Cross-sector / Privacy', category: 'Incident Reporting', frequency: 'EVENT_DRIVEN',
    deadline_rule: '3 dias úteis, ressalvada legislação específica; contagem vinculada ao conhecimento do incidente pelo controlador.',
    effective_date: null, submission_method: 'Peticionamento eletrônico', submission_system: 'SEI!ANPD', output_format: 'Electronic form', status: 'ACTIVE', criticality: 'CRITICAL', owner: 'Privacy & Security',
  },
  {
    id: 'obl-coaf-records', regulation_id: 'reg-law-9613', regulator_id: 'coaf', code: 'COAF-9613-IDENTIFICACAO-REGISTROS',
    title: 'Identificação de clientes e manutenção de registros',
    description: 'Pessoas obrigadas no escopo do art. 9º devem manter os registros e documentos pertinentes à prevenção à lavagem de dinheiro, conforme Lei e regulação setorial.',
    affected_entities: 'Pessoas obrigadas enquadradas no art. 9º da Lei nº 9.613/1998, observada a regulamentação de cada segmento.',
    sector: 'Cross-sector / AML', category: 'AML', frequency: 'CONTINUOUS',
    deadline_rule: 'Prazo mínimo de guarda de documentos indicado pelo COAF: 5 anos; podem existir prazos adicionais do regulador setorial.',
    submission_method: 'Manutenção de registros e evidências internas', submission_system: 'N/A', output_format: 'UNSTRUCTURED', status: 'ACTIVE', criticality: 'HIGH', owner: 'Financial Crime Compliance',
  },
  {
    id: 'obl-coaf-comms', regulation_id: 'reg-law-9613', regulator_id: 'coaf', code: 'COAF-9613-COMUNICACOES',
    title: 'Comunicações de operações e de não ocorrência via Siscoaf',
    description: 'Pessoas obrigadas devem avaliar e realizar comunicações previstas nos arts. 10 e 11 da Lei nº 9.613, observando o regulador/fiscalizador próprio e a habilitação no Siscoaf quando aplicável.',
    affected_entities: 'Pessoas obrigadas conforme art. 9º da Lei nº 9.613/1998; condições dependem do segmento e do órgão regulador/fiscalizador.',
    sector: 'Cross-sector / AML', category: 'AML', frequency: 'EVENT_DRIVEN',
    deadline_rule: 'Prazo e condições variam por regulamentação do segmento; UNKNOWN para esta obrigação genérica. Não usar prazo de outro setor.',
    submission_method: 'Comunicação por sistema habilitado', submission_system: 'Siscoaf quando aplicável', output_format: 'UNKNOWN', status: 'ACTIVE', criticality: 'HIGH', owner: 'Financial Crime Compliance',
  },
  {
    id: 'obl-rfb-decripto', regulation_id: 'reg-rfb-2291', regulator_id: 'rfb', code: 'RFB-DECRIPTO-2026',
    title: 'Declaração de operações com criptoativos — DeCripto',
    description: 'Prestar informações de operações com criptoativos declaráveis segundo a IN RFB nº 2.291/2025 e o leiaute oficial DeCripto; escopo do declarante depende da hipótese normativa aplicável.',
    affected_entities: 'Prestadores de serviço de criptoativo e demais pessoas físicas/jurídicas nos casos definidos pela IN RFB nº 2.291/2025; verificar enquadramento.',
    sector: 'Digital Assets / Tax', category: 'Regulatory Reporting', frequency: 'UNKNOWN',
    deadline_rule: 'A vigência do novo modelo inicia em 2026-07-01. Periodicidade/prazo não foram consolidados neste recorte; UNKNOWN.',
    effective_date: '2026-07-01', submission_method: 'Arquivo texto UTF-8 delimitado por pipe', submission_system: 'Coleta Nacional (conforme manual)', output_format: 'PIPE_DELIMITED', status: 'ACTIVE', criticality: 'HIGH', owner: 'Tax Data Reporting',
  },
];

const documents = [
  { id: 'doc-bcb-3040', obligation_id: 'obl-bcb-scr-3040', code: '3040', name: 'Documento 3040 — Dados de Risco de Crédito', description: 'Documento estruturado de remessa ao SCR; leiaute oficial em XLS e instruções oficiais.', document_type: 'REPORT', frequency: 'MONTHLY', output_format: 'XML', status: 'ACTIVE', source_id: 'src-bcb-3040-layout' },
  { id: 'doc-bcb-4111', obligation_id: 'obl-bcb-4111', code: '4111', name: 'Documento 4111 — Saldos Contábeis Diários', description: 'Documento XML com cabeçalho e linhas de contas/saldos.', document_type: 'REPORT', frequency: 'DAILY', output_format: 'XML', status: 'ACTIVE', source_id: 'src-bcb-4111-manual', adapter: 'XML' },
  { id: 'doc-cvm-fre', obligation_id: 'obl-cvm-fre', code: 'FRE', name: 'Formulário de Referência', description: 'Documento eletrônico cujo conteúdo reflete o Anexo C da Resolução CVM 80; schema técnico independente não catalogado neste recorte.', document_type: 'FORM', frequency: 'ANNUAL', output_format: 'Electronic form', status: 'ACTIVE', source_id: 'src-cvm-res80' },
  { id: 'doc-cvm-cad', obligation_id: 'obl-cvm-cadastral', code: 'FORM-CADASTRAL', name: 'Formulário Cadastral', description: 'Documento eletrônico cujo conteúdo reflete o Anexo B da Resolução CVM 80.', document_type: 'FORM', frequency: 'EVENT_DRIVEN', output_format: 'Electronic form', status: 'ACTIVE', source_id: 'src-cvm-res80' },
  { id: 'doc-susep-fip', obligation_id: 'obl-susep-fip', code: 'FIP', name: 'Formulário de Informações Periódicas', description: 'Coleção de quadros em arquivo .MDB transmitidos pelo FIPSUSEP.', document_type: 'REPORT', frequency: 'MONTHLY', output_format: 'MDB', status: 'ACTIVE', source_id: 'src-susep-responsaveis' },
  { id: 'doc-susep-rcomp', obligation_id: 'obl-susep-rcomp', code: 'R_COMP', name: 'Dados de Seguros Compreensivos — arquivo R_COMP.DBF', description: 'Arquivo de dados de apólices/endossos com 18 colunas catalogadas a partir do manual 02/2026.', document_type: 'LAYOUT', frequency: 'ANNUAL', output_format: 'DBF/ZIP', status: 'ACTIVE', source_id: 'src-susep-manual' },
  { id: 'doc-susep-openinsurance', obligation_id: 'obl-susep-open-insurance', code: 'OPEN-INSURANCE-SCOPE', name: 'Escopo de dados e serviços do Open Insurance', description: 'Manual 6.7 registra escopo e domínios funcionais de APIs; o schema técnico JSON/OpenAPI completo não está capturado.', document_type: 'DATA_CATALOG', frequency: 'ON_DEMAND', output_format: 'JSON / REST API', status: 'ACTIVE', source_id: 'src-susep-openinsurance' },
  { id: 'doc-anpd-cis', obligation_id: 'obl-anpd-cis', code: 'CIS', name: 'Comunicação de Incidente de Segurança', description: 'Processo e formulário eletrônico no SEI!ANPD; schema de payload não extraído nesta versão.', document_type: 'FORM', frequency: 'EVENT_DRIVEN', output_format: 'Electronic form', status: 'ACTIVE', source_id: 'src-anpd-cis' },
  { id: 'doc-coaf-records', obligation_id: 'obl-coaf-records', code: 'AML-RECORDS', name: 'Registros e documentos de PLD/FTP', description: 'Conjunto de registros internos sujeito a regras setoriais de retenção.', document_type: 'RECORD_SET', frequency: 'CONTINUOUS', output_format: 'UNSTRUCTURED', status: 'ACTIVE', source_id: 'src-coaf-faq' },
  { id: 'doc-coaf-siscoaf', obligation_id: 'obl-coaf-comms', code: 'SISCOAF-COMMUNICATION', name: 'Comunicações de operações ao Coaf', description: 'Comunicação eletrônica via Siscoaf; estrutura e prazos setoriais não inferidos.', document_type: 'SUBMISSION', frequency: 'EVENT_DRIVEN', output_format: 'UNKNOWN', status: 'ACTIVE', source_id: 'src-coaf-faq' },
  { id: 'doc-rfb-decripto', obligation_id: 'obl-rfb-decripto', code: 'DECRIPTO', name: 'Declaração de Criptoativos — DeCripto', description: 'Arquivo texto UTF-8 delimitado por pipe. O registro 0110 descreve operações de compra e venda.', document_type: 'LAYOUT', frequency: 'UNKNOWN', output_format: 'PIPE_DELIMITED', status: 'ACTIVE', source_id: 'src-rfb-decripto', adapter: 'PIPE_DELIMITED' },
];

const canonicalElements = [
  { id: 'canon-org-tax-id', qualified_name: 'canonical.organization.tax_id', domain: 'ORGANIZATION', description: 'Identificador fiscal da instituição/organização; normalização sujeita ao sistema e ao país.', data_type: 'STRING', classification: 'CONFIDENTIAL' },
  { id: 'canon-customer-tax-id', qualified_name: 'canonical.customer.tax_id', domain: 'CUSTOMER', description: 'CPF/CNPJ/NIF do cliente, com país e tipo de identificador preservados.', data_type: 'STRING', classification: 'PERSONAL' },
  { id: 'canon-credit-contract-id', qualified_name: 'canonical.contract.credit_id', domain: 'CONTRACT', description: 'Identificador interno do contrato de crédito.', data_type: 'STRING', classification: 'CONFIDENTIAL' },
  { id: 'canon-credit-operation-id', qualified_name: 'canonical.transaction.credit_operation_id', domain: 'TRANSACTION', description: 'Identificador padronizado da operação de crédito (IPOC) conforme a especificação correspondente.', data_type: 'STRING', classification: 'CONFIDENTIAL' },
  { id: 'canon-account-code', qualified_name: 'canonical.account.cosif_code', domain: 'ACCOUNT', description: 'Código de conta contábil COSIF no contexto do documento regulatório.', data_type: 'STRING', classification: 'INTERNAL' },
  { id: 'canon-balance', qualified_name: 'canonical.account.balance_amount', domain: 'ACCOUNT', description: 'Saldo contábil informado para uma conta e data-base.', data_type: 'DECIMAL', classification: 'CONFIDENTIAL' },
  { id: 'canon-reporting-date', qualified_name: 'canonical.reporting_period.date', domain: 'REPORTING_PERIOD', description: 'Data-base de referência de informação regulatória.', data_type: 'DATE', classification: 'INTERNAL' },
  { id: 'canon-policy-id', qualified_name: 'canonical.policy.policy_id', domain: 'POLICY', description: 'Identificador de apólice mantido no sistema interno.', data_type: 'STRING', classification: 'CONFIDENTIAL' },
  { id: 'canon-premium', qualified_name: 'canonical.policy.premium_amount', domain: 'POLICY', description: 'Prêmio total da apólice ou endosso, em reais, conforme mapeamento vigente.', data_type: 'DECIMAL', classification: 'CONFIDENTIAL' },
  { id: 'canon-crypto-symbol', qualified_name: 'canonical.asset.crypto_symbol', domain: 'ASSET', description: 'Símbolo do criptoativo informado na operação.', data_type: 'STRING', classification: 'INTERNAL' },
  { id: 'canon-transaction-amount', qualified_name: 'canonical.transaction.amount_brl', domain: 'TRANSACTION', description: 'Valor de transação em reais, preservando moeda, escala e regra de arredondamento.', data_type: 'DECIMAL', classification: 'CONFIDENTIAL' },
  { id: 'canon-transaction-date', qualified_name: 'canonical.transaction.event_date', domain: 'TRANSACTION', description: 'Data em que ocorreu a operação ou evento.', data_type: 'DATE', classification: 'INTERNAL' },
  { id: 'canon-country', qualified_name: 'canonical.organization.country_code', domain: 'ORGANIZATION', description: 'Código de país conforme domínio de referência aplicável.', data_type: 'STRING', classification: 'INTERNAL' },
];

const systems = [
  ['sys-core-banking', 'CORE_BANKING', 'Core banking', 'Lançamentos, contratos e operações de crédito de demonstração.', 'Core Data Team', 'CRITICAL'],
  ['sys-crm', 'CRM', 'CRM', 'Cadastro sintético de clientes e identificadores.', 'Customer Data Team', 'HIGH'],
  ['sys-risk', 'RISK', 'Risk platform', 'Eventos de risco e indicadores sintéticos.', 'Risk Analytics', 'HIGH'],
  ['sys-accounting', 'ACCOUNTING', 'Finance ledger', 'Saldos contábeis e códigos de conta sintéticos.', 'Finance Data', 'HIGH'],
  ['sys-legal', 'LEGAL', 'Legal repository', 'Documentos e metadados de referência sintéticos.', 'Legal Ops', 'MEDIUM'],
  ['sys-fraud', 'FRAUD', 'Fraud monitoring', 'Eventos sintéticos de fraude e AML.', 'Financial Crime', 'HIGH'],
  ['sys-insurance-core', 'INSURANCE_CORE', 'Insurance core', 'Apólices, endossos, sinistros e prêmios sintéticos.', 'Insurance Data', 'CRITICAL'],
  ['sys-investments', 'INVESTMENT_PLATFORM', 'Investment platform', 'Operações e saldos sintéticos de ativos digitais/investimentos.', 'Investment Data', 'HIGH'],
];

const datasets = [
  ['ds-core-contracts', 'sys-core-banking', 'credit_contracts', 'core', 'silver', 'Contratos de crédito sintéticos para referência de mapeamento.', 'Core Data Team'],
  ['ds-crm-customers', 'sys-crm', 'customers', 'crm', 'silver', 'Cadastro de clientes sintético; nenhum titular real.', 'Customer Data Team'],
  ['ds-accounting-daily', 'sys-accounting', 'daily_balances', 'accounting', 'silver', 'Saldos diários sintéticos no recorte mínimo do 4111.', 'Finance Data'],
  ['ds-insurance-policies', 'sys-insurance-core', 'policies', 'insurance', 'silver', 'Apólices sintéticas usadas como fixture de mapping.', 'Insurance Data'],
  ['ds-investment-crypto', 'sys-investments', 'crypto_transactions', 'investment', 'silver', 'Operações sintéticas para visualizar campos do manual DeCripto.', 'Investment Data'],
  ['ds-fraud-incidents', 'sys-fraud', 'security_incidents', 'fraud', 'silver', 'Incidentes sintéticos, sem dados pessoais reais.', 'Financial Crime'],
];

const dataFields = [
  ['df-core-contract-id', 'ds-core-contracts', 'contract_id', 'STRING', 'Identificador de contrato sintético.', 'CONFIDENTIAL', 'canon-credit-contract-id'],
  ['df-core-ipoc', 'ds-core-contracts', 'ipoc', 'STRING', 'Identificador de operação de crédito sintético.', 'CONFIDENTIAL', 'canon-credit-operation-id'],
  ['df-crm-tax-id', 'ds-crm-customers', 'tax_id', 'STRING', 'Identificador fiscal fictício para demo; não usar em produção.', 'PERSONAL', 'canon-customer-tax-id'],
  ['df-accounting-cnpj', 'ds-accounting-daily', 'institution_cnpj', 'STRING', 'Identificador institucional sintético de 8 caracteres (formato de demonstração).', 'CONFIDENTIAL', 'canon-org-tax-id'],
  ['df-accounting-cosif', 'ds-accounting-daily', 'cosif_code', 'STRING', 'Conta COSIF sintética em 10 posições.', 'INTERNAL', 'canon-account-code'],
  ['df-accounting-balance', 'ds-accounting-daily', 'balance', 'DECIMAL(16,2)', 'Saldo em reais sintético.', 'CONFIDENTIAL', 'canon-balance'],
  ['df-accounting-base-date', 'ds-accounting-daily', 'base_date', 'DATE', 'Data-base sintética.', 'INTERNAL', 'canon-reporting-date'],
  ['df-insurance-policy', 'ds-insurance-policies', 'policy_number', 'STRING', 'Número de apólice exclusivamente sintético.', 'CONFIDENTIAL', 'canon-policy-id'],
  ['df-insurance-premium', 'ds-insurance-policies', 'premium_amount', 'DECIMAL(16,2)', 'Prêmio sintético em reais.', 'CONFIDENTIAL', 'canon-premium'],
  ['df-insurance-process', 'ds-insurance-policies', 'susep_process', 'STRING', 'Número de processo fictício da fixture; sem validade regulatória.', 'INTERNAL', null],
  ['df-crypto-event-date', 'ds-investment-crypto', 'operation_date', 'DATE', 'Data de operação sintética, inspirada apenas no formato do manual.', 'INTERNAL', 'canon-transaction-date'],
  ['df-crypto-amount', 'ds-investment-crypto', 'operation_amount_brl', 'DECIMAL(15,2)', 'Valor em reais sintético.', 'CONFIDENTIAL', 'canon-transaction-amount'],
  ['df-crypto-symbol', 'ds-investment-crypto', 'crypto_symbol', 'STRING', 'Símbolo sintético de ativo.', 'INTERNAL', 'canon-crypto-symbol'],
  ['df-incident-date', 'ds-fraud-incidents', 'incident_date', 'DATE', 'Timestamp de incidente sintético.', 'CONFIDENTIAL', null],
  ['df-incident-category', 'ds-fraud-incidents', 'data_category', 'STRING', 'Categoria sintética de dados afetados.', 'CONFIDENTIAL', null],
];

const regulatoryFieldSeed = [];
const bcb4111SourceRef = 'Manual BCB Documento 4111, itens 4.1.2, 4.2.2 e 5; URL src-bcb-4111-manual.';
const bcb3040SourceRef = 'Leiaute BCB Documento 3040 (XLS), cabeçalho e campos Cli/Op; URL src-bcb-3040-layout.';
const susepSourceRef = 'Manual de Orientação para Envio de Dados SUSEP, versão 02/2026, seção 3.6 / Tabela 3-1; URL src-susep-manual.';
const rfbSourceRef = 'Manual de Orientação do Leiaute da DeCripto, versão 1.01, seções 4.2.0 e 4.2.1; URL src-rfb-decripto.';

function field(schemaId, id, name, path, description, dataType, sourceReference, opts = {}) {
  regulatoryFieldSeed.push({
    id, schema_version_id: schemaId, name, path, parent_path: opts.parent_path || null,
    description, data_type: dataType, required: opts.required ?? null,
    required_condition: opts.required_condition || null, min_occurs: opts.min_occurs ?? null,
    max_occurs: opts.max_occurs ?? null, length: opts.length ?? null, precision: opts.precision ?? null,
    scale: opts.scale ?? null, domain: opts.domain ? JSON.stringify(opts.domain) : null,
    pattern: opts.pattern || null, source_reference: sourceReference, status: opts.status || 'ACTIVE',
  });
}

function seedSchemas() {
  // Schema field examples are attached to exact paths and source references.
  field('schema-bcb-4111-v2026', 'fld-4111-code', 'codigoDocumento', 'documento/@codigoDocumento', 'Código do documento; valor fixo 4111.', 'STRING', bcb4111SourceRef, { required: 1, length: 4, domain: ['4111'] });
  field('schema-bcb-4111-v2026', 'fld-4111-cnpj', 'cnpj', 'documento/@cnpj', 'Identificação da instituição; a descrição vigente exige formato alfanumérico com 8 caracteres.', 'STRING', bcb4111SourceRef, { required: 1, length: 8, pattern: '^[A-Z0-9]{8}$' });
  field('schema-bcb-4111-v2026', 'fld-4111-date', 'dataBase', 'documento/@dataBase', 'Data-base em AAAA-MM-DD.', 'DATE', bcb4111SourceRef, { required: 1, length: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
  field('schema-bcb-4111-v2026', 'fld-4111-type', 'tipoRemessa', 'documento/@tipoRemessa', 'I para inclusão ou S para substituição de documento aceito.', 'STRING', bcb4111SourceRef, { required: 1, length: 1, domain: ['I', 'S'] });
  field('schema-bcb-4111-v2026', 'fld-4111-account', 'codigoConta', 'documento/contas/conta/@codigoConta', 'Código COSIF numérico com dez dígitos, sem pontuação.', 'STRING', bcb4111SourceRef, { required: 1, length: 10, pattern: '^\\d{10}$', min_occurs: 1, max_occurs: 'N' });
  field('schema-bcb-4111-v2026', 'fld-4111-balance', 'saldoDia', 'documento/contas/conta/@saldoDia', 'Saldo em reais ao final do dia; campo numérico com até 18 posições e duas casas decimais.', 'DECIMAL', bcb4111SourceRef, { required: 1, length: 18, precision: 18, scale: 2, min_occurs: 1, max_occurs: 'N' });

  field('schema-bcb-3040-current', 'fld-3040-dtbase', 'DtBase', 'Doc3040/@DtBase', 'Data-base no formato AAAA-MM.', 'STRING', bcb3040SourceRef, { required: 1, length: 7, pattern: '^\\d{4}-\\d{2}$' });
  field('schema-bcb-3040-current', 'fld-3040-cnpj', 'CNPJ', 'Doc3040/@CNPJ', 'CNPJ da instituição com 8 dígitos, conforme trecho do leiaute consultado.', 'STRING', bcb3040SourceRef, { required: 1, length: 8 });
  field('schema-bcb-3040-current', 'fld-3040-totalcli', 'TotalCli', 'Doc3040/@TotalCli', 'Número total de clientes, individualizados ou não.', 'INTEGER', bcb3040SourceRef, { required: 1 });
  field('schema-bcb-3040-current', 'fld-3040-cd', 'Cd', 'Doc3040/Cli/@Cd', 'Identificação do cliente: CPF, CNPJ de 8 dígitos ou outro código permitido.', 'STRING', bcb3040SourceRef, { required: 1, length: 14 });
  field('schema-bcb-3040-current', 'fld-3040-tp', 'Tp', 'Doc3040/Cli/@Tp', 'Tipo de cliente; formato A1 e domínio definido no Anexo 11.', 'STRING', bcb3040SourceRef, { required: 1, length: 1 });
  field('schema-bcb-3040-current', 'fld-3040-autorzc', 'Autorzc', 'Doc3040/Cli/@Autorzc', 'Autorização para consulta de informações do cliente no SCR; domínio definido no Anexo 20.', 'STRING', bcb3040SourceRef, { required: 1, length: 1 });
  field('schema-bcb-3040-current', 'fld-3040-porte', 'PorteCli', 'Doc3040/Cli/@PorteCli', 'Porte do cliente; depende da classificação PF/PJ e dos anexos citados no leiaute.', 'STRING', bcb3040SourceRef, { required: 1, length: 1 });
  field('schema-bcb-3040-current', 'fld-3040-tpctrl', 'TpCtrl', 'Doc3040/Cli/@TpCtrl', 'Tipo de controle; obrigatório apenas para pessoa jurídica conforme o leiaute.', 'STRING', bcb3040SourceRef, { required: 0, required_condition: 'Obrigatório apenas para PJ', length: 1 });
  field('schema-bcb-3040-current', 'fld-3040-ini-rel', 'IniRelactCli', 'Doc3040/Cli/@IniRelactCli', 'Data de início do relacionamento no formato AAAA-MM-DD.', 'DATE', bcb3040SourceRef, { required: 1, length: 10 });
  field('schema-bcb-3040-current', 'fld-3040-fat', 'FatAnual', 'Doc3040/Cli/@FatAnual', 'Faturamento anual de PJ ou renda mensal de PF; tipo indicado como N19,2.', 'DECIMAL', bcb3040SourceRef, { required: null, required_condition: 'Aplicabilidade por tipo de cliente e cronograma oficial', length: 19, precision: 19, scale: 2 });
  field('schema-bcb-3040-current', 'fld-3040-classcli', 'ClassCli', 'Doc3040/Cli/@ClassCli', 'Classificação de risco do cliente; o leiaute consultado marca descontinuação a partir da data-base janeiro/2025.', 'STRING', bcb3040SourceRef, { required: 0, length: 2, status: 'DEPRECATED' });
  field('schema-bcb-3040-current', 'fld-3040-ipoc', 'IPOC', 'Doc3040/Cli/Op/@IPOC', 'Identificação padronizada da operação de crédito; formato A67.', 'STRING', bcb3040SourceRef, { required: 1, length: 67 });
  field('schema-bcb-3040-current', 'fld-3040-contract', 'Contrt', 'Doc3040/Cli/Op/@Contrt', 'Código interno identificador do contrato; formato A40.', 'STRING', bcb3040SourceRef, { required: 1, length: 40 });
  field('schema-bcb-3040-current', 'fld-3040-mod', 'Mod', 'Doc3040/Cli/Op/@Mod', 'Código identificador da modalidade da operação; domínio do Anexo 3.', 'STRING', bcb3040SourceRef, { required: 1, length: 4 });

  const rcompFields = [
    ['COD_SEG','1','Código da Seguradora — FIP. Exemplo do manual: 08001.','STRING',5,null,null],
    ['PROCESSO','2','Número do processo referente ao plano.','STRING',20,null,null],
    ['TIPO','3','Tipo de seguro conforme Tabela 3-3.','INTEGER',1,null,null],
    ['CLASSE','4','Classe conforme Tabela 3-3.','INTEGER',2,null,null],
    ['APOLICE','5','Número da apólice; alinhado à direita e preenchido com zeros à esquerda.','STRING',20,null,null],
    ['ENDOSSO','6','Número do endosso; alinhado à direita e preenchido com zeros à esquerda.','STRING',10,null,null],
    ['COD_END','7','Código de endosso conforme Tabela 3-4; zero no registro de apólice.','INTEGER',1,null,null],
    ['ITEM','8','Identificador do risco em apólice coletiva; seis caracteres.','STRING',6,null,null],
    ['COBERTURA','9','Código da cobertura conforme Tabela 3-5.','INTEGER',4,null,null],
    ['UF','10','Código da Unidade Federativa do local do risco.','STRING',2,null,null],
    ['INICIO_VIG','11','Início de vigência no formato AAAAMMDD.','STRING',8,null,null],
    ['FIM_VIG','12','Término de vigência no formato AAAAMMDD.','STRING',8,null,null],
    ['TIPO_FRANQ','13','Tipo de franquia conforme Tabela 3-6.','STRING',1,null,null],
    ['VAL_FRANQ','14','Valor da franquia; tipo numérico com nove posições.','DECIMAL',9,9,0],
    ['IMP_SEG','15','Importância segurada contratada; tipo numérico com onze posições.','DECIMAL',11,11,0],
    ['PREMIO','16','Prêmio total da apólice/endosso para a cobertura; tipo numérico com nove posições.','DECIMAL',9,9,0],
    ['CORRETAGEM','17','Valor total da comissão de corretagem.','DECIMAL',7,7,0],
    ['PERC_DESC','18','Percentual total de desconto; tipo numérico com cinco posições e duas casas.','DECIMAL',5,5,2],
  ];
  for (const [name, number, description, dataType, length, precision, scale] of rcompFields) {
    field('schema-susep-rcomp-2026', `fld-rcomp-${name.toLowerCase()}`, name, `R_COMP.DBF.${name}`, description, dataType, susepSourceRef, { length, precision, scale, required: null, parent_path: 'R_COMP.DBF' });
  }

  const decriptoFields = [
    ['0000.tipo','Tipo de Registro','0000.Tipo de Registro','Identificador fixo de registro 0000.','STRING',4,1,'0000'],
    ['0000.cnpj','CNPJ','0000.CNPJ','CNPJ da Exchange.','STRING',14,1,null],
    ['0000.exchange-name','ExchangeNome','0000.ExchangeNome','Nome da Exchange.','STRING',80,1,null],
    ['0000.exchange-url','ExchangeURL','0000.ExchangeURL','URL da Exchange.','STRING',80,1,null],
    ['0110.tipo','Tipo de Registro','0110.Tipo de Registro','Identificador fixo do registro 0110.','STRING',4,1,'0110'],
    ['0110.operation-date','OperacaoData','0110.OperacaoData','Data da operação no formato DDMMAAAA.','DATE',8,1,null],
    ['0110.operation-id','OperacaoID','0110.OperacaoID','Código único da operação na Exchange.','STRING',1024,0,null],
    ['0110.operation-code','OperacaoCodigo','0110.OperacaoCodigo','Código da operação conforme tabela.','STRING',4,1,null],
    ['0110.operation-value','OperacaoValor','0110.OperacaoValor','Valor da operação em reais, excluídas as taxas; duas casas decimais.','DECIMAL',15,1,null],
    ['0110.fee-value','OperacaoTaxasValor','0110.OperacaoTaxasValor','Valor das taxas em reais.','DECIMAL',10,0,null],
    ['0110.crypto-symbol','CriptoativoSimbolo','0110.CriptoativoSimbolo','Símbolo do criptoativo.','STRING',10,1,null],
    ['0110.crypto-quantity','CriptoativoQuantidade','0110.CriptoativoQuantidade','Quantidade de criptoativos; dez casas decimais.','DECIMAL',26,1,null],
    ['0110.buyer-type-ni','CompradorTipoNI','0110.CompradorTipoNI','Tipo de identificação do comprador conforme tabela TipoNI.','STRING',2,1,null],
    ['0110.buyer-country','CompradorPais','0110.CompradorPais','Código do país de domicílio fiscal do comprador.','STRING',2,1,null],
    ['0110.buyer-tax-id','CompradorCPFCNPJ','0110.CompradorCPFCNPJ','CPF/CNPJ do comprador, se brasileiro.','STRING',14,null,null],
    ['0110.buyer-ni','CompradorNI','0110.CompradorNI','Número de identificação do comprador, se estrangeiro.','STRING',30,null,null],
    ['0110.buyer-name','CompradorNome','0110.CompradorNome','Nome completo do comprador.','STRING',80,1,null],
    ['0110.buyer-address','CompradorEndereco','0110.CompradorEndereco','Endereço do comprador, se estrangeiro; condicional conforme o manual.','STRING',120,null,null],
    ['0110.seller-type-ni','VendedorTipoNI','0110.VendedorTipoNI','Tipo de identificação do vendedor conforme tabela TipoNI.','STRING',2,1,null],
    ['0110.seller-country','VendedorPais','0110.VendedorPais','Código do país de domicílio fiscal do vendedor.','STRING',2,1,null],
    ['0110.seller-tax-id','VendedorCPFCNPJ','0110.VendedorCPFCNPJ','CPF/CNPJ do vendedor, se brasileiro.','STRING',14,null,null],
    ['0110.seller-ni','VendedorNI','0110.VendedorNI','Número de identificação do vendedor, se estrangeiro.','STRING',30,null,null],
    ['0110.seller-name','VendedorNome','0110.VendedorNome','Nome completo do vendedor.','STRING',80,1,null],
    ['0110.seller-address','VendedorEndereco','0110.VendedorEndereco','Endereço do vendedor, se estrangeiro; condicional conforme o manual.','STRING',120,null,null],
  ];
  for (const [idSuffix, name, path, description, dataType, length, required, domainValue] of decriptoFields) {
    field('schema-rfb-decripto-101', `fld-decripto-${idSuffix.replaceAll('.', '-')}`, name, path, description, dataType, rfbSourceRef, {
      length, required, domain: domainValue ? [domainValue] : undefined, parent_path: path.split('.')[0],
      required_condition: required === null ? 'Condicional conforme a identificação nacional/estrangeira e regras do manual' : null,
    });
  }
}

export async function seedDatabase(db) {
  if (!seedAllowed()) return { seeded: false, reason: 'SEED_BLOCKED_IN_PRODUCTION', notice: 'Synthetic development fixtures are never seeded into production; production data comes only from official-source ingestion.' };
  const alreadySeeded = await db.prepare("SELECT value FROM system_settings WHERE key = 'seed_version'").get();
  if (alreadySeeded) return { seeded: false, reason: 'seed_version exists' };

  try {
    const regulatorsSeed = [
      ['bcb','Banco Central do Brasil','BCB','Brazil','Financial Services','https://www.bcb.gov.br'],
      ['cvm','Comissão de Valores Mobiliários','CVM','Brazil','Capital Markets','https://www.gov.br/cvm'],
      ['susep','Superintendência de Seguros Privados','SUSEP','Brazil','Insurance and Open Insurance','https://www.gov.br/susep'],
      ['anpd','Autoridade Nacional de Proteção de Dados','ANPD','Brazil','Privacy and Data Protection','https://www.gov.br/anpd'],
      ['coaf','Conselho de Controle de Atividades Financeiras','COAF','Brazil','AML / Financial Intelligence','https://www.gov.br/coaf'],
      ['rfb','Receita Federal do Brasil','RFB','Brazil','Tax / Digital Assets','https://www.gov.br/receitafederal'],
    ];
    for (const [id,name,acronym,jurisdiction,sector,website] of regulatorsSeed) await stableInsert(db, 'regulators', { id,name,acronym,jurisdiction,sector,website,active:1 });

    const regulationsSeed = [
      ['reg-cmn-5037','bcb','RESOLUTION','CMN 5.037/2022','Resolução CMN nº 5.037, de 29 de setembro de 2022','O manual oficial do Documento 3040 referencia o art. 3º desta Resolução para a definição das operações de crédito.','2022-09-29',null,'ACTIVE','https://www.bcb.gov.br/estabilidadefinanceira/scrdoc3040','src-bcb-3040-manual'],
      ['reg-bcb-208','bcb','RESOLUTION','BCB 208/2022','Resolução BCB nº 208, de 22 de março de 2022','A instrução oficial do Documento 4111 referencia esta Resolução como base normativa.','2022-03-22',null,'ACTIVE','https://www.bcb.gov.br/content/estabilidadefinanceira/Documents/Leiaute_de_documentos/saldosDiariosInstrucoesPreenchimentoV2.pdf','src-bcb-4111-manual'],
      ['reg-cvm-80','cvm','RESOLUTION','CVM 80/2022','Resolução CVM nº 80, de 29 de março de 2022','Dispõe sobre registro e prestação de informações periódicas e eventuais por emissores de valores mobiliários admitidos à negociação em mercados regulamentados.','2022-03-29',null,'ACTIVE','https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/resolucoes/anexos/001/resol080consolid.pdf','src-cvm-res80'],
      ['reg-susep-648','susep','CIRCULAR','SUSEP 648','Circular SUSEP nº 648','Normativo indicado pela tabela oficial de dados da SUSEP como referência para FIP e FIP Estatístico.',null,null,'ACTIVE','https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/areas-responsaveis-pelos-dados','src-susep-responsaveis'],
      ['reg-susep-627','susep','CIRCULAR','SUSEP 627','Circular SUSEP nº 627','Normativo indicado pela tabela oficial da SUSEP para envio de determinados arquivos de dados.',null,null,'ACTIVE','https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/areas-responsaveis-pelos-dados','src-susep-manual'],
      ['reg-susep-openinsurance','susep','CIRCULAR','SUSEP 635/2021','Circular SUSEP nº 635, de 2021','Referenciada pelo Manual de Escopo de Dados e Serviços do Open Insurance versão 6.7.',null,null,'ACTIVE','https://www.gov.br/susep/pt-br/assuntos/open-insurance/arquivos/copy_of_Manual_de_Escopo_de_Dados_e_Servicos_v6.7.pdf/@@display-file/file','src-susep-openinsurance'],
      ['reg-anpd-15','anpd','RESOLUTION','CD/ANPD 15/2024','Resolução CD/ANPD nº 15, de 24 de abril de 2024','Aprova o Regulamento de Comunicação de Incidente de Segurança com Dados Pessoais.', '2024-04-24',null,'ACTIVE','https://www.in.gov.br/en/web/dou/-/resolucao-cd/anpd-n-15-de-24-de-abril-de-2024-556243024','src-anpd-res15'],
      ['reg-law-9613','coaf','LAW','Lei 9.613/1998','Lei nº 9.613, de 3 de março de 1998','A página oficial do COAF remete aos arts. 9º, 10 e 11 como base das obrigações das pessoas obrigadas.','1998-03-03',null,'ACTIVE','https://www.planalto.gov.br/ccivil_03/leis/l9613.htm','src-coaf-law'],
      ['reg-rfb-2291','rfb','INSTRUCTION','IN RFB 2.291/2025','Instrução Normativa RFB nº 2.291, de 14 de novembro de 2025','Institui novo modelo de captação de informações de criptoativos mediante a DeCripto; o manual oficial informa vigência a partir de 1º de julho de 2026.', '2025-11-14','2026-07-01','ACTIVE','https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/manual-orientacao-leiaute-criptoativos/manual-de-orientacao-do-leiaute-da-decripto-v1.pdf','src-rfb-decripto'],
    ];
    for (const [id,regulator_id,type,number,title,description,publication_date,effective_date,status,source_url,sourceId] of regulationsSeed) {
      const source = sources.find((row) => row.id === sourceId);
      await stableInsert(db, 'regulations', {
        id, regulator_id,type,number,title,description,publication_date,effective_date,status,source_url,
        content_hash: source?.excerpt ? hash(source.excerpt) : null,
        content_hash_scope: source?.excerpt ? 'CURATED_EXCERPT_SHA256' : null,
        source_excerpt: source?.excerpt || null, is_demo: 0,
      });
    }

    const collectedAt = isoNow();
    for (const source of sources) {
      const excerptHash = source.excerpt ? hash(source.excerpt) : null;
      await stableInsert(db, 'regulatory_sources', {
        id: source.id, regulator_id: source.regulator_id, regulation_id: source.regulation_id,
        source_url: source.source_url, source_title: source.source_title, source_authority: source.source_authority,
        source_type: source.source_type, content_hash: excerptHash,
        content_hash_scope: excerptHash ? 'CURATED_EXCERPT_SHA256' : null,
        publication_date: source.publication_date || null, effective_date: source.effective_date || null,
        collected_at: null, excerpt_verified_at: excerptHash ? collectedAt : null, version: source.version || null,
        mime_type: source.mime_type || null, status: source.status || (excerptHash ? 'EXCERPT_VERIFIED' : 'DISCOVERED'),
        excerpt: source.excerpt || null,
      });
    }
    const sourceLinks = [
      ['src-bcb-3040-page','OBLIGATION','obl-bcb-scr-3040','SOURCE_DISCOVERY'], ['src-bcb-3040-layout','OBLIGATION','obl-bcb-scr-3040','LAYOUT'], ['src-bcb-3040-manual','OBLIGATION','obl-bcb-scr-3040','REQUIREMENT'], ['src-bcb-3040-deadlines','OBLIGATION','obl-bcb-scr-3040','DEADLINE'],
      ['src-bcb-4111-manual','OBLIGATION','obl-bcb-4111','REQUIREMENT'], ['src-bcb-4111-manual','OBLIGATION','obl-bcb-4111','LAYOUT'], ['src-bcb-3040-page','REGULATION','reg-cmn-5037','SOURCE_DISCOVERY'],
      ['src-cvm-res80','OBLIGATION','obl-cvm-fre','REQUIREMENT'], ['src-cvm-res80','OBLIGATION','obl-cvm-cadastral','REQUIREMENT'],
      ['src-susep-responsaveis','OBLIGATION','obl-susep-fip','REQUIREMENT'], ['src-susep-manual','OBLIGATION','obl-susep-rcomp','LAYOUT'], ['src-susep-openinsurance','REGULATION','reg-susep-openinsurance','TECHNICAL_SCOPE'], ['src-susep-openinsurance','OBLIGATION','obl-susep-open-insurance','TECHNICAL_SCOPE'],
      ['src-anpd-cis','OBLIGATION','obl-anpd-cis','PROCEDURE'], ['src-anpd-res15','OBLIGATION','obl-anpd-cis','NORMATIVE_BASIS'],
      ['src-coaf-faq','OBLIGATION','obl-coaf-records','INTERPRETATION'], ['src-coaf-faq','OBLIGATION','obl-coaf-comms','SYSTEM_AND_SCOPE'],
      ['src-rfb-decripto','OBLIGATION','obl-rfb-decripto','LAYOUT'],
    ];
    for (const [source_id,entity_type,entity_id,relation] of sourceLinks) await stableInsert(db,'regulatory_source_links',{source_id,entity_type,entity_id,relation});

    for (const row of obligations) {
      const score = scoreObligationFootprint(row, { fields: row.id === 'obl-bcb-4111' ? 6 : row.id === 'obl-bcb-scr-3040' ? 14 : row.id === 'obl-susep-rcomp' ? 18 : row.id === 'obl-rfb-decripto' ? 24 : 0, mapped: row.id === 'obl-bcb-4111' ? 3 : row.id === 'obl-susep-rcomp' ? 3 : 0 });
      await stableInsert(db, 'regulatory_obligations', {
        ...row, impact_score: score.score, impact_level: score.level, impact_rationale: `Footprint heuristic (not legal severity): ${score.rationale}`,
        is_demo: 0, updated_at: collectedAt,
      });
    }

    const requirementsSeed = [
      ['req-3040-report','obl-bcb-scr-3040','REPORTING','Remeter mensalmente o Documento 3040 com informações de risco de crédito conforme leiaute e instruções oficiais.','src-bcb-3040-manual',null],
      ['req-3040-deadline','obl-bcb-scr-3040','DEADLINE','Aplicar o calendário de prazo oficial do BCB para o período de referência; não derivar datas sem a fonte/calendário correspondente.','src-bcb-3040-deadlines',null],
      ['req-4111-daily','obl-bcb-4111','REPORTING','Apurar e remeter diariamente os saldos contábeis cobertos para a população indicada nas instruções.','src-bcb-4111-manual','2025-01-02'],
      ['req-4111-xml','obl-bcb-4111','FORMAT','Gerar arquivo XML pelo STA usando o código ACOS111, conforme manual do documento.','src-bcb-4111-manual','2025-01-02'],
      ['req-cvm-fre','obl-cvm-fre','REPORTING','Entregar anualmente Formulário de Referência atualizado no sistema eletrônico da CVM.','src-cvm-res80',null],
      ['req-cvm-fre-deadline','obl-cvm-fre','DEADLINE','Calcular até cinco meses do encerramento do exercício social específico do emissor.','src-cvm-res80',null],
      ['req-cvm-cad-update','obl-cvm-cadastral','GOVERNANCE','Atualizar dados cadastrais até sete dias úteis depois de fato que os altere; confirmar anualmente até 31 de maio.','src-cvm-res80',null],
      ['req-susep-fip','obl-susep-fip','REPORTING','Transmitir FIP mensal em MDB por FIPSUSEP para os sujeitos listados na fonte oficial.','src-susep-responsaveis',null],
      ['req-susep-rcomp','obl-susep-rcomp','REPORTING','Enviar arquivos R_COMP.DBF e S_COMP.DBF até 31 de março, compactados em ZIP, conforme Manual 02/2026.','src-susep-manual',null],
      ['req-susep-openinsurance','obl-susep-open-insurance','TECHNICAL_SCOPE','Compartilhar dados e serviços aplicáveis por APIs padronizadas, observando o escopo mínimo e domínios definidos nos normativos e no Manual de Escopo v6.7; endpoints e schema técnico não estão catalogados.','src-susep-openinsurance',null],
      ['req-anpd-cis','obl-anpd-cis','INCIDENT_REPORTING','Comunicar incidente confirmado com dados pessoais e risco/dano relevante em três dias úteis, ressalvada regra específica.','src-anpd-cis',null],
      ['req-coaf-records','obl-coaf-records','RETENTION','Identificar clientes e manter registros; prazo mínimo de guarda informado pelo COAF: cinco anos, sem afastar prazos setoriais adicionais.','src-coaf-faq',null],
      ['req-coaf-comm','obl-coaf-comms','SUBMISSION','Avaliar e encaminhar comunicações pelo Siscoaf quando aplicável; validar prazo conforme regulamento do segmento.','src-coaf-faq',null],
      ['req-rfb-decripto','obl-rfb-decripto','FORMAT','Gerar arquivo texto UTF-8 delimitado por pipe conforme leiaute DeCripto; vigência inicial informada pelo manual: 01/07/2026.','src-rfb-decripto','2026-07-01'],
    ];
    for (const [id,obligation_id,requirement_type,description,source_id,effective_from] of requirementsSeed) {
      const source = sources.find((item) => item.id === source_id);
      await stableInsert(db,'requirements',{id,obligation_id,requirement_type,description,source_reference:source?.source_url || 'UNKNOWN',source_id,effective_from,effective_to:null,status:'ACTIVE',is_demo:0});
    }
    for (const document of documents) await stableInsert(db,'regulatory_documents',document);

    for (const element of canonicalElements) await stableInsert(db,'canonical_data_elements',{...element,is_demo:0});
    const schemaRows = [
      { id:'schema-bcb-4111-v2026', document_id:'doc-bcb-4111', version:'Manual rev. 2026-05-07', effective_from:'2025-01-02', schema_type:'XML', schema_url:sources.find((s)=>s.id==='src-bcb-4111-manual').source_url, content_hash:hash(sources.find((s)=>s.id==='src-bcb-4111-manual').excerpt), content_hash_scope:'CURATED_EXCERPT_SHA256', fields_count:6, field_inventory_scope:'FULL_MANUAL_FIELD_LIST (6 fields)', parse_status:'CURATED_EXTRACT', adapter_config_json:JSON.stringify({ kind:'XML', rootName:'documento', rootAttributes:{ codigoDocumento:{constant:'4111'}, cnpj:{path:'cnpj'}, dataBase:{path:'dataBase'}, tipoRemessa:{path:'tipoRemessa'} }, children:[{name:'contas',itemsPath:'accounts',itemName:'conta',itemAttributes:{codigoConta:{path:'codigoConta'},saldoDia:{path:'saldoDia'}}}], projection:[{regulatoryFieldId:'fld-4111-cnpj',target:'cnpj'},{regulatoryFieldId:'fld-4111-date',target:'dataBase'},{regulatoryFieldId:'fld-4111-type',target:'tipoRemessa',constant:'I'},{regulatoryFieldId:'fld-4111-account',target:'accounts.0.codigoConta'},{regulatoryFieldId:'fld-4111-balance',target:'accounts.0.saldoDia'}], requiredPaths:['cnpj','dataBase','tipoRemessa','accounts'], constraints:[{path:'cnpj',type:'string',length:8,required:true,regex:'^[A-Z0-9]{8}$'},{path:'dataBase',type:'string',length:10,required:true,regex:'^\\d{4}-\\d{2}-\\d{2}$'},{path:'tipoRemessa',type:'string',length:1,required:true,allowed:['I','S']},{path:'accounts.0.codigoConta',type:'string',length:10,required:true,regex:'^\\d{10}$'},{path:'accounts.0.saldoDia',type:'number',required:true}]}) },
      { id:'schema-bcb-3040-current', document_id:'doc-bcb-3040', version:'Unversioned source layout (current official page)', effective_from:null, schema_type:'XML/XLS_LAYOUT', schema_url:sources.find((s)=>s.id==='src-bcb-3040-layout').source_url, content_hash:hash(sources.find((s)=>s.id==='src-bcb-3040-layout').excerpt), content_hash_scope:'CURATED_EXCERPT_SHA256', fields_count:14, field_inventory_scope:'PARTIAL — 14 selected header/client/operation fields only', parse_status:'CURATED_EXTRACT', adapter_config_json:null },
      { id:'schema-susep-rcomp-2026', document_id:'doc-susep-rcomp', version:'Manual 02/2026 (seção 3.6)', effective_from:null, schema_type:'DBF_LAYOUT', schema_url:sources.find((s)=>s.id==='src-susep-manual').source_url, content_hash:hash(sources.find((s)=>s.id==='src-susep-manual').excerpt), content_hash_scope:'CURATED_EXCERPT_SHA256', fields_count:18, field_inventory_scope:'FULL R_COMP.DBF table 3-1 (18 fields)', parse_status:'CURATED_EXTRACT', adapter_config_json:null },
      { id:'schema-susep-openinsurance-67', document_id:'doc-susep-openinsurance', version:'6.7 (19/08/2024)', effective_from:null, schema_type:'MANUAL_SCOPE', schema_url:sources.find((s)=>s.id==='src-susep-openinsurance').source_url, content_hash:hash(sources.find((s)=>s.id==='src-susep-openinsurance').excerpt), content_hash_scope:'CURATED_EXCERPT_SHA256', fields_count:null, field_inventory_scope:'UNSTRUCTURED — manual de escopo; contrato JSON/OpenAPI e inventário de campos não capturados', parse_status:'UNSTRUCTURED', adapter_config_json:null },
      { id:'schema-rfb-decripto-101', document_id:'doc-rfb-decripto', version:'1.01 (Ago/2026)', effective_from:'2026-07-01', schema_type:'PIPE_DELIMITED_LAYOUT', schema_url:sources.find((s)=>s.id==='src-rfb-decripto').source_url, content_hash:hash(sources.find((s)=>s.id==='src-rfb-decripto').excerpt), content_hash_scope:'CURATED_EXCERPT_SHA256', fields_count:24, field_inventory_scope:'PARTIAL — registros 0000 e 0110 (24 campos; documento oficial completo possui outros registros)', parse_status:'CURATED_EXTRACT', adapter_config_json:null },
    ];
    for (const schema of schemaRows) await stableInsert(db,'schema_versions',{...schema,status:'CURRENT'});
    seedSchemas();
    for (const f of regulatoryFieldSeed) await stableInsert(db,'regulatory_fields',f);

    for (const [id,name,type,description,owner,criticality] of systems) await stableInsert(db,'internal_systems',{id,name,type,description,owner,criticality,is_demo:1});
    for (const [id,system_id,name,database_name,schema_name,description,owner] of datasets) await stableInsert(db,'datasets',{id,system_id,name,database_name,schema_name,description,owner,is_demo:1});
    for (const [id,dataset_id,name,data_type,description,classification,canonical_element_id] of dataFields) await stableInsert(db,'data_fields',{id,dataset_id,name,data_type,description,classification,canonical_element_id,is_demo:1});
    for (const row of dataFields) {
      const [data_field_id,,,,,,canonical_element_id] = row;
      if (!canonical_element_id) continue;
      await stableInsert(db,'canonical_mappings',{id:`canonical-map-${data_field_id}`,canonical_element_id,data_field_id,transformation:'IDENTITY',mapping_status:'VALIDATED',owner:'Demo Data Governance',version:1,is_demo:1,updated_at:collectedAt});
    }

    const demoRows = [
      ['demo-acct-valid','ds-accounting-daily','valid-4111-row',{institution_cnpj:'12AB34CD',cosif_code:'4110000001',balance:125000.45,base_date:'2026-10-02'},'happy_path'],
      ['demo-acct-invalid','ds-accounting-daily','negative-control-invalid-cnpj',{institution_cnpj:'12AB34CDX',cosif_code:'4110000001',balance:125000.45,base_date:'2026-10-02'},'deliberately_invalid_fixture'],
      ['demo-customer','ds-crm-customers','synthetic-customer',{tax_id:'12345678901'},'happy_path'],
      ['demo-credit','ds-core-contracts','synthetic-credit-contract',{contract_id:'DEMO-CREDIT-0001',ipoc:'11111111000000000000000000000000000000000000000000000000000000000'},'happy_path'],
      ['demo-policy','ds-insurance-policies','synthetic-policy',{policy_number:'DEMO-POLICY-00000001',premium_amount:1250.50,susep_process:'15414.000001/2026-01'},'happy_path'],
      ['demo-crypto','ds-investment-crypto','synthetic-crypto-operation',{operation_date:'2026-07-03',operation_amount_brl:100315.45,crypto_symbol:'BTC'},'illustrative_only'],
      ['demo-incident','ds-fraud-incidents','synthetic-incident',{incident_date:'2026-10-01T15:10:00Z',data_category:'CUSTOMER_IDENTIFIER'},'illustrative_only'],
    ];
    for (const [id,dataset_id,row_key,data,scenario] of demoRows) await stableInsert(db,'demo_data',{id,dataset_id,row_key,data_json:JSON.stringify(data),scenario,is_demo:1});

    const mappingSeed = [
      ['map-4111-cnpj','fld-4111-cnpj','df-accounting-cnpj','canon-org-tax-id','IDENTITY','MAPPED','Finance Data','',1],
      ['map-4111-account','fld-4111-account','df-accounting-cosif','canon-account-code','LEFT_PAD(10)','VALIDATED','Finance Data','account code must be 10 digits',1],
      ['map-4111-balance','fld-4111-balance','df-accounting-balance','canon-balance','DECIMAL(2)','VALIDATED','Finance Data','2 decimal places; sign follows COSIF nature',1],
      ['map-4111-date','fld-4111-date','df-accounting-base-date','canon-reporting-date','ISO_DATE','MAPPED','Finance Data','',1],
      ['map-3040-client-id','fld-3040-cd','df-crm-tax-id','canon-customer-tax-id','NORMALIZE_ID_BY_COUNTRY','REVIEW_REQUIRED','Customer Data Team','Must preserve identity type and scope; requires business review',1],
      ['map-3040-contract','fld-3040-contract','df-core-contract-id','canon-credit-contract-id','IDENTITY','MAPPED','Core Data Team','',1],
      ['map-3040-ipoc','fld-3040-ipoc','df-core-ipoc','canon-credit-operation-id','IPOC_COMPONENTS','REVIEW_REQUIRED','Core Data Team','Regulatory composition must be validated against current instructions',1],
      ['map-rcomp-policy','fld-rcomp-apolice','df-insurance-policy','canon-policy-id','PAD_LEFT_20','MAPPED','Insurance Data','Format according to manual; demo identifier only',1],
      ['map-rcomp-premium','fld-rcomp-premio','df-insurance-premium','canon-premium','DECIMAL(2)','MAPPED','Insurance Data','Rounding and source of premium require production sign-off',1],
      ['map-rcomp-process','fld-rcomp-processo','df-insurance-process',null,'IDENTITY','VALIDATED','Insurance Data','DEMO FIXTURE ONLY; the process id is fictitious',1],
      ['map-decripto-date','fld-decripto-0110-operation-date','df-crypto-event-date','canon-transaction-date','DDMMYYYY','MAPPED','Investment Data','',1],
      ['map-decripto-value','fld-decripto-0110-operation-value','df-crypto-amount','canon-transaction-amount','BRL_DECIMAL_2','REVIEW_REQUIRED','Investment Data','Confirm tax valuation policy and operation-specific requirements',1],
      ['map-decripto-symbol','fld-decripto-0110-crypto-symbol','df-crypto-symbol','canon-crypto-symbol','UPPERCASE','MAPPED','Investment Data','',1],
    ];
    for (const [id,regulatory_field_id,data_field_id,canonical_element_id,transformation,mapping_status,owner,business_rule,is_demo] of mappingSeed) {
      await stableInsert(db,'data_mappings',{id,regulatory_field_id,data_field_id,canonical_element_id,transformation,sql_expression:null,python_expression:null,business_rule, mapping_status,owner,approved_by:mapping_status==='VALIDATED'?'Demo Reviewer':null,version:1,is_demo,updated_at:collectedAt});
    }

    const pipelineSeed = [
      ['pipeline-regulatory-demo','regulatory-demo-reference','RAW → STANDARDIZED → CANONICAL → REGULATORY → VALIDATED → OUTPUT','Node.js / SQLite demo executor','Data Platform Demo','ACTIVE'],
      ['pipeline-rcomp-reference','susep-rcomp-reference','Insurance policy source → canonical policy/premium → R_COMP field mapping','Reference-only mapping; DBF writer not enabled','Insurance Data','REFERENCE_ONLY'],
    ];
    for (const [id,name,description,technology,owner,status] of pipelineSeed) await stableInsert(db,'pipelines',{id,name,description,technology,owner,status,is_demo:1});
    const dependencyPairs = [
      ['pipeline-regulatory-demo','map-4111-cnpj'],['pipeline-regulatory-demo','map-4111-account'],['pipeline-regulatory-demo','map-4111-balance'],['pipeline-regulatory-demo','map-4111-date'],
      ['pipeline-regulatory-demo','map-3040-client-id'],['pipeline-regulatory-demo','map-decripto-value'],['pipeline-rcomp-reference','map-rcomp-policy'],['pipeline-rcomp-reference','map-rcomp-premium'],
    ];
    for (const [pipeline_id, mapping_id] of dependencyPairs) await stableInsert(db,'pipeline_dependencies',{id:`dep-${dependencyPairs.findIndex((pair)=>pair[0]===pipeline_id&&pair[1]===mapping_id)+1}`,pipeline_id,mapping_id,dependency_type:'READS',is_demo:1});

    const dqSeed = [
      ['dq-4111-cnpj-not-null','fld-4111-cnpj','map-4111-cnpj','CNPJ institucional presente','NOT_NULL',null,'HIGH','CNPJ é obrigatório no cabeçalho do Documento 4111.',bcb4111SourceRef],
      ['dq-4111-cnpj-length','fld-4111-cnpj','map-4111-cnpj','CNPJ possui oito caracteres alfanuméricos','LENGTH',JSON.stringify({min:8,max:8}),'HIGH','O manual define campo obrigatório com oito caracteres alfanuméricos.',bcb4111SourceRef],
      ['dq-4111-account-pattern','fld-4111-account','map-4111-account','Conta COSIF contém dez dígitos','REGEX',JSON.stringify({pattern:'^\\d{10}$'}),'HIGH','O manual define dez dígitos sem pontuação.',bcb4111SourceRef],
      ['dq-4111-balance-type','fld-4111-balance','map-4111-balance','Saldo é numérico','TYPE',JSON.stringify({type:'number'}),'HIGH','O manual descreve campo numérico em reais com duas casas.',bcb4111SourceRef],
      ['dq-rcomp-policy-not-null','fld-rcomp-apolice','map-rcomp-policy','Número de apólice presente','NOT_NULL',null,'MEDIUM','Campo descrito no layout R_COMP; obrigatoriedade de cada quadro deve ser validada contra o manual completo.',susepSourceRef],
      ['dq-rcomp-policy-length','fld-rcomp-apolice','map-rcomp-policy','Apólice não excede vinte caracteres','LENGTH',JSON.stringify({min:1,max:20}),'MEDIUM','Comprimento máximo de 20 no campo APOLICE.',susepSourceRef],
      ['dq-rcomp-premium-nonnegative','fld-rcomp-premio','map-rcomp-premium','Prêmio não negativo (fixture de demonstração)','RANGE',JSON.stringify({min:0}),'MEDIUM','Regra interna de demonstração; não é transcrição de regra de domínio da SUSEP.',susepSourceRef],
      ['dq-decripto-value-range','fld-decripto-0110-operation-value','map-decripto-value','Valor da operação diferente de zero','RANGE',JSON.stringify({min:0.01}),'HIGH','O manual descreve OperacaoValor com valor diferente de zero.',rfbSourceRef],
    ];
    for (const [id,regulatory_field_id,mapping_id,name,rule_type,expression,severity,description,source] of dqSeed) await stableInsert(db,'dq_rules',{id,regulatory_field_id,mapping_id,name,rule_type,expression,severity,description,source,is_demo:1});

    const deadlineSeed = [
      ['deadline-bcb-4111-20261002','obl-bcb-4111','2026-10-02','2026-10-07','OFFICIAL','https://www.bcb.gov.br/content/estabilidadefinanceira/Documents/Leiaute_de_documentos/saldosDiariosInstrucoesPreenchimentoV2.pdf','UPCOMING','Finance Data','Data-base 2026-10-02 + 3º dia útil subsequente. Dias úteis 05, 06 e 07/10/2026; calendários locais não inferidos. Fonte do prazo: manual 4111.',0],
      ['deadline-bcb-3040-202609','obl-bcb-scr-3040','2026-09','2026-10-14','OFFICIAL','https://www.bcb.gov.br/content/estabilidadefinanceira/supervisao/Prazos_Nao_contabeis_Cosif.pdf','UPCOMING','Regulatory Reporting','Data-base 2026-09; vencimento 14/10/2026 reproduzido do calendário oficial BCB 2026.',0],
      ['deadline-susep-rcomp-2026','obl-susep-rcomp','2026','2027-03-31','OFFICIAL','https://www.gov.br/susep/pt-br/servicos/mercado/enviar-dados/arquivos/manual_orientacao_envio_dados_Mar2026.pdf/@@display-file/file','UPCOMING','Insurance Reporting','Ano de dados 2026; manual SUSEP 02/2026 informa entrega anual até 31 de março.',0],
    ];
    for (const [id,obligation_id,reference_period,due_date,deadline_type,source_url,status,owner,calculation_basis,is_demo] of deadlineSeed) await stableInsert(db,'regulatory_deadlines',{id,obligation_id,reference_period,due_date,deadline_type,source_url,status,owner,calculation_basis,is_demo});

    const controlSeed = [
      ['control-4111-cnpj','Validação de cabeçalho do Documento 4111','obl-bcb-4111','req-4111-xml','Finance Data','Per submission','SCHEMA + DQ','NOT_RUN','ACTIVE'],
      ['control-4111-reconciliation','Reconciliação do saldo diário antes da geração','obl-bcb-4111','req-4111-daily','Finance Data','Daily','PIPELINE + RECONCILIATION','NOT_RUN','ACTIVE'],
      ['control-3040-periodic','Monitorar completude mensal SCR','obl-bcb-scr-3040','req-3040-report','Regulatory Reporting','Monthly','DQ + submission receipt','NOT_RUN','ACTIVE'],
      ['control-anpd-cis','Registro e escalonamento de incidente','obl-anpd-cis','req-anpd-cis','Privacy & Security','Event-driven','Incident record + decision evidence','NOT_RUN','ACTIVE'],
      ['control-susep-rcomp','Checagem de campos do arquivo R_COMP','obl-susep-rcomp','req-susep-rcomp','Insurance Reporting','Annual','DQ + file validation','NOT_RUN','ACTIVE'],
    ];
    for (const [id,control_name,obligation_id,requirement_id,owner,frequency,evidence_type,result,status] of controlSeed) await stableInsert(db,'regulatory_controls',{id,control_name,obligation_id,requirement_id,owner,frequency,evidence_type,last_execution:null,result,status,is_demo:1});
    const evidenceSeed = [
      ['evidence-source-4111','obl-bcb-4111','control-4111-cnpj','OFFICIAL_SOURCE_EXCERPT','Manual oficial Documento 4111 — excerto com hash de texto','src-bcb-4111-manual','Available — SHA-256 do excerto, não do PDF original.'],
      ['evidence-demo-schema-4111','obl-bcb-4111','control-4111-cnpj','SCHEMA_METADATA','Campos catalogados para o schema 4111','schema-bcb-4111-v2026','DEMO CONFIGURATION; metadata derivada de excerto oficial.'],
      ['evidence-demo-data','obl-bcb-4111','control-4111-reconciliation','DEMO_DATA_FIXTURE','Linha sintética de saldo para teste do fluxo','demo-acct-valid','DEMO DATA; não representa instituição real nem submissão.'],
      ['evidence-source-anpd','obl-anpd-cis','control-anpd-cis','OFFICIAL_SOURCE_EXCERPT','Página oficial ANPD — excerto de critérios e prazo','src-anpd-cis','Available — SHA-256 do excerto, não do HTML original.'],
    ];
    for (const [id,obligation_id,control_id,evidence_type,title,sourceKey,status] of evidenceSeed) {
      const source = sources.find((s)=>s.id===sourceKey);
      const collected_at = collectedAt;
      const artifact_path = sourceKey.startsWith('src-') ? source?.source_url : null;
      const content_hash = source?.excerpt ? hash(source.excerpt) : null;
      await stableInsert(db,'evidence_items',{id,obligation_id,control_id,evidence_type,title,artifact_path,collected_at,source_reference:source?.source_url || sourceKey,content_hash,status,is_demo:1});
    }

    const changeRows = [
      {
        id:'change-bcb-4111-cnpj-2026', entity_type:'SCHEMA_VERSION', entity_id:'schema-bcb-4111-v2026',
        old_version:'instruções anteriores (arquivo anterior não capturado)', new_version:'revisão indicada em 2026-05-07', change_type:'TYPE_CHANGED', field:'Documento 4111 / documento/@cnpj',
        old_value:'NOT AVAILABLE — versão anterior não preservada nesta instalação', new_value:'CNPJ alfanumérico, 8 caracteres', detected_at:'2026-05-07T00:00:00.000Z', effective_at:null,
        source_reference:'Histórico de atualizações do Manual 4111, entrada 07/05/2026; o histórico descreve ajuste para formato alfanumérico. A versão anterior integral não está armazenada.',
        source_url:'https://www.bcb.gov.br/content/estabilidadefinanceira/Documents/Leiaute_de_documentos/saldosDiariosInstrucoesPreenchimentoV2.pdf',
        summary:'Atualização documentada do formato do campo CNPJ no cabeçalho do Documento 4111 para alfanumérico com oito caracteres. Valor anterior não reconstruído porque o snapshot antigo não foi capturado.', confidence:'OFFICIAL_CHANGE_LOG', review_status:'CONFIRMED',
      },
      {
        id:'change-susep-openinsurance-67', entity_type:'SCHEMA_VERSION', entity_id:'schema-susep-openinsurance-67',
        old_version:'6.6', new_version:'6.7', change_type:'ENUM_ADDED', field:'Anexo I.7 / Tabela 51 — tipos de coberturas de seguros do grupo automóvel',
        old_value:'Sem o item adicionado (histórico da versão 6.7)', new_value:'Responsabilidade Civil Veículos de Passeio — Acordos fora do Mercosul', detected_at:'2024-08-19T00:00:00.000Z', effective_at:null,
        source_reference:'Manual de Escopo de Dados e Serviços do Open Insurance v6.7, histórico de revisão de 19/08/2024.',
        source_url:'https://www.gov.br/susep/pt-br/assuntos/open-insurance/arquivos/copy_of_Manual_de_Escopo_de_Dados_e_Servicos_v6.7.pdf/@@display-file/file',
        summary:'O histórico oficial da versão 6.7 registra inclusão de cobertura na Tabela 51. O catálogo não infere schema JSON/OpenAPI além do valor explicitamente descrito.', confidence:'OFFICIAL_CHANGE_LOG', review_status:'CONFIRMED',
      },
      {
        id:'change-rfb-decripto-101', entity_type:'REGULATORY_DOCUMENT', entity_id:'doc-rfb-decripto',
        old_version:'1.0 (Fev/2026)', new_version:'1.01 (Ago/2026)', change_type:'DOCUMENTATION_CHANGED', field:'Manual DeCripto — volume de arquivos / registro 0850',
        old_value:'Versão 1.0', new_value:'Adicionadas instruções para arquivos de grande volume; exemplo do registro 0850 emendado.', detected_at:collectedAt, effective_at:null,
        source_reference:'Tabela “Versões do documento” do Manual de Orientação do Leiaute da DeCripto; versão 1.01, Ago/2026.',
        source_url:'https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/manual-orientacao-leiaute-criptoativos/manual-de-orientacao-do-leiaute-da-decripto-v1.pdf',
        summary:'Atualização do manual DeCripto v1.01 documenta particionamento de arquivos grandes e corrige exemplo; não se afirma alteração de campo sem diff integral das duas versões.', confidence:'OFFICIAL_CHANGE_LOG', review_status:'CONFIRMED',
      },
    ];
    for (const row of changeRows) {
      const impact = calculateImpacts(row.change_type,{field:row.field});
      await stableInsert(db,'regulatory_changes',{...row,severity:impact.level,is_demo:0});
      for (const item of impact.impacts) await stableInsert(db,'technical_impacts',{id:`impact-${row.id}-${item.impactType.toLowerCase()}`,regulatory_change_id:row.id,impact_type:item.impactType,severity:item.severity,score:item.score,description:item.description,recommended_action:item.recommendedAction,rationale:item.rationale});
    }

    const cases = [
      ['case-bcb-4111','CASE-001','BCB — saldos diários 4111: XML, schema e prazo','bcb','obl-bcb-4111','Trilha técnica genérica: instruções oficiais → campos registrados → mapeamentos sintéticos → geração XML de demonstração → validação interna.','REFERENCE_IMPLEMENTED','O schema catalogado contém 6 campos descritos no manual. A configuração produz somente artefato DEMO; não usa conexão BCB nem substitui o XSD/validador oficial.','src-bcb-4111-manual',0],
      ['case-cvm-fre','CASE-002','CVM — Formulário de Referência: obrigação e prazo condicionado','cvm','obl-cvm-fre','Conecta o artigo 25 da Resolução CVM 80 a requisito, prazo relativo ao exercício social e fonte oficial.','REFERENCE_STRUCTURED','O formulário é eletrônico; nenhum schema técnico de submissão é afirmado ou inventado.','src-cvm-res80',0],
      ['case-susep-rcomp','CASE-003','SUSEP — R_COMP.DBF: layout anual de seguros compreensivos','susep','obl-susep-rcomp','Catálogo parcial/full-table dos 18 campos da Tabela 3-1, regra de prazo anual e mapeamentos internos sintéticos.','REFERENCE_IMPLEMENTED','Formato oficial DBF/ZIP é registrado. Adaptador DBF não implementado; nenhum arquivo DBF é gerado.','src-susep-manual',0],
      ['case-susep-openinsurance','CASE-006','SUSEP — Open Insurance: escopo de dados e change log v6.7','susep','obl-susep-open-insurance','Registra o escopo de compartilhamento, versão do manual e alteração no domínio da Tabela 51, ligada ao impacto técnico sem inventar um contrato OpenAPI.','REFERENCE_STRUCTURED','Inventário de campos, cronograma completo e especificação técnica de endpoints não capturados. Schema técnico marcado UNSTRUCTURED; mudança de domínio confirmada pelo histórico do manual.','src-susep-openinsurance',0],
      ['case-anpd-cis','CASE-004','ANPD — Comunicação de incidente: obrigação event-driven','anpd','obl-anpd-cis','Cadeia de requisito, critérios de aplicabilidade, janela de três dias úteis e canal SEI!ANPD.','REFERENCE_STRUCTURED','Prazo apresentado com ressalva de legislação específica; sem incidente real ou dados pessoais no demo.','src-anpd-cis',0],
      ['case-rfb-decripto','CASE-005','RFB — DeCripto: leiaute pipe-delimited versão 1.01','rfb','obl-rfb-decripto','Schema registry parcial dos registros 0000 e 0110 e change log v1.0 → v1.01.','REFERENCE_STRUCTURED','24 campos catalogados em 2 registros de um manual mais amplo. Sem adapter de geração pronto para o arquivo completo.','src-rfb-decripto',0],
    ];
    for (const [id,code,title,regulator_id,obligation_id,scenario,status,implementation_notes,source_id,is_demo] of cases) await stableInsert(db,'regulatory_cases',{id,code,title,regulator_id,obligation_id,scenario,status,implementation_notes,source_id,is_demo});

    const seededSourceCount = (await db.prepare('SELECT COUNT(*) AS count FROM regulatory_sources').get()).count;
    await stableInsert(db,'job_runs',{id:'job-bootstrap-official-excerpts',job_name:'seed_official_source_excerpts',started_at:collectedAt,finished_at:collectedAt,status:'SUCCEEDED',records_processed:seededSourceCount,records_created:seededSourceCount,records_updated:0,errors:null,result_json:JSON.stringify({official_regulators:6,source_excerpt_hashes:'SHA-256 over curated excerpt text; not original remote payloads',raw_remote_snapshots:0,seeded_obligation_count:obligations.length})});
    await stableInsert(db,'system_settings',{key:'seed_version',value:'2026-10-02.1',updated_at:collectedAt});
    await stableInsert(db,'system_settings',{key:'official_raw_snapshot_count',value:'0',updated_at:collectedAt});

    return { seeded: true, regulators: 6, obligations: obligations.length, sources: seededSourceCount };
  } catch (error) {
    throw error;
  }
}

function hash(text) {
  return createHash('sha256').update(String(text),'utf8').digest('hex');
}
