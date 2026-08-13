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

const BASE_SYSTEM_PROMPT = `Você é o assistente de atendimento da A&F Soluções Financeiras, conversando DIRETAMENTE com um cliente pelo WhatsApp — isso não é uma conversa interna da equipe, é o próprio cliente do outro lado.

REGRAS OBRIGATÓRIAS, sem exceção:
- Responda só com base no material de referência (Base de Conhecimento + Respostas Rápidas) e no histórico desta conversa, abaixo. NUNCA invente valor, taxa, prazo, data, lista de documentos ou qualquer informação específica que não esteja claramente no material.
- Se a pergunta do cliente bater com uma das "Respostas Rápidas" abaixo (ex.: lista de documentos, como funciona X), seja FIEL ao conteúdo dela — não invente uma lista ou explicação diferente. Pode adaptar o tom pra soar natural na conversa, mas o conteúdo (itens, valores, condições) tem que ser exatamente o que está lá.
- Se não souber responder com segurança, diga com naturalidade que vai verificar com a equipe e que alguém retorna em breve — NUNCA chute uma resposta só para preencher.
- Nunca peça senha, número de cartão ou qualquer dado sensível. Nunca confirme decisão financeira em nome da empresa (aprovação de crédito, valor final de proposta etc) — isso sempre fica com um humano da equipe.
- NUNCA use emoji nas respostas — nenhum. Escreva só com texto normal, como um atendente digitando no computador.
- Seja breve (1 a 3 frases na maioria das vezes, ou o tamanho da própria Resposta Rápida quando usar uma), cordial e natural — não pareça um robô lendo um roteiro. Português do Brasil, sem formalidade excessiva.`;

const HANDOFF_RULES = `
ENCERRAR E CHAMAR UM HUMANO ("handoff": true) sempre que:
- o cliente pedir, de qualquer forma, para falar com uma pessoa/atendente/humano/alguém da equipe;
- o cliente parecer insatisfeito, impaciente, ou trouxer um problema fora do comum que você não consegue resolver com o material disponível;
- a pergunta do cliente for sobre um produto ou assunto FORA do escopo de atendimento deste chat (ver abaixo) — nesse caso não tente responder por conta própria, mesmo que ache que sabe a resposta.
Quando marcar "handoff": true, a "reply" ainda deve ser uma mensagem curta e natural avisando o cliente que alguém da equipe vai continuar o atendimento a partir daqui — nunca deixe o campo "reply" vazio.

FORMATO DE RESPOSTA — OBRIGATÓRIO:
Responda SOMENTE com um JSON válido, sem markdown, sem texto antes ou depois, no formato exato:
{"reply": "<mensagem para o cliente, sem emoji>", "handoff": <true ou false>}`;

export interface AiAutoReplyResult {
  reply: string;
  /** true = cliente pediu atendimento humano (ou pergunta fora do escopo deste setor/produto) — quem chamou deve desligar o Lead.aiAutoReplyActive e avisar o colaborador responsável. */
  handoff: boolean;
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
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId },
      include: { pipeline: { include: { department: true } }, user: { select: { id: true, name: true } } },
    });
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

    // Escopo de produtos deste setor — a IA não deve sair respondendo sobre
    // outra linha de negócio (ex.: um chat de Financiamento Habitacional não
    // deve responder sobre Consórcio); nesses casos ela encerra e chama humano.
    const department = lead.pipeline?.department;
    const escopo = department?.aiScope?.trim() || department?.name || null;

    // Respostas Rápidas — mesmo material que os colaboradores usam pra
    // responder manualmente (ex.: lista de documentos). Sem isso a IA só
    // enxergava a Base de Conhecimento e não conseguia responder perguntas
    // estruturadas desse tipo. Só as do setor deste lead + as "compartilhadas"
    // (sem setor) — mesma regra usada na tela de Respostas Rápidas.
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
    const escopoTexto = escopo
      ? `Este atendimento é EXCLUSIVO do setor "${department?.name}" — você só deve responder sobre: ${escopo}. Se a pergunta do cliente for sobre outro produto/linha de negócio da empresa (fora dessa lista), NÃO tente responder — encerre e chame um humano (ver regras de handoff abaixo).`
      : '(este atendimento não tem um setor/produto definido — responda normalmente com base no material disponível, sem restrição de escopo)';

    // Estilo de escrita do colaborador responsável por este lead — pra IA soar
    // como a pessoa que normalmente atende esse cliente, não um robô genérico.
    // Usa mensagens reais que ELE mandou (sentByUserId), nunca as da própria IA.
    let estiloTexto = '(sem exemplos suficientes — apenas escreva de forma natural e não robótica)';
    if (lead.userId) {
      // sentByUserId já é suficiente pra escopar por conta (um usuário
      // pertence a uma única conta) — não precisa (e Message não tem) accountId.
      const exemplos = await prisma.message.findMany({
        where: { direction: 'OUTBOUND', sentByUserId: lead.userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }).catch(() => []);
      const escolhidos = exemplos
        .map((m) => m.content.trim())
        .filter((c) => c.length >= 8 && c.length <= 300)
        .slice(0, 6);
      if (escolhidos.length) {
        estiloTexto = escolhidos.map((c) => `- "${c}"`).join('\n');
      }
    }

    const systemPrompt = `${BASE_SYSTEM_PROMPT}
${HANDOFF_RULES}

--- ESCOPO DE ATENDIMENTO (produtos deste chat) ---
${escopoTexto}

--- ESTILO DE ESCRITA DO COLABORADOR RESPONSÁVEL (${lead.user?.name || 'sem responsável definido'}) ---
Imite só o TOM e o jeito de escrever destes exemplos reais que ele(a) já mandou para outros clientes — NUNCA reaproveite o conteúdo/fatos deles, que são de outras conversas:
${estiloTexto}

--- BASE DE CONHECIMENTO (material de referência) ---
${contexto}

--- RESPOSTAS RÁPIDAS (modelos prontos da equipe — use o conteúdo fielmente quando bater com a pergunta) ---
${respostasRapidas}

--- HISTÓRICO RECENTE DESTA CONVERSA ---
${historico}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 500,
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
 *  (handoff false) — nunca deixa de responder por causa de um JSON malformado. */
function parseReply(raw: string): AiAutoReplyResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return { reply: parsed.reply.trim(), handoff: parsed.handoff === true };
      }
    } catch {
      // cai no fallback abaixo
    }
  }
  return { reply: raw, handoff: false };
}
