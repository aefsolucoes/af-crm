import { PrismaClient } from '@prisma/client';
import { buildSharedAiContext, buildContextBlocks, CORE_RULES, stripOpeningInterjection } from './ai-shared.service';

const prisma = new PrismaClient();

/**
 * Sugestão de resposta pro COLABORADOR (não confundir com ai-auto-reply.
 * service.ts, que conversa direto com o cliente sozinho quando ligado numa
 * conversa). Aqui é sob demanda — o colaborador clica "Sugerir resposta"
 * quando trava numa objeção — e a IA nunca envia nada sozinha: só sugere um
 * texto, que fica no balão até o colaborador clicar "Usar" (coloca no campo
 * de digitar) e revisar/enviar ele mesmo.
 *
 * Usa o MESMO "cérebro" (ai-shared.service.ts) que o auto-reply — mesma
 * Base de Conhecimento, mesmas regras de confiança/tom. A única diferença
 * estrutural é que aqui NUNCA precisa decidir "chamar um humano" (o
 * vendedor já é o humano revisando), então não tem regras de handoff nem
 * formato JSON — só o texto puro da sugestão.
 */

const ROLE_FRAMING = `Você é um coach de vendas ajudando um vendedor da A&F Soluções Financeiras a responder um cliente pelo WhatsApp. Sugira o que ELE deveria escrever agora — você não fala com o cliente, o vendedor vai revisar e decidir se manda.`;

const OUTPUT_FORMAT = `FORMATO DE RESPOSTA — OBRIGATÓRIO:
Responda SOMENTE com o texto da mensagem sugerida — sem aspas, sem explicação, sem markdown.`;

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
    // Última mensagem do CLIENTE — é o foco da busca na Base de
    // Conhecimento (o que o vendedor está tentando responder/contornar
    // agora). Busca leve só pra achar esse foco e confirmar que existe
    // histórico; buildSharedAiContext monta o resto formatado.
    const recent = await prisma.message.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 12 });
    if (!recent.length) return null;
    const lastClientMsg = recent.find((m) => m.direction === 'INBOUND')?.content || '';

    const ctx = await buildSharedAiContext(accountId, leadId, lastClientMsg, {
      historyTake: 12,
      historyRoleLabels: { inbound: 'Cliente', outbound: 'Vendedor' },
    });
    if (!ctx) return null;

    const systemPrompt = `${ROLE_FRAMING}

${CORE_RULES}
${OUTPUT_FORMAT}

${buildContextBlocks(ctx)}`;

    // Achado real (2026-09-24): "às vezes" a sugestão falhava com o erro
    // genérico "sem histórico ou IA indisponível" mesmo numa conversa cheia
    // de mensagens -- confirmado via log que a chamada de verdade batia na
    // Anthropic (~5s, tempo de round-trip real), só que às vezes ela volta
    // 200 OK só que sem nenhum bloco de texto usável (raw vazio), e esse
    // caminho não logava nada, então não dava pra saber a causa real na
    // próxima vez que acontecesse. Uma segunda tentativa automática (sem
    // pedir pro usuário clicar de novo) resolve a maior parte dos casos
    // transitórios sozinha; se as duas falharem, agora fica registrado o
    // motivo de verdade (status, stop_reason, tipos de bloco devolvidos).
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          // 300 acabava no raciocínio do modelo e a sugestão vinha vazia (o
          // erro intermitente do "Sugerir resposta").
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: 'Sugira a próxima resposta.' }],
        }),
      });
      if (!response.ok) {
        console.error(`[AI Suggest-reply] Erro Anthropic (tentativa ${attempt}/2):`, response.status, (await response.text()).slice(0, 300));
        if (attempt === 2) return null;
        continue;
      }
      const data = await response.json() as { content: { type: string; text?: string }[]; stop_reason?: string };
      const raw = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
      if (!raw) {
        console.error(`[AI Suggest-reply] Resposta sem texto usável (tentativa ${attempt}/2): stop_reason=${data.stop_reason}, blocos=${JSON.stringify(data.content?.map((b) => b.type))}`);
        if (attempt === 2) return null;
        continue;
      }
      return { suggestion: stripOpeningInterjection(raw) };
    }
    return null;
  } catch (err) {
    console.error('[AI Suggest-reply] Erro ao gerar sugestão:', err);
    return null;
  }
}
