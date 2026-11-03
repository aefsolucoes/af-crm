import { prisma } from '../lib/prisma';
import { buildSharedAiContext, todayContextLine, CORE_RULES } from './ai-shared.service';
import { fixedRule } from './fixed-rules.service';

/**
 * "Converse sobre este cliente" dentro do Resumo (Fabio 03/11): a equipe pergunta qualquer coisa sobre o cliente ("por que demorou pra finalizar?") e a IA responde com TUDO
 * que o CRM sabe dele — conversa inteira, card, anotações, análises de crédito (com as datas de pedido/resultado), documentos, tarefas, e-mails vinculados e o registro de atividade.
 * Também sugere a mensagem pro cliente (ou avisa que precisa de template, com a conversa fechada). Só responde — não manda nada, não mexe no card e não desliga a IA do card.
 */

type Turno = { role: 'user' | 'assistant'; text: string };

const dt = (d: Date | null | undefined) => (d ? new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16).replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$3/$2 ') : '-');
const corta = (s: string | null | undefined, n: number) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Linha do tempo do cliente no CRM, pra IA explicar o "porquê" das coisas (datas de cada passo). */
export async function dossieCliente(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { name: true, createdAt: true, stageEnteredAt: true, status: true, lostReason: true, value: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { name: true } }, user: { select: { name: true } } },
  });
  if (!lead) return '';
  const [notas, analises, tarefas, emails, atividade, anexos] = await Promise.all([
    prisma.note.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 200, select: { createdAt: true, type: true, content: true, user: { select: { name: true } } } }),
    prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false }, orderBy: { createdAt: 'asc' }, take: 80, select: { bank: true, kind: true, status: true, requestedAt: true, startedAt: true, finishedAt: true, approvedValue: true, requestedValue: true, termMonths: true, rate: true, detail: true, chosen: true } }),
    prisma.task.findMany({ where: { leadId }, orderBy: { dueAt: 'asc' }, take: 40, select: { title: true, dueAt: true, done: true } }),
    prisma.emailMessage.findMany({ where: { leadId }, orderBy: { date: 'desc' }, take: 30, select: { date: true, folder: true, fromName: true, fromAddress: true, toList: true, subject: true, snippet: true, textBody: true } }),
    prisma.activityLog.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 60, select: { createdAt: true, userName: true, summary: true } }),
    prisma.messageAttachment.findMany({ where: { leadId }, select: { id: true, fileName: true, createdAt: true } }),
  ]);
  const cf = (lead.customFields || {}) as Record<string, any>;
  const quando = new Map(anexos.map((a) => [a.id, a]));
  const docs = Object.entries((cf._docReview || {}) as Record<string, any>).map(([id, r]) => {
    const a = quando.get(id);
    return `- ${dt(a?.createdAt)} ${r?.tipo || '?'}${r?.titular ? ` (${r.titular})` : ''}${r?.dono ? ` — dono: ${r.dono}${r.donoSituacao ? ` [${r.donoSituacao}]` : ''}` : ''} → ${r?.resultado || '?'}${r?.problemas?.length ? `: ${corta(r.problemas.join('; '), 200)}` : ''}${r?.emissao ? ` (emissão ${r.emissao})` : ''}${a?.fileName ? ` — ${a.fileName}` : ''}`;
  });
  const campos = Object.entries(cf).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '' && typeof v !== 'object').slice(0, 60).map(([k, v]) => `${k}: ${corta(String(v), 120)}`);
  return [
    `--- CARD ---
Nome: ${lead.name} | Funil: ${lead.pipeline?.name || '-'} → ${lead.stage?.name || '-'} (desde ${dt(lead.stageEnteredAt)}) | Status: ${lead.status}${lead.lostReason ? ` (${lead.lostReason})` : ''} | Criado: ${dt(lead.createdAt)} | Responsável: ${lead.user?.name || '-'}${lead.value ? ` | Valor da venda: R$ ${lead.value}` : ''}
${campos.join(' | ')}`,
    analises.length ? `--- ANÁLISES DE CRÉDITO (pedido → início → resultado) ---\n${analises.map((a) => `- ${a.bank} ${a.kind} ${a.status}${a.chosen ? ' ⭐' : ''}: pedida ${dt(a.requestedAt)}, começou ${dt(a.startedAt)}, terminou ${dt(a.finishedAt)}${a.approvedValue ? ` | aprovado R$ ${a.approvedValue}` : a.requestedValue ? ` | pedido R$ ${a.requestedValue}` : ''}${a.termMonths ? ` ${a.termMonths}m` : ''}${a.rate ? ` ${a.rate}` : ''}${a.detail ? ` | ${corta(a.detail, 220)}` : ''}`).join('\n')}` : '',
    docs.length ? `--- DOCUMENTOS LIDOS (quando chegou → leitura) ---\n${docs.join('\n')}` : '',
    tarefas.length ? `--- TAREFAS ---\n${tarefas.map((t) => `- ${dt(t.dueAt)} ${t.done ? '[feita]' : '[aberta]'} ${corta(t.title, 160)}`).join('\n')}` : '',
    emails.length ? `--- E-MAILS VINCULADOS AO CLIENTE (mais antigos primeiro) ---\n${emails.reverse().map((e) => `- ${dt(e.date)} ${e.folder === 'SENT' ? 'ENVIADO' : 'RECEBIDO'} de ${e.fromName || e.fromAddress || '?'}${Array.isArray(e.toList) ? ` para ${(e.toList as any[]).map((x) => x?.address || x).join(', ')}` : ''} — "${corta(e.subject, 120)}": ${corta(e.textBody || e.snippet, 600)}`).join('\n')}` : '',
    notas.length ? `--- ANOTAÇÕES DO CARD (mais antigas primeiro) ---\n${notas.reverse().map((n) => `- ${dt(n.createdAt)} [${n.type}${n.user?.name ? ` · ${n.user.name}` : ''}] ${corta(n.content, 400)}`).join('\n')}` : '',
    atividade.length ? `--- REGISTRO DE ATIVIDADE ---\n${atividade.reverse().map((a) => `- ${dt(a.createdAt)} ${a.userName}: ${corta(a.summary, 160)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

const CHAT_RULES = `Você é o assistente da equipe da A&F Soluções Financeiras (correspondente bancário: financiamento habitacional, Home Equity, consórcio) e conhece este cliente por completo — tudo abaixo vem do CRM. A pessoa da equipe vai te fazer perguntas sobre ele.
- Responda à pergunta com base SÓ nesses dados. Quando a pergunta for "por que demorou", "o que aconteceu", "onde travou", monte a linha do tempo com as datas e diga quanto tempo cada etapa levou e de quem foi a demora (cliente, equipe, banco, extensão) — ex.: "a análise do Inter foi pedida em 10/10 e o resultado só saiu em 15/10 (5 dias)", "o cliente levou 3 dias pra mandar a certidão de ônus atualizada".
- Direto e curto, português do Brasil, sem markdown pesado (pode usar "-" pra lista). Não invente; se o dado não está aqui, diga que o CRM não tem.
- Se a pessoa pedir (ou se ajudar) uma mensagem pro cliente, escreva em "mensagem" o texto pronto, seguindo as REGRAS DA IA DA CONVERSA abaixo (curta, sem prometer aprovação, no tom da equipe). Com a conversa do WhatsApp FECHADA (mais de 24 h sem mensagem do cliente), texto livre não sai: marque "template": true e diga na resposta que precisa de um template pra abrir a conversa.
- Você não manda nada nem mexe no card: só responde e sugere.`;

export async function perguntarSobreCliente(accountId: string, leadId: string, pergunta: string, historico: Turno[] = []): Promise<{ resposta: string; mensagem: string | null; template: boolean; janelaAberta: boolean } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !pergunta.trim()) return null;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, contact: { select: { name: true } } } });
  if (!lead) return null;
  const nome = lead.contact?.name || lead.name || 'Cliente';
  const [ctx, dossie, core, ultimaDoCliente] = await Promise.all([
    buildSharedAiContext(accountId, leadId, pergunta, { fullHistory: true, historyRoleLabels: { inbound: nome, outbound: 'A&F (nós)' } }),
    dossieCliente(leadId),
    fixedRule(accountId, 'CORE_RULES', CORE_RULES),
    prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  if (!ctx) return null;
  const janelaAberta = !!ultimaDoCliente && Date.now() - ultimaDoCliente.createdAt.getTime() < 24 * 3_600_000;
  const system = `${CHAT_RULES}

--- ${todayContextLine()} ---
Conversa do WhatsApp: ${janelaAberta ? 'ABERTA (texto livre sai)' : 'FECHADA (precisa de template pra abrir)'}.

--- ESTADO DO CARD (o mesmo que a IA da conversa vê) ---
${ctx.etapaTexto}${ctx.bancoTexto ? `\nBanco do card: ${ctx.bancoTexto}` : ''}${ctx.creditoTexto ? `\n${ctx.creditoTexto}` : ''}${ctx.perdidoTexto ? `\n${ctx.perdidoTexto}` : ''}

${dossie}

--- CONVERSA DO WHATSAPP (inteira) ---
${ctx.historicoTexto}

--- BASE DE CONHECIMENTO (trechos ligados à pergunta) ---
${ctx.contextoTexto}

--- REGRAS DA IA DA CONVERSA (pra sugerir mensagem) ---
${core}

FORMATO: responda SOMENTE com um JSON: {"resposta": "texto pra equipe", "mensagem": "texto pronto pro cliente ou null", "template": true ou false}`;

  const messages = [
    ...historico.slice(-10).map((t) => ({ role: t.role, content: corta(t.text, 4000) || '.' })),
    { role: 'user' as const, content: pergunta.trim().slice(0, 4000) },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      // O raciocínio conta no limite — limite baixo deixa a resposta vazia.
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, system, messages }),
    });
    if (!res.ok) { console.error(`[Chat do cliente] falhou (${res.status}) tentativa ${attempt}/2`); continue; }
    const data = await res.json() as { content: { type: string; text?: string }[] };
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { if (text && attempt === 2) return { resposta: text.replace(/\*\*/g, ''), mensagem: null, template: false, janelaAberta }; continue; }
    try {
      const j = JSON.parse(m[0]) as { resposta?: string; mensagem?: string | null; template?: boolean };
      const resposta = String(j.resposta || '').replace(/\*\*/g, '').trim();
      if (!resposta) continue;
      const mensagem = j.mensagem && String(j.mensagem).trim() && String(j.mensagem).trim() !== 'null' ? String(j.mensagem).trim() : null;
      return { resposta, mensagem, template: !!j.template || (!!mensagem && !janelaAberta), janelaAberta };
    } catch { continue; }
  }
  return null;
}
