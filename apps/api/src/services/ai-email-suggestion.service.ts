import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { fixedRule } from './fixed-rules.service';
import { buildSharedAiContext, buildContextBlocks, stripOpeningInterjection, todayContextLine } from './ai-shared.service';
import { searchKnowledge } from './knowledge.service';
import { htmlToText } from './email-inbox.service';

/**
 * "Sugerir resposta" na janela de e-mail (pedido do Fabio 28/09) — mesmo
 * espírito do botão da conversa (ai-reply-suggestion.service.ts): a IA só
 * SUGERE o texto, quem revisa e envia é a pessoa. Usa o e-mail que está
 * sendo respondido + o card/conversa do cliente (se o e-mail estiver
 * vinculado a um card) + Base de Conhecimento. Assinatura não entra no texto
 * (o CRM coloca sozinho no envio).
 */


const EMAIL_RULES = `Você ajuda a equipe da A&F Soluções Financeiras (correspondente bancário: financiamento habitacional, crédito com garantia de imóvel/Home Equity, consórcio) a responder e-mails de clientes. Sugira o CORPO do e-mail que a pessoa deveria mandar agora — ela vai revisar antes de enviar.
REGRAS:
- Responda com base no material de referência abaixo (Base de Conhecimento, Respostas Rápidas, dados do card, conversa). NUNCA invente valor, taxa, prazo, documento ou fato que não esteja no material; se faltar algo pra responder, diga que vai verificar e retorna.
- Nunca prometa aprovação. A A&F é correspondente: quem aprova e libera o crédito são os bancos parceiros.
- Tom de e-mail cordial e direto, português do Brasil, sem formalidade exagerada. Comece com "Olá, <primeiro nome>," (ou "Olá," se não souber o nome) e termine com uma frase curta de fechamento (ex.: "Qualquer dúvida, fico à disposição."). Parágrafos curtos.
- Responda o que o cliente perguntou/pediu no e-mail e conduza pro próximo passo (proposta, documentos, retorno).
- Depois do "Olá", vá direto ao assunto — sem elogio ou interjeição ("Boa pergunta!", "Que ótimo!", "Perfeito!").
- SEM assinatura, SEM nome de quem envia, SEM linha de assunto, SEM markdown (nada de ** ou #). Só o texto do corpo.
- Se já houver um rascunho, melhore/complete mantendo a intenção dele.`;

export async function generateEmailReplySuggestion(params: {
  accountId: string;
  replyTo?: { fromName: string | null; fromAddress: string | null; subject: string | null; date: Date; textBody: string | null; htmlBody: string | null; leadId: string | null } | null;
  leadId?: string | null;
  subject?: string;
  to?: string;
  draft?: string;
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const { accountId, replyTo } = params;

  const original = replyTo
    ? (replyTo.textBody?.trim() || (replyTo.htmlBody ? htmlToText(replyTo.htmlBody) : '') || '').slice(0, 8000)
    : '';
  const leadId = params.leadId || replyTo?.leadId || null;
  const focus = [replyTo?.subject, original].filter(Boolean).join('\n').slice(0, 2000) || params.subject || '';

  let contextBlocks = '';
  if (leadId) {
    const ctx = await buildSharedAiContext(accountId, leadId, focus, { historyTake: 10, historyRoleLabels: { inbound: 'Cliente', outbound: 'Equipe' } });
    if (ctx) contextBlocks = buildContextBlocks(ctx);
  }
  if (!contextBlocks && focus) {
    const hits = await searchKnowledge(accountId, focus, 6).catch(() => []);
    if (hits.length) contextBlocks = `--- BASE DE CONHECIMENTO (trechos relevantes) ---\n${hits.map((h) => `- ${h.content}`).join('\n')}`;
  }

  const emailBlock = replyTo
    ? `--- E-MAIL QUE ESTÁ SENDO RESPONDIDO ---
De: ${replyTo.fromName ? `${replyTo.fromName} <${replyTo.fromAddress}>` : replyTo.fromAddress}
Data: ${replyTo.date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
Assunto: ${replyTo.subject || '(sem assunto)'}

${original || '(sem texto)'}`
    : `--- E-MAIL NOVO ---
Para: ${params.to || '(não informado)'}
Assunto: ${params.subject || '(sem assunto)'}
(Não é resposta: sugira um e-mail adequado pro momento do cliente, com base no card e na conversa.)`;

  const emailRules = await fixedRule(accountId, 'EMAIL_SUGGESTION_RULES', EMAIL_RULES);
  const system = `${emailRules}

${contextBlocks}

${emailBlock}${params.draft?.trim() ? `\n\n--- RASCUNHO JÁ ESCRITO ---\n${params.draft.trim().slice(0, 4000)}` : ''}

FORMATO: responda SOMENTE com o texto do corpo do e-mail.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // O raciocínio conta no limite — limite baixo deixa a resposta vazia.
        max_tokens: 6000,
        system,
        messages: [{ role: 'user', content: replyTo ? 'Sugira a resposta a esse e-mail.' : 'Sugira o e-mail.' }],
      }),
    });
    if (!res.ok) {
      console.error(`[E-mail] Sugestão falhou (${res.status}) tentativa ${attempt}/2`);
      continue;
    }
    const data = await res.json() as { content: { type: string; text?: string }[] };
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
    if (text) return stripOpeningInterjection(text.replace(/\*\*/g, ''));
  }
  return null;
}

/** Documento que a pessoa deu pra IA LER (não vai anexado no e-mail): só PDF e imagem. */
export interface DocParaLer { name: string; mimeType: string; buffer: Buffer }

const EMAIL_COMPOSE_RULES = `Você escreve e-mails em nome da A&F Soluções Financeiras (correspondente bancário: financiamento habitacional, crédito com garantia de imóvel/Home Equity, consórcio). A pessoa da equipe está numa conversa de WhatsApp (com cliente, gerente de banco, correspondente, cartório…) e quer um e-mail montado A PARTIR dessa conversa. Ela vai revisar antes de enviar.
REGRAS:
- Entenda pela conversa PRA QUEM é o e-mail e O QUE ele precisa resolver. Ex.: o gerente do banco disse "sugiro enviar um e-mail pra plataforma explicando…" → o e-mail vai pra plataforma, explica o caso como o gerente orientou e cita que foi por indicação dele. Se a pessoa da equipe escreveu o objetivo (PEDIDO DA EQUIPE), ele manda sobre a conversa.
- "para": só um endereço de e-mail que aparece ESCRITO na conversa, no pedido, no card ou nos documentos. Nunca invente nem deduza endereço; sem endereço certo, deixe vazio.
- Use os DOCUMENTOS PRA LER pra tirar os dados que o e-mail precisa (nome completo, CPF, endereço do imóvel, matrícula, número de contrato/proposta, valores) — só o que for útil pro objetivo do e-mail, copiado exatamente como está no documento. Dado necessário que não está em lugar nenhum → [preencher: o que falta]. NUNCA invente valor, taxa, prazo, número ou fato.
- Conte o caso de forma clara e completa pra quem não viu a conversa: situação, o que se quer, e as perguntas numeradas quando houver mais de uma.
- Tom profissional e cordial, português do Brasil. Cumprimento: "Prezados," pra setor/caixa de e-mail; "Olá, <primeiro nome>," pra pessoa. Parágrafos curtos. Fecho curto ("Fico no aguardo.").
- Nada interno do CRM (notas, IA, etiquetas, etapas do funil) e nenhuma promessa de aprovação — quem aprova é o banco.
- SEM assinatura e SEM nome de quem envia (o CRM coloca a assinatura sozinho). SEM markdown (nada de ** ou #).`;

/** "Criar com IA" na janela de e-mail (Fabio 03/11): a IA lê a conversa INTEIRA do card (+ o e-mail respondido, se for resposta) e os documentos que a pessoa
 *  deu pra ela ler, e devolve para/assunto/corpo. Diferente da "Sugerir resposta": o e-mail pode ir pra outra pessoa que não a da conversa (ex.: a plataforma do banco). */
export async function generateEmailFromConversation(params: {
  accountId: string;
  leadId?: string | null;
  replyTo?: { fromName: string | null; fromAddress: string | null; subject: string | null; date: Date; textBody: string | null; htmlBody: string | null; leadId: string | null } | null;
  instruction?: string;
  to?: string;
  subject?: string;
  draft?: string;
  docs?: DocParaLer[];
}): Promise<{ to: string; subject: string; body: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const { accountId, replyTo } = params;
  const leadId = params.leadId || replyTo?.leadId || null;
  const instrucao = (params.instruction || '').trim().slice(0, 2000);

  let contato = '';
  let blocos = '';
  if (leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, contact: { select: { name: true, email: true } } } });
    contato = lead?.contact?.name || lead?.name || '';
    const ctx = await buildSharedAiContext(accountId, leadId, instrucao || params.subject || '', { fullHistory: true, historyRoleLabels: { inbound: contato || 'Contato', outbound: 'A&F (nós)' } });
    if (ctx) {
      blocos = `--- ${todayContextLine()} ---

--- CONTATO DA CONVERSA ---
${contato || '(sem nome)'}${lead?.contact?.email ? ` — e-mail no card: ${lead.contact.email}` : ''}
${ctx.nomeTexto}

--- CARD NO CRM (funil → etapa) ---
${ctx.etapaTexto}${ctx.bancoTexto ? `\nBanco do card: ${ctx.bancoTexto}` : ''}${ctx.creditoTexto ? `\n${ctx.creditoTexto}` : ''}

--- BASE DE CONHECIMENTO (referência) ---
${ctx.contextoTexto}

--- CONVERSA DE WHATSAPP (inteira) ---
${ctx.historicoTexto}`;
    }
  }
  const original = replyTo ? (replyTo.textBody?.trim() || (replyTo.htmlBody ? htmlToText(replyTo.htmlBody) : '') || '').slice(0, 8000) : '';
  const emailBlock = replyTo
    ? `\n\n--- E-MAIL QUE ESTÁ SENDO RESPONDIDO ---
De: ${replyTo.fromName ? `${replyTo.fromName} <${replyTo.fromAddress}>` : replyTo.fromAddress}
Data: ${replyTo.date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
Assunto: ${replyTo.subject || '(sem assunto)'}

${original || '(sem texto)'}`
    : '';
  const jaEscrito = [
    params.to?.trim() ? `Para (já preenchido): ${params.to.trim()}` : '',
    params.subject?.trim() ? `Assunto (já preenchido): ${params.subject.trim()}` : '',
    params.draft?.trim() ? `Rascunho já escrito (melhore/complete mantendo a intenção):\n${params.draft.trim().slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n');

  const rules = await fixedRule(accountId, 'EMAIL_COMPOSE_RULES', EMAIL_COMPOSE_RULES);
  const system = `${rules}

${blocos || '(e-mail sem conversa vinculada)'}${emailBlock}${jaEscrito ? `\n\n--- O QUE JÁ ESTÁ NA JANELA DO E-MAIL ---\n${jaEscrito}` : ''}

FORMATO: responda SOMENTE com um JSON: {"para": "endereço ou vazio", "assunto": "...", "corpo": "texto do e-mail, com \\n entre parágrafos"}`;

  const docs = (params.docs || []).filter((d) => d.buffer.length);
  const content: any[] = [];
  docs.forEach((d, i) => {
    content.push({ type: 'text', text: `Documento ${i + 1} pra ler: ${d.name}` });
    content.push(d.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.buffer.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.buffer.toString('base64') } });
  });
  content.push({ type: 'text', text: `${instrucao ? `PEDIDO DA EQUIPE: ${instrucao}\n\n` : ''}${replyTo ? 'Escreva a resposta a esse e-mail.' : 'Escreva o e-mail com base na conversa.'}${docs.length ? ' Use os documentos acima pros dados que o e-mail precisar.' : ''}` });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // O raciocínio conta no limite — limite baixo deixa a resposta vazia.
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) {
      console.error(`[E-mail] Criar com IA falhou (${res.status}) tentativa ${attempt}/2: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const data = await res.json() as { content: { type: string; text?: string }[] };
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]) as { para?: string; assunto?: string; corpo?: string };
      const body = stripOpeningInterjection(String(j.corpo || '').replace(/\*\*/g, '').trim());
      if (!body) continue;
      const para = String(j.para || '').trim();
      return { to: /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(para) ? para : '', subject: String(j.assunto || '').trim().slice(0, 250), body };
    } catch { continue; }
  }
  return null;
}
