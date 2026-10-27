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
/** 02113849500 → 021.138.495-00. Outro formato (CPF incompleto/digitado errado) sai como está, pro cliente enxergar o erro. */
export function cpfCompleto(cpf: unknown): string {
  const d = soDigitos(cpf);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(cpf ?? '').trim();
}

export function participantesDoCard(cf: Record<string, any>): CadDivParticipante[] {
  const out: CadDivParticipante[] = [];
  for (const i of [1, 2]) {
    const nome = String(cf[`participante_${i}`] || '').trim();
    // CPF COMPLETO (Fabio 26/10: "como o CRM vai confirmar o CPF se ela não mostra o CPF completo? foi o próprio cliente que informou, não precisa tapar com *"): o cliente só consegue conferir se vir o número todo.
    const cpf = cpfCompleto(cf[`cpf_${i}`]);
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
  try { await reabrirConversas(accountId, io); } catch (e: any) { console.warn('[Cadastro divergente] reabrir', e?.message); }
}

// ─── REABRIR A CONVERSA (Fabio 26/10, Hélio: "precisa reabrir a conversa e o CRM conversar com ele sobre isso pra tentar ajustar, senão vai ficar lá pra sempre") ───
// Divergência pendente (pergunta feita sem resposta, ou esperando a janela) e a janela de 24 h FECHADA: manda o template de UTILIDADE "atualizacao_processo_credito"
// ("Temos uma atualização sobre o seu processo… Responda esta mensagem…"). Quando o cliente responde, a janela abre: a pergunta sai (PENDING) ou a IA retoma o assunto (ASKED).
// Até 3 vezes, de 48 em 48 h, só 07h–21h e com a IA do card ligada.
const REABRIR_TEMPLATE = 'atualizacao_processo_credito';
const REABRIR_GAP_MS = 48 * 3600_000;
const REABRIR_MAX = 3;
async function reabrirConversas(accountId: string, io: Io): Promise<void> {
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "isGroup" = false AND "aiAutoReplyActive" = true
      AND "customFields"->'_cadDiv'->>'status' IN ('ASKED', 'PENDING', 'EQUIPE') AND COALESCE("customFields"->>'_autoPaused', '') = ''`;
  for (const { id } of ids) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    if (!lead) continue;
    const cf = (lead.customFields || {}) as Record<string, any>;
    const cd = (cf._cadDiv || {}) as { status?: string; at?: string; bank?: string; reopenAt?: string; reopenN?: number };
    if ((cd.reopenN || 0) >= REABRIR_MAX) continue;
    if (cd.reopenAt && Date.now() - new Date(cd.reopenAt).getTime() < REABRIR_GAP_MS) continue;
    if (cd.at && Date.now() - new Date(cd.at).getTime() < 3600_000) continue; // acabou de perguntar/registrar
    if (await whatsappWindowOpen(lead.id)) continue; // janela aberta: a pergunta/IA cuidam
    const respondeu = cd.at ? await prisma.message.count({ where: { leadId: lead.id, direction: 'INBOUND', createdAt: { gt: new Date(cd.at) } } }) : 0;
    if (respondeu && cd.status === 'ASKED') continue; // ele respondeu depois da pergunta: a conversa está com a IA/equipe
    const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
    const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || String(lead.name || '').trim().split(/\s+/)[0] || 'cliente';
    const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
    const t = await sendOutboundWhatsAppTemplate({ accountId, leadId: lead.id, templateName: REABRIR_TEMPLATE, language: 'pt_BR', bodyParams: [nome], previewText: `Oi ${nome}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io: io as any });
    if (!t.success) { await note(lead.id, `🔎 Cadastro divergente: tentei reabrir a conversa (template de atualização) e não saiu: ${t.error}.`); await salva(lead.id, { reopenAt: new Date().toISOString(), reopenN: (cd.reopenN || 0) + 1 }); continue; }
    // EQUIPE (desistiu depois de 24 h) volta pra PENDING: assim que ele responder, a pergunta da divergência sai sozinha.
    await salva(lead.id, { reopenAt: new Date().toISOString(), reopenN: (cd.reopenN || 0) + 1, ...(cd.status === 'EQUIPE' ? { status: 'PENDING', at: new Date().toISOString() } : {}) });
    await note(lead.id, `🔎 Cadastro divergente sem resposta e janela do WhatsApp fechada: mandei o template de atualização pra reabrir a conversa (${(cd.reopenN || 0) + 1}ª vez). Quando o cliente responder, ${cd.status === 'ASKED' ? 'a IA retoma a conferência de nome, CPF e nascimento' : 'o CRM manda a pergunta da divergência'}.`);
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
  // (Hélio, 25/10: as conferências "não achei o cliente na lista" também são mais novas e não dizem "diverg" — contavam como "já resolvido" e o cliente nunca era avisado.) Só vale uma RODADA nova (RUN) sem a divergência,
  // ou um resultado decisivo (aprovou/reprovou/condicional).
  const maisNova = await prisma.creditAnalysis.findFirst({
    where: { leadId: r.leadId, bank: r.bank, dryRun: false, createdAt: { gt: r.createdAt }, source: { not: 'AI_SIM' }, NOT: { detail: { contains: 'diverg', mode: 'insensitive' } }, OR: [{ kind: 'RUN' }, { status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] } }] },
    select: { id: true },
  });
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
  if ((cf._cadConfirm as any)?.status === 'ASKED') await salvaConfirm(lead.id, { status: 'SUPERADO', supersededAt: new Date().toISOString() }); // a pergunta da divergência substitui a confirmação (mesmos dados)
  await note(lead.id, `🔎 O ${banco} acusou "Cadastro Divergente": perguntei ao cliente se o nome, o CPF e a data de nascimento de cada participante correspondem à pessoa (pode haver erro em qualquer um dos três ou nome de um com CPF do outro). Se ele corrigir, o CRM atualiza o card e refaz a análise em todos os bancos.`);
}

/** Bloco pro prompt da IA da conversa enquanto a pergunta está em aberto. '' se não houver. */
export async function aiCadDivContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cd = ((l?.customFields || {}) as Record<string, any>)._cadDiv as { status?: string; bank?: string } | undefined;
  if (!cd || cd.status !== 'ASKED') return aiCadConfirmContext((l?.customFields || {}) as Record<string, any>);
  const cf = (l?.customFields || {}) as Record<string, any>;
  const banco = BANK_LABEL[cd.bank || ''] || 'o banco';
  const lista = participantesDoCard(cf).map((p, i) => `  ${i + 1}) ${p.nome} — CPF ${p.cpf} — nascimento ${p.nascimento}`).join('\n');
  return `--- CADASTRO DIVERGENTE (pergunta já feita ao cliente) ---
${banco} acusou "Cadastro Divergente" (o cadastro não bate: nome, CPF ou data de nascimento) e o CRM já perguntou ao cliente se o nome, o CPF e a data de nascimento correspondem à mesma pessoa. Dados do card:
${lista}
Quando o cliente responder:
- Se disser que algum NOME, CPF ou DATA DE NASCIMENTO está trocado/errado (ex.: o nome de um participante com o CPF do outro): grave em "extractedFields" SÓ os campos que mudam, com os valores CERTOS que ele informou ("participante_1", "cpf_1", "nascimento_1", "participante_2", "cpf_2", "nascimento_2"; CPF só com os números; nascimento no formato DD/MM/AAAA). Se ele não passar o dado certo completo, peça o que falta (um de cada vez). Ao gravar, diga que corrigiu e que a equipe já refaz a análise nos bancos (sem prazo). O CRM refaz sozinho a análise em TODOS os bancos.
- Se disser que está TUDO CERTO: não invente; use "askTeam": "Cliente confirma que nome, CPF e data de nascimento batem, mas o banco acusou cadastro divergente — conferir na Receita Federal." (sem falar disso ao cliente além de "vou conferir aqui").
- Se a resposta for confusa, pergunte de novo de forma simples (nome completo, CPF e data de nascimento de cada pessoa). Nunca peça documento por isso e nunca diga que foi reprovado.
- Se o cliente só RESPONDEU À MENSAGEM DE ATUALIZAÇÃO (template "Temos uma atualização sobre o seu processo…"), cumprimentou ou perguntou "qual atualização?": explique em 1 frase que o banco acusou uma divergência no cadastro e refaça a pergunta com a lista acima (nome, CPF completo e nascimento de cada pessoa), pedindo pra ele dizer se está tudo certo ou o que está errado.`;
}

const CAMPOS_IDENTIDADE = ['participante_1', 'cpf_1', 'nascimento_1', 'participante_2', 'cpf_2', 'nascimento_2'];

/** A IA gravou campos de identidade enquanto a pergunta estava aberta: o card foi corrigido → refaz a análise em todos os bancos. */
export async function cadastroCorrigido(accountId: string, leadId: string, camposMudados: string[], io: Io): Promise<boolean> {
  const mudouIdentidade = camposMudados.some((k) => CAMPOS_IDENTIDADE.includes(k));
  if (!mudouIdentidade && !camposMudados.includes('cadastro_confirmado')) return false;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, name: true } });
  const cdAll = ((l?.customFields || {}) as Record<string, any>);
  const cd = cdAll._cadDiv as { status?: string } | undefined;
  // Confirmação do cadastro logo que a proposta chega (não é a divergência do banco): corrigiu → refaz a análise com os dados certos; confirmou → só registra.
  if (l && (!cd || cd.status !== 'ASKED') && (cdAll._cadConfirm as any)?.status === 'ASKED') return confirmacaoRespondida(accountId, leadId, l.name, camposMudados, mudouIdentidade);
  if (!mudouIdentidade) return false;
  if (!l || !cd || cd.status !== 'ASKED') return false;
  await salva(leadId, { status: 'CORRIGIDO', correctedAt: new Date().toISOString(), campos: camposMudados.filter((k) => CAMPOS_IDENTIDADE.includes(k)) });
  const { createRequests, BANK_KEYS } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const r = await createRequests(prisma as any, { accountId, leadIds: [leadId], banks: BANK_KEYS, dryRun: false, kind: 'RUN', source: 'AI', force: true, queueIfBusy: true });
  await note(leadId, `🔁 O cliente corrigiu nome/CPF/nascimento (${camposMudados.filter((k) => CAMPOS_IDENTIDADE.includes(k)).join(', ')}) depois do "Cadastro Divergente": o card foi atualizado e refiz a análise em ${r.created} banco(s) (todos os bancos, com os dados certos).`);
  push(accountId, '🔁 Cadastro corrigido', `${l.name}: análise refeita nos bancos com nome/CPF corrigidos`, leadId);
  void io;
  return true;
}


// ─── CONFIRMAÇÃO DO CADASTRO LOGO QUE A PROPOSTA CHEGA (Fabio 25/10) ───────────────────────────────────────────────────────────────────────────────────────────
// "Preciso que o CRM confirme com o cliente que encaminhou a proposta o nome, a data de nascimento e o CPF e ajuste no card — isso não impede a análise de crédito."
// A análise automática segue normalmente (não espera esta confirmação). O CRM pergunta no WhatsApp (IA do card ligada, sem STOP TOTAL, 07h–21h, janela de 24 h aberta; senão espera até 24 h e desiste sem barulho);
// a IA da conversa grava as correções no card ("participante_1", "cpf_1", "nascimento_1"…) e o CRM refaz a análise em TODOS os bancos com os dados certos (confirmacaoRespondida).
// Estado: customFields._cadConfirm = { status: ASKED | PENDING | CONFIRMADO | CORRIGIDO | EXPIRADO | SUPERADO, at }.

export const CADCONFIRM_FROM = new Date('2026-10-25T14:00:00Z'); // só propostas cuja análise automática começou depois disto (não pergunta a quem já está no meio do processo)
const CONFIRM_ASK_VALID_MS = 3 * 86_400_000;

export function cadConfirmText(participantes: CadDivParticipante[], primeiroNome: string | null): string {
  const lista = participantes.map((p) => `• ${p.nome} — CPF ${p.cpf} — nascimento ${p.nascimento}`).join('\n');
  return [
    `${primeiroNome ? `${primeiroNome}, recebi` : 'Recebi'} a sua proposta e a análise de crédito já está em andamento. Só pra garantir que tudo sai certinho, confere comigo o nome, o CPF e a data de nascimento que vieram nela:`,
    '',
    lista,
    '',
    'Está tudo correto? Se algum dado estiver errado, me manda o certo que eu ajusto aqui.',
  ].join('\n');
}

async function salvaConfirm(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._cadConfirm = { ...(cf._cadConfirm || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

const ehPreAnalise = (stage?: string | null) => /pre\W*analise/i.test(String(stage || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

export async function processCadastroConfirm(accountId: string, io: Io): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, stage: { name: { contains: 'an', mode: 'insensitive' } } },
    select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 120,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Record<string, any>;
    if (!ehPreAnalise(l.stage?.name) || cf._cadConfirm || cf._autoPaused) continue;
    const comecou = cf._autoStartedAt ? new Date(cf._autoStartedAt) : null;
    if (!comecou || comecou < CADCONFIRM_FROM) continue; // análise automática ainda não começou (ou é de antes deste recurso)
    if (String(cf._cadDiv?.status || '') === 'ASKED') { await salvaConfirm(l.id, { status: 'SUPERADO', at: new Date().toISOString() }); continue; }
    if (soDigitos(cf.cpf_1).length !== 11 || !String(cf.participante_1 || '').trim()) continue; // sem proposta preenchida não há o que conferir
    if (!l.aiAutoReplyActive) continue; // IA desligada: a equipe está na conversa
    try { await confirmaUma(accountId, l.id, l.name, cf, io); } catch (e: any) { console.warn('[Confirmação do cadastro]', e?.message); }
  }
}

async function confirmaUma(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, io: Io): Promise<void> {
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const inicio = new Date(cf._autoStartedAt).getTime();
  if (!(inNoticeWindow() && (await whatsappWindowOpen(leadId)))) {
    if (Date.now() - inicio > WAIT_MAX_MS) await salvaConfirm(leadId, { status: 'EXPIRADO', at: new Date().toISOString() }); // não deu pra perguntar em 24 h: desiste (não bloqueia nada)
    return;
  }
  const participantes = participantesDoCard(cf);
  if (!participantes.length) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, leadName);
  const env = await sendOutboundWhatsApp({ accountId, leadId, content: cadConfirmText(participantes, nome), io: io as any });
  if (!env.success) return; // tenta no próximo minuto
  await salvaConfirm(leadId, { status: 'ASKED', at: new Date().toISOString(), participantes });
  await note(leadId, '🔎 Perguntei ao cliente se o nome, o CPF e a data de nascimento da proposta estão corretos (a análise de crédito segue normalmente). Se ele corrigir, o CRM atualiza o card e refaz a análise nos bancos.');
}

/** Bloco pro prompt da IA da conversa enquanto a confirmação do cadastro está em aberto (3 dias). '' se não houver. */
export function aiCadConfirmContext(cf: Record<string, any>): string {
  const cc = cf._cadConfirm as { status?: string; at?: string } | undefined;
  if (!cc || cc.status !== 'ASKED' || (cc.at && Date.now() - new Date(cc.at).getTime() > CONFIRM_ASK_VALID_MS)) return '';
  const lista = participantesDoCard(cf).map((p, i) => `  ${i + 1}) ${p.nome} — CPF ${p.cpf} — nascimento ${p.nascimento}`).join('\n');
  return `--- CONFIRMAÇÃO DO CADASTRO DA PROPOSTA (pergunta já feita ao cliente) ---
O CRM já perguntou se o nome, o CPF e a data de nascimento que vieram na proposta estão corretos (a análise de crédito JÁ está rodando: isto não a atrasa nem a impede). Dados do card:
${lista}
Quando o cliente responder:
- Se corrigir algum NOME, CPF ou DATA DE NASCIMENTO: grave em "extractedFields" SÓ os campos que mudam, com os valores CERTOS ("participante_1", "cpf_1", "nascimento_1", "participante_2", "cpf_2", "nascimento_2"; CPF só números; nascimento DD/MM/AAAA). Se faltar parte do dado, peça só o que falta. Diga que ajustou e que a análise será refeita com os dados certos (sem prazo).
- Se disser que está TUDO CERTO ("sim", "tudo certo", "confere"): grave "cadastro_confirmado": "Sim" e agradeça em uma frase curta; não peça mais nada por isso.
- Se a resposta não tiver a ver com a pergunta, responda normalmente à conversa e não insista. Nunca peça documento por isso e nunca fale de resultado de crédito.`;
}

async function confirmacaoRespondida(accountId: string, leadId: string, nome: string, campos: string[], mudouIdentidade: boolean): Promise<boolean> {
  if (!mudouIdentidade) {
    await salvaConfirm(leadId, { status: 'CONFIRMADO', confirmedAt: new Date().toISOString() });
    await note(leadId, '✅ O cliente confirmou que o nome, o CPF e a data de nascimento da proposta estão corretos.');
    return true;
  }
  const mudados = campos.filter((k) => CAMPOS_IDENTIDADE.includes(k));
  await salvaConfirm(leadId, { status: 'CORRIGIDO', correctedAt: new Date().toISOString(), campos: mudados });
  const { createRequests, BANK_KEYS } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const r = await createRequests(prisma as any, { accountId, leadIds: [leadId], banks: BANK_KEYS, dryRun: false, kind: 'RUN', source: 'AI', force: true, queueIfBusy: true });
  await note(leadId, `🔁 O cliente corrigiu dados da proposta (${mudados.join(', ')}): o card foi atualizado e refiz a análise em ${r.created} banco(s) com os dados certos.`);
  push(accountId, '🔁 Cadastro corrigido', `${nome}: análise refeita nos bancos com os dados corrigidos`, leadId);
  return true;
}
