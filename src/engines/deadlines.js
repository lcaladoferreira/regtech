const DEFAULT_BR_HOLIDAYS = new Set([
  // Only national public holidays belong here; local/state holidays must be supplied per entity.
  '2026-01-01', '2026-04-03', '2026-04-21', '2026-05-01', '2026-09-07', '2026-10-12',
  '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25',
  '2027-01-01', '2027-03-26', '2027-04-21', '2027-05-01', '2027-09-07', '2027-10-12',
  '2027-11-02', '2027-11-15', '2027-11-20', '2027-12-25',
]);

export function isBusinessDay(date, holidays = DEFAULT_BR_HOLIDAYS) {
  const value = date instanceof Date ? date : parseISODate(date);
  const weekday = value.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(formatDate(value));
}

export function addBusinessDays(startDate, count, { holidays = DEFAULT_BR_HOLIDAYS, includeStart = false } = {}) {
  const date = parseISODate(startDate);
  if (count < 0) throw new RangeError('count must be >= 0');
  let remaining = count;
  if (includeStart && isBusinessDay(date, holidays)) remaining -= 1;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isBusinessDay(date, holidays)) remaining -= 1;
  }
  return formatDate(date);
}

export function calculateDeadline({ startDate, rule, holidays = DEFAULT_BR_HOLIDAYS }) {
  if (!startDate || !rule || rule.kind === 'UNKNOWN') {
    return { dueDate: null, basis: 'Prazo não calculado: regra oficial desconhecida ou sem evento de referência.' };
  }
  if (rule.kind === 'BUSINESS_DAYS_AFTER_EVENT') {
    return {
      dueDate: addBusinessDays(startDate, Number(rule.days), { holidays }),
      basis: `${rule.days} dias úteis após ${startDate}; calendário nacional fornecido pelo operador.`,
    };
  }
  if (rule.kind === 'NTH_BUSINESS_DAY_OF_NEXT_MONTH') {
    const date = parseISODate(startDate);
    const nextMonthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    let count = 0;
    while (true) {
      if (isBusinessDay(nextMonthStart, holidays)) count += 1;
      if (count === Number(rule.day)) break;
      nextMonthStart.setUTCDate(nextMonthStart.getUTCDate() + 1);
    }
    return { dueDate: formatDate(nextMonthStart), basis: `${rule.day}º dia útil do mês seguinte; validar com o calendário oficial publicado.` };
  }
  return { dueDate: null, basis: `Regra ${rule.kind} requer parâmetro específico; nenhum vencimento presumido.` };
}

export function calendarStatus(dueDate, today = new Date()) {
  const due = parseISODate(dueDate);
  const current = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const diff = Math.round((due.getTime() - current.getTime()) / 86_400_000);
  return { daysRemaining: diff, status: diff < 0 ? 'OVERDUE' : diff === 0 ? 'DUE_TODAY' : 'UPCOMING' };
}

function parseISODate(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) throw new TypeError(`Expected YYYY-MM-DD date; got ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
