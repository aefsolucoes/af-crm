import { PrismaClient } from '@prisma/client';
import { buildSharedAiContext, buildContextBlocks, stripOpeningInterjection } from './ai-shared.service';
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

const prisma = new PrismaClient();

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

  const system = `${EMAIL_RULES}

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
