import { buildSharedAiContext, buildContextBlocks, buildFillableFieldsText, CORE_RULES } from './ai-shared.service';

/**
 * Assistente de IA que conversa DIRETO com o cliente pelo WhatsApp (ligado por
 * conversa, via botão na Inbox — Lead.aiAutoReplyActive). Deliberadamente
 * separado do assistente interno (routes/ai.ts): aqui não tem ferramentas
 * genéricas, só o que está explicitamente listado abaixo (responder, mover
 * de etapa entre um conjunto fixo, preencher campos conhecidos do card) —
 * nunca faz nenhuma outra ação no CRM.
 *
 * Usa o MESMO "cérebro" (ai-shared.service.ts) que a Sugerir resposta —
 * mesma Base de Conhecimento, mesmas regras de confiança/tom. A diferença
 * estrutural é que esta IA fala sem ninguém revisando, então precisa saber
 * decidir quando chamar um humano (handoff) e é a única que pode agir
 * direto no card (mover etapa, preencher dados) — a Sugerir resposta nunca
 * precisou disso, sempre teve um vendedor revisando e fazendo essas ações
 * ele mesmo.
 */

const ROLE_FRAMING = `Você é o assistente de atendimento da A&F Soluções Financeiras, conversando DIRETAMENTE com um cliente pelo WhatsApp — isso não é uma conversa interna da equipe, é o próprio cliente do outro lado.`;

const SAFETY_RULES = `- Nunca peça senha, número de cartão ou qualquer dado sensível. Nunca confirme decisão financeira em nome da empresa (aprovação de crédito, valor final de proposta etc) — isso sempre fica com um humano da equipe.`;

const HANDOFF_RULES = `
ENCERRAR E CHAMAR UM HUMANO ("handoff": true) sempre que:
- o cliente pedir, de qualquer forma, para falar com uma pessoa/atendente/humano/alguém da equipe;
- o cliente parecer insatisfeito, impaciente, ou trouxer um problema fora do comum que você não consegue resolver com o material disponível;
- a pergunta do cliente for GENUINAMENTE sobre um produto ou assunto fora do escopo de atendimento deste chat (ver acima) — nesse caso não tente responder por conta própria, mesmo que ache que sabe a resposta;
- REALMENTE não houver nenhum material nem contexto que sustente uma resposta séria pra pergunta do cliente (isso é a EXCEÇÃO, não o padrão — não use por cautela).
Quando marcar "handoff": true, a "reply" ainda deve ser uma mensagem curta e natural avisando o cliente que alguém da equipe vai continuar o atendimento a partir daqui — nunca deixe o campo "reply" vazio.`;

/** Só estes 4 valores são aceitos em "moveToStage" — usuário definiu esse
 *  alcance explicitamente: a IA NUNCA move sozinha pra etapas que fecham
 *  negócio (Fechado, Aprovado, Perdido etc.), só pra estas de andamento. */
const MOVE_STAGE_RULES = `MOVER O CARD DE ETAPA ("moveToStage") — só estes valores são aceitos, escolha no máximo um, ou null se não for o caso (a maioria das mensagens não muda de etapa):
- "Follow Up": o cliente demonstrou interesse mas precisa de acompanhamento (disse que vai pensar, pediu pra retornarem depois, ainda não deu informação suficiente pra avançar).
- "Lead Sem Retorno": o cliente disse EXPLICITAMENTE que não tem mais interesse, ou pediu pra não ser mais contatado.
- "Pré-Análise": o cliente confirmou que já preencheu a proposta/formulário manual completo, OU você já reuniu nesta conversa todos os dados pessoais necessários pra uma pré-análise (nome, telefone, CPF, renda etc. de todos os participantes). Só use se essa condição foi REALMENTE atendida — não adiante.
- "Prospecção": raramente necessário (o lead já começa nessa etapa).`;

function buildFillFieldsRules(camposTexto: string): string {
  return `PREENCHER DADOS DO CARD ("extractedFields") — um objeto com os campos abaixo que o cliente mencionar CLARAMENTE na conversa (nunca invente, deduza ou arredonde um valor que ele não disse). Use só chaves desta lista, ou {} se nada novo foi mencionado:
${camposTexto}`;
}

const OUTPUT_FORMAT = `FORMATO DE RESPOSTA — OBRIGATÓRIO:
Responda SOMENTE com um JSON válido, sem markdown, sem texto antes ou depois, no formato exato:
{"reply": "<mensagem para o cliente>", "handoff": <true ou false>, "moveToStage": "<Follow Up | Lead Sem Retorno | Pré-Análise | Prospecção | null>", "extractedFields": {<chave: valor, ou {} se nenhuma>}}`;

export interface AiAutoReplyResult {
  reply: string;
  /** true = cliente pediu atendimento humano (ou pergunta fora do escopo deste setor/produto) — quem chamou deve desligar o Lead.aiAutoReplyActive e avisar o colaborador responsável. */
  handoff: boolean;
  /** Etapa pra mover o card, se a IA identificou uma mudança — aplicar via applyAiExtractedActions (ai-shared.service.ts), que valida contra a lista permitida. */
  moveToStage?: string | null;
  /** Campos do card que a IA extraiu da conversa — aplicar via applyAiExtractedActions. */
  extractedFields?: Record<string, string> | null;
}

/**
 * Gera a resposta do assistente para uma mensagem recebida de um cliente,
 * usando a Base de Conhecimento + Respostas Rápidas + histórico recente da
 * conversa, restrito ao escopo de produtos do setor do lead. Retorna null
 * (não responde) se faltar configuração ou algo der errado — nunca lança erro
 * pro chamador, pra não travar o fluxo de recebimento de mensagem.
 */
export async function generateAiAutoReply(accountId: string, leadId: string, incomingText: string): Promise<AiAutoReplyResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !incomingText.trim()) return null;

  try {
    const ctx = await buildSharedAiContext(accountId, leadId, incomingText, {
      historyTake: 12,
      historyRoleLabels: { inbound: 'Cliente', outbound: 'Atendente' },
    });
    if (!ctx) return null;

    const camposTexto = await buildFillableFieldsText(accountId);

    const systemPrompt = `${ROLE_FRAMING}

${CORE_RULES}
${SAFETY_RULES}
${HANDOFF_RULES}

${MOVE_STAGE_RULES}

${buildFillFieldsRules(camposTexto)}

${OUTPUT_FORMAT}

${buildContextBlocks(ctx)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: incomingText }],
      }),
    });
    if (!response.ok) {
      console.error('[AI Auto-reply] Erro Anthropic:', response.status, (await response.text()).slice(0, 300));
      return null;
    }
    const data = await response.json() as { content: { type: string; text?: string }[] };
    const raw = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
    if (!raw) return null;

    return parseReply(raw);
  } catch (err) {
    console.error('[AI Auto-reply] Erro ao gerar resposta:', err);
    return null;
  }
}

/** O modelo deve responder só com JSON, mas por segurança extrai o primeiro
 *  bloco {...} do texto (cobre o caso raro de markdown/texto extra ao redor)
 *  e, se o parse falhar de qualquer jeito, cai pro texto cru como resposta
 *  (sem handoff/ação nenhuma) — nunca deixa de responder por causa de um
 *  JSON malformado. moveToStage/extractedFields são sempre opcionais e
 *  validados de verdade só em applyAiExtractedActions — aqui só extrai o
 *  que veio, sem confiar cegamente no formato. */
function parseReply(raw: string): AiAutoReplyResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        const extractedFields = parsed.extractedFields && typeof parsed.extractedFields === 'object' && !Array.isArray(parsed.extractedFields)
          ? parsed.extractedFields
          : null;
        return {
          reply: parsed.reply.trim(),
          handoff: parsed.handoff === true,
          moveToStage: typeof parsed.moveToStage === 'string' && parsed.moveToStage.trim() ? parsed.moveToStage.trim() : null,
          extractedFields,
        };
      }
    } catch {
      // cai no fallback abaixo
    }
  }
  return { reply: raw, handoff: false };
}
