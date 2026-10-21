import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { voiceNoteForAi } from './speech-to-text.service';
import { searchKnowledge } from './knowledge.service';
import { parseMoneyOrNumber } from './campaign-detection.service';
import { logActivity } from './activity.service';
import { callableFirstName, isCallableName, normalizeClientName } from '../lib/text';


/**
 * "Cérebro" compartilhado entre as duas IAs que ajudam a responder cliente:
 * a que fala DIRETO com ele (ai-auto-reply.service.ts) e a que sugere pro
 * colaborador revisar antes de mandar (ai-reply-suggestion.service.ts).
 *
 * Usuário pediu explicitamente que fossem "a mesma IA" — antes eram dois
 * prompts mantidos à mão, que foram divergindo (a de auto-resposta ficou
 * mais hesitante que a de sugestão com o mesmo material disponível). Agora
 * as duas usam exatamente este mesmo material de contexto (Base de
 * Conhecimento, Respostas Rápidas, estilo do vendedor, escopo do setor) e
 * as mesmas regras de como responder (CORE_RULES) — só o que é
 * estruturalmente inevitável continua diferente em cada arquivo: a
 * auto-resposta precisa decidir quando chamar um humano (handoff) e agora
 * também pode mover o card de etapa/preencher dados extraídos da conversa
 * (ver applyAiExtractedActions) — a sugestão nunca precisou disso, porque
 * um vendedor sempre revisa e faz essas ações ele mesmo.
 */

export const CORE_RULES = `REGRAS OBRIGATÓRIAS:
- Responda com base no material de referência (Base de Conhecimento + Respostas Rápidas) e no histórico da conversa, abaixo — e use esse material com CONFIANÇA: se ele sustenta uma resposta, responda direto, sem hesitar. NUNCA invente valor, taxa, prazo, data, documento ou qualquer fato específico que não esteja claramente no material — mas se faltar só um dado específico pra completar a resposta, responda a parte que você tem certeza e avance a conversa (peça a informação que falta, ou marque o próximo passo) SEM inventar o dado que falta.
- Se a pergunta/objeção do cliente bater com uma das "Respostas Rápidas" abaixo, seja FIEL ao conteúdo dela — não invente uma lista ou explicação diferente. Pode adaptar o tom pra soar natural, mas o conteúdo (itens, valores, condições) tem que ser exatamente o que está lá.
- Foco em AVANÇAR o atendimento: entenda a última mensagem/objeção do cliente e responda contornando a objeção, reforçando o benefício certo pra esse cliente, conduzindo a conversa adiante (marcar um próximo passo, pedir um documento, agendar, confirmar interesse) — não só responda, empurre pra frente.
- Tom natural de conversa do dia a dia, como a pessoa normalmente escreve (ver estilo abaixo) — nunca pareça um roteiro decorado ou um robô. Português do Brasil, sem formalidade excessiva.
- Sem emoji, a menos que o estilo de escrita abaixo já use.
- NUNCA ANUNCIE APROVAÇÃO DE CRÉDITO POR TEXTO PRÓPRIO (Fabio 19/10: "nunca mandar daquele jeito, sempre encaminhar do nosso jeito"): não escreva "seu crédito foi aprovado/pré-aprovado" com valor, prazo, taxa ou parcela por conta própria — a aprovação é SEMPRE o aviso padrão do CRM (resumo da proposta + documentos), que o CRM envia (a IA pede com sendApproval, ou a equipe usa o botão "Avisar cliente"). Se não houver aviso padrão a enviar, leve a dúvida pra equipe.
- EMISSÃO DE DOCUMENTOS (Fabio 19/10, corrigindo; 21/10: SEM nome de empresa e SEM nome de ninguém): a gente EMITE certidões e documentos (CND de IPTU, certidão de ônus/matrícula…) e você PODE dizer isso — mas só dentro do horário comercial (a linha "HORÁRIO AGORA" abaixo diz se é o caso). DENTRO: pode dizer que a gente vai emitir (e que envia assim que sair). FORA: diga apenas que consegue emitir (sem citar o nome da empresa, ex.: "dá pra emitir aqui"), sem dizer que VAI emitir agora e sem "já te envio", "te mando assim que sair" ou "só um instante". Nunca prometa horário nem prazo exato.
- IPTU NO HOME EQUITY (Fabio 19/10): a GUIA, o carnê ou a CAPA do IPTU que o cliente mandar JÁ SERVE (traz a inscrição imobiliária) — agradeça e siga. NUNCA diga que o que ele mandou "não é o que o banco pede", NÃO peça CND de IPTU ao cliente: se a CND for necessária, a equipe emite com a inscrição (e, se o assunto surgir, vale a regra de EMISSÃO DE DOCUMENTOS acima).
- Nada de abrir a mensagem com interjeição ou elogio ("Show", "Perfeito", "Que ótimo", "Ótimo", "Que bom", "Entendi"): vá direto ao ponto, como a equipe faz. Não repita o nome do cliente em toda mensagem e evite pontos de exclamação em sequência.
- ÁUDIO: o cliente PODE mandar áudio — o CRM transcreve e você lê o que ele falou (no histórico aparece como "(áudio) ..."). Se ele perguntar se pode mandar áudio, diga que pode sim, à vontade. Nunca peça pra mandar por texto em vez de áudio (Fabio 07/10).
- CAIXA (Caixa Econômica Federal; Fabio 21/10): diferente dos outros bancos (que analisam primeiro e pedem documentos depois), a CAIXA pede a documentação ANTES de qualquer análise. A proposta lista a CAIXA entre os bancos solicitados de quase todo cliente (marcação padrão), então DEPOIS de mostrar a aprovação o CRM pergunta ao cliente se REALMENTE quer seguir pela CAIXA ("Vi que você marcou a CAIXA… você realmente deseja seguir com a CAIXA?") — NÃO pergunte isso por conta própria antes da aprovação. SEQUÊNCIA, UMA pergunta curta por vez: (1) se ele disser que SIM (ou falar da CAIXA por conta própria): pergunte, na mesma mensagem, se o NOME está limpo (sem restrição) e se o imóvel tem HABITE-SE — são as regras da CAIXA; (2) se o nome está limpo E o imóvel tem Habite-se: avise que, pela CAIXA, ele precisa encaminhar a documentação ANTES (RG, CPF, comprovante de endereço, último contracheque, certidão de estado civil e, se tiver cônjuge, RG e CPF dele); (3) se o nome NÃO está limpo OU o imóvel NÃO tem Habite-se: explique, com clareza e sem prometer, que na CAIXA essas são as regras, mas que nos outros bancos privados pode ser que aprove (siga com a aprovação que ele já tem); (4) se ele disser que NÃO quer a CAIXA: agradeça e siga com a aprovação. HABITE-SE: a CAIXA NÃO aceita imóvel RESIDENCIAL sem Habite-se em NENHUMA operação — nem financiamento habitacional, nem Home Equity.
- CURTO E OBJETIVO (Fabio 15/10: "ela tá com textos muito longos, pede pra resumir"): no MÁXIMO 2 frases curtas (uns 220 caracteres no total), mesmo quando está explicando algo. Dê só o essencial, na ordem: a resposta primeiro, depois (se precisar) UM detalhe. Sem repetir o que o cliente disse, sem introdução ("Entendo…", "É importante lembrar…"), sem parágrafos, sem listas, sem explicar o que ele não perguntou, sem fechar com frase de efeito. Se o cliente quiser mais, ele pergunta. Exceção única: Resposta Rápida pronta (lista de documentos, link da proposta, condições da aprovação) — vai no tamanho dela, sem texto em volta.`;

/** Corta interjeição/elogio no começo da resposta ("Show, então vamos
 *  seguir..." → "Então vamos seguir..."). A regra acima já pede isso, mas o
 *  modelo às vezes imita o "Show" das mensagens da equipe (exemplos de estilo)
 *  — Fabio 26/09: "a IA continua usando: SHOW". Filtro fixo, não depende do modelo. */
export function stripOpeningInterjection(text: string): string {
  // ", Jaime." colado na interjeição sai junto ("Que ótimo, Jaime. Vamos lá." → "Vamos lá.").
  const re = /^\s*(show( de bola)?|perfeito|(que )?[oó]timo|que bom|maravilha|excelente|top|beleza|massa|legal|entendi|certo|combinado|fechado|show de bola)(\s*,\s*[\p{L}]+)?\s*[!.…]+\s*|^\s*(show( de bola)?|perfeito|(que )?[oó]timo|que bom|maravilha|excelente|top|beleza|massa|legal|entendi|certo|combinado|fechado|show de bola)\s*[!,.…]+\s*/iu;
  let out = text;
  for (let i = 0; i < 3 && re.test(out); i++) out = out.replace(re, '');
  out = out.trim();
  if (!out) return text.trim();
  return out === text.trim() ? out : out.charAt(0).toUpperCase() + out.slice(1);
}

export interface SharedAiContext {
  lead: {
    id: string;
    userId: string | null;
    user: { id: string; name: string } | null;
  };
  departmentId: string | undefined;
  historicoTexto: string;
  contextoTexto: string;
  respostasRapidasTexto: string;
  estiloTexto: string;
  escopoTexto: string;
  etapaTexto: string;
  /** Campo "Instituição" do card — o banco em que o processo está seguindo. */
  bancoTexto: string | null;
  /** Card Perdido: motivo + notas de aprovação/reprovação (regra dos Perdidos). */
  perdidoTexto: string | null;
  /** Como chamar o cliente — ou aviso de que o nome do card não é nome. */
  nomeTexto: string;
}

/**
 * Monta todo o material de contexto compartilhado pras duas IAs, escopado
 * pelo lead/setor. `focusText` é o texto usado pra buscar na Base de
 * Conhecimento (a mensagem recebida, no auto-reply; a última mensagem do
 * cliente, na sugestão) — cada chamador decide como achar esse foco, essa
 * função só recebe o resultado. Retorna null se o lead não existir.
 */
export async function buildSharedAiContext(
  accountId: string,
  leadId: string,
  focusText: string,
  opts: { historyTake?: number; historyRoleLabels?: { inbound: string; outbound: string } } = {}
): Promise<SharedAiContext | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { pipeline: { include: { department: true } }, stage: { select: { name: true } }, user: { select: { id: true, name: true } } },
  });
  if (!lead) return null;

  const historyTake = opts.historyTake ?? 12;
  const inboundLabel = opts.historyRoleLabels?.inbound ?? 'Cliente';
  const outboundLabel = opts.historyRoleLabels?.outbound ?? 'Atendente';

  // Só a conversa (WhatsApp etc.) — e-mails ficam de fora do que a IA lê
  // (Fabio 27/09: "a IA não precisa levar em consideração os e-mails").
  const recent = await prisma.message.findMany({
    where: { leadId, channel: { not: 'EMAIL' } },
    orderBy: { createdAt: 'desc' },
    take: historyTake,
  });
  const ordered = recent.reverse();
  const historicoTexto = ordered.length
    ? ordered.map((m) => `${m.direction === 'INBOUND' ? inboundLabel : outboundLabel}: ${voiceNoteForAi(m.content)}`).join('\n')
    : '(sem histórico anterior)';

  // Escopo de produtos deste setor — trata o setor do CARD como o produto
  // correto do cliente, mesmo com palavreado ambíguo (ex.: "crédito com
  // garantia de imóvel" pode soar como Home Equity mesmo num card de
  // Financiamento Habitacional) — evita a IA trocar de produto sozinha.
  const department = lead.pipeline?.department;
  const escopo = department?.aiScope?.trim() || department?.name || null;
  const escopoTexto = escopo
    ? `Este atendimento já está classificado no setor "${department?.name}" — os produtos deste setor são: ${escopo}. Trate isso como o produto CORRETO do cliente, mesmo que a mensagem dele use um termo ambíguo que pareça outro produto da empresa — não troque de produto por conta própria. Só se a mensagem for GENUINAMENTE sobre outra linha de negócio da empresa (fora dessa lista) é que isso deve ser tratado como fora de escopo.`
    : '(este atendimento não tem um setor/produto definido — sem restrição de escopo)';

  // Combina documentos do Drive (busca por similaridade) com entradas
  // manuais da Base de Conhecimento (sempre incluídas, escopadas por
  // setor) — ver searchKnowledge em knowledge.service.ts.
  const hits = focusText.trim() ? await searchKnowledge(accountId, focusText, 5, department?.id) : [];
  // Regras do banco do card entram sempre, mesmo que a mensagem não cite o
  // banco ("Ele é financiado." não puxava a regra do Santander pela busca).
  const banco = String(((lead.customFields as any) || {}).instituicao || '').trim();
  if (banco) {
    const doBanco = await prisma.knowledgeEntry.findMany({
      where: { accountId, title: { contains: banco, mode: 'insensitive' }, ...(department?.id ? { OR: [{ departmentId: department.id }, { departmentId: null }] } : {}) },
      select: { title: true, content: true },
      take: 5,
    }).catch(() => []);
    for (const e of doBanco) {
      const content = `${e.title}: ${e.content}`;
      if (!hits.some((h) => h.content === content)) hits.push({ content, fileName: e.title, score: 1 });
    }
  }
  const contextoTexto = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n')
    : '(nenhum material relevante encontrado na Base de Conhecimento para esta pergunta — se a dúvida depender de um fato específico, não invente)';

  // Respostas Rápidas do setor deste lead + as "compartilhadas" (sem
  // setor) — mesmo critério usado na tela de Respostas Rápidas.
  const templates = await prisma.messageTemplate.findMany({
    where: {
      accountId,
      ...(department?.id ? { OR: [{ departmentId: department.id }, { departmentId: null }] } : {}),
    },
    orderBy: { name: 'asc' },
  });
  const respostasRapidasTexto = templates.length
    ? templates.map((t) => `- "${t.name}": ${t.body}`).join('\n')
    : '(nenhuma resposta rápida cadastrada)';

  // Estilo de escrita: mensagens reais que a EQUIPE escreveu à mão
  // (sentByUserId), nunca as da própria IA — pra imitar só o TOM, nunca o
  // conteúdo/fatos de outra conversa. Primeiro as do responsável pelo card,
  // completando com as do resto da equipe: antes eram só as do responsável,
  // e com um responsável que não escreve (ex.: "Admin AF") a IA ficava sem
  // exemplo nenhum e caía no "Show! Perfeito! Que ótimo!" genérico.
  let estiloTexto = '(sem exemplos suficientes — escreva de forma natural e não robótica)';
  const exemplos = await prisma.message.findMany({
    where: { direction: 'OUTBOUND', channel: 'WHATSAPP', sentByUserId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 300,
    select: { content: true, sentByUserId: true },
  }).catch(() => []);
  const vistos = new Set<string>();
  const candidatos = exemplos
    .map((m) => ({ texto: m.content.trim(), doResponsavel: !!lead.userId && m.sentByUserId === lead.userId }))
    .filter(({ texto }) => {
      if (texto.length < 12 || texto.length > 220 || /https?:|📎|📞/.test(texto)) return false;
      const chave = texto.toLowerCase();
      if (vistos.has(chave)) return false; // lembretes automáticos repetidos
      vistos.add(chave);
      return true;
    });
  const escolhidos = [...candidatos.filter((c) => c.doResponsavel), ...candidatos.filter((c) => !c.doResponsavel)]
    .slice(0, 12)
    .map((c) => c.texto);
  if (escolhidos.length) estiloTexto = escolhidos.map((c) => `- "${c}"`).join('\n');

  return {
    lead: { id: lead.id, userId: lead.userId, user: lead.user },
    departmentId: department?.id,
    historicoTexto,
    contextoTexto,
    respostasRapidasTexto,
    estiloTexto,
    escopoTexto,
    etapaTexto: `${lead.pipeline?.name || '?'} → ${lead.stage?.name || '?'}`,
    // Sem o banco a IA dizia que imóvel financiado "não impede" pra um
    // cliente aprovado no Santander, que só aceita quitado (Cláudio, 01/10).
    bancoTexto: String(((lead.customFields as any) || {}).instituicao || '').trim() || null,
    perdidoTexto: lead.status === 'LOST' ? await lostCardContext(lead.id, lead.lostReason) : null,
    nomeTexto: (() => {
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      const nome = callableFirstName(cf.participante_1, lead.name);
      return nome
        ? `${nome} (pode chamar pelo nome, sem repetir em toda mensagem).`
        : `O nome no card ("${String(cf.participante_1 || lead.name || '').slice(0, 40)}") NÃO é um nome de verdade (tem número, emoji ou símbolo). NÃO chame o cliente por esse nome nem por um pedaço dele (Fabio 08/10). Quando for natural na conversa, pergunte como ele se chama; quando ele disser, preencha "participante_1" em "extractedFields" com o nome que ele informou.`;
    })(),
  };
}

/** Perdido que voltou a escrever (Fabio 08/10): a IA precisa saber POR QUE
 *  ele foi perdido — reprovação/restrição antes muda a conversa. Junta o
 *  motivo da perda com as notas do card que falam de análise. */
async function lostCardContext(leadId: string, lostReason: string | null): Promise<string> {
  const notes = await prisma.note.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 60, select: { content: true, createdAt: true } }).catch(() => []);
  const analise = notes
    .filter((n) => /aprovad|reprovad|recusad|restri|negad|n[aã]o foi poss|n[aã]o aprov|score|serasa|spc/i.test(n.content) && !/^(Resposta automática da IA|🤖)/.test(n.content))
    .slice(0, 5)
    .map((n) => `- ${n.createdAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}: ${n.content.replace(/\s+/g, ' ').slice(0, 220)}`);
  return `Motivo da perda: ${lostReason || '(não informado)'}
${analise.length ? `Notas do card sobre análise/aprovação:\n${analise.join('\n')}` : 'Nenhuma nota de análise/aprovação no card.'}
Se o cliente quiser seguir com o crédito/aprovação:
- Se o motivo e as notas NÃO mostram reprovação, restrição ou crédito negado antes (ex.: sem interesse, sem retorno, taxa, desistiu, não respondeu): atenda normal, como um cliente novo (dúvidas / simulação / proposta).
- Se mostram reprovação, restrição, crédito negado ou aprovado abaixo do que ele precisava: não prometa nada. Pergunte em 1-2 frases o que mudou desde a última análise (restrição regularizada, renda maior, outro imóvel de garantia, outro participante). Se ele trouxer um fato que pode mudar a aprovação, siga com a proposta e avise a equipe em "askTeam" com o que mudou. Se nada mudou, explique com educação que a análise anterior não aprovou e que dá pra tentar de novo quando essa situação mudar.
- Nunca repita o motivo interno cru (ex.: "LEAD DESQUALIFICADO", "CLIENTE COM RESTRICAO") — fale com naturalidade.`;
}

/** Monta os blocos de contexto no MESMO formato/ordem pras duas IAs. */
/** Data de hoje no horário de Brasília. Sem isso o modelo usa a própria
 *  noção de ano e chamou a admissão de 21/05/2026 de "data futura" pra uma
 *  cliente em 01/10/2026 (Déborah, Fabio 01/10). */
export function todayContextLine(): string {
  const hoje = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const h = Number(hora.slice(0, 2));
  const dentro = h >= 7 && h < 21; // mesmo horário dos avisos ao cliente (Fabio 14/10): 07h às 21h, Brasília
  return `DATA DE HOJE: ${hoje} (horário de Brasília). Use sempre esta data pra saber se uma data é passada, futura ou recente — nunca a sua própria ideia de ano.
HORÁRIO AGORA: ${hora} — ${dentro ? 'DENTRO do horário comercial (07h às 21h): se a equipe precisar emitir um documento, você pode dizer que a gente vai emitir.' : 'FORA do horário comercial (07h às 21h): se a equipe precisar emitir um documento, diga SÓ que consegue emitir (ex.: "dá pra emitir aqui com a inscrição", "consigo emitir") sem citar o nome da empresa — NÃO diga que vai emitir, NÃO diga "já te envio", "te mando assim que sair" nem "só um instante".'}`;
}

export function buildContextBlocks(ctx: SharedAiContext): string {
  return `--- ${todayContextLine()} ---

--- NOME DO CLIENTE ---
${ctx.nomeTexto}

--- ESCOPO DE ATENDIMENTO (produto deste chat) ---
${ctx.escopoTexto}

--- ETAPA ATUAL DO CARD (funil → etapa) ---
${ctx.etapaTexto}
${ctx.perdidoTexto ? `
--- ESTE CLIENTE ESTÁ MARCADO COMO PERDIDO (voltou a escrever) ---
${ctx.perdidoTexto}
` : ''}${ctx.bancoTexto ? `
--- BANCO DESTE CARD (campo Instituição — o banco em que o processo do cliente está seguindo) ---
${ctx.bancoTexto}. Quando o cliente trouxer algo que depende do banco (ex.: imóvel financiado/com saldo devedor, conta, forma de pagamento), responda pela regra DESTE banco na Base de Conhecimento — nunca diga que "não impede" ou "dá pra fazer" de forma genérica se a regra deste banco diz o contrário.
` : ''}
--- ESTILO DE ESCRITA DA EQUIPE (mensagens reais escritas à mão) ---
Imite o TOM e o jeito de escrever destes exemplos reais que a equipe já mandou pra outros clientes: direto, simples, sem enfeite. NUNCA reaproveite o conteúdo/fatos deles (são de outras conversas) nem copie erros de digitação:
${ctx.estiloTexto}

--- BASE DE CONHECIMENTO (material de referência) ---
${ctx.contextoTexto}

--- RESPOSTAS RÁPIDAS (modelos prontos da equipe — use o conteúdo fielmente quando bater) ---
${ctx.respostasRapidasTexto}

--- HISTÓRICO RECENTE DESTA CONVERSA ---
${ctx.historicoTexto}`;
}

// ─── Ações que só a IA de auto-resposta pode tomar (mover etapa / ────────
// ─── preencher dados do card) — a Sugerir resposta nunca faz isso        ─
// sozinha, porque um humano sempre revisa e mexe no card ele mesmo.

/** Campos "fixos" da aba Principal (lead-sidebar.tsx) — não vêm de
 *  FieldDefinition, por isso ficam hardcoded aqui (mesmo critério já usado
 *  em site-lead.service.ts pros campos conhecidos). */
const BUILTIN_LEAD_FIELDS: { key: string; label: string }[] = [
  { key: 'participante_1', label: 'Nome do participante 1' },
  { key: 'participante_2', label: 'Nome do participante 2' },
  { key: 'telefone_1', label: 'Telefone do participante 1' },
  { key: 'telefone_2', label: 'Telefone do participante 2' },
  { key: 'cpf_1', label: 'CPF do participante 1' },
  { key: 'cpf_2', label: 'CPF do participante 2' },
  { key: 'nascimento_1', label: 'Data de nascimento do participante 1' },
  { key: 'nascimento_2', label: 'Data de nascimento do participante 2' },
  { key: 'renda_1', label: 'Renda do participante 1' },
  { key: 'renda_2', label: 'Renda do participante 2' },
  { key: 'email_1', label: 'E-mail do participante 1' },
  { key: 'email_2', label: 'E-mail do participante 2' },
  { key: 'vinculo_1', label: 'Tipo de vínculo do participante 1 (ex.: CLT, autônomo)' },
  { key: 'vinculo_2', label: 'Tipo de vínculo do participante 2' },
];

/** Campos numéricos — passam por parseMoneyOrNumber ("R$ 100 mil" → número
 *  puro) antes de gravar. Mesmo critério de site-lead.service.ts. */
const NUMBER_FIELD_KEYS = new Set([
  'valor_avaliacao', 'valor_imovel', 'valor_credito', 'valor_entrada',
  'primeira_parcela', 'ultima_parcela', 'renda_1', 'renda_2',
  'credito_consorcio', 'parcela_consorcio', 'prazo_consorcio',
]);

/** Texto listando todos os campos que a IA pode preencher no card — os
 *  fixos da aba Principal + os que a própria conta cadastrou (Financiamento/
 *  Consórcio/abas customizadas), buscados de FieldDefinition pra sempre
 *  refletir o que a conta realmente tem hoje. */
export async function buildFillableFieldsText(accountId: string): Promise<string> {
  const defs = await prisma.fieldDefinition.findMany({ where: { accountId }, orderBy: [{ tab: 'asc' }, { order: 'asc' }] });
  const builtinText = BUILTIN_LEAD_FIELDS.map((f) => `- "${f.key}": ${f.label}`).join('\n');
  const customText = defs.map((d) => `- "${d.key}" (aba ${d.tab}): ${d.name}`).join('\n');
  return [builtinText, customText].filter(Boolean).join('\n');
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export interface AiExtractedAction {
  moveToStage?: string | null;
  /** Motivo da mudança de etapa — vira anotação no card. */
  moveReason?: string | null;
  /** AAAA-MM-DD combinada com o cliente pra retomar o crédito (Venda Futura): grava _vendaFuturaAt no card; o poller de Venda Futura dispara no dia. */
  resumeOn?: string | null;
  extractedFields?: Record<string, string> | null;
  /** Motivo da perda, se a IA decidiu marcar o lead como Perdido — string
   *  não-vazia = marca; ausente/vazio = não mexe no status. */
  markLost?: string | null;
  /** true = cliente pediu pra parar de receber lembrete automático (sem
   *  recusar o negócio) — marca STOP_FOLLOWUP_TAG, que os gatilhos de
   *  inatividade recorrente (excludeTag) já sabem respeitar. */
  stopFollowUp?: boolean;
  /** true = a IA pediu pra rodar a análise de crédito do cliente (extensões como ponte) — valem as travas de requestRunForAi. */
  runAnalysis?: boolean;
  /** Bancos (SANTANDER | INTER) cuja simulação em PDF a IA quer mandar ao cliente — o PDF original do portal sai com a logo A&F (simulation-doc.service.ts). */
  sendSimulation?: string[] | null;
  /** true = a IA decidiu apresentar a aprovação: o CRM manda o aviso padrão (resumo + documentos + PDF) em vez de a IA escrever as condições. */
  sendApproval?: boolean;
  /** Prazo (meses) a simular sozinha no Inter (modo teste) e mandar ao cliente — requestSimulationForAi. */
  simulate?: { prazo?: number; valor?: number } | null;
}

/** Tag usada pra excluir o lead de lembretes automáticos recorrentes
 *  (automation.service.ts, checkInactivityAutomations → cfg.excludeTag) —
 *  nome em texto legível de propósito, aparece como tag normal na tela do
 *  card, igual "Site"/"Campanha". */
export const STOP_FOLLOWUP_TAG = 'Pediu pra parar lembretes';

/** Aplica o que a IA de auto-resposta decidiu (opcional): mover o card pra
 *  uma das etapas permitidas, preencher campos que o cliente mencionou na
 *  conversa, e/ou marcar como Perdido (status, não etapa — mesma ação do
 *  botão "Marcar Perdido" já existente). Nunca lança erro pro chamador —
 *  cada ação é independente e fire-and-forget, igual o resto do fluxo de
 *  mensagem recebida. */
export async function applyAiExtractedActions(
  accountId: string,
  leadId: string,
  action: AiExtractedAction,
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } }
): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, name: true, pipelineId: true, customFields: true, tags: true, contactId: true },
    });
    if (!lead) return;

    // Cliente pediu pra parar de receber lembrete automático (sem recusar o
    // negócio) — marca a tag que os gatilhos de inatividade recorrente
    // (excludeTag) já sabem respeitar, e deixa registrado pra um humano ver.
    if (action.stopFollowUp) {
      const tags = Array.from(new Set([...(lead.tags || []), STOP_FOLLOWUP_TAG]));
      await prisma.lead.update({ where: { id: lead.id }, data: { tags } });
      await prisma.note.create({
        data: { leadId: lead.id, content: 'A IA identificou que o cliente pediu pra parar de receber os lembretes automáticos — os envios recorrentes foram pausados pra esse lead. O negócio continua ativo, só não insiste mais sozinho.', type: 'COMMENT' },
      }).catch(() => {});
      logActivity({
        accountId, userId: null, userName: 'Assistente IA', action: 'lead_tag_added',
        leadId: lead.id, leadName: lead.name, summary: 'pausou os lembretes automáticos a pedido do cliente',
      });
    }

    // Marcar como Perdido — separado de moveToStage de propósito: é o
    // STATUS do lead (Aberto/Ganho/Perdido), não a etapa do funil, e exige
    // motivo (mesma regra do botão "Marcar Perdido" na tela). Usuário
    // definiu o critério: só quando o cliente recusa EXPLICITAMENTE (ver
    // regra exata no prompt de ai-auto-reply.service.ts) — nunca por
    // silêncio (isso é "Lead Sem Retorno", abaixo).
    if (action.markLost && action.markLost.trim()) {
      const { updateLead } = require('./lead.service') as typeof import('./lead.service');
      await updateLead(lead.id, accountId, { status: 'LOST', lostReason: action.markLost.trim() }, io);
      // Igual ao botão "Marcar Perdido": sai do funil ativo pro "Perdidos"
      // (antes o card marcado pela IA ficava parado na Prospecção).
      const pipe = await prisma.pipeline.findUnique({ where: { id: lead.pipelineId }, select: { departmentId: true } });
      const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
      await moveLeadToPerdidos({ accountId, leadId: lead.id, departmentId: pipe?.departmentId, byName: 'Assistente IA', userId: null, motivo: action.markLost.trim(), io });
      logActivity({
        accountId, userId: null, userName: 'Assistente IA', action: 'lead_status_changed',
        leadId: lead.id, leadName: lead.name, summary: `marcou o card como Perdido: "${action.markLost.trim()}"`,
      });
    }

    // Mover etapa — só estes valores são aceitos (usuário definiu esse
    // alcance explicitamente: nada de Fechado/Aprovado sozinha, Perdido é
    // tratado acima como status, não como etapa). Resolve o nome DENTRO do
    // funil onde o lead já está — mesmo critério de move_stage_by_name em
    // automation.service.ts.
    // Perdido já levou o card pro funil "Perdidos" — mover etapa aqui (no funil
    // antigo) traria ele de volta pro funil ativo.
    if (action.moveToStage && !(action.markLost && action.markLost.trim())) {
      const ALLOWED = ['prospeccao', 'follow up', 'lead sem retorno', 'pre-analise', 'pre analise', 'venda futura', 'aguardando doc'];
      const target = normalize(action.moveToStage);
      const isAllowed = ALLOWED.some((a) => target.includes(a) || a.includes(target));
      // Cliente JÁ aprovado e esperando documento não volta pra Follow Up / Sem Retorno / Pré-Análise só porque disse que ainda não tem um papel
      // (Jézer, 14/10: "sem a escritura, volto essa semana" → a IA mandou pro Follow Up). Aguardando Documentação é justamente a etapa dessa espera.
      const atual = await prisma.lead.findUnique({ where: { id: lead.id }, select: { stage: { select: { name: true } } } });
      const regressao = /^aguardando doc/.test(normalize(atual?.stage?.name || '')) && /follow up|lead sem retorno|prospec|pre.?analise/.test(target);
      if (isAllowed && regressao) {
        await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `🤖 A IA quis mover o card pra "${action.moveToStage}"${action.moveReason ? ` (${action.moveReason})` : ''}, mas o cliente já está aprovado em "${atual?.stage?.name}" — a espera do documento é essa etapa; o card ficou onde estava.` } }).catch(() => {});
      }
      if (isAllowed && !regressao) {
        // Nome exato primeiro, depois "começa com" (ex.: "Follow Up Home"),
        // só então "contém" — e nunca uma etapa de aprovado/fechado: "Pré-
        // Análise" casava com "Aprovado Pré-Analise" por conter o texto e a
        // IA movia o card pra aprovado sozinha (achado real 2026-09-25).
        const stages = (await prisma.stage.findMany({ where: { pipelineId: lead.pipelineId }, orderBy: { order: 'asc' } }))
          .filter((s) => !/aprovad|fechad|ganh|conclu/.test(normalize(s.name)));
        const match =
          stages.find((s) => normalize(s.name) === target) ||
          stages.find((s) => normalize(s.name).startsWith(target)) ||
          stages.find((s) => { const n = normalize(s.name); return n.includes(target) || target.includes(n); });
        if (match) {
          const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
          await updateLeadStage(lead.id, accountId, match.id);
          logActivity({
            accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed',
            leadId: lead.id, leadName: lead.name, summary: `moveu o card pra "${match.name}", com base na conversa`,
          });
          await prisma.note.create({
            data: { leadId: lead.id, type: 'STAGE_CHANGE', content: `🤖 IA moveu o card pra "${match.name}"${action.moveReason ? ` — ${action.moveReason}` : ''}` },
          }).catch(() => {});
          if (io) io.to(`lead:${leadId}`).emit('lead_moved', { leadId, stageId: match.id });
        }
      }
    }

    // Venda Futura com data (Fabio 16/10): a data combinada vira o agendamento do disparo; se o card não está em "Venda Futura", vai pra lá.
    if (action.resumeOn && /^\d{4}-\d{2}-\d{2}$/.test(action.resumeOn)) {
      try {
        const atual = await prisma.lead.findUnique({ where: { id: lead.id }, select: { customFields: true, pipelineId: true, stage: { select: { name: true } } } });
        const cfv: Record<string, any> = { ...((atual?.customFields || {}) as Record<string, any>), _vendaFuturaAt: action.resumeOn };
        delete cfv._vendaFuturaSentAt; delete cfv._vendaFuturaFailAt; cfv._vendaFuturaCount = 0;
        await prisma.lead.update({ where: { id: lead.id }, data: { customFields: cfv as any } });
        if (!/venda futura/i.test(atual?.stage?.name || '') && atual?.pipelineId) {
          const vf = await prisma.stage.findFirst({ where: { pipelineId: atual.pipelineId, name: { contains: 'Venda Futura', mode: 'insensitive' } }, select: { id: true } });
          if (vf) { const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service'); await updateLeadStage(lead.id, accountId, vf.id); }
        }
        await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `📅 Retomada combinada com o cliente para ${action.resumeOn.split('-').reverse().join('/')}${action.moveReason ? ` (${action.moveReason})` : ''}. Nesse dia o CRM manda a mensagem de retomada (template "venda_futura_retomada").` } });
        logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: `agendou a retomada do crédito para ${action.resumeOn.split('-').reverse().join('/')}` });
      } catch (e: any) { console.error('[IA] agendar retomada (Venda Futura) falhou:', e?.message); }
    }

    // Rodar a análise de crédito (a IA pediu): só com a "Análise automática" ligada, sem pausa geral e card em Pré-Análise.
    if (action.runAnalysis) {
      try {
        const { requestRunForAi } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
        const r = await requestRunForAi(prisma as any, accountId, leadId);
        await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: r.ok ? `🤖 A IA pediu a análise de crédito a pedido do cliente: ${r.detail}.` : `🤖 A IA quis rodar a análise de crédito, mas não rodou: ${r.detail}.` } }).catch(() => {});
        logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: r.ok ? 'pediu a análise de crédito nos bancos' : `não rodou a análise: ${r.detail}` });
      } catch (e: any) { console.error('[IA] rodar análise falhou:', e?.message); }
    }

    // Prazo/valor DIFERENTE depois da aprovação (Fabio 19/10): a extensão roda NOVA PROPOSTA nos bancos que aprovaram e o CRM manda o resultado ao cliente (aviso padrão).
    if (action.simulate && (action.simulate.prazo || action.simulate.valor)) {
      const pedido = [action.simulate.prazo && `${action.simulate.prazo} meses`, action.simulate.valor && `R$ ${action.simulate.valor.toLocaleString('pt-BR')}`].filter(Boolean).join(' e ');
      try {
        const { requestProposalChangeForAi } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
        const r = await requestProposalChangeForAi(prisma as any, accountId, leadId, action.simulate);
        await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: r.ok ? `🤖 A IA pediu uma NOVA PROPOSTA a pedido do cliente (${pedido}): ${r.detail}. O resultado segue pro cliente sozinho.` : `🤖 A IA quis rodar uma nova proposta (${pedido}), mas não deu: ${r.detail}. Resolva à mão.` } }).catch(() => {});
        if (r.ok) logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: `pediu nova proposta nos bancos (${pedido})` });
      } catch (e: any) { console.error('[IA] nova proposta com outro prazo/valor falhou:', e?.message); }
    }

    // Apresentar a aprovação (a IA decidiu): o CRM manda o MESMO aviso do botão "Avisar cliente" — mensagem 1 com o resumo, mensagem 2 com os
    // documentos — e já pede o PDF da simulação. A IA não escreve as condições (formato fixo, Fabio 14/10).
    if (action.sendApproval) {
      try {
        const { sendApprovalNoticeNow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
        await new Promise((resolve) => setTimeout(resolve, 1500)); // depois da frase curta da IA
        const r = await sendApprovalNoticeNow({ accountId, leadId, io, sendDocs: true, moveStage: true });
        await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: r.ok ? (r.scheduled ? '🤖 A IA quis apresentar a aprovação: o aviso padrão (resumo + documentos + PDF) ficou agendado pro próximo horário de aviso (07h–21h).' : '🤖 A IA apresentou a aprovação ao cliente (aviso padrão: resumo + documentos + simulação em PDF).') : `🤖 A IA quis apresentar a aprovação, mas ${r.already ? 'o aviso não foi reenviado' : 'o aviso não saiu'}: ${r.error}` } }).catch(() => {});
        if (r.ok) logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: 'apresentou a aprovação ao cliente (aviso padrão)' });
      } catch (e: any) { console.error('[IA] aviso de aprovação falhou:', e?.message); }
    }

    // Mandar a simulação em PDF (a IA decidiu, a pedido do cliente): a extensão do Credimorar baixa o original e o CRM envia com a logo A&F.
    if (action.sendSimulation && action.sendSimulation.length && !action.sendApproval) { // com sendApproval o PDF já vai junto do aviso padrão
      try {
        const { requestSimulationDocs } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
        const r = await requestSimulationDocs(prisma as any, { accountId, leadId, institutions: action.sendSimulation.slice(0, 1), source: 'AI', skipIfSentWithinHours: 0.25 });
        const quais = r.created.map((c: any) => c.institution).join(', ');
        await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: r.created.length ? `🤖 A IA pediu o PDF da simulação (${quais}) a pedido do cliente; sai com a logo A&F assim que a extensão baixar do portal.` : `🤖 A IA quis mandar o PDF da simulação, mas já havia um pedido em andamento (${r.skipped.join(', ') || 'nenhum banco válido'}).` } }).catch(() => {});
        if (r.created.length) logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: `pediu o PDF da simulação (${quais})` });
      } catch (e: any) { console.error('[IA] pedir PDF da simulação falhou:', e?.message); }
    }

    // Preencher dados extraídos da conversa — só chaves conhecidas
    // (buildFillableFieldsText), nunca sobrescreve com vazio.
    if (action.extractedFields && Object.keys(action.extractedFields).length) {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(action.extractedFields)) {
        if (v === undefined || v === null) continue;
        const raw = String(v).trim();
        if (!raw) continue;
        const parsed = NUMBER_FIELD_KEYS.has(k) ? parseMoneyOrNumber(raw) : raw;
        if (parsed !== null && parsed !== '') patch[k] = parsed;
      }
      if (Object.keys(patch).length) {
        const customFields = { ...((lead.customFields as any) || {}), ...patch };
        // Nome do card era número/emoji e o cliente disse como se chama:
        // corrige o nome do card e do contato também (Fabio 08/10).
        const renomear = patch.participante_1 && isCallableName(patch.participante_1) && !isCallableName(lead.name);
        await prisma.lead.update({ where: { id: lead.id }, data: { customFields, ...(renomear ? { name: normalizeClientName(patch.participante_1) } : {}) } });
        if (renomear && lead.contactId) {
          await prisma.contact.update({ where: { id: lead.contactId }, data: { name: normalizeClientName(patch.participante_1) } }).catch(() => {});
          await prisma.note.create({ data: { leadId: lead.id, type: 'DATA_EDIT', content: `🤖 Nome do card corrigido pela IA: "${lead.name}" → "${normalizeClientName(patch.participante_1)}" (o cliente informou o nome).` } }).catch(() => {});
          if (io) io.to(`account_${accountId}`).emit("new_conversation", { leadId: lead.id });
        }
        logActivity({
          accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited',
          leadId: lead.id, leadName: lead.name, summary: `preencheu dados do card a partir da conversa (${Object.keys(patch).join(', ')})`,
        });
      }
    }
  } catch (err) {
    console.error('[AI] Erro ao aplicar ações extraídas (mover etapa/preencher campos):', err);
  }
}
