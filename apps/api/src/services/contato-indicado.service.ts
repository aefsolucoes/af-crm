import { prisma } from '../lib/prisma';

/* ── Corretor/vendedor indicado pelo cliente do Financiamento Habitacional ──
 * Fabio 11/11 (Jaime mandou o cartão do corretor e o CRM descartou): "É normal o cliente passar o contato do corretor para solicitarmos a documentação
 * … o CRM chamar o corretor e solicitar a documentação do imóvel e do vendedor" + "isso pode ocorrer em caso de corretor e vendedor".
 *
 * 1. Cartão de contato que chega na conversa de um card do FH → fica em `_contatosIndicados` (PENDENTE).
 * 2. Poller (1 min): passados 2 min (o cliente costuma explicar logo depois, por áudio), a IA (Haiku) lê a conversa e diz se é o CORRETOR, o VENDEDOR ou outra
 *    pessoa. Outra pessoa → só anotação.
 * 3. Corretor/vendedor → card próprio pelo telefone (Caixa de Entrada), com a IA DESLIGADA e ligado ao card do cliente (`_terceiroDe`). Número que já é card
 *    de outro processo → só anotação + push (a equipe decide).
 * 4. Conversa aberta (24 h) → o pedido da documentação do imóvel e do vendedor sai na hora. Fechada → modelo da Meta (DOC_TEMPLATE, UTILITY; sem aprovação
 *    ainda, "ola_tudo_bem") e o pedido fica guardado pra sair na 1ª resposta (reply-pending).
 * 5. Arquivo que o corretor/vendedor manda → copiado pro card do cliente (conferência de documentos e pasta do Drive dele, como se o cliente tivesse mandado —
 *    Fabio 11/11: "Sim, pro card do cliente"). */

type Cf = Record<string, any>;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
export type ContatoIndicado = {
  nome: string; telefone: string; messageId: string | null; at: string;
  status: 'PENDENTE' | 'ENVIADO' | 'TEMPLATE' | 'IGNORADO' | 'EQUIPE' | 'FALHOU';
  papel?: 'corretor' | 'vendedor' | 'outro'; terceiroLeadId?: string; enviadoAt?: string; motivo?: string;
};
export type TerceiroDe = { leadId: string; cliente: string; papel: 'corretor' | 'vendedor'; at: string };

/** Modelo novo (UTILITY) pra abrir a conversa com quem o cliente indicou — {{1}} = nome do cliente. Enquanto a Meta não aprova, vai o "ola_tudo_bem". */
export const DOC_TEMPLATE = 'documentacao_imovel_indicacao';
export const DOC_TEMPLATE_BODY = 'Olá, tudo bem? {{1}} nos passou o seu contato para a documentação do imóvel do financiamento habitacional. Podemos te enviar por aqui a lista do que precisamos?';
const ESPERA_MS = 2 * 60_000;

const nota = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const soDigitos = (v: string) => String(v || '').replace(/\D/g, '');
const titulo = (s: string) => String(s || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E)\s/g, (m) => m.toLowerCase()).trim();

async function gravarIndicados(leadId: string, lista: ContatoIndicado[]): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_contatosIndicados}', ${JSON.stringify(lista.slice(-10))}::jsonb, true) WHERE id = ${leadId}`;
}
async function atualizarIndicado(leadId: string, telefone: string, patch: Partial<ContatoIndicado>): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const lista: ContatoIndicado[] = Array.isArray(((l?.customFields || {}) as Cf)._contatosIndicados) ? ((l!.customFields as Cf)._contatosIndicados) : [];
  await gravarIndicados(leadId, lista.map((c) => (soDigitos(c.telefone) === soDigitos(telefone) ? { ...c, ...patch } : c)));
}

/** Webhook: cartão de contato recebido. Só Financiamento Habitacional, card aberto, cliente (não grupo nem card de corretor/vendedor). */
export async function registrarContatoIndicado(accountId: string, leadId: string, contato: { nome: string; telefone: string }, messageId: string | null): Promise<void> {
  if (soDigitos(contato.telefone).length < 10) return;
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN', isGroup: false }, select: { customFields: true, contact: { select: { phone: true, whatsappPhone: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l || !/habitacional/i.test(l.pipeline?.department?.name || '')) return;
  const cf = (l.customFields || {}) as Cf;
  if (cf._terceiroDe) return;
  const tel = soDigitos(contato.telefone);
  const proprio = [l.contact?.phone, l.contact?.whatsappPhone].map((x) => soDigitos(String(x || ''))).filter(Boolean);
  if (proprio.some((p) => p.slice(-8) === tel.slice(-8))) return; // o cliente mandou o próprio contato
  const lista: ContatoIndicado[] = Array.isArray(cf._contatosIndicados) ? cf._contatosIndicados : [];
  if (lista.some((c) => soDigitos(c.telefone).slice(-8) === tel.slice(-8))) return; // mesmo contato de novo (o WhatsApp manda o cartão duas vezes às vezes)
  lista.push({ nome: contato.nome, telefone: contato.telefone, messageId, at: new Date().toISOString(), status: 'PENDENTE' });
  await gravarIndicados(leadId, lista);
}

/** Corretor, vendedor ou outra pessoa? Lê as últimas mensagens do cliente (com a transcrição dos áudios). */
async function papelDoContato(leadId: string, nome: string): Promise<'corretor' | 'vendedor' | 'outro' | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const hist = await prisma.message.findMany({ where: { leadId, deleted: false }, orderBy: { createdAt: 'desc' }, take: 14, select: { direction: true, content: true } });
  const conversa = hist.reverse().map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : 'ATENDENTE'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      system: 'Conversa de um correspondente bancário (financiamento habitacional) com o cliente que está COMPRANDO um imóvel. O cliente mandou um cartão de contato ("📇 Contato: …"). Decida, pelo que o cliente disse antes ou depois do cartão, quem é essa pessoa: "corretor" (corretor/imobiliária que está vendendo o imóvel), "vendedor" (dono/proprietário que está vendendo o imóvel) ou "outro" (parente, cônjuge, gerente de banco, outro cliente, ou não dá pra saber). Responda SÓ com JSON: {"papel":"corretor"|"vendedor"|"outro"}.',
      messages: [{ role: 'user', content: `Contato compartilhado: ${nome || '(sem nome)'}\n\nConversa:\n${conversa}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  const out = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const m = /"papel"\s*:\s*"(corretor|vendedor|outro)"/i.exec(out);
  return m ? (m[1].toLowerCase() as 'corretor' | 'vendedor' | 'outro') : null;
}

/** Itens (linhas com •) de uma Resposta Rápida — a equipe muda a lista por lá. */
async function itensDaResposta(accountId: string, nome: string): Promise<string[]> {
  const t = await prisma.messageTemplate.findFirst({ where: { accountId, name: { equals: nome, mode: 'insensitive' } }, select: { body: true } });
  return String(t?.body || '').split('\n').map((l) => l.trim()).filter((l) => /^[•\-–]/.test(l)).map((l) => l.replace(/^[•\-–]\s*/, '').replace(/:\s*$/, '').trim())
    .filter((l) => l && !/^(e-?mail|telefone)$/i.test(l));
}

/** Pedido da documentação do imóvel e do vendedor (Respostas Rápidas "Documentos imóvel para vistoria" e "Documentos vendedor do imóvel"). */
export async function textoPedido(accountId: string, p: { nome: string; cliente: string; papel: 'corretor' | 'vendedor' }): Promise<string> {
  const imovel = (await itensDaResposta(accountId, 'Documentos imóvel para vistoria')).length ? await itensDaResposta(accountId, 'Documentos imóvel para vistoria') : ['Certidão de ônus', 'CND de IPTU'];
  const vendBase = await itensDaResposta(accountId, 'Documentos vendedor do imóvel');
  const vendedor = [...(vendBase.length ? vendBase : ['Documento de identificação', 'Comprovante de residência', 'Estado civil', 'Conta para crédito']), 'E-mail e telefone'];
  const primeiro = (p.nome || '').trim().split(/\s+/)[0] || '';
  const oi = `Oi${primeiro ? ` ${titulo(primeiro)}` : ''}, tudo bem? Cuidamos do financiamento habitacional de ${p.cliente}, que nos passou o seu contato.`;
  const quem = p.papel === 'vendedor' ? '*Seus documentos (vendedor):*' : '*Do vendedor:*';
  return `${oi} Pra seguir com o processo, a gente precisa da documentação do imóvel${p.papel === 'vendedor' ? ' e a sua' : ' e do vendedor'}:\n\n*Do imóvel:*\n${imovel.map((i) => `• ${i}`).join('\n')}\n\n${quem}\n${vendedor.map((i) => `• ${i}`).join('\n')}\n\nPode mandar por aqui mesmo. Obrigado!`;
}

/** Poller (1 min, laço do credit-auto). */
export async function processContatosIndicados(accountId: string, io?: Io): Promise<void> {
  const { inNoticeWindow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const leads = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND jsonb_typeof("customFields"->'_contatosIndicados') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements("customFields"->'_contatosIndicados') c WHERE c->>'status' = 'PENDENTE')
    LIMIT 5`;
  for (const { id } of leads) await processarCard(accountId, id, io).catch((e) => console.error('[Contato indicado]', e?.message));
}

async function processarCard(accountId: string, leadId: string, io?: Io): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, userId: true, customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const lista: ContatoIndicado[] = Array.isArray(cf._contatosIndicados) ? cf._contatosIndicados : [];
  for (const c of lista.filter((x) => x.status === 'PENDENTE')) {
    if (Date.now() - Date.parse(c.at) < ESPERA_MS) continue;
    await chamarIndicado(accountId, leadId, { name: l!.name, userId: l!.userId, cf }, c, io);
  }
}

/** Chama o corretor/vendedor indicado. Exportada pra rodar à mão num contato que se perdeu antes da correção (Jaime, 11/11). */
export async function chamarIndicado(accountId: string, leadId: string, lead: { name: string; userId: string | null; cf: Cf }, c: Pick<ContatoIndicado, 'nome' | 'telefone'> & { papel?: ContatoIndicado['papel'] }, io?: Io): Promise<string> {
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  const pushColab = (title: string, body: string) => sendPushToAccount(accountId, { title, body, leadId }, lead.userId ? [lead.userId] : undefined).catch(() => {});
  const papel = c.papel && c.papel !== 'outro' ? c.papel : await papelDoContato(leadId, c.nome);
  if (!papel) return 'não consegui ler a conversa agora (tento de novo no próximo minuto)';
  const quem = `${c.nome || 'sem nome'} (${c.telefone})`;
  if (papel === 'outro') {
    await atualizarIndicado(leadId, c.telefone, { status: 'IGNORADO', papel });
    await nota(leadId, `📇 O cliente mandou o contato de ${quem}. Pela conversa não é o corretor nem o vendedor do imóvel, então o CRM não chamou essa pessoa. Se for, chame você.`);
    return 'ignorado (não é corretor/vendedor)';
  }
  const rotulo = papel === 'corretor' ? 'corretor' : 'vendedor';
  const cliente = titulo(String(lead.cf.participante_1 || lead.name.split('/')[0] || lead.name));
  const { findOrCreateLeadByPhone, sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  const r = await findOrCreateLeadByPhone(accountId, c.telefone, c.nome || undefined);
  if (!r) {
    await atualizarIndicado(leadId, c.telefone, { status: 'FALHOU', papel, motivo: 'não criou o card do contato' });
    await nota(leadId, `⚠️ O cliente mandou o contato do ${rotulo} ${quem}, mas não consegui criar a conversa com ele. Chame você e peça a documentação do imóvel e do vendedor.`);
    pushColab(`⚠️ ${lead.name}: chamar o ${rotulo}`, `${quem} — o CRM não conseguiu abrir a conversa`);
    return 'falhou ao criar o card';
  }
  const t = await prisma.lead.findUnique({ where: { id: r.leadId }, select: { name: true, status: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  const tcf = (t?.customFields || {}) as Cf;
  const deOutroProcesso = !r.created && !(tcf._terceiroDe?.leadId === leadId) && (!!t?.pipeline?.department || !!tcf._terceiroDe);
  if (deOutroProcesso) {
    await atualizarIndicado(leadId, c.telefone, { status: 'EQUIPE', papel, terceiroLeadId: r.leadId, motivo: 'número já é de outro card' });
    await nota(leadId, `📇 O cliente mandou o contato do ${rotulo} ${quem}, mas esse número já é de outro card ("${t?.name || '—'}"), então o CRM não mandou nada sozinho. Peça você a documentação do imóvel e do vendedor.`);
    pushColab(`📇 ${lead.name}: contato do ${rotulo}`, `${quem} já tem card no CRM — peça você a documentação`);
    return 'número já é de outro card';
  }
  const vinculo: TerceiroDe = { leadId, cliente, papel, at: new Date().toISOString() };
  await prisma.$executeRaw`UPDATE "Lead" SET "aiAutoReplyActive" = false, "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_terceiroDe}', ${JSON.stringify(vinculo)}::jsonb, true) WHERE id = ${r.leadId}`;
  await nota(r.leadId, `📇 ${titulo(rotulo)} do imóvel de ${cliente} (card "${lead.name}"), indicado pelo cliente. A IA fica DESLIGADA nesta conversa; os arquivos que chegarem aqui vão sozinhos pro card do cliente.`);
  const texto = await textoPedido(accountId, { nome: c.nome, cliente, papel });
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  let status: ContatoIndicado['status'];
  let como: string;
  if (await whatsappWindowOpen(r.leadId)) {
    const env = await sendOutboundWhatsApp({ accountId, leadId: r.leadId, content: texto, io: io as any });
    if (!env.success) { await atualizarIndicado(leadId, c.telefone, { status: 'FALHOU', papel, terceiroLeadId: r.leadId, motivo: env.error }); await nota(leadId, `⚠️ Não consegui mandar o pedido da documentação ao ${rotulo} ${quem}: ${env.error}.`); pushColab(`⚠️ ${lead.name}: chamar o ${rotulo}`, String(env.error || '').slice(0, 100)); return 'falhou ao enviar'; }
    status = 'ENVIADO'; como = 'mandou o pedido da documentação do imóvel e do vendedor';
  } else {
    const first = cliente.split(' ')[0] ? cliente : 'O cliente';
    let tpl = await sendOutboundWhatsAppTemplate({ accountId, leadId: r.leadId, templateName: DOC_TEMPLATE, language: 'pt_BR', bodyParams: [first], previewText: DOC_TEMPLATE_BODY.replace('{{1}}', first), io: io as any });
    if (!tpl.success) tpl = await sendOutboundWhatsAppTemplate({ accountId, leadId: r.leadId, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: io as any });
    if (!tpl.success) { await atualizarIndicado(leadId, c.telefone, { status: 'FALHOU', papel, terceiroLeadId: r.leadId, motivo: tpl.error }); await nota(leadId, `⚠️ Não consegui abrir a conversa com o ${rotulo} ${quem} (modelo da Meta): ${tpl.error}. Chame você.`); pushColab(`⚠️ ${lead.name}: chamar o ${rotulo}`, String(tpl.error || '').slice(0, 100)); return 'falhou o modelo'; }
    const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
    await queueOnReply(prisma as any, { leadId: r.leadId, label: 'documentação do imóvel e do vendedor', text: texto, noteText: `⏳ O pedido da documentação do imóvel e do vendedor sai assim que ${c.nome || 'o contato'} responder.` });
    status = 'TEMPLATE'; como = 'abriu a conversa com o modelo da Meta; o pedido da documentação do imóvel e do vendedor sai quando ele responder';
  }
  await atualizarIndicado(leadId, c.telefone, { status, papel, terceiroLeadId: r.leadId, enviadoAt: new Date().toISOString() });
  await nota(leadId, `📇 O cliente passou o contato do ${rotulo} ${quem}: o CRM ${como}. Os arquivos que ele mandar vêm sozinhos pra este card.`);
  pushColab(`📇 ${lead.name}: ${rotulo} chamado`, `${c.nome || c.telefone}: pedida a documentação do imóvel e do vendedor`);
  return status === 'ENVIADO' ? 'pedido enviado' : 'modelo enviado, pedido guardado';
}

/** Webhook: arquivo que chegou na conversa de um corretor/vendedor indicado → cópia no card do cliente (Fabio 11/11). `buffer` = bytes do arquivo (o
 *  original sobe pro Drive e sai do banco logo depois). */
export async function repassarArquivoDoTerceiro(accountId: string, terceiroLeadId: string, arq: { fileName: string; mimeType: string; caption?: string | null; buffer: Buffer }, io?: Io): Promise<void> {
  const t = await prisma.lead.findFirst({ where: { id: terceiroLeadId, accountId }, select: { name: true, customFields: true } });
  const v = ((t?.customFields || {}) as Cf)._terceiroDe as TerceiroDe | undefined;
  if (!t || !v?.leadId) return;
  const cliente = await prisma.lead.findFirst({ where: { id: v.leadId, accountId }, select: { id: true, name: true, userId: true } });
  if (!cliente) return;
  const de = `${v.papel === 'corretor' ? 'Corretor' : 'Vendedor'} ${t.name}`;
  const message = await prisma.message.create({
    data: {
      content: `📎 ${arq.fileName}${arq.caption ? ` — ${arq.caption}` : ''}`, direction: 'INBOUND', channel: 'WHATSAPP', leadId: cliente.id, read: false, status: 'DELIVERED',
      forwardedFromLeadId: terceiroLeadId, forwardedFromLeadName: de,
      attachments: { create: { leadId: cliente.id, fileName: arq.fileName, mimeType: arq.mimeType, data: arq.buffer } },
    },
    include: { attachments: true },
  });
  if (io) io.to(`lead:${cliente.id}`).emit('new_message', message);
  const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
  for (const att of message.attachments || []) autoUploadAttachmentToDrive(accountId, cliente.id, att.id).catch((e: any) => console.error('[Drive] arquivo do corretor/vendedor:', e?.message));
  const { scheduleDocsCheck } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  scheduleDocsCheck(accountId, cliente.id, io as any).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `📎 ${cliente.name}: documento do ${v.papel}`, body: `${arq.fileName} (de ${t.name}) — copiado pro card do cliente`, leadId: cliente.id }, cliente.userId ? [cliente.userId] : undefined).catch(() => {});
}

/** Linha pro ESTADO DO CARD da IA do cliente: quem o CRM já chamou (ela não promete chamar de novo nem pede o contato outra vez). */
export function aiContatosIndicadosTexto(cf: Cf): string {
  const lista: ContatoIndicado[] = Array.isArray(cf._contatosIndicados) ? cf._contatosIndicados : [];
  const feitos = lista.filter((c) => c.status === 'ENVIADO' || c.status === 'TEMPLATE');
  if (!feitos.length) return '';
  return feitos.map((c) => `${c.papel === 'vendedor' ? 'vendedor' : 'corretor'} ${c.nome || c.telefone} (indicado pelo cliente): o CRM já chamou e pediu a documentação do imóvel e do vendedor em ${String(c.enviadoAt || c.at).slice(0, 10).split('-').reverse().join('/')}${c.status === 'TEMPLATE' ? ' — esperando ele responder' : ''}; o que ele mandar vem pra este card`).join('; ');
}
