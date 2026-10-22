import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { cleanEmailForAi } from './ai-shared.service';
import { contractingAutoOn } from './contracting-auto.service';
import { callableFirstName } from '../lib/text';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * E-MAIL DO BANCO QUE PRECISA DO CLIENTE → AVISO AO CLIENTE (Fabio 22/10: "ela só encaminha algo ao cliente se chegar algo no e-mail que precise do cliente — exemplo esse do Pedro": o Inter pediu por e-mail o
 * documento que vincule a vaga de garagem ao apartamento). Poller (1 min): lê cada e-mail NOVO de banco/consultor ligado a um card aberto, a IA (Haiku) decide se o e-mail PEDE ALGO AO CLIENTE (documento, informação,
 * correção, assinatura, comparecimento) e, se sim, escreve 1–2 frases pro cliente. E-mail que só informa, resultado de crédito (aprovado/reprovado/condições), pedidos à A&F e e-mails automáticos NÃO geram nada.
 *  - SEMPRE: nota + push na equipe com o texto pronto (a equipe vê na hora o que o banco pediu).
 *  - Só MANDA ao cliente se a chave da contratação automática estiver LIGADA, a IA do card ligada, sem STOP TOTAL, dentro das 07h–21h e com a janela de 24 h do WhatsApp aberta; senão a nota diz o que falta
 *    (janela fechada: usar o template sugerido ou esperar o cliente responder — a IA já lê o e-mail quando ele escreve).
 * Só vale pra e-mails recebidos a partir de EMAIL_RELAY_FROM. Estado no card: customFields._emailRelay = { done: [ids de e-mail já tratados] }.
 */

export const EMAIL_RELAY_FROM = new Date('2026-10-22T13:00:00Z');
const INSTITUTIONAL = /@([a-z0-9-]+\.)*(inter\.co|bancointer\.com\.br|creditas\.(com|com\.br|io)|santander\.com\.br|bradesco\.com\.br|caixa\.gov\.br|credimorar\.com\.br)$/i;
const AUTOMATICO = /^(no-?reply|nao-?responda|do-?not-?reply|noreply|notificacao|notificacoes|alerta)/i;
const PER_TICK = 4;
const MODEL = 'claude-haiku-4-5-20251001';

export type RelayDecision = { needsClient: boolean; message: string; resumo: string };

const SYSTEM = `Você ajuda a A&F Soluções Financeiras (correspondente bancário, crédito com garantia de imóvel e financiamento habitacional). Chegou um E-MAIL de um banco/consultor sobre o processo de um cliente. Decida se o e-mail PEDE ALGO AO CLIENTE e, se pedir, escreva o aviso pro cliente.

IMPORTANTE: os e-mails do banco são SEMPRE escritos pra A&F (o correspondente), mesmo quando pedem algo que só o cliente consegue providenciar ("Prezado, se faz necessário documentação que…", "favor enviar…", "precisamos do aceite/dados do cliente…"). O que importa é QUEM consegue providenciar o que foi pedido.

"needsClient": true quando o que o e-mail pede só o CLIENTE consegue providenciar ou fazer: enviar/atualizar documento dele ou do imóvel (matrícula da vaga, certidão, comprovante, CNH, IPTU…), informar um dado pessoal, corrigir uma declaração dele, assinar, dar um aceite, comparecer, resolver uma pendência do imóvel ou da pessoa. Exemplo real: "Se faz necessário documentação que vincule a vaga de garagem à unidade. A matrícula não informa sobre vaga de garagem e o formulário indica 1 vaga." → needsClient true (o documento é do cliente/do imóvel), mensagem: "Pedro, o banco pediu um documento que mostre que a vaga de garagem pertence ao apartamento (a matrícula não cita a vaga). Pode ser a matrícula da vaga ou a escritura/convenção que fale dela. Consegue me mandar?".
"needsClient": false para: confirmação de recebimento ("fico no aguardo", "obrigado"), e-mail só informativo, agendamento que o banco/A&F resolve, pedido que a PRÓPRIA A&F resolve sozinha (reenviar documento que já temos, subir arquivo no portal, pedir vistoria, responder o banco), mensagens automáticas, engajamento, e QUALQUER resultado de crédito (aprovado, pré-aprovado, reprovado, condições, valor liberado) — isso nunca é avisado por aqui.

Se já foi avisado ao cliente o mesmo pedido (veja a conversa e os avisos anteriores abaixo), needsClient false.

"message" (só se needsClient): mensagem de WhatsApp em português do Brasil, BEM RESUMIDA (1 a 2 frases, até 330 caracteres), linguagem simples, tom natural da equipe, começando pelo primeiro nome do cliente. Diga SÓ o que o cliente precisa providenciar e como. Termine com um pedido claro ("Consegue me mandar?"). PROIBIDO na mensagem: dizer que o crédito foi aprovado/pré-aprovado, "parabéns", valores, taxa, juros, prazo/meses, parcela ou qualquer resultado de crédito (mesmo que o e-mail traga — o aviso de aprovação segue a regra própria do CRM); copiar o e-mail; citar nome de consultor/funcionário do banco, protocolo ou número de proposta; prometer prazo ou aprovação; usar "Show", "Perfeito" ou "Ok". "resumo": uma frase curta pra equipe do que o banco pediu (pode citar o pedido, sem valores).

Responda SOMENTE com JSON, sem markdown: {"needsClient":true|false,"resumo":"...","message":"..."}`;

/** O aviso nunca pode trazer resultado de crédito (regra do Fabio 19/10: aprovação só pelo aviso padrão do CRM). Pura (testável). */
export const temResultadoDeCredito = (t: string): boolean => /(aprovad|pr[eé]-?aprov|parab[eé]ns|cr[eé]dito (foi )?liberad|R\$\s*\d|\d+[.,]\d+\s*%|\bipca\b|\btaxa\b|\bjuros\b|\b\d{2,3}\s*(meses|parcelas)\b|\bparcelas? de\b)/i.test(String(t || ''));

/** Interpreta a resposta da IA (JSON, possivelmente com texto em volta). Pura (testável). */
export function parseRelayDecision(raw: string): RelayDecision | null {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const needs = j.needsClient === true;
    const message = String(j.message || '').replace(/\s+\n/g, '\n').trim().slice(0, 600);
    if (needs && message.length < 15) return null; // pediu algo mas não escreveu o aviso: não arrisca
    return { needsClient: needs, message: needs ? message : '', resumo: String(j.resumo || '').trim().slice(0, 240) };
  } catch { return null; }
}

async function ask(contexto: string, email: string): Promise<RelayDecision | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content: `${contexto}\n\n--- E-MAIL RECEBIDO ---\n${email}` }] }),
      });
      if (!r.ok) { console.error('[E-mail→cliente] Erro Anthropic:', r.status, (await r.text()).slice(0, 200)); continue; }
      const data = await r.json() as { content: { type: string; text?: string }[] };
      const d = parseRelayDecision(data.content?.find((b) => b.type === 'text')?.text || '');
      if (d) return d;
    } catch (e: any) { console.error('[E-mail→cliente] falha:', e?.message); }
  }
  return null;
}

const falhas = new Map<string, number>();
let running = false;
export async function processEmailRelay(accountId: string, io: Io): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await prisma.emailMessage.findMany({
      where: { folder: 'INBOX', leadId: { not: null }, date: { gte: EMAIL_RELAY_FROM }, emailAccount: { accountId }, lead: { is: { status: 'OPEN', archived: false, isGroup: false } } },
      orderBy: { date: 'asc' },
      take: 80,
      select: { id: true, leadId: true, fromAddress: true, subject: true, textBody: true, snippet: true, date: true },
    });
    const cand = rows.filter((e) => e.fromAddress && INSTITUTIONAL.test(e.fromAddress) && !AUTOMATICO.test(e.fromAddress.split('@')[0]) && !/Engajamento Autom[aá]tico/i.test(e.subject || ''));
    if (!cand.length) return;
    const leads = await prisma.lead.findMany({ where: { id: { in: [...new Set(cand.map((e) => e.leadId!))] } }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, stage: { select: { name: true } } } });
    const byId = new Map(leads.map((l) => [l.id, l]));
    let feitos = 0;
    for (const e of cand) {
      if (feitos >= PER_TICK) break;
      const lead = byId.get(e.leadId!);
      if (!lead) continue;
      const cf = (lead.customFields || {}) as Record<string, any>;
      const done: string[] = Array.isArray(cf._emailRelay?.done) ? cf._emailRelay.done : [];
      if (done.includes(e.id)) continue;
      if ((falhas.get(e.id) || 0) >= 5) continue; // IA fora do ar/resposta inválida 5 vezes: deixa quieto (não gasta a cada minuto)
      feitos++;
      try { await uma(accountId, lead, cf, done, e, io); } catch (err: any) { console.warn('[E-mail→cliente]', err?.message); }
    }
  } finally { running = false; }
}

async function marca(leadId: string, id: string, resultado: string) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  const done: string[] = Array.isArray(cf._emailRelay?.done) ? cf._emailRelay.done : [];
  cf._emailRelay = { done: [...done, id].slice(-40), lastAt: new Date().toISOString(), lastResult: resultado };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

async function uma(accountId: string, lead: { id: string; name: string; aiAutoReplyActive: boolean; customFields: any; stage: { name: string } | null }, cf: Record<string, any>, done: string[], e: { id: string; subject: string | null; textBody: string | null; snippet: string | null; date: Date; fromAddress: string | null }, io: Io) {
  void done;
  const limpo = cleanEmailForAi(`📧 ${e.subject || ''}\n${e.textBody || e.snippet || ''}`, 1500);
  if (limpo.body.length < 25) { await marca(lead.id, e.id, 'IGNORADO (curto)'); return; }

  const recentes = await prisma.message.findMany({ where: { leadId: lead.id, channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, take: 8, select: { direction: true, content: true } });
  const avisos = await prisma.note.findMany({ where: { leadId: lead.id, content: { startsWith: '📧 O banco pediu' }, createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 3, select: { content: true } });
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const contexto = [
    `Cliente: ${nome || '(sem nome utilizável)'} · etapa do card: ${lead.stage?.name || '?'}`,
    `--- CONVERSA RECENTE NO WHATSAPP ---\n${recentes.length ? recentes.reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'A&F'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n') : '(sem conversa)'}`,
    `--- AVISOS ANTERIORES SOBRE E-MAILS (últimos 3 dias) ---\n${avisos.length ? avisos.map((n) => n.content.replace(/\s+/g, ' ').slice(0, 260)).join('\n') : '(nenhum)'}`,
  ].join('\n\n');
  const d = await ask(contexto, `Assunto: ${limpo.subject}\n${limpo.body}`);
  if (!d) { falhas.set(e.id, (falhas.get(e.id) || 0) + 1); return; } // IA fora do ar / resposta inválida: tenta de novo no próximo minuto (até 5 vezes)
  if (!d.needsClient) { await marca(lead.id, e.id, 'IGNORADO (não pede nada ao cliente)'); return; }

  // Texto com resultado de crédito (aprovado, valor, taxa, prazo): NUNCA sai — a equipe escreve só o pedido (o resultado segue o aviso padrão de aprovação).
  const semTexto = temResultadoDeCredito(d.message);
  if (semTexto) d.message = '';
  // pedido ao cliente: decide se manda ou só avisa a equipe
  let enviado = false;
  let motivo = '';
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (semTexto) motivo = 'o texto sugerido trazia resultado de crédito (aprovação/valores) e foi descartado — escreva só o pedido, sem falar de aprovação';
  else if (!(await contractingAutoOn(accountId))) motivo = 'automação da contratação desligada — mande você';
  else if (!lead.aiAutoReplyActive) motivo = 'a IA deste card está desligada — mande você';
  else if (cf._autoPaused) motivo = 'o cliente está com STOP TOTAL — mande você';
  else if (!inNoticeWindow()) motivo = 'fora do horário (07h–21h) — mande você de manhã';
  else if (!(await whatsappWindowOpen(lead.id))) motivo = 'a janela de 24 h do WhatsApp está fechada — use um template (o sugerido em Templates) ou espere o cliente responder (a IA já lê o e-mail quando ele escrever)';
  else {
    const r = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: d.message, io: io as any });
    if (r.success) enviado = true; else motivo = `o envio falhou (${(r as any).error || 'erro'}) — mande você`;
  }
  await marca(lead.id, e.id, enviado ? 'ENVIADO ao cliente' : 'AVISOU a equipe');
  await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: enviado
    ? `📧 O banco pediu algo ao cliente por e-mail (${d.resumo || limpo.subject}). Repassei ao cliente pelo WhatsApp: “${d.message.replace(/\s+/g, ' ')}”`
    : `📧 O banco pediu algo ao cliente por e-mail: ${d.resumo || limpo.subject}. NÃO mandei: ${motivo}.${d.message ? ` Texto pronto: “${d.message.replace(/\\s+/g, ' ')}”` : ''}` } }).catch(() => {});
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: enviado ? '📧 Repassei o pedido do banco' : '📧 O banco pediu algo ao cliente', body: `${lead.name}: ${d.resumo || limpo.subject}`.slice(0, 140), leadId: lead.id }).catch(() => {}); } catch { /* aviso */ }
}
