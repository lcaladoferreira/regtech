export const IMPACT_RULES = Object.freeze({
  FIELD_ADDED: [
    ['DATA_MODEL', 3, 'Um novo elemento exige compatibilidade no modelo de dados.'],
    ['DATA_PIPELINE', 3, 'A cadeia de ingestão/transformação precisa produzir o novo elemento.'],
    ['SCHEMA', 3, 'O schema de saída deve incorporar o elemento.'],
    ['DATA_QUALITY', 2, 'A presença, o tipo e as regras do campo precisam de validação.'],
    ['REPORTING', 2, 'A projeção do documento regulatório pode precisar de atualização.'],
    ['SUBMISSION', 2, 'A geração e os testes da entrega podem precisar de atualização.'],
  ],
  NEW_REQUIRED_FIELD: [
    ['DATA_MODEL', 3, 'Um novo campo obrigatório requer representação no modelo.'],
    ['DATA_PIPELINE', 3, 'A pipeline precisa fornecer o valor antes da janela de entrega.'],
    ['SCHEMA', 3, 'O campo precisa constar no schema de saída.'],
    ['DATA_QUALITY', 2, 'A ausência deve bloquear a validação.'],
    ['REPORTING', 3, 'O relatório fica incompleto sem o novo dado.'],
    ['SUBMISSION', 3, 'A submissão não deve avançar sem o valor obrigatório.'],
  ],
  FIELD_REMOVED: [
    ['DATA_MODEL', 2, 'Revisar elementos internos que deixam de ser consumidos.'],
    ['DATA_PIPELINE', 2, 'Remover ou adaptar projeções e dependências.'],
    ['SCHEMA', 3, 'O campo deve sair da versão de destino.'],
    ['DATA_QUALITY', 1, 'Revisar regras que referenciam o campo removido.'],
    ['SUBMISSION', 2, 'Revisar serialização e testes de conformidade.'],
  ],
  FIELD_RENAMED: [
    ['DATA_MODEL', 2, 'Confirmar equivalência semântica antes de renomear.'],
    ['DATA_PIPELINE', 2, 'Atualizar seletores e projeções do campo.'],
    ['SCHEMA', 3, 'O identificador publicado foi alterado.'],
    ['DATA_QUALITY', 1, 'Atualizar referências nas regras.'],
  ],
  TYPE_CHANGED: [
    ['DATA_MODEL', 3, 'Validar precisão, representação e compatibilidade do tipo.'],
    ['DATA_PIPELINE', 3, 'Revisar casts, serializadores e transformações.'],
    ['SCHEMA', 3, 'Atualizar a definição de tipo e os validadores.'],
    ['DATA_QUALITY', 2, 'Revisar regras de tipo, comprimento e valores inválidos.'],
    ['REPORTING', 2, 'Conferir arredondamento e representação do dado enviado.'],
  ],
  LENGTH_CHANGED: [
    ['DATA_MODEL', 2, 'Confirmar capacidade de armazenamento e truncamento.'],
    ['DATA_PIPELINE', 2, 'Revisar buffers, casts e limites de payload.'],
    ['SCHEMA', 3, 'Atualizar limites de comprimento do campo.'],
    ['DATA_QUALITY', 2, 'Atualizar as regras de tamanho e seus testes.'],
  ],
  PRECISION_CHANGED: [
    ['DATA_MODEL', 3, 'A precisão numérica interna pode ser insuficiente.'],
    ['DATA_PIPELINE', 2, 'Revisar precisão, escala e arredondamento.'],
    ['SCHEMA', 3, 'Atualizar precisão e escala no formato de destino.'],
    ['DATA_QUALITY', 2, 'Revisar limites numéricos e casos extremos.'],
    ['REPORTING', 2, 'Revalidar totalizações e reconciliações.'],
  ],
  REQUIRED_CHANGED: [
    ['SCHEMA', 3, 'A cardinalidade/obrigatoriedade do campo foi alterada.'],
    ['DATA_QUALITY', 3, 'Atualizar a validação de preenchimento.'],
    ['DATA_PIPELINE', 2, 'Verificar se todas as rotas de origem preenchem o campo.'],
    ['SUBMISSION', 3, 'A regra pode bloquear a geração ou validação do arquivo.'],
  ],
  CARDINALITY_CHANGED: [
    ['DATA_MODEL', 2, 'Verificar relação pai-filho e multiplicidade.'],
    ['SCHEMA', 3, 'Atualizar cardinalidade no contrato do documento.'],
    ['DATA_PIPELINE', 2, 'Revisar agrupamento, explode e deduplicação.'],
    ['DATA_QUALITY', 2, 'Adicionar testes de ocorrência mínima/máxima.'],
  ],
  DOMAIN_CHANGED: [
    ['BUSINESS_RULE', 3, 'Atualizar os códigos de negócio aceitos.'],
    ['DATA_QUALITY', 2, 'Atualizar domínio permitido e rejeições.'],
    ['DATA_PIPELINE', 2, 'Revisar tabelas de referência e normalização.'],
    ['SCHEMA', 2, 'Sincronizar o domínio publicado.'],
  ],
  ENUM_ADDED: [
    ['SCHEMA', 2, 'Atualizar o domínio de valores aceitos.'],
    ['BUSINESS_RULE', 2, 'Adicionar o novo código às regras de negócio.'],
    ['DATA_QUALITY', 2, 'Atualizar a regra de domínio e os casos de teste.'],
    ['DATA_PIPELINE', 2, 'Atualizar dimensões e tabelas de referência.'],
  ],
  ENUM_REMOVED: [
    ['SCHEMA', 3, 'O código removido não deve ser serializado.'],
    ['BUSINESS_RULE', 3, 'Localizar valores internos que ainda dependem do código.'],
    ['DATA_QUALITY', 3, 'Bloquear valores do domínio descontinuado.'],
    ['DATA_PIPELINE', 2, 'Atualizar mapeamentos de códigos.'],
  ],
  PATTERN_CHANGED: [
    ['SCHEMA', 2, 'Atualizar a expressão do formato esperado.'],
    ['DATA_QUALITY', 3, 'Atualizar a regra de regex e testes de fronteira.'],
    ['DATA_PIPELINE', 2, 'Revisar normalização e validação de entrada.'],
  ],
  STRUCTURE_CHANGED: [
    ['DATA_MODEL', 3, 'A hierarquia do conteúdo regulatório foi alterada.'],
    ['SCHEMA', 3, 'Atualizar a estrutura de serialização.'],
    ['DATA_PIPELINE', 3, 'Revisar montagem, particionamento e dependências.'],
    ['SUBMISSION', 2, 'Atualizar geração e validação do artefato.'],
  ],
  DEADLINE_CHANGED: [
    ['DEADLINE', 3, 'Atualizar calendário e regras de contagem do prazo.'],
    ['GOVERNANCE', 2, 'Reconfirmar responsável, aprovação e escalonamento.'],
    ['DATA_PIPELINE', 1, 'Revisar a janela operacional de geração/entrega.'],
  ],
  POPULATION_CHANGED: [
    ['GOVERNANCE', 3, 'Confirmar aplicabilidade por entidade e segmento.'],
    ['DATA_MODEL', 2, 'Pode exigir novas entidades ou classificações.'],
    ['DATA_PIPELINE', 2, 'Incluir ou remover populações na seleção de dados.'],
    ['DATA_QUALITY', 1, 'Revisar cobertura e controles de aplicabilidade.'],
  ],
  FORMAT_CHANGED: [
    ['SCHEMA', 3, 'O contrato do arquivo ou payload foi alterado.'],
    ['INTEGRATION', 3, 'O canal/adaptador pode precisar de atualização.'],
    ['DATA_PIPELINE', 3, 'Revisar serialização, compactação e transporte.'],
    ['SUBMISSION', 3, 'Atualizar validação e processo de entrega.'],
  ],
  OBLIGATION_ADDED: [
    ['GOVERNANCE', 3, 'Avaliar aplicabilidade, owner e controles.'],
    ['DATA_PIPELINE', 2, 'Criar ou estender a rota de dados necessária.'],
    ['REPORTING', 3, 'Implementar a nova saída regulatória.'],
    ['SUBMISSION', 2, 'Definir formato, validação e evidência de entrega.'],
  ],
  DOCUMENTATION_CHANGED: [
    ['DOCUMENTATION', 2, 'Revisar instruções e guias operacionais afetados.'],
    ['DATA_PIPELINE', 1, 'Avaliar se a mudança exige ajuste de execução.'],
    ['SUBMISSION', 1, 'Executar regressão do adaptador e do processo de envio.'],
  ],
  SOURCE_HASH_CHANGED: [],
});

const impactLabel = (score) => (score >= 3 ? 'HIGH' : score === 2 ? 'MEDIUM' : 'LOW');

export function calculateImpacts(changeType, context = {}) {
  const rules = IMPACT_RULES[changeType];
  if (!rules) {
    return {
      totalScore: 0,
      level: 'UNASSESSED',
      rationale: `Tipo ${changeType} não possui regra de impacto configurada; classificação manual necessária.`,
      impacts: [],
    };
  }
  const impacts = rules.map(([impactType, score, rationale]) => ({
    impactType,
    score,
    severity: impactLabel(score),
    rationale,
    description: context.field
      ? `${context.field}: ${rationale}`
      : rationale,
    recommendedAction: recommendedAction(impactType),
  }));
  const totalScore = impacts.reduce((sum, item) => sum + item.score, 0);
  const level = totalScore >= 17 ? 'CRITICAL' : totalScore >= 9 ? 'HIGH' : totalScore >= 5 ? 'MEDIUM' : 'LOW';
  const rationale = `Regra ${changeType}: soma determinística de ${impacts.length} impactos (${totalScore} pontos). Faixas: LOW 0–4, MEDIUM 5–8, HIGH 9–16, CRITICAL 17+. ${context.note || ''}`.trim();
  return { totalScore, level, rationale, impacts };
}

function recommendedAction(type) {
  const map = {
    DATA_MODEL: 'Abrir alteração de modelo e validar compatibilidade retroativa.',
    DATA_PIPELINE: 'Identificar jobs consumidores, implementar e executar regressão.',
    SCHEMA: 'Versionar contrato e comparar com a versão ativa antes da publicação.',
    DATA_QUALITY: 'Atualizar regra e acrescentar testes positivos/negativos.',
    REPORTING: 'Reconciliar saída, totais e período de referência.',
    SUBMISSION: 'Executar geração, validação interna e aprovação antes do envio.',
    DEADLINE: 'Atualizar calendário oficial preservando período, fonte e regra de contagem.',
    GOVERNANCE: 'Reconfirmar entidade aplicável, responsável e aprovador.',
    BUSINESS_RULE: 'Atualizar catálogo de códigos e testar casos existentes.',
    INTEGRATION: 'Revalidar protocolo, autenticação, payload e tratamento de respostas.',
    DOCUMENTATION: 'Atualizar runbook com referência à versão oficial.',
  };
  return map[type] || 'Registrar responsável, evidência e teste de regressão.';
}

/**
 * A footprint score is an inventory heuristic, not a legal severity assessment.
 * It is deliberately based only on stored structure (format, cadence and known
 * official deadline metadata), and always returns the reasons used.
 */
export function scoreObligationFootprint(obligation, { fields = 0, mapped = 0 } = {}) {
  let score = 0;
  const reasons = [];
  if (obligation.output_format && !['UNKNOWN', 'UNSTRUCTURED', 'N/A'].includes(obligation.output_format.toUpperCase())) {
    score += 2;
    reasons.push(`saída declarada (${obligation.output_format}) +2`);
  }
  if (fields > 0) {
    score += Math.min(3, Math.ceil(fields / 5));
    reasons.push(`${fields} campos catalogados +${Math.min(3, Math.ceil(fields / 5))}`);
  }
  if (obligation.frequency === 'DAILY' || obligation.frequency === 'EVENT_DRIVEN') {
    score += 2;
    reasons.push(`cadência ${obligation.frequency} +2`);
  }
  if (mapped > 0) {
    score += 1;
    reasons.push(`${mapped} mapping(s) configurado(s) +1`);
  }
  const level = score >= 8 ? 'HIGH' : score >= 4 ? 'MEDIUM' : 'LOW';
  return { score, level, rationale: reasons.length ? reasons.join('; ') : 'Sem formato, schema ou mapeamento estruturado confirmado.' };
}
