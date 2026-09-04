import { PrismaClient } from '@prisma/client';
import { searchKnowledge } from './knowledge.service';

const prisma = new PrismaClient();

/**
 * Sugestão de resposta pro COLABORADOR (não confundir com ai-auto-reply.
 * service.ts, que conversa direto com o cliente sozinho quando ligado numa
 * conversa). Aqui é sob demanda — o colaborador clica "Sugerir resposta"
 * quando trava numa objeção — e a IA nunca envia nada sozinha: só sugere um
 * texto, que fica no balão até o colaborador clicar "Usar" (coloca no campo
 * de digitar) e revisar/enviar ele mesmo.
 *
 * Por isso o tom pode ser mais assertivo/persuasivo que o do auto-reply (tem
 * sempre um humano revisando antes de sair pro cliente) — mas a regra de
 * nunca inventar fato (valor, taxa, prazo, documento) continua igual, porque
 * um vendedor apressado pode copiar e colar sem checar.
 */

const SYSTEM_PROMPT = `Você é um coach de vendas ajudando um vendedor da A&F Soluções Financeiras a responder um cliente pelo WhatsApp. Sugira o que ELE deveria escrever agora — você não fala com o cliente, o vendedor vai revisar e decidir se manda.

REGRAS OBRIGATÓRIAS:
- Responda só com base no material de referência (Base de Conhecimento + Respostas Rápidas) e no histórico da conversa. NUNCA invente valor, taxa, prazo, documento ou qualquer fato específico que não esteja no material — se faltar informação pra sustentar um argumento, sugira uma resposta que peça a informação certa ou que avance a conversa sem citar o dado que falta.
- Foco em VENDER: entenda a última mensagem/objeção do cliente e sugira uma resposta que contorne a objeção, reforce o benefício certo pra esse cliente e conduza a conversa adiante (marcar um próximo passo, pedir um documento, agendar, confirmar interesse) — não só responda, avance o funil.
- Tom natural de conversa do dia a dia, como o vendedor normalmente escreve (ver estilo abaixo) — nunca pareça um roteiro decorado ou um robô.
- Sem emoji, a menos que o estilo do vendedor abaixo já use.
- Curto: 1 a 3 frases, do tamanho de uma mensagem de WhatsApp real.
- Responda SOMENTE com o texto da mensagem sugerida — sem aspas, sem explicação, sem markdown.`;

export interface ReplySuggestion {
  suggestion: string;
}

/** Gera 1 sugestão de resposta pro colaborador, com base no histórico recente
 *  da conversa + Base de Conhecimento + Respostas Rápidas do setor do lead
 *  (mesmo material que o auto-reply usa). Retorna null se faltar configuração,
 *  não houver histórico, ou algo der errado. */
export async function generateReplySuggestion(accountId: string, leadId: string): Promise<ReplySuggestion | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId },
      include: { pipeline: { include: { department: true } }, user: { select: { id: true, name: true } } },
    });
    if (!lead) return null;

    const recent = await prisma.message.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
    const ordered = recent.reverse();
    if (!ordered.length) return null;
    const historico = ordered.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Vendedor'}: ${m.content}`).join('\n');

    // Última mensagem do CLIENTE — é o que o vendedor está tentando
    // responder/contornar agora. Sem isso (só o vendedor falou por último,
    // ou não há mensagem de cliente ainda), ainda gera sugestão baseada no
    // histórico geral, só sem foco de busca na Base de Conhecimento.
    const lastClientMsg = [...ordered].reverse().find((m) => m.direction === 'INBOUND')?.content || '';

    const hits = lastClientMsg ? await searchKnowledge(accountId, lastClientMsg, 5) : [];
    const contexto = hits.length
      ? hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n')
      : '(nenhum material relevante encontrado na Base de Conhecimento — se a objeção depender de um fato específico, não invente; sugira avançar sem citar o dado que falta)';

    const department = lead.pipeline?.department;
    const templates = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        ...(department?.id ? { OR: [{ departmentId: department.id }, { departmentId: null }] } : {}),
      },
      orderBy: { name: 'asc' },
    });
    const respostasRapidas = templates.length
      ? templates.map((t) => `- "${t.name}": ${t.body}`).join('\n')
      : '(nenhuma resposta rápida cadastrada)';

    // Mesmo truque do auto-reply: imita o TOM do vendedor responsável usando
    // mensagens reais que ele já mandou (nunca o conteúdo/fatos delas).
    let estiloTexto = '(sem exemplos suficientes — escreva de forma natural e não robótica)';
    if (lead.userId) {
      const exemplos = await prisma.message.findMany({
        where: { direction: 'OUTBOUND', sentByUserId: lead.userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }).catch(() => []);
      const escolhidos = exemplos
        .map((m) => m.content.trim())
        .filter((c) => c.length >= 8 && c.length <= 300)
        .slice(0, 6);
      if (escolhidos.length) estiloTexto = escolhidos.map((c) => `- "${c}"`).join('\n');
    }

    const systemPrompt = `${SYSTEM_PROMPT}

--- ESTILO DE ESCRITA DO VENDEDOR (${lead.user?.name || 'sem responsável definido'}) ---
Imite só o TOM e o jeito de escrever destes exemplos reais dele(a) — nunca reaproveite o conteúdo/fatos, que são de outras conversas:
${estiloTexto}

--- BASE DE CONHECIMENTO (material de referência) ---
${contexto}

--- RESPOSTAS RÁPIDAS (modelos prontos da equipe) ---
${respostasRapidas}

--- HISTÓRICO RECENTE DESTA CONVERSA ---
${historico}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Sugira a próxima resposta.' }],
      }),
    });
    if (!response.ok) {
      console.error('[AI Suggest-reply] Erro Anthropic:', response.status, (await response.text()).slice(0, 300));
      return null;
    }
    const data = await response.json() as { content: { type: string; text?: string }[] };
    const raw = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
    if (!raw) return null;

    return { suggestion: raw };
  } catch (err) {
    console.error('[AI Suggest-reply] Erro ao gerar sugestão:', err);
    return null;
  }
}
