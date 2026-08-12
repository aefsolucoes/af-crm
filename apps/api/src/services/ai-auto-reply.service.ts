import { PrismaClient } from '@prisma/client';
import { searchKnowledge } from './knowledge.service';

const prisma = new PrismaClient();

/**
 * Assistente de IA que conversa DIRETO com o cliente pelo WhatsApp (ligado por
 * conversa, via botão na Inbox — Lead.aiAutoReplyActive). Deliberadamente
 * separado do assistente interno (routes/ai.ts): aqui não tem ferramentas, só
 * gera texto — nunca move card, edita cadastro nem faz nenhuma ação no CRM.
 * Isolado num arquivo próprio (sem import de baileys.service/whatsapp.service)
 * pra evitar dependência circular nos dois canais que o chamam.
 */

const CLIENT_FACING_SYSTEM_PROMPT = `Você é o assistente de atendimento da A&F Soluções Financeiras, conversando DIRETAMENTE com um cliente pelo WhatsApp — isso não é uma conversa interna da equipe, é o próprio cliente do outro lado.

REGRAS OBRIGATÓRIAS, sem exceção:
- Responda só com base no material de referência (Base de Conhecimento) e no histórico desta conversa, abaixo. NUNCA invente valor, taxa, prazo, data ou qualquer promessa específica que não esteja claramente no material.
- Se não souber responder com segurança, diga com naturalidade que vai verificar com a equipe e que alguém retorna em breve — NUNCA chute uma resposta só para preencher.
- Nunca peça senha, número de cartão ou qualquer dado sensível. Nunca confirme decisão financeira em nome da empresa (aprovação de crédito, valor final de proposta etc) — isso sempre fica com um humano da equipe.
- Se o cliente pedir para falar com uma pessoa, ou parecer insatisfeito/impaciente/com um problema fora do comum, diga que vai chamar alguém da equipe para continuar com ele — não insista em resolver sozinho.
- Seja breve (1 a 3 frases na maioria das vezes), cordial e natural, como um atendente de verdade digitando no WhatsApp — não pareça um robô lendo um roteiro. Português do Brasil, sem formalidade excessiva.`;

/**
 * Gera a resposta do assistente para uma mensagem recebida de um cliente,
 * usando a Base de Conhecimento + histórico recente da conversa. Retorna null
 * (não responde) se faltar configuração ou algo der errado — nunca lança erro
 * pro chamador, pra não travar o fluxo de recebimento de mensagem.
 */
export async function generateAiAutoReply(accountId: string, leadId: string, incomingText: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !incomingText.trim()) return null;

  try {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return null;

    const recent = await prisma.message.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const historico = recent.reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${m.content}`).join('\n') || '(sem histórico anterior)';

    const hits = await searchKnowledge(accountId, incomingText, 5);
    const contexto = hits.length
      ? hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n')
      : '(nenhum material relevante encontrado na Base de Conhecimento para esta pergunta — se a dúvida do cliente depender disso, siga a regra de dizer que vai verificar com a equipe)';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        system: `${CLIENT_FACING_SYSTEM_PROMPT}\n\n--- BASE DE CONHECIMENTO (material de referência) ---\n${contexto}\n\n--- HISTÓRICO RECENTE DESTA CONVERSA ---\n${historico}`,
        messages: [{ role: 'user', content: incomingText }],
      }),
    });
    if (!response.ok) {
      console.error('[AI Auto-reply] Erro Anthropic:', response.status, (await response.text()).slice(0, 300));
      return null;
    }
    const data = await response.json() as { content: { type: string; text?: string }[] };
    return data.content?.find((b) => b.type === 'text')?.text?.trim() || null;
  } catch (err) {
    console.error('[AI Auto-reply] Erro ao gerar resposta:', err);
    return null;
  }
}
