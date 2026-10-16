/**
 * Por que uma análise NÃO rodou (Fabio 15/10: "não tem nada informando sobre o que houve… faça uma auditoria e veja quais não têm análise rodada e o motivo").
 * Pura (sem banco): recebe o que o quadro já carregou e devolve uma frase para a tela mostrar no lugar de "Nenhuma análise ainda".
 * As regras espelham o automático (credit-auto.service): início depois de ligar, conferência da IA, cascata pro 2º participante.
 */
export interface NotRunRow { bank: string; kind: string; status: string; detail: string | null; dryRun?: boolean }

export interface NotRunInput {
  who: 1 | 2;
  bank: string;
  cf: Record<string, any>;
  inPre: boolean;
  stageEnteredAt: Date | null;
  settings: { enabled: boolean; enabledAt: Date | null; paused: boolean } | null;
  /** Linhas deste banco do OUTRO participante (do mais novo pro mais antigo). */
  otherRows: NotRunRow[];
  /** Linhas deste banco do MESMO participante (vazio quando chega aqui; usado só pra clareza). */
  now?: number;
}

const POSITIVO = new Set(['APPROVED', 'CONDITIONAL']);
const MIN_AFTER_STAGE_MS = 3 * 60_000;
const AI_CHECK_MAX = 6;

/** Trecho útil do detalhe (sem o "Titular na análise: …"): o erro/recusa quando houver; senão o começo. */
function curto(detail: string | null | undefined, max = 170): string {
  const t = String(detail || '').replace(/Titular na análise:[^.]*\.\s*/i, '').replace(/\s+/g, ' ').trim();
  const chave = /(Mas n[aã]o consegui[^]*|N[AÃ]O RODEI[^]*|RESULTADO:[^]*|Erro[^]*|A extens[aã]o[^]*)/i.exec(t);
  const x = chave ? chave[1] : t;
  return x.length > max ? `${x.slice(0, max - 1)}…` : x;
}

/** Falha que vale para os DOIS participantes (regra do imóvel/proposta), não do titular. */
export function regraDoImovel(detail: string | null | undefined): boolean {
  return /N[AÃ]O RODEI|abaixo do m[ií]nimo|terreno|saldo devedor|im[oó]vel (n[aã]o|fora)|valor do cr[eé]dito|cr[eé]dito (m[ií]nimo|acima)|LTV/i.test(String(detail || ''));
}

export function whyNotRun(i: NotRunInput): string {
  const now = i.now ?? Date.now();
  const cf = i.cf || {};
  const other = i.otherRows.filter((r) => !r.dryRun);
  const outroNome = i.who === 1 ? '2º participante' : '1º participante';

  if (cf._autoPaused) return `Cliente PAUSADO (stop total) — nada roda sozinho enquanto estiver pausado.`;

  if (i.who === 1) {
    if (other.length) return `Este banco só foi rodado no nome do ${outroNome} (titular invertido). Use "Rodar" para rodar também no 1º participante.`;
    if (!i.inPre) return 'O cliente saiu da Pré-Análise sem ter sido rodado neste banco.';
    if (i.settings?.paused) return 'A análise automática está em PAUSA GERAL (botão na tela).';
    if (!i.settings?.enabled) return 'A análise automática está DESLIGADA — rode à mão (botão "Rodar").';
    if (i.settings.enabledAt && i.stageEnteredAt && i.stageEnteredAt.getTime() < i.settings.enabledAt.getTime()) return 'Entrou na Pré-Análise ANTES de a análise automática ser ligada (cards antigos não entram) — rode à mão.';
    if (cf._autoGiveUp) return `A IA conferiu a proposta ${AI_CHECK_MAX} vezes e achou que precisa de atenção (veja a anotação "Análise automática NÃO iniciada" no card). Acerte e use "Rodar".`;
    if (!cf._autoStartedAt) {
      if (i.stageEnteredAt && now - i.stageEnteredAt.getTime() < MIN_AFTER_STAGE_MS) return 'Acabou de entrar na Pré-Análise: a IA começa a conferir os dados da proposta em ~3 min.';
      const n = Number(cf._autoChecks || 0);
      return n ? `A IA ainda está conferindo se a proposta está pronta (tentativa ${n} de ${AI_CHECK_MAX}).` : 'Ainda não começou: a IA não achou a proposta preenchida na conversa ou ainda não conferiu os dados.';
    }
    return 'O automático iniciou o cliente mas não criou o pedido deste banco — use "Rodar".';
  }

  // 2º participante
  const cpf2 = String(cf.cpf_2 || '').replace(/\D/g, '');
  if (cpf2.length < 11) return 'O 2º participante está sem CPF no card — o automático só roda no 2º com nome e CPF completos.';
  const ult = other[0]; // do mais novo pro mais antigo
  if (!ult) return `O ${outroNome} ainda não rodou neste banco; o 2º participante só entra depois.`;
  const tried: string[] = Array.isArray(cf._autoP2Banks) ? cf._autoP2Banks : [];
  if (['REQUESTED', 'RUNNING'].includes(ult.status)) return 'O 1º participante ainda está na fila/rodando neste banco. O 2º só roda se o 1º for reprovado, aprovado a menor ou for enviado ao banco.';
  if (POSITIVO.has(ult.status) && !/aprovad[oa] a menor/i.test(ult.detail || '')) return 'O 1º participante foi aprovado no valor total neste banco — não precisa rodar o 2º.';
  if (ult.status === 'FAILED' && regraDoImovel(ult.detail)) return `Não rodou por regra que vale para os dois participantes: ${curto(ult.detail)}`;
  if (ult.status === 'FAILED') return `O 1º participante falhou neste banco (${curto(ult.detail)}). O 2º só roda depois que o 1º tiver resultado — use "Rodar de novo" no 1º ou "Rodar no 2º participante".`;
  if (ult.status === 'CHECK' || ult.status === 'INCOMPLETE') return `O 1º participante ficou em "${ult.status === 'CHECK' ? 'Conferir' : 'Incompleto'}" (${curto(ult.detail)}). O 2º só entra quando o 1º for reprovado, aprovado a menor ou enviado ao banco.`;
  const deveriaRodar = ult.status === 'REJECTED' || ult.status === 'SENT' || (POSITIVO.has(ult.status) && /aprovad[oa] a menor/i.test(ult.detail || ''));
  if (deveriaRodar) {
    if (tried.includes(i.bank)) return 'O automático já pediu o 2º participante neste banco — o pedido está na fila.';
    if (!cf._autoStartedAt) return 'Este cliente não foi iniciado pelo automático, então o 2º participante não roda sozinho — use "Rodar no 2º participante".';
    return 'O 1º participante deveria ter passado pro 2º: o automático ainda não fez (ele confere a cada minuto) — se continuar assim, use "Rodar no 2º participante".';
  }
  return 'Ainda não rodou no 2º participante.';
}
