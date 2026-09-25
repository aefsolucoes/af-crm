import { PrismaClient } from '@prisma/client';
import { buildSharedAiContext, buildContextBlocks, buildFillableFieldsText, CORE_RULES } from './ai-shared.service';

const prisma = new PrismaClient();

// Mensagem que é só confirmação/encerramento ("ok", "beleza", "tá bom",
// "obrigada", 👍). Achado real (2026-09-24): a IA respondia cada "ok" com
// outra confirmação ("Perfeito! Vou seguir...", "Show! Assim que sair..."),
// num pingue-pongue sem fim com o cliente.
const ACK_CORE = new Set([
  'ok', 'okay', 'oks', 'okk', 'okey', 'blz', 'beleza', 'bom', 'certo', 'certinho', 'combinado', 'perfeito', 'show',
  'otimo', 'obrigado', 'obrigada', 'obg', 'brigado', 'brigada', 'valeu', 'vlw', 'entendi', 'entendido', 'joia',
  'fechado', 'tranquilo', 'aguardo', 'aguardando', 'top', 'massa', 'legal', 'maravilha', 'certeza', 'demais',
]);
const ACK_FILLERS = new Set(['ta', 'tudo', 'bem', 'e', 'entao', 'muito', 'pela', 'atencao', 'fico', 'no', 'vou', 'aguardar', 'de', 'boa', 'ai', 'sim', 'mesmo', 'mt', 'mto']);

export function isAcknowledgmentOnly(text: string): boolean {
  if (text.includes('?')) return false;
  const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const tokens = norm.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return /\p{Extended_Pictographic}/u.test(text);
  if (tokens.length > 6) return false;
  return tokens.every((t) => ACK_CORE.has(t) || ACK_FILLERS.has(t)) && tokens.some((t) => ACK_CORE.has(t));
}

// "…te chamo por aqui, tá bom?" termina com "?" mas não espera resposta de
// verdade — só uma pergunta real deixa o "ok" do cliente valer como um "sim".
// "Pode ser?" NÃO entra nessa lista: é o "vamos tentar aprovar seu crédito,
// pode ser?" da regra do formulário, e o "ok" do cliente ali é um sim.
function hasRealQuestion(text: string): boolean {
  const withoutTag = text
    .trim()
    .replace(/\b(tudo\s+(bem|bom|certo|joia)|td\s+bem|como\s+vai|como\s+voc[eê]\s+est[aá])\s*\?+/gi, '')
    .replace(/[\s,.!]*(t[aá]\s*bom|ok|certo|beleza|combinado|blz|fechado)\s*\?+[\s!.]*$/i, '');
  return withoutTag.includes('?');
}

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

/** Só estes valores são aceitos em "moveToStage" — usuário definiu esse
 *  alcance explicitamente: a IA NUNCA move sozinha pra etapas que fecham
 *  negócio (Fechado, Aprovado etc.), só pra estas de andamento. "Perdido"
 *  não é etapa — é status, tratado separado em MARK_LOST_RULES. */
const MOVE_STAGE_RULES = `MOVER O CARD DE ETAPA ("moveToStage") — só estes valores são aceitos, escolha no máximo um, ou null se não for o caso (a maioria das mensagens não muda de etapa):
- "Follow Up": o cliente demonstrou interesse mas precisa de acompanhamento (disse que vai pensar, pediu pra retornarem depois, ainda não deu informação suficiente pra avançar).
- "Lead Sem Retorno": o cliente foi ficando em silêncio/enrolando, sem dar uma resposta clara nem positiva nem negativa — NÃO use isso quando o cliente recusar explicitamente (isso é "Perdido", ver regra abaixo).
- "Pré-Análise": o cliente confirmou que já preencheu a proposta/formulário manual completo, OU você já reuniu nesta conversa todos os dados pessoais necessários pra uma pré-análise (nome, telefone, CPF, renda etc. de todos os participantes). Só use se essa condição foi REALMENTE atendida — não adiante.
- "Prospecção": raramente necessário (o lead já começa nessa etapa).
- "Venda Futura": o cliente quer seguir, mas não agora — disse que vai deixar pra mais pra frente, pra outro mês/ano, depois de algum evento.
Sempre que mover de etapa, preencha "moveReason" com o motivo em 1 frase (vai pra uma anotação no card).`;

/** "Perdido" é o STATUS do lead (Aberto/Ganho/Perdido, mesmo botão "Marcar
 *  Perdido" da tela), não uma etapa — por isso é um campo separado, com
 *  motivo obrigatório quando usado. */
const MARK_LOST_RULES = `MARCAR COMO PERDIDO ("markLost") — preencha com um motivo curto (1 frase, baseado no que o cliente disse) quando ele recusar EXPLICITAMENTE: disser que não quer mais, não tem mais interesse, desistiu, ou pedir pra não ser mais contatado. Também quando o lead for desqualificado (ex.: imóvel de garantia sem registro/irregular e sem alternativa) — aí o motivo começa com "Lead desqualificado — ". Deixe null/vazio em todos os outros casos — isso é diferente de só ficar em silêncio (isso é "Lead Sem Retorno", acima), e é definitivo, então só use quando a recusa for clara.`;

/** Diferente de markLost: o negócio continua vivo, só a INSISTÊNCIA
 *  automática (lembrete periódico) deve parar — um humano assume esse
 *  cliente a partir daqui. Ex.: cliente irritado com o lembrete repetido de
 *  documento, mas ainda quer seguir com o negócio. */
const STOP_FOLLOWUP_RULES = `CLIENTE PEDIU PRA PARAR / NÃO VAI CONTINUAR — pedido do Fabio: entenda o motivo antes de decidir.
- Se ele pedir pra parar as mensagens/lembretes ou disser que não vai continuar SEM dizer por quê, pergunte o motivo em uma frase, com educação (ex.: "Tudo bem! Posso saber o motivo? Assim eu anoto aqui.") e marque "stopFollowUp": true.
- Com o motivo (ou se já veio junto):
  - não quer mais o negócio (desistiu, fechou com outro, não tem interesse) → "markLost" com o motivo;
  - quer, mas mais pra frente → "moveToStage": "Venda Futura" + "moveReason";
  - ficou em dúvida, sumiu ou não explicou → "moveToStage": "Lead Sem Retorno" + "moveReason".
- Nos três casos também marque "stopFollowUp": true (pausa os lembretes automáticos).
- Use "stopFollowUp": false em todos os outros casos.`;

// Pedido do Fabio (2026-09-25): a IA ia fazendo pergunta por pergunta
// (casa ou apartamento? está quitado? qual valor?) em vez de mandar o
// formulário, que já pede tudo isso de uma vez.
const FORM_FIRST_RULES = `FORMULÁRIO PRIMEIRO — REGRA PRINCIPAL DE CONDUÇÃO:
- NÃO faça perguntas de qualificação (tipo de imóvel, se está quitado, valor do imóvel, valor do crédito, renda, entrada, idade etc.). O formulário da proposta manual já pede tudo isso.
- HOME EQUITY — SITUAÇÃO DO IMÓVEL (antes do passo 1 abaixo, se a conversa ainda não respondeu isso): pergunte em uma frase se o imóvel que vai ficar de garantia tem matrícula registrada em cartório e está regularizado.
  - Se sim: siga normalmente.
  - Se não: antes de desistir, pergunte se ele tem outro imóvel pra colocar como garantia, ou outra pessoa que possa fazer o crédito com um imóvel no nome dela — pode ser um parente de 1º grau (pai, mãe, filho).
  - Só se não houver nenhuma alternativa: explique com gentileza que sem imóvel registrado e regular não dá pra seguir agora e marque "markLost" com "Lead desqualificado — <motivo>".
- Do jeito que a equipe faz, em dois passos:
  1. Quando o cliente responder ou mostrar interesse (e a proposta ainda não foi oferecida nesta conversa), proponha tentar aprovar o crédito primeiro, curto, algo como: "Antes de tudo, vamos tentar aprovar seu crédito. Pode ser?"
  2. Quando ele concordar (sim, pode, ok, bora...), mande o link da proposta manual do produto dele usando o texto da Resposta Rápida correspondente ("Proposta manual Finan Hab" ou "Proposta manual Home Equity") e termine com algo como "Se tiver alguma dúvida, é só me falar."
  Se o cliente já pediu pra seguir, pediu o link ou já está pronto pra mandar os dados, pule direto pro passo 2.
  - Financiamento pra comprar/construir imóvel: https://aefsolucoesfinanceiras.com.br/proposta-manual
  - Crédito com garantia de imóvel (Home Equity): https://aefsolucoesfinanceiras.com.br/proposta-manual-home-equity
- Se o cliente fizer uma pergunta, responda em poucas palavras e, se o link ainda não foi enviado nesta conversa, mande junto.
- Depois que o link foi enviado, só responda dúvidas — não peça os dados do formulário pela conversa nem reenvie o link a cada mensagem (só se ele pedir ou disser que não achou).
- Não avalie viabilidade (valor mínimo, percentual do imóvel etc.) antes do formulário preenchido: isso é visto na pré-análise, com os dados do formulário.
- Se o cliente já disse que preencheu a proposta, não mande o link de novo.
- Crédito com garantia no nome de EMPRESA (PJ): as condições (taxa e documentação) são diferentes e bem mais complexas que as de pessoa física — nunca use taxa de PF pra PJ. O caminho padrão é pessoa física: na primeira vez que o cliente falar em fazer pela empresa, pergunte em uma frase se ele pode fazer no nome dele (pessoa física), que é mais simples. Só se ele confirmar que precisa mesmo como PJ: não mande o formulário de pessoa física — no lugar dele, mande a lista de documentos da Resposta Rápida "Documentos comprador PJ" (fiel ao conteúdo) e pergunte se ficou alguma dúvida. Pra PJ essa lista é o primeiro passo (exceção à regra de só pedir documentos depois da pré-análise). Taxa pra PJ só sai na análise: se perguntarem, diga isso, sem citar taxa de PF.
- Setores sem proposta manual (ex.: Consórcio): siga normalmente, sem esta regra.

DOCUMENTOS: quando for a hora de pedir a documentação — pré-análise já aprovada (etapa "Aprovado Pré-Analise" ou "Aguardando Documentação") ou o cliente perguntar quais documentos precisa:
- Se a conversa JÁ TEM uma lista de documentos enviada pela equipe, use a MESMA lista (não mande outra diferente) — só lembre o que falta dela.
- Senão, Home Equity pessoa física: mande a Resposta Rápida "Documentos Home Equity", fiel ao conteúdo, sem texto em volta. Financiamento Habitacional: a lista do perfil de renda do cliente. PJ: "Documentos comprador PJ" (regra acima).
- Antes da pré-análise aprovada, não peça documentos (a proposta vem primeiro).
- Durante a pré-análise, se o cliente perguntar do resultado: diga que a análise está em andamento e que avisa por aqui assim que sair — nunca adiante aprovação.`;

const NO_REPLY_RULES = `NÃO RESPONDER ("noReply": true) — quando a mensagem do cliente for só uma confirmação ou encerramento (ex.: "ok", "beleza", "tá bom", "obrigado", "combinado", 👍) sem pergunta nem informação nova, e a sua última mensagem não fez uma pergunta que ele precise responder. Nesse caso deixe "reply" vazio: o atendimento continua, só não precisa mandar mais nada agora.
- Se o "ok" responder uma pergunta sua de sim/não (ex.: "posso te mandar a lista de documentos?"), trate como "sim" e siga normalmente, com noReply false.
- Nunca repita uma confirmação que você já deu na conversa (ex.: dizer de novo "vou seguir com a análise e te retorno").`;

function buildFillFieldsRules(camposTexto: string): string {
  return `PREENCHER DADOS DO CARD ("extractedFields") — um objeto com os campos abaixo que o cliente mencionar CLARAMENTE na conversa (nunca invente, deduza ou arredonde um valor que ele não disse). Use só chaves desta lista, ou {} se nada novo foi mencionado:
${camposTexto}`;
}

const OUTPUT_FORMAT = `FORMATO DE RESPOSTA — OBRIGATÓRIO:
Responda SOMENTE com um JSON válido, sem markdown, sem texto antes ou depois, no formato exato:
{"reply": "<mensagem para o cliente, ou vazio se noReply>", "noReply": <true ou false>, "handoff": <true ou false>, "moveToStage": "<Follow Up | Lead Sem Retorno | Pré-Análise | Prospecção | Venda Futura | null>", "markLost": "<motivo curto, ou null>", "stopFollowUp": <true ou false>, "moveReason": "<motivo da mudança de etapa, ou null>", "extractedFields": {<chave: valor, ou {} se nenhuma>}}`;

export interface AiAutoReplyResult {
  reply: string;
  /** true = cliente só confirmou/encerrou ("ok", "beleza") — não mandar nada (reply vem vazio). */
  noReply?: boolean;
  /** true = cliente pediu atendimento humano (ou pergunta fora do escopo deste setor/produto) — quem chamou deve desligar o Lead.aiAutoReplyActive e avisar o colaborador responsável. */
  handoff: boolean;
  /** Etapa pra mover o card, se a IA identificou uma mudança — aplicar via applyAiExtractedActions (ai-shared.service.ts), que valida contra a lista permitida. */
  moveToStage?: string | null;
  /** Motivo da perda, se a IA identificou uma recusa explícita — aplicar via applyAiExtractedActions (marca status LOST, não é etapa). */
  markLost?: string | null;
  /** true = cliente pediu pra parar de receber lembrete automático (ex.:
   *  cobrança repetida de documento), sem recusar o negócio em si — aplicar
   *  via applyAiExtractedActions (marca uma tag que os gatilhos de
   *  inatividade recorrente já sabem excluir). */
  stopFollowUp?: boolean;
  /** Motivo da mudança de etapa (vira anotação no card). */
  moveReason?: string | null;
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
    if (isAcknowledgmentOnly(incomingText)) {
      const lastOut = await prisma.message.findFirst({
        where: { leadId, direction: 'OUTBOUND', callWaCallId: null, deleted: false },
        orderBy: { createdAt: 'desc' },
        select: { content: true },
      });
      if (!lastOut || !hasRealQuestion(lastOut.content)) {
        console.log(`[AI Auto-reply] cliente só confirmou ("${incomingText.trim().slice(0, 40)}") — sem resposta`);
        return { reply: '', handoff: false, noReply: true };
      }
    }

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

${MARK_LOST_RULES}

${STOP_FOLLOWUP_RULES}

${FORM_FIRST_RULES}

${NO_REPLY_RULES}

${buildFillFieldsRules(camposTexto)}

${OUTPUT_FORMAT}

${buildContextBlocks(ctx)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // O modelo pensa antes de responder e o raciocínio conta nesse
        // limite: com 1024 às vezes acabava tudo no raciocínio e a resposta
        // vinha VAZIA (cliente ficava sem resposta, achado 2026-09-25).
        max_tokens: 4096,
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
 *  bloco {...} do texto (cobre o caso raro de markdown/texto extra ao redor).
 *
 *  INCIDENTE REAL (16/09/2026): quando o JSON vem cortado/malformado (ex.:
 *  estourou o max_tokens no meio do extractedFields), o fallback antigo
 *  mandava o TEXTO INTEIRO — chaves, "extractedFields", CPF etc. — como se
 *  fosse a mensagem, e isso foi parar de verdade no WhatsApp de um cliente.
 *  Agora, se o JSON completo não parsear, tenta recuperar só o VALOR de
 *  "reply" na marra (ele normalmente vem primeiro, antes do resto quebrar);
 *  se nem isso der, usa uma mensagem genérica seria — nunca mais o texto
 *  cru. moveToStage/extractedFields são sempre opcionais e validados de
 *  verdade só em applyAiExtractedActions — aqui só extrai o que veio, sem
 *  confiar cegamente no formato. */
function parseReply(raw: string): AiAutoReplyResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // Sem chave nenhuma no texto — não é um JSON quebrado, é resposta livre
    // mesmo (raro, mas seguro de mandar como está).
    return { reply: raw, handoff: false };
  }

  try {
    const parsed = JSON.parse(match[0]);
    const extractedFields = parsed?.extractedFields && typeof parsed.extractedFields === 'object' && !Array.isArray(parsed.extractedFields)
      ? parsed.extractedFields
      : null;
    if (parsed && parsed.noReply === true) {
      return {
        reply: '',
        noReply: true,
        handoff: false,
        moveToStage: typeof parsed.moveToStage === 'string' && parsed.moveToStage.trim() ? parsed.moveToStage.trim() : null,
        markLost: typeof parsed.markLost === 'string' && parsed.markLost.trim() ? parsed.markLost.trim() : null,
        stopFollowUp: parsed.stopFollowUp === true,
        moveReason: typeof parsed.moveReason === 'string' && parsed.moveReason.trim() ? parsed.moveReason.trim() : null,
        extractedFields,
      };
    }
    if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      return {
        reply: parsed.reply.trim(),
        handoff: parsed.handoff === true,
        moveToStage: typeof parsed.moveToStage === 'string' && parsed.moveToStage.trim() ? parsed.moveToStage.trim() : null,
        markLost: typeof parsed.markLost === 'string' && parsed.markLost.trim() ? parsed.markLost.trim() : null,
        stopFollowUp: parsed.stopFollowUp === true,
        moveReason: typeof parsed.moveReason === 'string' && parsed.moveReason.trim() ? parsed.moveReason.trim() : null,
        extractedFields,
      };
    }
  } catch {
    // JSON malformado/cortado — segue pro resgate abaixo, NUNCA usa `raw`
    // (que contém as chaves { } e o resto do JSON) como mensagem.
  }

  const replyMatch = raw.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (replyMatch) {
    try {
      const reply = (JSON.parse(`"${replyMatch[1]}"`) as string).trim();
      if (reply) return { reply, handoff: false };
    } catch {
      // segue pro fallback genérico abaixo
    }
  }

  return { reply: 'Recebi sua mensagem! Só um instante que já te retorno.', handoff: false };
}
