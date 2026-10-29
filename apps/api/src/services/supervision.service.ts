import { prisma } from '../lib/prisma';
import { buildSharedAiContext } from './ai-shared.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * SUPERVISÃO DE SEXTA (Fabio 28/10): toda sexta às 08:00 (Brasília) o CRM pega cada card ABERTO num funil "Em contratação…" (Home Equity e Habitacional),
 * lê a conversa inteira + o estado do card, e a IA escreve: resumo, onde o processo está, o que está pendente, a mensagem sugerida pro cliente e o que a equipe
 * deveria fazer. Manda UM push pro Fabio, que passa card por card em /supervisao: enviar a sugestão (editada ou não), abrir o card, marcar feito ou pular.
 * Sobrou pendente às 14:00 da sexta → um lembrete. Nada sai pro cliente sem clique. Janela de 24 h fechada = não dá pra mandar texto (a tela avisa).
 */

const MODEL = 'claude-sonnet-5';
const BRT = 3 * 3600_000;
const SUPERVISOR_EMAIL = 'fabio@aefsolucoesfinanceiras.com.br'; // Fabio 28/10: "pode mandar para mim"

const brtNow = () => new Date(Date.now() - BRT);
/** Data (BRT) da sexta desta semana, AAAA-MM-DD — chave da lista. */
export function weekKeyFor(d: Date = new Date()): string {
  const b = new Date(d.getTime() - BRT);
  const diff = (b.getUTCDay() - 5 + 7) % 7; // dias desde a última sexta
  b.setUTCDate(b.getUTCDate() - diff);
  return b.toISOString().slice(0, 10);
}

const SYSTEM = `Você é o supervisor de atendimento da A&F Soluções Financeiras (correspondente bancário: crédito com garantia de imóvel/Home Equity e financiamento habitacional).
Recebe UM cliente que está na fase de CONTRATAÇÃO (crédito aprovado; documentos, vistoria, contrato, registro). Leia a conversa inteira e o estado do card e escreva para o dono da empresa revisar, sem enrolação.

Responda SOMENTE com JSON, sem markdown:
{"resumo":"2 a 4 frases: quem é, o que já aconteceu e onde o processo está","situacao":"uma frase curta com a etapa real (ex.: aguardando o laudo do Inter)","pendencias":"o que falta, em itens separados por '; ' (vazio se nada)","sugestao":"a mensagem pronta para mandar ao cliente AGORA pelo WhatsApp, no tom da equipe, curta, sem emoji, chamando pelo primeiro nome — ou vazio se o certo agora é NÃO falar com o cliente (ex.: a bola está com o banco e ele já foi avisado ontem)","acao":"o que a equipe deveria fazer além da mensagem (cobrar o banco, pedir certidão, solicitar vistoria…) — ou vazio"}

Regras: nunca invente fato, valor ou prazo que não esteja na conversa/estado; nunca anuncie aprovação de crédito em texto livre; se o cliente fez uma pergunta que ficou sem resposta, a sugestão responde a pergunta (ou diz que a equipe vai verificar); se ele está parado há dias sem mandar o que falta, a sugestão cobra com gentileza o item específico.`;

function parse(raw: string): { resumo: string; situacao: string; pendencias: string; sugestao: string; acao: string } | null {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const s = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    if (!s(j.resumo, 10)) return null;
    return { resumo: s(j.resumo, 1200), situacao: s(j.situacao, 300), pendencias: s(j.pendencias, 600), sugestao: s(j.sugestao, 1500), acao: s(j.acao, 600) };
  } catch { return null; }
}

async function ask(contexto: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: contexto }] }),
      });
      if (!r.ok) { console.error('[Supervisão] Anthropic', r.status, (await r.text()).slice(0, 200)); continue; }
      const data = await r.json() as { content: { type: string; text?: string }[] };
      const out = parse(data.content?.find((b) => b.type === 'text')?.text || '');
      if (out) return out;
    } catch (e: any) { console.error('[Supervisão] falha:', e?.message); }
  }
  return null;
}

async function supervisorIds(accountId: string): Promise<string[]> {
  const u = await prisma.user.findFirst({ where: { accountId, email: SUPERVISOR_EMAIL }, select: { id: true } });
  return u ? [u.id] : [];
}

function push(accountId: string, ids: string[], title: string, body: string) {
  if (!ids.length) return;
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, url: '/supervisao' }, ids).catch(() => {}); } catch { /* aviso */ }
}

/** Monta (ou completa) a lista da semana. force = roda fora do horário (botão "Gerar agora"). Devolve quantos cards entraram. */
export async function buildWeeklySupervision(accountId: string, opts: { force?: boolean; notify?: boolean } = {}): Promise<{ weekKey: string; criados: number; total: number }> {
  const weekKey = weekKeyFor();
  const leads = await prisma.lead.findMany({
    where: { accountId, archived: false, status: 'OPEN', isGroup: false, pipeline: { name: { startsWith: 'Em contrata' } } },
    select: { id: true, name: true }, orderBy: { updatedAt: 'asc' },
  });
  const ja = new Set((await prisma.supervisionItem.findMany({ where: { accountId, weekKey }, select: { leadId: true } })).map((x) => x.leadId));
  let criados = 0;
  for (const l of leads) {
    if (ja.has(l.id)) continue;
    const ctx = await buildSharedAiContext(accountId, l.id, '', { fullHistory: true, historyRoleLabels: { inbound: 'Cliente', outbound: 'Atendente' } }).catch(() => null);
    if (!ctx) continue;
    const ultimaIn = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const janela = ultimaIn && Date.now() - ultimaIn.createdAt.getTime() < 23 * 3600_000 ? 'ABERTA (dá pra mandar texto)' : 'FECHADA (só template; a sugestão vai ser enviada pela equipe quando ele responder)';
    const hoje = brtNow().toISOString().slice(0, 10);
    const contexto = [
      `Hoje: ${hoje}. Cliente: ${l.name}. Etapa: ${ctx.etapaTexto}. Banco: ${ctx.bancoTexto || '?'}. Janela do WhatsApp: ${janela}.`,
      ctx.nomeTexto ? `Como chamar: ${ctx.nomeTexto}` : '',
      ctx.creditoTexto ? `--- ESTADO DO CARD ---\n${ctx.creditoTexto}` : '',
      `--- CONVERSA ---\n${ctx.historicoTexto}`,
    ].filter(Boolean).join('\n\n');
    const out = await ask(contexto);
    if (!out) continue;
    await prisma.supervisionItem.create({ data: { accountId, leadId: l.id, weekKey, ...out } }).catch(() => {});
    criados++;
  }
  const total = await prisma.supervisionItem.count({ where: { accountId, weekKey } });
  if (opts.notify !== false && total > 0) push(accountId, await supervisorIds(accountId), '📋 Supervisão de sexta', `${total} cliente(s) em contratação pra revisar, um por um.`);
  return { weekKey, criados, total };
}

const ran = new Set<string>();
/** Poller (1 min): sexta 08:00 monta a lista e avisa; sexta 14:00 lembra do que ficou. */
export async function processWeeklySupervision(): Promise<void> {
  const b = brtNow();
  if (b.getUTCDay() !== 5) return;
  const h = b.getUTCHours();
  const weekKey = weekKeyFor();
  const contas = await prisma.account.findMany({ select: { id: true } });
  for (const c of contas) {
    const kGerar = `${c.id}:${weekKey}:gerar`, kLembrar = `${c.id}:${weekKey}:lembrar`;
    if (h >= 8 && !ran.has(kGerar)) {
      ran.add(kGerar);
      const existe = await prisma.supervisionItem.count({ where: { accountId: c.id, weekKey } });
      if (!existe) await buildWeeklySupervision(c.id).catch((e) => console.error('[Supervisão] gerar:', e?.message));
    }
    if (h >= 14 && !ran.has(kLembrar)) {
      ran.add(kLembrar);
      const pend = await prisma.supervisionItem.count({ where: { accountId: c.id, weekKey, status: 'PENDING' } });
      if (pend > 0) push(c.id, await supervisorIds(c.id), '📋 Supervisão: ainda faltam clientes', `${pend} cliente(s) da lista de hoje ainda sem revisão.`);
    }
  }
}

export async function listSupervision(accountId: string, weekKey = weekKeyFor()) {
  const items = await prisma.supervisionItem.findMany({ where: { accountId, weekKey }, orderBy: { createdAt: 'asc' } });
  const leads = await prisma.lead.findMany({ where: { id: { in: items.map((i) => i.leadId) } }, select: { id: true, name: true, stage: { select: { name: true } }, pipeline: { select: { name: true } }, customFields: true } });
  const ultimaIn = await prisma.message.groupBy({ by: ['leadId'], where: { leadId: { in: items.map((i) => i.leadId) }, direction: 'INBOUND', channel: 'WHATSAPP' }, _max: { createdAt: true } });
  const porLead = new Map(leads.map((l) => [l.id, l]));
  const janela = new Map(ultimaIn.map((x) => [x.leadId, x._max.createdAt]));
  return {
    weekKey,
    items: items.map((i) => {
      const l = porLead.get(i.leadId);
      const last = janela.get(i.leadId);
      return {
        ...i, leadName: l?.name || '?', etapa: `${l?.pipeline?.name || ''} → ${l?.stage?.name || ''}`,
        banco: String(((l?.customFields || {}) as any).instituicao || ''),
        janelaAberta: !!last && Date.now() - new Date(last).getTime() < 23 * 3600_000,
      };
    }),
  };
}

export async function actOnSupervision(accountId: string, userId: string, id: string, acao: 'SEND' | 'SKIP' | 'DONE' | 'REOPEN', text?: string, io?: Io) {
  const it = await prisma.supervisionItem.findFirst({ where: { id, accountId } });
  if (!it) throw new Error('Item não encontrado');
  if (acao === 'SEND') {
    const t = String(text || '').trim();
    if (!t) throw new Error('Escreva a mensagem');
    const ultimaIn = await prisma.message.findFirst({ where: { leadId: it.leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!ultimaIn || Date.now() - ultimaIn.createdAt.getTime() >= 24 * 3600_000) throw new Error('A janela de 24 h do WhatsApp está fechada: abra o card e use um template.');
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r: any = await sendOutboundWhatsApp({ accountId, leadId: it.leadId, content: t, userId, io: io as any });
    if (!r.success) throw new Error(r.error || 'Falha ao enviar');
    return prisma.supervisionItem.update({ where: { id }, data: { status: 'SENT', sentText: t, handledAt: new Date() } });
  }
  const status = acao === 'SKIP' ? 'SKIPPED' : acao === 'DONE' ? 'DONE' : 'PENDING';
  return prisma.supervisionItem.update({ where: { id }, data: { status, handledAt: acao === 'REOPEN' ? null : new Date() } });
}
