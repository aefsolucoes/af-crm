import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * CADASTRO DIVERGENTE (Fabio 23/10: "sempre que aparecer o resultado Cadastro Divergente a IA deve perguntar ao cliente se o nome e o CPF correspondem à pessoa — pode ser nome de um participante e CPF
 * de outro" / exemplo Valdinei, Santander: "caso esteja divergente, precisa alterar e rodar novamente o crédito nos outros bancos também").
 * O Santander (Credimorar) devolve na lista o status "Cadastro Divergente" (nome e CPF não batem na Receita/no banco) e a extensão grava "não reconheci o status na coluna do Santander: Cadastro Divergente…"
 * — a análise ficava SENT, pendente pra sempre. Daqui:
 *  1) poller (1 min): acha a análise com "Cadastro Divergente" ainda sem tratamento no card e PERGUNTA ao cliente, no WhatsApp, se o nome e o CPF de cada participante são da mesma pessoa (CPF mascarado);
 *     só com a IA do card ligada, sem STOP TOTAL, 07h–21h e janela de 24 h aberta; senão espera a janela (até 24 h) ou avisa a equipe (nota + push com o texto pronto);
 *  2) a IA da conversa recebe o contexto (aiCadDivContext) e, quando o cliente disser o que está trocado, grava os campos corrigidos (nome/CPF dos participantes); ao aplicar, o CRM refaz sozinho a análise
 *     em TODOS os bancos (cadastroCorrigido); se o cliente disser que está tudo certo, a IA leva a dúvida pra equipe (conferir na Receita).
 * Estado: customFields._cadDiv = { analysisId, bank, status: PENDING | ASKED | EQUIPE | CORRIGIDO, ... }.
 */

export const CADDIV_FROM = new Date('2026-10-22T00:00:00Z');
const RX = /cadastro\s+diverg/i;
const BANK_LABEL: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
const WAIT_MAX_MS = 24 * 3600_000;

const soDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');
/** 021.138.495-00 → 021.***.***-00 (o cliente reconhece, sem expor o CPF inteiro). */
export function cpfMascarado(cpf: unknown): string {
  const d = soDigitos(cpf);
  return d.length === 11 ? `${d.slice(0, 3)}.***.***-${d.slice(9)}` : '';
}

export type CadDivParticipante = { nome: string; cpf: string; nascimento: string };
export function participantesDoCard(cf: Record<string, any>): CadDivParticipante[] {
  const out: CadDivParticipante[] = [];
  for (const i of [1, 2]) {
    const nome = String(cf[`participante_${i}`] || '').trim();
    const cpf = cpfMascarado(cf[`cpf_${i}`]);
    const nascimento = String(cf[`nascimento_${i}`] || '').trim();
    if (nome || cpf) out.push({ nome: nome || '(sem nome)', cpf: cpf || '(sem CPF)', nascimento: nascimento || '(sem data)' });
  }
  return out;
}

export function cadDivText(participantes: CadDivParticipante[], primeiroNome: string | null): string {
  const lista = participantes.map((p) => `• ${p.nome} — CPF ${p.cpf} — nascimento ${p.nascimento}`).join('\n');
  return [
    `${primeiroNome ? `${primeiroNome}, o` : 'O'} banco acusou uma divergência no cadastro. Preciso conferir com você se o nome, o CPF e a data de nascimento abaixo correspondem à mesma pessoa:`,
    '',
    lista,
    '',
    'Pode ter algo errado: o nome, o CPF ou a data de nascimento (ou o nome de um participante com o CPF do outro). Me diga o que está errado ou se está tudo certo.',
  ].join('\n');
}

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

async function salva(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._cadDiv = { ...(cf._cadDiv || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

export async function processCadastroDivergente(accountId: string, io: Io): Promise<void> {
  const rows = await prisma.creditAnalysis.findMany({
    where: { dryRun: false, createdAt: { gte: CADDIV_FROM }, OR: [{ detail: { contains: 'diverg', mode: 'insensitive' } }, { conditions: { contains: 'diverg', mode: 'insensitive' } }], lead: { is: { accountId, status: 'OPEN', archived: false, isGroup: false } } },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, leadId: true, bank: true, status: true, createdAt: true, detail: true, conditions: true },
  });
  const vistos = new Set<string>();
  for (const r of rows) {
    if (vistos.has(r.leadId)) continue;
    if (!RX.test(`${r.detail || ''} ${r.conditions || ''}`)) continue;
    vistos.add(r.leadId);
    try { await uma(accountId, r, io); } catch (e: any) { console.warn('[Cadastro divergente]', e?.message); }
  }
}

async function uma(accountId: string, r: { id: string; leadId: string; bank: string; createdAt: Date }, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: r.leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const cd = (cf._cadDiv || {}) as { analysisId?: string; status?: string; at?: string; correctedAt?: string };
  if (cd.analysisId === r.id && (cd.status === 'ASKED' || cd.status === 'EQUIPE' || cd.status === 'CORRIGIDO')) return; // já tratado
  if (cd.status === 'CORRIGIDO' && cd.correctedAt && r.createdAt < new Date(cd.correctedAt)) return; // divergência anterior à correção
  // Já saiu uma rodada mais nova NESSE banco que não é a divergente: resolvido.
  const maisNova = await prisma.creditAnalysis.findFirst({ where: { leadId: r.leadId, bank: r.bank, dryRun: false, createdAt: { gt: r.createdAt }, NOT: { detail: { contains: 'diverg', mode: 'insensitive' } } }, select: { id: true } });
  if (maisNova) return;
  if (cf._autoPaused) return;

  const participantes = participantesDoCard(cf);
  if (!participantes.length) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name);
  const texto = cadDivText(participantes, nome);
  const banco = BANK_LABEL[r.bank] || r.bank;

  if (!lead.aiAutoReplyActive) {
    await salva(lead.id, { analysisId: r.id, bank: r.bank, status: 'EQUIPE', at: new Date().toISOString() });
    await note(lead.id, `🔎 O ${banco} acusou "Cadastro Divergente" (nome, CPF ou data de nascimento não batem). IA do card desligada: pergunte ao cliente se o nome, o CPF e a data de nascimento correspondem à pessoa — pode haver erro em qualquer um dos três (ou o nome de um participante com o CPF do outro). Se estiver trocado, corrija em "Ajustar" e rode de novo em TODOS os bancos. Texto pronto:\n“${texto.replace(/\n+/g, ' ')}”`);
    push(accountId, '🔎 Cadastro divergente', `${lead.name}: ${banco} — confirmar nome e CPF com o cliente`, lead.id);
    return;
  }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const pronto = inNoticeWindow() && (await whatsappWindowOpen(lead.id));
  if (!pronto) {
    // espera a janela/horário (até 24 h); depois avisa a equipe
    if (cd.analysisId !== r.id) await salva(lead.id, { analysisId: r.id, bank: r.bank, status: 'PENDING', at: new Date().toISOString() });
    const desde = new Date(cd.analysisId === r.id && cd.at ? cd.at : Date.now()).getTime();
    if (Date.now() - desde > WAIT_MAX_MS) {
      await salva(lead.id, { analysisId: r.id, bank: r.bank, status: 'EQUIPE', at: new Date().toISOString() });
      await note(lead.id, `🔎 O ${banco} acusou "Cadastro Divergente" e não consegui perguntar ao cliente em 24 h (janela do WhatsApp fechada). Pergunte você se o nome, o CPF e a data de nascimento correspondem à pessoa (pode ser nome de um participante com CPF de outro) e, se estiver trocado, corrija em "Ajustar" e rode de novo em TODOS os bancos. Texto pronto:\n“${texto.replace(/\n+/g, ' ')}”`);
      push(accountId, '🔎 Cadastro divergente', `${lead.name}: ${banco} — perguntar nome e CPF ao cliente (janela fechada)`, lead.id);
    }
    return;
  }
  const env = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: texto, io: io as any });
  if (!env.success) return; // tenta no próximo minuto
  await salva(lead.id, { analysisId: r.id, bank: r.bank, status: 'ASKED', at: new Date().toISOString(), participantes });
  await note(lead.id, `🔎 O ${banco} acusou "Cadastro Divergente": perguntei ao cliente se o nome, o CPF e a data de nascimento de cada participante correspondem à pessoa (pode haver erro em qualquer um dos três ou nome de um com CPF do outro). Se ele corrigir, o CRM atualiza o card e refaz a análise em todos os bancos.`);
}

/** Bloco pro prompt da IA da conversa enquanto a pergunta está em aberto. '' se não houver. */
export async function aiCadDivContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cd = ((l?.customFields || {}) as Record<string, any>)._cadDiv as { status?: string; bank?: string } | undefined;
  if (!cd || cd.status !== 'ASKED') return '';
  const cf = (l?.customFields || {}) as Record<string, any>;
  const banco = BANK_LABEL[cd.bank || ''] || 'o banco';
  const lista = participantesDoCard(cf).map((p, i) => `  ${i + 1}) ${p.nome} — CPF ${p.cpf} — nascimento ${p.nascimento}`).join('\n');
  return `--- CADASTRO DIVERGENTE (pergunta já feita ao cliente) ---
${banco} acusou "Cadastro Divergente" (o cadastro não bate: nome, CPF ou data de nascimento) e o CRM já perguntou ao cliente se o nome, o CPF e a data de nascimento correspondem à mesma pessoa. Dados do card:
${lista}
Quando o cliente responder:
- Se disser que algum NOME, CPF ou DATA DE NASCIMENTO está trocado/errado (ex.: o nome de um participante com o CPF do outro): grave em "extractedFields" SÓ os campos que mudam, com os valores CERTOS que ele informou ("participante_1", "cpf_1", "nascimento_1", "participante_2", "cpf_2", "nascimento_2"; CPF só com os números; nascimento no formato DD/MM/AAAA). Se ele não passar o dado certo completo, peça o que falta (um de cada vez). Ao gravar, diga que corrigiu e que a equipe já refaz a análise nos bancos (sem prazo). O CRM refaz sozinho a análise em TODOS os bancos.
- Se disser que está TUDO CERTO: não invente; use "askTeam": "Cliente confirma que nome, CPF e data de nascimento batem, mas o banco acusou cadastro divergente — conferir na Receita Federal." (sem falar disso ao cliente além de "vou conferir aqui").
- Se a resposta for confusa, pergunte de novo de forma simples (nome completo, CPF e data de nascimento de cada pessoa). Nunca peça documento por isso e nunca diga que foi reprovado.`;
}

const CAMPOS_IDENTIDADE = ['participante_1', 'cpf_1', 'nascimento_1', 'participante_2', 'cpf_2', 'nascimento_2'];

/** A IA gravou campos de identidade enquanto a pergunta estava aberta: o card foi corrigido → refaz a análise em todos os bancos. */
export async function cadastroCorrigido(accountId: string, leadId: string, camposMudados: string[], io: Io): Promise<boolean> {
  if (!camposMudados.some((k) => CAMPOS_IDENTIDADE.includes(k))) return false;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, name: true } });
  const cd = ((l?.customFields || {}) as Record<string, any>)._cadDiv as { status?: string } | undefined;
  if (!l || !cd || cd.status !== 'ASKED') return false;
  await salva(leadId, { status: 'CORRIGIDO', correctedAt: new Date().toISOString(), campos: camposMudados.filter((k) => CAMPOS_IDENTIDADE.includes(k)) });
  const { createRequests, BANK_KEYS } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const r = await createRequests(prisma as any, { accountId, leadIds: [leadId], banks: BANK_KEYS, dryRun: false, kind: 'RUN', source: 'AI', force: true, queueIfBusy: true });
  await note(leadId, `🔁 O cliente corrigiu nome/CPF/nascimento (${camposMudados.filter((k) => CAMPOS_IDENTIDADE.includes(k)).join(', ')}) depois do "Cadastro Divergente": o card foi atualizado e refiz a análise em ${r.created} banco(s) (todos os bancos, com os dados certos).`);
  push(accountId, '🔁 Cadastro corrigido', `${l.name}: análise refeita nos bancos com nome/CPF corrigidos`, leadId);
  void io;
  return true;
}
