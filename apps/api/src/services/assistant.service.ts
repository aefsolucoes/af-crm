import { prisma } from '../lib/prisma';

/**
 * ASSISTENTE DO CRM (Fabio 26/10: "preciso que abra o chat para que eu possa pedir qualquer coisa sobre qualquer cliente a ele, inclusive simulação —
 * ex.: preciso da simulação do cliente X, ele me retorna com o PDF").
 * Chat da EQUIPE (não do cliente) com o Claude usando ferramentas que leem o CRM de verdade: achar cliente, ver o card inteiro (estado da análise,
 * documentos, contratação, conversa, notas, tarefas), ver as análises de crédito, listar clientes por etapa e pedir a simulação em PDF — que fica
 * SÓ pra equipe (status PRIVATE, nunca vai ao cliente) e aparece no chat com o botão "Abrir PDF".
 * Nesta versão o assistente NÃO manda mensagem a cliente nem altera card (só lê e pede a simulação). O antigo balão (removido em 08/09) não volta.
 */

const MODEL = 'claude-sonnet-5';
const MAX_TURNS = 8;

export type ChatMsg = { role: 'user' | 'assistant'; content: string };
export type ChatAttachment = { type: 'simulation'; id: string; banco: string; leadName: string };

const TOOLS = [
  {
    name: 'buscar_clientes',
    description: 'Procura clientes (cards) pelo nome do titular ou do 2º participante, CPF, telefone ou nº da proposta. Devolve até 10, do mais recente pro mais antigo.',
    input_schema: { type: 'object', properties: { termo: { type: 'string', description: 'nome, parte do nome, CPF, telefone ou nº da proposta' } }, required: ['termo'] },
  },
  {
    name: 'ver_cliente',
    description: 'Tudo sobre um cliente: dados do card (participantes, CPF, valores, banco, proposta, troco, saldo devedor…), funil/etapa, estado no CRM (análise de crédito, documentos, contratação, agenda), últimas mensagens da conversa, notas e tarefas abertas.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, mensagens: { type: 'number', description: 'quantas mensagens recentes trazer (padrão 15, máx. 40)' } }, required: ['leadId'] },
  },
  {
    name: 'analises_credito',
    description: 'Histórico das análises de crédito do cliente nos bancos (Inter, Creditas, Santander/Credimorar): status, valor aprovado, líquido, prazo, taxa, 1ª/última parcela, nº da proposta, em nome de quem.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] },
  },
  {
    name: 'listar_clientes',
    description: 'Lista clientes por etapa e/ou funil (ex.: etapa "Pré-Analise", "Aguardando Documentação", "Vistoria"; funil "Vendas", "Em contratação"). Padrão: só abertos, os 20 mais recentes.',
    input_schema: { type: 'object', properties: { etapa: { type: 'string' }, funil: { type: 'string' }, incluirFechados: { type: 'boolean' }, limite: { type: 'number' } } },
  },
  {
    name: 'pedir_simulacao_pdf',
    description: 'Pede a simulação em PDF (modelo A&F) de um banco APROVADO do cliente. O PDF é gerado pela extensão do banco (1 a 2 min) e fica SÓ pra equipe: aparece aqui no chat com o botão "Abrir PDF" — NÃO vai pro cliente. Bancos: INTER ou SANTANDER (o da Creditas está desativado).',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' }, banco: { type: 'string', enum: ['INTER', 'SANTANDER'] } }, required: ['leadId', 'banco'] },
  },
  {
    name: 'ver_simulacoes',
    description: 'Simulações em PDF já pedidas pra esse cliente (pro cliente ou só pra equipe), com o status de cada uma.',
    input_schema: { type: 'object', properties: { leadId: { type: 'string' } }, required: ['leadId'] },
  },
];

const corta = (t: unknown, n: number) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const quando = (d: Date | null | undefined) => (d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

async function buscarClientes(accountId: string, termo: string) {
  const t = String(termo || '').trim();
  if (t.length < 2) return { erro: 'termo muito curto' };
  const dig = t.replace(/\D/g, '');
  const like = `%${t}%`;
  const digLike = dig.length >= 4 ? `%${dig}%` : '%__nada__%';
  const rows = await prisma.$queryRaw<any[]>`
    SELECT l.id, l.name, l.status, l.archived, s.name AS etapa, p.name AS funil, l."updatedAt",
           l."customFields"->>'participante_2' AS p2, l."customFields"->>'cpf_1' AS cpf1, l."customFields"->>'num_proposta' AS proposta, c.phone, c."whatsappPhone"
    FROM "Lead" l LEFT JOIN "Stage" s ON s.id = l."stageId" LEFT JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Contact" c ON c.id = l."contactId"
    WHERE l."accountId" = ${accountId} AND l."isGroup" = false AND (
      l.name ILIKE ${like} OR coalesce(l."customFields"->>'participante_1', '') ILIKE ${like} OR coalesce(l."customFields"->>'participante_2', '') ILIKE ${like}
      OR regexp_replace(coalesce(l."customFields"->>'cpf_1', '') || ' ' || coalesce(l."customFields"->>'cpf_2', ''), '\\D', '', 'g') LIKE ${digLike}
      OR regexp_replace(coalesce(c.phone, '') || ' ' || coalesce(c."whatsappPhone", ''), '\\D', '', 'g') LIKE ${digLike}
      OR regexp_replace(coalesce(l."customFields"->>'num_proposta', ''), '\\D', '', 'g') LIKE ${digLike}
      OR EXISTS (SELECT 1 FROM "CreditAnalysis" ca WHERE ca."leadId" = l.id AND regexp_replace(coalesce(ca."proposalNumber", ''), '\\D', '', 'g') LIKE ${digLike})
    )
    ORDER BY l."updatedAt" DESC LIMIT 10`;
  return rows.map((r) => ({ leadId: r.id, nome: r.name, segundoParticipante: r.p2 || null, cpf: r.cpf1 || null, telefone: r.whatsappPhone || r.phone || null, funil: r.funil, etapa: r.etapa, status: r.archived ? 'ARQUIVADO' : r.status, atualizado: quando(r.updatedAt), proposta: r.proposta || null }));
}

const CAMPOS_CARD = ['participante_1', 'cpf_1', 'nascimento_1', 'renda_1', 'vinculo_1', 'email_1', 'participante_2', 'cpf_2', 'nascimento_2', 'renda_2', 'falando_com', 'falando_com_relacao',
  'valor_imovel', 'valor_credito', 'prazo_financ', 'instituicao', 'num_proposta', 'valor_aprovado', 'primeira_parcela', 'ultima_parcela', 'taxa_efetiva', 'troco', 'saldo_devedor',
  'imovel_tipo', 'imovel_cep', 'imovel_numero', 'cidade', 'uf', 'possui_certidao', 'cadastro_confirmado', 'link_pasta_drive', 'link_laudo_inter', 'contato_vistoria'];

async function verCliente(accountId: string, leadId: string, nMsgs = 15) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    select: { id: true, name: true, status: true, archived: true, value: true, lostReason: true, aiAutoReplyActive: true, createdAt: true, customFields: true,
      stage: { select: { name: true } }, pipeline: { select: { name: true, department: { select: { name: true } } } }, contact: { select: { name: true, phone: true, whatsappPhone: true, email: true } }, user: { select: { name: true } } },
  });
  if (!lead) return { erro: 'cliente não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const card: Record<string, unknown> = {};
  for (const k of CAMPOS_CARD) if (cf[k] !== undefined && cf[k] !== null && String(cf[k]).trim() !== '') card[k] = cf[k];
  const { aiCardState } = require('./ai-shared.service') as typeof import('./ai-shared.service');
  const [estado, msgs, notas, tarefas] = await Promise.all([
    aiCardState(leadId).catch(() => ''),
    prisma.message.findMany({ where: { leadId, deleted: false }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(Number(nMsgs) || 15, 1), 40), select: { createdAt: true, direction: true, channel: true, content: true, sentByUserId: true, templateName: true } }),
    prisma.note.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 12, select: { createdAt: true, content: true } }),
    prisma.task.findMany({ where: { leadId, done: false }, orderBy: { dueAt: 'asc' }, take: 5, select: { title: true, dueAt: true } }),
  ]);
  return {
    leadId: lead.id, nome: lead.name, status: lead.archived ? 'ARQUIVADO' : lead.status, motivoPerda: lead.lostReason || null, setor: lead.pipeline?.department?.name || null, funil: lead.pipeline?.name, etapa: lead.stage?.name,
    responsavel: lead.user?.name || null, iaLigada: lead.aiAutoReplyActive, valorDaVenda: lead.value, criadoEm: quando(lead.createdAt),
    contato: { nome: lead.contact?.name, telefone: lead.contact?.whatsappPhone || lead.contact?.phone, email: lead.contact?.email },
    card, estadoNoCrm: estado || '(sem análise, documentos ou contratação registrados)',
    conversa: msgs.reverse().map((m) => `[${quando(m.createdAt)}] ${m.direction === 'INBOUND' ? 'Cliente' : m.templateName ? `Template ${m.templateName}` : m.sentByUserId ? 'Equipe' : 'IA/CRM'}${m.channel === 'EMAIL' ? ' (e-mail)' : ''}: ${corta(m.content, 400)}`),
    notas: notas.map((n) => `[${quando(n.createdAt)}] ${corta(n.content, 300)}`),
    tarefasAbertas: tarefas.map((t) => `${t.title} — ${quando(t.dueAt)}`),
  };
}

async function analisesCredito(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true } });
  if (!lead) return { erro: 'cliente não encontrado' };
  const rows = await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false }, orderBy: { createdAt: 'desc' }, take: 25,
    select: { bank: true, kind: true, status: true, source: true, createdAt: true, holderName: true, requestedValue: true, approvedValue: true, netValue: true, termMonths: true, rate: true, firstInstallment: true, lastInstallment: true, proposalNumber: true, detail: true, chosen: true } });
  const nome: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander (Credimorar)' };
  return rows.map((r) => ({ banco: nome[r.bank] || r.bank, tipo: r.kind === 'CHECK' ? 'conferência' : 'rodada', status: r.status, quando: quando(r.createdAt), emNomeDe: r.holderName, pedido: r.requestedValue, aprovado: r.approvedValue, liquido: r.netValue, prazoMeses: r.termMonths, taxa: r.rate, primeiraParcela: r.firstInstallment, ultimaParcela: r.lastInstallment, proposta: r.proposalNumber, escolhida: r.chosen || undefined, detalhe: corta(r.detail, 260) }));
}

async function listarClientes(accountId: string, p: { etapa?: string; funil?: string; incluirFechados?: boolean; limite?: number }) {
  const limite = Math.min(Math.max(Number(p.limite) || 20, 1), 40);
  const rows = await prisma.lead.findMany({
    where: { accountId, isGroup: false, archived: false, ...(p.incluirFechados ? {} : { status: 'OPEN' }), ...(p.etapa ? { stage: { name: { contains: String(p.etapa), mode: 'insensitive' } } } : {}), ...(p.funil ? { pipeline: { name: { contains: String(p.funil), mode: 'insensitive' } } } : {}) },
    orderBy: { updatedAt: 'desc' }, take: limite,
    select: { id: true, name: true, status: true, updatedAt: true, stage: { select: { name: true } }, pipeline: { select: { name: true } } },
  });
  return rows.map((r) => ({ leadId: r.id, nome: r.name, funil: r.pipeline?.name, etapa: r.stage?.name, status: r.status, atualizado: quando(r.updatedAt) }));
}

async function pedirSimulacao(accountId: string, userId: string, leadId: string, banco: string, anexos: ChatAttachment[]) {
  const inst = /santander|credimorar/i.test(banco) ? 'SANTANDER' : /inter/i.test(banco) ? 'INTER' : '';
  if (!inst) return { erro: 'banco inválido: use INTER ou SANTANDER (o PDF da Creditas está desativado)' };
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) return { erro: 'cliente não encontrado' };
  const { requestSimulationDocs } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
  const r = await requestSimulationDocs(prisma as any, { accountId, leadId, institutions: [inst], userId, source: 'ASSISTANT' });
  if (!r.created.length) return { erro: `já existe uma simulação do ${inst === 'INTER' ? 'Inter' : 'Santander'} sendo gerada pra esse cliente — espere ela terminar` };
  anexos.push({ type: 'simulation', id: r.created[0].id, banco: inst, leadName: lead.name });
  return { ok: true, pedido: r.created[0].id, aviso: 'A extensão do banco gera o PDF em 1 a 2 minutos (o Chrome com a extensão precisa estar aberto). Ele aparece no chat com o botão "Abrir PDF" e NÃO vai pro cliente.' };
}

async function verSimulacoes(accountId: string, leadId: string, anexos: ChatAttachment[]) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) return { erro: 'cliente não encontrado' };
  const rows = await prisma.simulationDocRequest.findMany({ where: { accountId, leadId }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, institution: true, status: true, source: true, createdAt: true, detail: true, pdf: false } });
  const comPdf = await prisma.simulationDocRequest.findMany({ where: { accountId, leadId, status: 'PRIVATE', NOT: { pdf: null } }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, institution: true } });
  if (comPdf[0]) anexos.push({ type: 'simulation', id: comPdf[0].id, banco: comPdf[0].institution, leadName: lead.name });
  return rows.map((r) => ({ banco: r.institution, status: r.status === 'PRIVATE' ? 'PRONTO (só pra equipe — botão Abrir PDF no chat)' : r.status === 'DONE' ? 'ENVIADO AO CLIENTE pelo WhatsApp' : r.status, pedidoPor: r.source, quando: quando(r.createdAt), detalhe: corta(r.detail, 200) }));
}

function systemPrompt(userName: string): string {
  const agora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
  return `Você é o assistente interno do CRM da A&F Soluções Financeiras (correspondente bancário: crédito com garantia de imóvel/Home Equity, financiamento habitacional e consórcio). Quem fala com você é ${userName}, da EQUIPE — nunca um cliente.
Agora: ${agora} (Brasília).
- Responda em português, curto e direto, com os dados reais do CRM: SEMPRE use as ferramentas antes de afirmar algo sobre um cliente; nunca invente número, data ou status.
- Pra achar o cliente use buscar_clientes; se vier mais de um com o nome, liste (nome, etapa, CPF) e pergunte qual — a menos que só um faça sentido.
- Simulação em PDF: use pedir_simulacao_pdf com o banco APROVADO do cliente (veja analises_credito ou o campo instituicao do card). Diga que o PDF aparece aqui no chat em 1–2 min (botão "Abrir PDF") e que ele NÃO vai pro cliente. Creditas não tem PDF.
- Você só LÊ o CRM e pede simulações: não manda mensagem ao cliente, não muda card, etapa nem análise. Se pedirem isso, diga como fazer na tela (ex.: botão no card, aba Análise de Crédito).
- Valores em reais no formato R$ 1.234,56; datas em dd/mm.`;
}

async function runTool(accountId: string, userId: string, name: string, input: any, anexos: ChatAttachment[]): Promise<unknown> {
  try {
    switch (name) {
      case 'buscar_clientes': return await buscarClientes(accountId, input?.termo);
      case 'ver_cliente': return await verCliente(accountId, String(input?.leadId || ''), input?.mensagens);
      case 'analises_credito': return await analisesCredito(accountId, String(input?.leadId || ''));
      case 'listar_clientes': return await listarClientes(accountId, input || {});
      case 'pedir_simulacao_pdf': return await pedirSimulacao(accountId, userId, String(input?.leadId || ''), String(input?.banco || ''), anexos);
      case 'ver_simulacoes': return await verSimulacoes(accountId, String(input?.leadId || ''), anexos);
      default: return { erro: `ferramenta desconhecida: ${name}` };
    }
  } catch (e: any) {
    return { erro: String(e?.message || e).slice(0, 300) };
  }
}

export async function assistantChat(p: { accountId: string; userId: string; userName: string; messages: ChatMsg[] }): Promise<{ reply: string; attachments: ChatAttachment[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('IA indisponível (sem chave da Anthropic)');
  const history = p.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()).slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length) throw new Error('mensagem vazia');
  const msgs: any[] = [...history];
  const anexos: ChatAttachment[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: systemPrompt(p.userName), tools: TOOLS, messages: msgs }),
    });
    if (!res.ok) throw new Error(`IA indisponível (${res.status}) ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const data = (await res.json()) as { content: any[]; stop_reason: string };
    const blocks = data.content || [];
    const usos = blocks.filter((b) => b.type === 'tool_use');
    if (!usos.length || data.stop_reason !== 'tool_use') {
      const reply = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: reply || '(sem resposta)', attachments: dedupe(anexos) };
    }
    msgs.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const u of usos) {
      const out = await runTool(p.accountId, p.userId, u.name, u.input, anexos);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 30_000) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return { reply: 'Precisei de passos demais pra responder isso — tente perguntar de forma mais direta (ex.: o nome do cliente e o que você quer saber).', attachments: dedupe(anexos) };
}

function dedupe(a: ChatAttachment[]): ChatAttachment[] {
  const vistos = new Set<string>();
  return a.filter((x) => (vistos.has(x.id) ? false : (vistos.add(x.id), true)));
}

/** Status de uma simulação pedida pelo assistente (o chat consulta até ficar pronta). */
export async function assistantSimulationStatus(accountId: string, id: string) {
  const r = await prisma.simulationDocRequest.findFirst({ where: { id, accountId }, select: { id: true, status: true, institution: true, detail: true, finishedAt: true, leadId: true } });
  if (!r) return null;
  const hasPdf = !!(await prisma.simulationDocRequest.count({ where: { id, NOT: { pdf: null } } }));
  return { ...r, hasPdf };
}

export async function assistantSimulationPdf(accountId: string, id: string): Promise<{ pdf: Buffer; fileName: string } | null> {
  const r = await prisma.simulationDocRequest.findFirst({ where: { id, accountId }, select: { pdf: true, institution: true, leadId: true } });
  if (!r?.pdf) return null;
  const lead = await prisma.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
  const nome = String(lead?.name || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return { pdf: Buffer.from(r.pdf), fileName: `AeF_${r.institution}_${nome || 'cliente'}.pdf` };
}

/** Só leitura — usado em teste local das ferramentas. */
export const _assistantReadTools = { buscarClientes, verCliente, analisesCredito, listarClientes };
