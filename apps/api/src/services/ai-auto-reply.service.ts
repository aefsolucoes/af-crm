import { PrismaClient } from '@prisma/client';
import { buildSharedAiContext, buildContextBlocks, buildFillableFieldsText, CORE_RULES, stripOpeningInterjection } from './ai-shared.service';
import { teamQuestionsContext } from './ai-team-question.service';
import { callSummaryContext } from './call-recording.service';

/**
 * Pedido de permissão pra LIGAR pelo WhatsApp (template com o cartão "pode
 * ligar para você?"). Responder "sim" por escrito NÃO dá a permissão — o
 * cliente tem que tocar em "Permitir ligações" no cartão. Pedido do Fabio
 * (26/09): a IA dizia "vamos te ligar" pra quem só escreveu "sim". Aqui a IA
 * recebe a situação REAL (consulta na Meta), só quando a conversa tem o pedido.
 */
// Cliente falando de ligação ("pode me ligar?", "me liga", "prefiro por telefone").
const TALKS_ABOUT_CALL_RE = /\b(me\s+)?lig(a|ar|ue|uem|am|ando|a[çc][aã]o|a[çc][oõ]es)\b|telefon|\bchamada/i;

async function callPermissionContext(accountId: string, leadId: string, incomingText: string): Promise<string> {
  try {
    const asked = await prisma.message.findFirst({
      where: { leadId, direction: 'OUTBOUND', OR: [{ templateName: { contains: 'permissao_ligar' } }, { content: { contains: 'Podemos te ligar pelo WhatsApp' } }] },
      select: { id: true },
    });
    // O pedido de permissão não vai mais na boas-vindas (Fabio 27/09: "só
    // manda se o cliente pedir pra ligar") — sem pedido na conversa, este
    // bloco só entra quando o cliente fala em ligação.
    const lastOut = await prisma.message.findFirst({
      where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { content: true },
    });
    const weAskedAboutCall = /\blig(ar|a[çc][aã]o|o)\b|hor[áa]rio/i.test(lastOut?.content || '');
    if (!asked && !TALKS_ABOUT_CALL_RE.test(incomingText) && !weAskedAboutCall) return '';
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { pipeline: { select: { departmentId: true } }, contact: { select: { whatsappPhone: true, phone: true } }, user: { select: { name: true } } } });
    const raw = (lead?.contact?.whatsappPhone && !lead.contact.whatsappPhone.includes('@') ? lead.contact.whatsappPhone : lead?.contact?.phone) || '';
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) return '';
    const { getWhatsAppConfig, normalizeBrazilianWhatsAppPhone } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const { getCallPermissionState } = require('./whatsapp-calling.service') as typeof import('./whatsapp-calling.service');
    const config = await getWhatsAppConfig(accountId, lead?.pipeline?.departmentId);
    if (!config?.phoneNumberId || !config.accessToken) return '';
    const state = await getCallPermissionState({ phoneNumberId: config.phoneNumberId, accessToken: config.accessToken }, normalizeBrazilianWhatsAppPhone(digits));
    // Quem liga é SEMPRE a Andreia (Fabio 28/09: a IA disse "o Fabio te
    // liga" porque ele era o responsável do card — errado) — e a IA fala
    // como ela, em primeira pessoa.
    // Achado real (Luiz Carlos 26/09): ele tocou "Tenho interesse" na
    // boas-vindas e contou que tem restrição; como a última mensagem nossa
    // era o pedido de ligação, a IA achou que era "sim, pode ligar",
    // respondeu só sobre o botão de permitir e ainda moveu o card.
    const onlyWhenAboutCall = `
IMPORTANTE: este bloco só vale quando a mensagem do cliente for sobre a LIGAÇÃO (ex.: "pode ligar", "me liga", "que horas vocês ligam", ou um "sim" solto logo depois do pedido de ligação). "Tenho interesse", "Não tenho interesse", "Quero mais informações" e parecidos são os botões da mensagem de boas-vindas/follow-up — são sobre o CRÉDITO, não sobre a ligação. Se o cliente falar de outro assunto (interesse, restrição no nome, dúvida, valores), responda a ESSE assunto normalmente e NÃO mencione a ligação nem o botão de permitir.`;
    const agora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
    const situacao = state.permitted
      ? 'O cliente JÁ autorizou ligação pelo WhatsApp.'
      : asked && !state.canRequest
      ? 'Já mandamos o pedido de permissão de ligação e ele AINDA NÃO tocou em *Permitir ligações*. Se ele falar da ligação já combinada, explique em 1-2 frases que, pra ligação completar, é só tocar em *Permitir ligações* no cartão "pode ligar para você?" aqui na conversa. Responder "sim" por escrito não vale.'
      : 'O cliente ainda não autorizou ligação pelo WhatsApp — o pedido de permissão é mandado pelo CRM DEPOIS que a Andreia confirmar o horário (não mande nem cite isso agora).';
    // Fabio 28/09: "sempre verificar se a Andreia consegue fazer a ligação;
    // se sim, agendar um horário com o cliente" — a IA pega o horário e o CRM
    // abre o popup pra equipe (createCallRequest); confirmado, o CRM avisa o
    // cliente, manda o pedido de permissão e cria a tarefa da Andreia.
    return `--- LIGAÇÃO PELO WHATSAPP ---
${situacao}
AGENDAR A LIGAÇÃO — quem liga é você (fala como a Andreia), mas o horário SEMPRE é confirmado antes com a agenda dela. Se o cliente pedir ou aceitar uma ligação:
- Se ele ainda não disse quando: pergunte em uma frase o melhor dia/horário (ex.: "Claro! Qual o melhor horário pra eu te ligar?").
- Quando ele disser o horário (ou "agora"): responda curto que vai confirmar (ex.: "Anotado, já te confirmo o horário.") — SEM prometer que liga nesse horário — e preencha "callRequest": {"when": "<dia e horário como combinado, ex.: amanhã (29/09) às 10h>", "isoDateTime": "<a mesma data/hora em ISO com fuso -03:00, calculada a partir de agora>"}.
- Se já existe um pedido de ligação aguardando confirmação (ver DÚVIDAS DESTE CLIENTE), não abra outro: diga que já já confirma — a não ser que ele tenha mudado o horário (aí preencha "callRequest" com o novo).
- "callRequest": null em todos os outros casos.
Agora: ${agora} (horário de Brasília).${onlyWhenAboutCall}`;
  } catch {
    return '';
  }
}

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

// Despedida/agradecimento do cliente ("Ok. Boa tarde.", "Obrigado", "Tchau")
// — Fabio 28/09: fechar com "Boa tarde! Disponha." em vez de ficar calada.
// "ok"/"beleza" sozinho continua sem resposta (anti pingue-pongue), e um
// "Boa tarde" solto não conta (pode ser o cliente puxando conversa).
const CLOSING_WORDS = new Set(['tarde', 'noite', 'dia', 'tchau', 'ate', 'mais', 'logo', 'breve', 'amanha', 'abraco', 'abracos', 'agradeco', 'grato', 'grata', 'obrigadao', 'igualmente', 'pra', 'voce', 'vc', 'tb', 'tambem', 'por', 'enquanto']);
const ACK_WORDS = new Set(['ok', 'okay', 'oks', 'okk', 'okey', 'blz', 'beleza', 'certo', 'certinho', 'combinado', 'perfeito', 'show', 'otimo', 'entendi', 'entendido', 'joia', 'fechado', 'tranquilo', 'aguardo', 'aguardando', 'top', 'legal', 'maravilha']);

function greetingNow(): string {
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(new Date()), 10);
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Texto de fechamento se a mensagem for despedida/agradecimento; senão null. */
export function farewellReply(text: string): string | null {
  if (text.includes('?')) return null;
  const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const tokens = norm.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 8) return null;
  if (!tokens.every((t) => ACK_CORE.has(t) || ACK_FILLERS.has(t) || CLOSING_WORDS.has(t))) return null;
  const thanks = /\b(obrigad[oa]s?|obrigadao|obg|brigad[oa]|valeu|vlw|agradeco|grat[oa])\b/.test(norm);
  const bye = /\b(tchau|ate (mais|logo|breve|amanha)|abracos?|por enquanto)\b/.test(norm);
  const greet = norm.match(/\b(bom dia|boa tarde|boa noite)\b/)?.[1];
  const ack = tokens.some((t) => ACK_WORDS.has(t)) || /\b(ta bom|ta certo|tudo bem)\b/.test(norm);
  if (!(thanks || bye || (greet && ack))) return null;
  const saud = greet ? greet.charAt(0).toUpperCase() + greet.slice(1) : greetingNow();
  return thanks ? `Disponha! ${saud}.` : `${saud}! Disponha.`;
}

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

// WhatsApp ÚNICO (Fabio 28/09): quem atende é a Andreia — não existe
// "outro atendente" pra quem passar. Pergunta fora do escopo virou askTeam
// (a IA disse "vou te passar pra um atendente" sobre garantia de veículo).
const HANDOFF_RULES = `
ESTE É UM WHATSAPP ÚNICO: quem atende o cliente é a Andreia (você fala como ela). Não existe outro atendente, setor ou pessoa pra quem "passar" o cliente — NUNCA diga que vai transferir, passar pra um atendente, pra outra pessoa ou pra equipe.
LIGAÇÕES: quem liga pro cliente é SEMPRE a Andreia — fale em primeira pessoa ("eu te ligo", "na nossa ligação"). Nunca diga que outra pessoa (Fabio, o responsável do card ou qualquer nome da equipe) vai ligar ou explicar algo numa ligação, mesmo que apareça outro nome no histórico ou nos dados do card.
Depois que uma ligação já foi combinada na conversa, NÃO fique reafirmando nem citando a ligação nas mensagens seguintes (nada de "antes da nossa ligação", "fica marcada pra amanhã", "te explico na ligação") — responda o que o cliente perguntou e só fale da ligação se ELE perguntar dela.
NÃO se apresente ("aqui é a Andreia", "Andreia da A&F") — o cliente já sabe com quem está falando; só diga seu nome quando for necessário (ex.: ele perguntar quem é). Vale a qualquer hora, inclusive à noite: o atendimento é o mesmo.
DÚVIDA OU DESCONFIANÇA (Fabio 30/09): se o cliente estiver desconfiado (medo de golpe, não conhece a empresa) ou cheio de dúvidas que não se resolvem bem por mensagem, além de responder (desconfiança → Prova Social), ofereça em uma frase agendar uma ligação — ex.: "Se preferir, podemos agendar uma ligação pra eu te explicar tudo com calma." Se ele aceitar, siga o bloco de LIGAÇÃO (pergunte o melhor dia/horário). Não ofereça de novo se ele já recusou ou se já tem ligação combinada.
Se o cliente perguntar SINCERAMENTE se está falando com um robô/IA ou com uma pessoa, não negue: diga que é a assistente virtual da A&F, que atende junto com a Andreia, e que, se ele preferir, ela mesma continua por aqui (se ele quiser, marque "handoff").
DEVOLVER A CONVERSA PRA ANDREIA ("handoff": true — a IA para de responder e ela assume pessoalmente) só quando:
- o cliente pedir, de qualquer forma, pra falar com uma pessoa/humano;
- o cliente parecer insatisfeito ou impaciente, ou reclamar do atendimento.
Pergunta que você não sabe responder ou sobre produto/assunto fora do escopo deste chat (ver acima) NÃO é handoff — é "askTeam" (abaixo).
Quando marcar "handoff": true, a "reply" é uma frase curta e natural, sem falar em transferência (ex.: "Certo, já te respondo por aqui."). Nunca deixe o campo "reply" vazio. Preencha também "handoffReason" com o motivo em poucas palavras (vai pro aviso da equipe).`;

// Pedido do Fabio (2026-09-25): em vez de só encerrar quando não sabe, a IA
// pergunta pra equipe no balão "Dúvidas da IA" — o colaborador responde lá,
// a resposta volta pro cliente e, se for regra geral, vira Base de
// Conhecimento (ver ai-team-question.service.ts).
const ASK_TEAM_RULES = `PERGUNTAR PRA EQUIPE ("askTeam") — quando você NÃO tem como responder com certeza (não está no material, depende da situação específica dele, é sobre outro produto/serviço fora do escopo deste chat — ex.: "vocês fazem com garantia de veículo?" —, é pedido de simulação/valor de parcela, ou é um caso que alguma regra aqui manda verificar):
- NÃO responda o cliente: "noReply": true e "reply" vazio. NUNCA mande "vou verificar", "deixa eu confirmar", "já te retorno" nem nada parecido (Fabio 30/09: fica chato e parece que a gente não sabe nada). A equipe responde no balão do CRM e aí o CRM manda a resposta certa pro cliente.
- NÃO invente e NÃO encerre o atendimento.
- Se a mensagem tiver uma parte que você sabe responder COM CERTEZA e outra que não, responda só a parte que sabe (sem citar a outra, sem "vou verificar") e mande a outra em "askTeam".
- Em "askTeam", escreva a pergunta pra equipe: curta, direta e com o contexto que a equipe precisa pra responder sem abrir a conversa (produto, o que o cliente disse, o que exatamente você precisa saber). Ex.: "Cliente de Home Equity diz que o imóvel é só de escritura, sem matrícula no cartório. Dá pra seguir ou precisa de outro imóvel?" / "Cliente de Home Equity pediu simulação de R$ 50 mil em 60 meses — qual fica a parcela?"
- Se a mesma dúvida já está com a equipe (ver "DÚVIDAS DESTE CLIENTE QUE VOCÊ JÁ LEVOU PRA EQUIPE"), não pergunte de novo e não responda nada sobre ela ("noReply": true, "askTeam": null) — a resposta chega pelo balão.
- Nos outros casos, "askTeam": null. Não use por cautela quando o material responde.`;

/** Só estes valores são aceitos em "moveToStage" — usuário definiu esse
 *  alcance explicitamente: a IA NUNCA move sozinha pra etapas que fecham
 *  negócio (Fechado, Aprovado etc.), só pra estas de andamento. "Perdido"
 *  não é etapa — é status, tratado separado em MARK_LOST_RULES. */
const MOVE_STAGE_RULES = `MOVER O CARD DE ETAPA ("moveToStage") — só estes valores são aceitos, escolha no máximo um, ou null se não for o caso (a maioria das mensagens não muda de etapa):
- "Follow Up": o PRÓPRIO CLIENTE adiou — disse que vai pensar, que vai conversar com alguém, pediu pra retornarem depois. NÃO use só porque ele disse que tem interesse, nem porque estamos esperando algo (ele preencher a proposta, permitir a ligação, mandar dado) — nesses casos o card fica onde está (null).
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
- HOME EQUITY — SITUAÇÃO DO IMÓVEL (antes de mandar o link da PROPOSTA — quando ele escolher seguir pra aprovação —, se a conversa ainda não respondeu isso; pra tirar dúvida ou mandar o simulador não precisa perguntar): pergunte em uma frase se o imóvel que vai ficar de garantia tem matrícula registrada em cartório e está regularizado.
  - Se sim: siga normalmente.
  - Se ele não tiver certeza (não sabe se tem matrícula, se está registrado, se está tudo certo com o imóvel): não insista nem desqualifique — diga que isso a gente vê depois e siga pra aprovação, algo como: "Sem problema, isso a gente confere mais pra frente." + o link da proposta.
  - Se não: antes de desistir, pergunte se ele tem outro imóvel pra colocar como garantia, ou outra pessoa que possa fazer o crédito com um imóvel no nome dela — pode ser um parente de 1º grau (pai, mãe, filho).
  - Só se não houver nenhuma alternativa: explique com gentileza que sem imóvel registrado e regular não dá pra seguir agora e marque "markLost" com "Lead desqualificado — <motivo>".
- Do jeito que a equipe faz (pedido do Fabio 26/09):
  1. Quando o cliente responder ou mostrar interesse (e isso ainda não foi perguntado nesta conversa), pergunte em UMA frase curta o que ele prefere — tirar dúvidas de como funciona, fazer uma nova simulação ou já seguir pra aprovação do crédito. Algo como: "Você tem alguma dúvida de como funciona, quer fazer uma nova simulação ou já quer seguir pra aprovação do seu crédito?" (Quando o cliente toca no botão "Tenho interesse", o CRM já manda essa pergunta sozinho — aí você só trata a resposta dele no passo 2.)
  2. Conforme a escolha:
     - Dúvidas: responda em poucas palavras (Base de Conhecimento) e, quando a dúvida estiver resolvida, ofereça seguir pra aprovação ("Quer que eu já te mande o link pra gente tentar aprovar?").
     - Simulação: mande o link do simulador do produto dele e diga que, depois de simular, é só preencher a proposta que a gente já faz a pré-análise. Financiamento pra comprar/construir: https://aefsolucoesfinanceiras.com.br/simulador.html — Crédito com garantia de imóvel (Home Equity): https://aefsolucoesfinanceiras.com.br/servicos/simulador-home-equity.html. Você mesma não calcula parcela, taxa nem valor aprovado.
  - A A&F FAZ SIMULAÇÃO (a equipe roda nos bancos): NUNCA diga que não faz simulação ou que "não é algo que eu calculo por aqui". Cliente que já passou da proposta (pré-análise, aprovado, documentação) e pede valor de parcela ou simulação com outro prazo/valor/banco: é pedido de simulação pra equipe — "askTeam" com os dados (produto, valor, prazo, banco) e "noReply": true.
     - Aprovação (ou sim, pode, bora, "quero aprovar"): mande o link da proposta manual do produto dele usando o texto da Resposta Rápida correspondente ("Proposta manual Finan Hab" ou "Proposta manual Home Equity") e termine com algo como "Se tiver alguma dúvida, é só me falar."
  Se o cliente já pediu pra seguir, pediu o link ou já está pronto pra mandar os dados, pule a pergunta e mande direto o link da proposta.
  - Financiamento pra comprar/construir imóvel: https://aefsolucoesfinanceiras.com.br/proposta-manual
  - Crédito com garantia de imóvel (Home Equity): https://aefsolucoesfinanceiras.com.br/proposta-manual-home-equity
- Se o cliente fizer uma pergunta, responda em poucas palavras; se o link da proposta ainda não foi enviado, termine oferecendo seguir pra aprovação.
- Depois que o link foi enviado, só responda dúvidas — não peça os dados do formulário pela conversa nem reenvie o link a cada mensagem (só se ele pedir ou disser que não achou).
- Não avalie viabilidade (valor mínimo, percentual do imóvel etc.) antes do formulário preenchido: isso é visto na pré-análise, com os dados do formulário.
- Se o cliente já disse que preencheu a proposta, não mande o link de novo.
- Crédito com garantia no nome de EMPRESA (PJ): as condições (taxa e documentação) são diferentes e bem mais complexas que as de pessoa física — nunca use taxa de PF pra PJ. O caminho padrão é pessoa física: na primeira vez que o cliente falar em fazer pela empresa, pergunte em uma frase se ele pode fazer no nome dele (pessoa física), que é mais simples. Só se ele confirmar que precisa mesmo como PJ: não mande o formulário de pessoa física — no lugar dele, mande a lista de documentos da Resposta Rápida "Documentos comprador PJ" (fiel ao conteúdo) e pergunte se ficou alguma dúvida. Pra PJ essa lista é o primeiro passo (exceção à regra de só pedir documentos depois da pré-análise). Taxa pra PJ só sai na análise: se perguntarem, diga isso, sem citar taxa de PF.
- Setores sem proposta manual (ex.: Consórcio): siga normalmente, sem esta regra.

DOCUMENTOS: quando for a hora de pedir a documentação — pré-análise já aprovada (etapa "Aprovado Pré-Analise" ou "Aguardando Documentação") ou o cliente perguntar quais documentos precisa:
- Se a conversa JÁ TEM uma lista de documentos enviada pela equipe, use a MESMA lista (não mande outra diferente) — só lembre o que falta dela.
- Senão, Home Equity pessoa física: mande a Resposta Rápida "Documentos Home Equity", fiel ao conteúdo, sem texto em volta. Financiamento Habitacional: a lista do perfil de renda do cliente. PJ: "Documentos comprador PJ" (regra acima).
- Antes da pré-análise aprovada, não peça documentos (a proposta vem primeiro). Se o card AINDA NÃO foi aprovado (etapa antes de "Aprovado Pré-Analise"/"Aguardando Documentação" — ex.: Prospecção, Follow Up, Pré-Análise) e o cliente perguntar quais documentos precisa: mande só a LISTA, SEM a frase de parabéns/aprovação que abre a Resposta Rápida, e diga em uma frase que a documentação entra depois da pré-análise aprovada — o primeiro passo é a proposta (mande o link se ele ainda não preencheu). NUNCA diga que foi aprovado ("Parabéns", "foi aprovado") se a etapa não é de aprovado.
- HOME EQUITY — DOCUMENTOS DO IMÓVEL: se, na hora dos documentos do imóvel (certidão de ônus reais, CND de IPTU), o cliente ainda estiver em dúvida sobre a situação do imóvel (não sabe se tem matrícula, se está registrado ou regularizado, se a certidão vai sair), não tente resolver nem explicar por conta própria: não responda sobre isso ("noReply": true, sem "vou verificar") e leve a dúvida pra equipe em "askTeam", com o que o cliente disse sobre o imóvel.
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
{"reply": "<mensagem para o cliente, ou vazio se noReply>", "noReply": <true ou false>, "handoff": <true ou false>, "handoffReason": "<motivo curto do handoff, ou null>", "askTeam": "<pergunta pra equipe, ou null>", "moveToStage": "<Follow Up | Lead Sem Retorno | Pré-Análise | Prospecção | Venda Futura | null>", "markLost": "<motivo curto, ou null>", "stopFollowUp": <true ou false>, "moveReason": "<motivo da mudança de etapa, ou null>", "extractedFields": {<chave: valor, ou {} se nenhuma>}, "callRequest": <{"when": "...", "isoDateTime": "..."} ou null — só quando o bloco LIGAÇÃO PELO WHATSAPP mandar>}`;

export interface AiAutoReplyResult {
  reply: string;
  /** true = cliente só confirmou/encerrou ("ok", "beleza") — não mandar nada (reply vem vazio). */
  noReply?: boolean;
  /** true = cliente pediu atendimento humano (ou pergunta fora do escopo deste setor/produto) — quem chamou deve desligar o Lead.aiAutoReplyActive e avisar o colaborador responsável. */
  handoff: boolean;
  /** Motivo do handoff em poucas palavras (vai pra nota do card e pro aviso da equipe). */
  handoffReason?: string | null;
  /** Pergunta pra equipe (balão "Dúvidas da IA") — a IA disse ao cliente que vai verificar; quem chamou cria a AiTeamQuestion (ai-team-question.service.ts). */
  askTeam?: string | null;
  /** Cliente quer ligação nesse horário — quem chamou abre o pedido pra Andreia confirmar (createCallRequest). */
  callRequest?: { when: string; isoDateTime: string | null } | null;
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
    const closing = farewellReply(incomingText);
    if (closing) {
      const lastOut = await prisma.message.findFirst({
        where: { leadId, direction: 'OUTBOUND', callWaCallId: null, deleted: false },
        orderBy: { createdAt: 'desc' },
        select: { content: true },
      });
      // Nossa última mensagem fez uma pergunta de verdade: o "ok, obrigado"
      // pode ser a resposta — segue o fluxo normal. Já fechamos: não repete.
      if (!lastOut || !hasRealQuestion(lastOut.content)) {
        if (lastOut && /disponha/i.test(lastOut.content)) return { reply: '', handoff: false, noReply: true };
        console.log(`[AI Auto-reply] cliente encerrou ("${incomingText.trim().slice(0, 40)}") — fechando com "${closing}"`);
        return { reply: closing, handoff: false };
      }
    }
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
    const duvidasEquipe = await teamQuestionsContext(leadId);
    const ligacao = await callPermissionContext(accountId, leadId, incomingText);
    const conversasPorTelefone = await callSummaryContext(leadId).catch(() => '');

    const systemPrompt = `${ROLE_FRAMING}

${CORE_RULES}
${SAFETY_RULES}
${HANDOFF_RULES}

${ASK_TEAM_RULES}

${MOVE_STAGE_RULES}

${MARK_LOST_RULES}

${STOP_FOLLOWUP_RULES}

${FORM_FIRST_RULES}

${NO_REPLY_RULES}

${buildFillFieldsRules(camposTexto)}

${OUTPUT_FORMAT}

${buildContextBlocks(ctx)}${duvidasEquipe ? `

${duvidasEquipe}` : ''}${ligacao ? `

${ligacao}` : ''}${conversasPorTelefone ? `

${conversasPorTelefone}` : ''}`;

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

    const result = parseReply(raw);
    // Trava: card que ainda não foi aprovado nunca recebe "parabéns, foi
    // aprovado" (Berenice 30/09: pediu a lista de documentos na Prospecção e
    // a IA mandou a Resposta Rápida inteira, que abre com a frase de aprovação).
    const aprovado = /aprovad|aguardando document|document|contrata|conclu|fechad/i.test(ctx.etapaTexto.split('→').pop() || '');
    if (!aprovado && result.reply) result.reply = stripApprovalClaims(result.reply);
    return result;
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
/** Tira frases de "parabéns / foi aprovado" (Resposta Rápida de documentos
 *  usada antes da aprovação). */
export function stripApprovalClaims(text: string): string {
  const out = text
    .split('\n')
    .map((line) => line.replace(/[^.!?\n]*(parab[ée]ns|foi aprovad|aprovad[oa] na pr[ée]-?\s?an[áa]lise)[^.!?\n]*[.!?]?\s*/gi, ''))
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\n{3,}/g, '\n\n');
  return out.trim() ? out.charAt(0).toUpperCase() + out.slice(1) : text;
}

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
        askTeam: typeof parsed.askTeam === 'string' && parsed.askTeam.trim() && parsed.askTeam.trim().toLowerCase() !== 'null' ? parsed.askTeam.trim().slice(0, 1000) : null,
        moveToStage: typeof parsed.moveToStage === 'string' && parsed.moveToStage.trim() ? parsed.moveToStage.trim() : null,
        markLost: typeof parsed.markLost === 'string' && parsed.markLost.trim() ? parsed.markLost.trim() : null,
        stopFollowUp: parsed.stopFollowUp === true,
        moveReason: typeof parsed.moveReason === 'string' && parsed.moveReason.trim() ? parsed.moveReason.trim() : null,
        extractedFields,
      };
    }
    if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      return {
        reply: stripOpeningInterjection(parsed.reply.trim()),
        callRequest: parsed.callRequest && typeof parsed.callRequest === 'object' && typeof parsed.callRequest.when === 'string' && parsed.callRequest.when.trim()
          ? { when: parsed.callRequest.when.trim(), isoDateTime: typeof parsed.callRequest.isoDateTime === 'string' ? parsed.callRequest.isoDateTime : null }
          : null,
        handoff: parsed.handoff === true,
        handoffReason: parsed.handoff === true && typeof parsed.handoffReason === 'string' && parsed.handoffReason.trim() ? parsed.handoffReason.trim().slice(0, 200) : null,
        askTeam: parsed.handoff !== true && typeof parsed.askTeam === 'string' && parsed.askTeam.trim() && parsed.askTeam.trim().toLowerCase() !== 'null' ? parsed.askTeam.trim().slice(0, 1000) : null,
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
      if (reply) return { reply: stripOpeningInterjection(reply), handoff: false };
    } catch {
      // segue pro fallback genérico abaixo
    }
  }

  return { reply: 'Recebi sua mensagem! Só um instante que já te retorno.', handoff: false };
}
