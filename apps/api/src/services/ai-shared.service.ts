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
- IPTU NO HOME EQUITY (Fabio 19/10 e 27/10): o item é UM só — "Inscrição Imobiliária/IPTU ou Capa do IPTU com as metragens". A GUIA, o carnê, a CAPA do IPTU ou só a INSCRIÇÃO imobiliária (imóvel isento de IPTU, ou sem a capa) JÁ SERVE — agradeça e siga; não cobre a capa nem as metragens de quem mandou a inscrição. NUNCA diga que o que ele mandou "não é o que o banco pede", NÃO peça CND de IPTU ao cliente: se a CND for necessária, a equipe emite com a inscrição (e, se o assunto surgir, vale a regra de EMISSÃO DE DOCUMENTOS acima).
- Nada de abrir a mensagem com interjeição ou elogio ("Show", "Perfeito", "Que ótimo", "Ótimo", "Que bom", "Entendi"): vá direto ao ponto, como a equipe faz. Não repita o nome do cliente em toda mensagem e evite pontos de exclamação em sequência.
- ÁUDIO: o cliente PODE mandar áudio — o CRM transcreve e você lê o que ele falou (no histórico aparece como "(áudio) ..."). Se ele perguntar se pode mandar áudio, diga que pode sim, à vontade. Nunca peça pra mandar por texto em vez de áudio (Fabio 07/10).
- CLIENTE DISSE QUE ENVIA O DOCUMENTO DEPOIS (Fabio 21/10, Vicente Paulo: avisou que estava no trabalho e só mandava à noite, e a IA pediu a escritura de novo): se o cliente já disse que não pode mandar agora ou quando vai mandar ("estou no trabalho", "só à noite", "quando chegar em casa", "assim que puder"), NÃO peça aquele documento de novo — nem reformulando, nem a cada mensagem dele ("tenho a escritura" quer dizer que ele TEM e vai mandar). Responda curto, sem pedir: "Combinado, fico no aguardo" (ou responda a dúvida que ele fez). O CRM cobra sozinho no horário que ele combinou. Só volte ao assunto se ele mesmo trouxer, ou depois do prazo que ele deu.
- LIÇÕES DA CONVERSA DO RONALDO/ANDREA (Fabio 22/10, respondidas por ele): 
  · TEMPO PRA O CRÉDITO SAIR: com a documentação sem pendências, de 30 a 40 dias — inclui o registro em cartório; o valor só é liberado DEPOIS do registro. Nunca diga "15 a 30 dias".
  · SÓ PRA CAIXA — pendências no CPF (protesto em cartório, Receita): antes de rodar a análise, avise que rodar assim pode voltar reprovado e derrubar o score, então é melhor regularizar antes. IPTU em atraso: a Caixa pede a certidão positiva com efeito de negativa; precisa regularizar, mas não impede de seguir com a vistoria. Essas duas regras NÃO valem pros outros bancos: não cite pro Santander, Inter, Creditas ou outro.
  · TAXA: só fale de taxa quando o CLIENTE perguntar ou questionar. Aí diga a taxa MENSAL que está na análise do card (a mesma do resumo da aprovação) e, se ele estranhar o número anual maior, explique que a anual (efetiva) é essa taxa mensal acumulada ao longo de 12 meses. Use SÓ a taxa que está na análise do card; nunca invente nem compare taxa/prazo de bancos diferentes por conta própria.
  · PRAZO E TAXA: NUNCA diga que reduzir/encurtar o prazo reduz a taxa — isso não é verdade (Fabio 22/10). Prazo menor deixa a parcela MAIOR; não prometa taxa melhor por mudar o prazo.
  · CLIENTE HESITANDO porque precisa regularizar pendências: proponha fazer a vistoria já, enquanto ele se organiza, pra manter o andamento (quando o banco permitir).
  · CUSTOS: se perguntarem "vocês cobram algum custo?", a A&F NÃO cobra nada do cliente. Se perguntarem da taxa/tarifa de vistoria ou avaliação do imóvel: também não precisa pagar agora, ela entra junto no financiamento. Não puxe o assunto de tarifa do banco se o cliente não perguntou.
- FECHANDO A CONVERSA ESPERANDO DOCUMENTO (Fabio 22/10, caso Vicente): se o card está em "Aguardando Documentação" e a conversa está terminando (o cliente já entendeu, não há pergunta pendente), termine sua mensagem com "Fico no aguardo da documentação." — uma vez só; se você já disse isso na conversa, não repita.
- CLIENTE FICOU DE ENCAMINHAR A DOCUMENTAÇÃO ("vou enviar", "ainda não", "mais tarde", "depois te mando") — NUNCA pergunte se ele tem dificuldade, por que não enviou ou o que houve: é RUDE (Fabio 23/10). O fecho certo é "Fico no aguardo da documentação." (Fabio 23/10, caso Pedro Luis: ele respondeu "Ainda não" e a IA perguntou "Alguma dificuldade pra enviar?" e repetiu a lista que o Fabio tinha acabado de pedir): NÃO interrogue ("alguma dificuldade?", "o que aconteceu?", "por que ainda não?") — soa como cobrança — e NÃO repita a lista de documentos que já foi pedida na conversa (pela equipe ou por você). Responda curto e leve, no tom da equipe: "Sem problema, fico no aguardo da documentação." Só ofereça ajuda se ELE disser que tem dificuldade ("não consigo", "não sei como"). Se o crédito já foi aprovado, não fale em "seguir com a análise": diga "dar andamento ao processo".
- IMÓVEL FINANCIADO (Fabio 26/10): financiamento EM DIA não impede o Home Equity (o crédito aprovado quita o saldo devedor e o que sobra vai pro cliente; no Santander só vale imóvel quitado). Financiamento com PARCELA EM ATRASO: NÃO fazemos Home Equity nessa condição — explique em 1 frase que o financiamento precisa estar em dia e pergunte se ele consegue regularizar as parcelas (quando regularizar, a gente segue com a análise). Não diga que é impossível nem que foi reprovado, e nessa mensagem não peça matrícula/documento nem diga "fico no aguardo". Atraso de IPTU/condomínio NÃO é isso (é pendência de documentação, tratada na conferência). APROVAÇÃO A MENOR (o banco aprovou menos que o pedido): não há como aprovar mais, então o saldo devedor é só informativo — NÃO peça print do saldo nem prometa nova análise com saldo + troco; o CRM calcula o troco (valor aprovado − saldo) e informa o cliente.
- AVALIAÇÕES NO GOOGLE (Fabio 26/10): quando o cliente estiver inseguro/hesitando ("vou pensar", "não conheço", "tenho receio", "é confiável?") ou pedir referência de outros clientes, e couber na conversa, cite em UMA frase que temos avaliações de clientes no nosso Google, com o link https://share.google/irc6grcCvTaU1AcRQ. Nunca invente nota, quantidade nem depoimento; não force nem repita se o link já foi enviado nas últimas 24 h; desconfiança/golpe/CNPJ segue a Prova Social completa.
- APROVADO A MENOR NÃO SOBE (Fabio 26/10): se um banco aprovou A MENOR (menos que o pedido), pedir valor MAIOR nesse banco não adianta — ele já deu o máximo. Nunca prometa "rodar uma nova proposta pedindo mais" nem "aumentar a aprovação" nesse banco; explique que é o máximo dele e mostre as saídas reais (outros bancos em análise, outro banco, prazo diferente quando o banco permite).
- BANCO COM AGÊNCIA FÍSICA (Fabio 26/10): Inter e Creditas são digitais; parceiros com agência física: Santander e CAIXA (cite sempre a CAIXA junto com o Santander quando o cliente preferir/temer banco só digital), sem prometer aprovação. Ter agência não muda o processo: com a A&F o processo é DIGITAL em TODOS os bancos, inclusive CAIXA e Santander — nunca diga que é presencial nem que precisa ir à agência (Fabio 27/10).
- CAMPOS DOS NOSSOS FORMULÁRIOS (Fabio 23/10: a IA mandou "avise no preenchimento que é portabilidade" e o formulário não tem essa opção): a IA conhece o que o formulário pergunta e NUNCA promete opção que ele não tem. HOME EQUITY (proposta-manual-home-equity): CPF, nome, nascimento, e-mail, WhatsApp, gênero, nacionalidade, naturalidade, estado civil, renda bruta mensal, endereço completo; 2º participante (opcional: nome, CPF, nascimento, celular, relação — cônjuge/pai-mãe/filho(a)/irmão/sócio(a)/outro —, se compõe renda e renda); imóvel em garantia (tipo: comercial/residencial/terreno; endereço; valor do imóvel; crédito desejado; imóvel quitado sim/não e, se não, quanto falta; certidão de ônus/matrícula sim/não; prazo 60/120/180/240 meses). HABITACIONAL (proposta-manual): CPF, nome, nascimento, e-mail, WhatsApp, restrição no Serasa, gênero, nacionalidade, naturalidade, estado civil, renda bruta, endereço, 2º participante (opcional, como acima mas sem sócio), UF e cidade do imóvel a comprar, tipo, valor de compra e venda, entrada, valor financiado, prazo 120 a 420 meses. O formulário NÃO tem campo de portabilidade, de "outro banco", de taxa nem de condição especial. Se o cliente pedir algo que não tem campo, não invente: peça que preencha o que existe. O formulário preenche o card sozinho: não pergunte de novo o que ele já traz.
- PORTABILIDADE (Fabio 23/10): se o cliente falar de portabilidade, de trazer contrato de outro banco ou "já fiz com outro banco", NÃO explique portabilidade, NÃO diga que fazemos nem que não fazemos, NÃO prometa condição e NUNCA diga "avise no preenchimento que é portabilidade". Apenas peça que preencha a proposta (o link do produto) pra gente avaliar.
- QUEM ESTÁ FALANDO PODE NÃO SER O TITULAR (Fabio 22/10, caso Ronaldo/Andrea: a esposa preencheu a proposta no nome do marido, falou no WhatsApp e o CRM a chamava de Ronaldo): o nome do card é o do TITULAR do crédito; quem escreve pode ser outra pessoa (esposa/marido, filho, sócio, contador, assistente). Se na conversa a pessoa disser quem é ("sou a esposa dele", "meu marido que vai fazer o crédito", "aqui é a Andrea") ou o nome dela for diferente do titular: (1) trate-a pelo NOME DELA, nunca pelo do titular; (2) fale do titular na terceira pessoa ("o Ronaldo", "seu marido") — nunca como se ela fosse ele; (3) registre quem está falando nos campos do card: "falando_com" (só o nome dela) e "falando_com_relacao" (Esposa, Marido, Filho(a), Pai/Mãe, Sócio(a), Contador(a), Outro) — se ela também for participante do crédito, o nome dela continua em "participante_2"; (4) dados e documentos pedidos são do TITULAR (renda, CPF, matrícula no nome de quem dá o imóvel): peça "do Ronaldo", e se ela não souber, aceite que ela repasse. Se o campo "falando_com" já estiver no card, ele manda: use esse nome.
- IMÓVEL TRANSFERIDO ANTES DO CONTRATO (Fabio 21/10): o contrato só pode ser finalizado com o imóvel JÁ transferido (escritura registrada em cartório, matrícula atualizada no nome de quem dá o imóvel em garantia). Cliente que diz que ainda não transferiu/registrou a escritura NÃO trava a análise nem a conferência de documentos — mas avise, UMA vez e em uma frase, que a transferência precisa ser feita no decorrer do processo, antes de assinar o contrato (sem prometer prazo nem falar de custo). Depois da vistoria (card em Análise Jurídica ou adiante) o CRM pede a transferência e a matrícula atualizada; se o cliente disser que já transferiu/registrou, peça a matrícula atualizada por aqui e diga que a equipe confere. Não repita o aviso se já foi dado na conversa.
- SEGUIR COM A PROPOSTA DO INTER (Fabio 21/10): quando o CRM acabou de perguntar "você confirma que quer seguir com a proposta do Inter?" e o cliente responde que SIM, escreva UMA frase curta dizendo que está encaminhando com o banco e que o Inter vai mandar um e-mail de engajamento; se ele disser que não ou tiver dúvida, responda a dúvida ou pergunte o motivo, sem insistir. Nunca diga que o "seguir" já foi feito: quem faz no portal é a equipe, depois da confirmação dele. Não prometa prazo.
- TAXA CARA → OFERECER A CAIXA (Fabio 27/10) — SÓ DEPOIS DA APROVAÇÃO (o cliente já recebeu as condições aprovadas de algum banco; antes disso, na simulação/proposta, NÃO ofereça a CAIXA por isso): quando o cliente achar a taxa, os juros ou a parcela CAROS/altos ("nessa taxa não consigo", "juros muito alto", "achei caro", "a parcela não cabe"), ANTES de aceitar a desistência pergunte, em 1 frase, se ele quer tentar pela CAIXA, que costuma ter taxa menor — avisando, sem prometer aprovação nem taxa, que na CAIXA a documentação é pedida ANTES da análise. O processo da CAIXA é DIGITAL, igual ao dos outros bancos — NUNCA diga que é presencial nem que o cliente precisa ir à agência (Fabio 27/10). Uma vez só por conversa; não ofereça se a CAIXA já foi oferecida/recusada na conversa ou se o cliente já foi reprovado na CAIXA. Se ele disser que SIM, siga a SEQUÊNCIA DA CAIXA abaixo (nome limpo e Habite-se primeiro). Se disser que não, aí sim respeite a decisão.
- IMÓVEL DE CESSÃO DE DIREITOS (Fabio 28/10: "a gente não faz de jeito nenhum"): imóvel que o cliente tem só por CESSÃO DE DIREITOS (contrato/instrumento/escritura de cessão de direitos possessórios, hereditários ou aquisitivos, sem matrícula registrada em cartório em nome dele) NÃO serve de garantia em NENHUM banco, nem na CAIXA — trocar valor, prazo ou banco não resolve. Assim que isso aparecer na conversa (o cliente contar, a equipe ou a leitura de um documento apontar), NÃO siga com esse imóvel (não peça documentos dele, não rode análise, não prometa nada): explique em 1 frase e pergunte se ele tem OUTRO imóvel com certidão de matrícula registrada em cartório pra colocar em garantia. Se tiver: peça o endereço, a cidade e o valor aproximado desse outro imóvel e que ele preencha a proposta de novo com ele; use "askTeam" pra avisar a equipe ("Cliente com imóvel de cessão de direitos tem outro imóvel com matrícula: <dados>"). Se não tiver: explique com educação que sem matrícula registrada não tem como seguir e marque "markLost": "Imóvel de cessão de direitos, sem outro imóvel com matrícula".
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
  /** Estado real do card no CRM (análise de crédito, documentos, contratação, agenda) — '' se não há nada a mostrar. */
  creditoTexto: string;
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
  opts: { historyTake?: number; fullHistory?: boolean; historyRoleLabels?: { inbound: string; outbound: string } } = {}
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
  // fullHistory (Fabio 28/10: "a IA precisa ler a conversa todinha antes de responder o cliente" — a Luciana foi enrolada porque a constatação do imóvel
  // de cessão de direitos estava 4 dias e 12+ mensagens antes): a conversa inteira, do começo, com o dia de cada trecho e quem da EQUIPE escreveu.
  // Mensagem muito longa (proposta do site colada, texto de e-mail) entra cortada; num caso extremo, acima do teto, ficam as mais recentes.
  const recent = await prisma.message.findMany({
    where: { leadId, channel: { not: 'EMAIL' } },
    orderBy: { createdAt: 'desc' },
    take: opts.fullHistory ? 1500 : historyTake,
    ...(opts.fullHistory ? { include: { sentBy: { select: { name: true } } } } : {}),
  });
  const ordered = recent.reverse();
  let historicoTexto = '(sem histórico anterior)';
  if (ordered.length && opts.fullHistory) {
    const TETO = 90_000;
    const linhas: string[] = [];
    let dia = '';
    for (const m of ordered as Array<(typeof ordered)[number] & { sentBy?: { name: string } | null }>) {
      const d = m.createdAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      if (d !== dia) { dia = d; linhas.push(`— ${d} —`); }
      const hora = m.createdAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      let texto = voiceNoteForAi(m.content);
      if (texto.length > 1800) texto = `${texto.slice(0, 1500)} …[mensagem longa, cortada]`;
      const quem = m.direction === 'INBOUND' ? inboundLabel : m.sentBy?.name ? `${outboundLabel} (equipe: ${m.sentBy.name})` : outboundLabel;
      linhas.push(`[${hora}] ${quem}: ${texto}`);
    }
    let total = 0;
    let corte = linhas.length;
    for (let i = linhas.length - 1; i >= 0; i--) { total += linhas[i].length + 1; if (total > TETO) break; corte = i; }
    historicoTexto = `${corte > 0 ? `(conversa muito longa: as mensagens mais antigas ficaram de fora; abaixo, do dia ${(linhas.slice(corte).find((l) => l.startsWith('— ')) || '').replace(/— /g, '').trim() || 'mais antigo que coube'} em diante)\n` : `(conversa COMPLETA, do começo — ${ordered.length} mensagens; leia tudo antes de responder: o que a equipe já disse e o que o cliente já respondeu valem)\n`}${linhas.slice(corte).join('\n')}`;
  } else if (ordered.length) {
    historicoTexto = ordered.map((m) => `${m.direction === 'INBOUND' ? inboundLabel : outboundLabel}: ${voiceNoteForAi(m.content)}`).join('\n');
  }

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
      where: { accountId, fixedKey: null, title: { contains: banco, mode: "insensitive" }, ...(department?.id ? { OR: [{ departmentId: department.id }, { departmentId: null }] } : {}) },
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
    creditoTexto: await aiCardState(lead.id).catch(() => ''),
    nomeTexto: (() => {
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name);
      const titular = callableFirstName(cf.participante_1, lead.name);
      const falando = callableFirstName(cf.falando_com);
      if (falando && titular && falando.toLowerCase() !== titular.toLowerCase()) {
        const rel = String(cf.falando_com_relacao || '').trim().toLowerCase();
        return `${falando}${rel ? ` (${rel} do titular)` : ' (NÃO é o titular)'} — QUEM ESTÁ NA CONVERSA É ${falando.toUpperCase()}, não o titular. O titular do crédito é ${titular}: trate ${falando} pelo nome dela(e) e fale de ${titular} na terceira pessoa; nunca chame ${falando} de ${titular}. Pode chamar pelo nome, sem repetir em toda mensagem.`;
      }
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

/** RACIOCÍNIO INTERNO VAZADO (Fabio 26/10, Selma: "erro grotesco, isso não deve existir de forma alguma"): a IA mandou ao cliente "A cliente disse que…", "Preciso continuar a conversa…",
 *  "Ela está conversando, então devo…", "Vou perguntar se ela…". Mensagem pro cliente fala COM ele (você), nunca DELE (ele/ela, "o cliente"), nem de si mesma planejando.
 *  Pura (testável). true = não pode sair. */
export function pareceRaciocinio(texto: string): boolean {
  const t = String(texto || '');
  const fortes = [
    // fala DO cliente em 3ª pessoa: "A cliente disse que…", "O cliente quer…"
    /\b(a|o) (cliente|lead)\b[^.!?\n]{0,40}\b(disse|diz|falou|est[aá]|quer|perguntou|respondeu|mencionou|informou|pediu|mandou|enviou|demonstr|parece|ainda n[aã]o)/i,
    // a IA planejando: "Preciso continuar a conversa…", "devo continuar o diálogo…", "Vou perguntar se ela…"
    /\b(preciso|devo|tenho que)\s+(continuar|manter|retomar)\s+(a|o)\s+(conversa|di[aá]logo|atendimento)/i,
    /\b(preciso|devo|tenho que)\s+(perguntar se (ela|ele)|responder (a|o) cliente|evitar|empurrar)/i,
    /\bvou perguntar se (ela|ele)\b/i,
    /(^|[.!?\n]\s*)(ela|ele) (est[aá] conversando|ainda n[aã]o respondeu|j[aá] respondeu|respondeu|disse|parece|quer)\b/i,
    /fase de ["“]tirar d[uú]vidas["”]/i,
    /^\s*(racioc[ií]nio|an[aá]lise interna|pensamento|observa[cç][aã]o interna)\s*:/im,
    // pedaço do JSON da resposta
    /"(reply|noReply|askTeam|extractedFields|moveToStage)"\s*:/,
  ];
  return fortes.some((re) => re.test(t));
}

/**
 * ANÁLISE DE CRÉDITO DENTRO DO CONTEXTO DE TODAS AS IAs (Fabio 23/10: "ela precisa estar interligada com todo o CRM, inclusive com a análise de crédito do cliente").
 * Caso Cibele: Santander e Inter já fora ("não analisa") e a IA disse "vamos aguardar o retorno dos demais bancos". Agora toda IA que conversa com o cliente (auto-resposta, sugestão, resposta da equipe,
 * sugestão de template/e-mail) vê o veredito REAL de cada banco e se os avisos padrão (aprovação / não aprovado) já saíram. Sem valores: aprovação nunca vai em texto livre. '' se o card não tem análise.
 */
export async function aiCreditContext(leadId: string): Promise<string> {
  const rows = await prisma.creditAnalysis.findMany({
    where: { leadId, dryRun: false, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { createdAt: 'desc' },
    select: { bank: true, kind: true, status: true, detail: true, conditions: true, source: true, createdAt: true },
  });
  if (!rows.length) return '';
  const { bankVerdict, semRuidoDeSimulacao } = require('./credit-auto.service') as typeof import('./credit-auto.service');
  const nomes: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
  const { latestPerBank } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const lat = latestPerBank(rows as any);
  const linhas = ['INTER', 'CREDITAS', 'CREDIMORAR'].map((b) => {
    const v = bankVerdict(rows as any, b);
    const ultima = rows.find((r) => r.bank === b && semRuidoDeSimulacao(r as any) && !(r.kind === 'CHECK' && r.status === 'CHECK'));
    let txt: string;
    const aMenorB = v === 'POS' && /aprovad[oa] a menor/i.test(`${ultima?.detail || ''}`);
    if (lat[b]?.cadDiv) txt = 'CADASTRO DIVERGENTE (o banco acusou que nome, CPF ou data de nascimento não batem; o CRM pede ao cliente para conferir e refaz a análise quando ele corrige) — NÃO é reprovação';
    else if (aMenorB) txt = 'APROVOU A MENOR (menos que o pedido — o banco NÃO aprova mais que isso; pedir valor maior não adianta)';
    else if (v === 'POS') txt = ultima?.status === 'CONDITIONAL' ? 'APROVOU (condicionado ao envio de documentos)' : 'APROVOU';
    else if (v === 'NEG') txt = ultima?.status === 'REJECTED' ? 'REPROVOU a proposta' : 'NÃO analisa este cliente (regra do banco/imóvel — nem chegou a analisar)';
    else if (ultima && ['SENT', 'REQUESTED', 'RUNNING'].includes(ultima.status)) txt = 'EM ANÁLISE (proposta enviada, sem resposta ainda)';
    // 26/10 (Jézer): banco sem NENHUMA análise virava "ainda sem resultado" e a IA disse 3 vezes "o Santander ainda está em análise" — ele nunca rodou.
    else if (!rows.some((r) => r.bank === b)) txt = 'NÃO RODOU — nenhuma proposta foi enviada a este banco ainda (se disser ao cliente que vai pôr/está em análise nele, o CRM precisa rodar: na auto-resposta marque "runBanks")';
    else txt = 'ainda sem resultado (a última tentativa não terminou ou falhou — não diga que está em análise neste banco)';
    return `- ${nomes[b]}: ${txt}`;
  });
  const [aprovSent, rejSent] = await Promise.all([
    prisma.message.count({ where: { leadId, direction: 'OUTBOUND', content: { contains: 'Resumo da proposta' }, createdAt: { gte: new Date(Date.now() - 21 * 86_400_000) } } }),
    (require('./approval-notice.service') as typeof import('./approval-notice.service')).rejectionAlreadyInChat(leadId).catch(() => null),
  ]);
  return `${linhas.join('\n')}
- Aviso padrão de APROVAÇÃO já enviado ao cliente: ${aprovSent > 0 ? 'sim' : 'não'}. Aviso padrão de NÃO APROVADO já enviado: ${rejSent ? 'sim' : 'não'}.
REGRAS COM ESTES DADOS: (1) só diga que um banco está "em análise" ou que estamos "aguardando retorno" se estiver assim acima — nunca invente espera, e não prometa novo retorno se todos já negaram. (2) O RESULTADO do crédito (aprovado ou não) quem comunica é o aviso padrão do CRM: você não anuncia aprovação, não escreve valores e NÃO conta o motivo que o banco deu (Bacen, SCR, prejuízo, política interna, score, restrição, renda). (3) Se o cliente perguntar do resultado: com banco em análise, diga que ainda aguardamos esse banco; com todos negados e o aviso ainda não enviado, diga só que o resultado sai por aqui em instantes; com o aviso já enviado, não repita — pergunte se ficou alguma dúvida.`;
}

/**
 * ESTADO DO CARD NO CRM PRA TODAS AS IAs (Fabio 23/10: "não só aquele contexto, é ligada em todo o sistema"): análise de crédito + documentos + contratação (certidão ONR, vistoria, seguir proposta,
 * transferência do imóvel, passos manuais) + agenda (Venda Futura, tarefas). Fatos do sistema, não opinião: a IA responde por eles e nunca os contradiz. Cada chamada de IA que fala com o cliente
 * ou decide algo no card recebe este bloco (conversa, sugestões, resposta da equipe, e-mails do processo, classificadores de aceite/desinteresse). '' se o card não tem nada a mostrar.
 */
export async function aiCardState(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!lead) return '';
  const cf = (lead.customFields || {}) as Record<string, any>;
  const partes: string[] = [];

  const credito = await aiCreditContext(leadId).catch(() => '');
  if (credito) partes.push(`ANÁLISE DE CRÉDITO:\n${credito}`);
  // 26/10 (Fernando Felipe): a proposta nunca chegou e a IA disse "está em análise com o Inter". Sem nenhuma análise, isso precisa estar escrito.
  else if (!(await prisma.creditAnalysis.count({ where: { leadId, dryRun: false } }).catch(() => 1))) {
    partes.push('ANÁLISE DE CRÉDITO: AINDA NÃO COMEÇOU — nenhum banco recebeu proposta deste cliente. NÃO diga que está "em análise", com qual banco, nem que aguardamos retorno; se faltar a proposta ou algum dado pra rodar, peça o que falta.');
  }

  // Cadastro (nome/CPF/nascimento) — confirmação pedida ao cliente / divergência do banco
  const cadConf = cf._cadConfirm as { status?: string } | undefined;
  const cadDivSt = cf._cadDiv as { status?: string } | undefined;
  const rot: Record<string, string> = { ASKED: 'perguntei ao cliente e aguardo a resposta', CONFIRMADO: 'o cliente CONFIRMOU que está tudo certo', CORRIGIDO: 'o cliente corrigiu e a análise foi refeita com os dados certos' };
  const cadTxt = [cadDivSt?.status && rot[cadDivSt.status] ? `divergência acusada pelo banco: ${rot[cadDivSt.status]}` : '', cadConf?.status && rot[cadConf.status] ? `confirmação da proposta: ${rot[cadConf.status]}` : ''].filter(Boolean).join('; ');
  if (cadTxt) partes.push(`CADASTRO (nome, CPF e data de nascimento): ${cadTxt}.`);

  // Documentos já recebidos e conferidos pela IA
  const revs = Object.values((cf._docReview || {}) as Record<string, any>).filter((r: any) => r && r.tipo && r.resultado !== 'NAO_DOCUMENTO' && !r.encerrada) as any[];
  const protegidos = Object.keys((cf._docsProtegidos || {}) as Record<string, unknown>).length;
  if (revs.length || protegidos) {
    const ok = Array.from(new Set(revs.filter((r) => r.resultado !== 'PROBLEMA').map((r) => String(r.tipo)))).slice(0, 14);
    const prob = Array.from(new Set(revs.filter((r) => r.resultado === 'PROBLEMA').map((r) => String(r.tipo)))).slice(0, 8);
    partes.push(`DOCUMENTOS (conferência da IA): recebidos e OK: ${ok.join(', ') || 'nenhum'}.${prob.length ? ` Com problema: ${prob.join(', ')}.` : ''}${protegidos ? ` Arquivos protegidos por senha aguardando verificação: ${protegidos}.` : ''}${cf._rendaDispensada ? ' Renda dispensada neste card (caso específico).' : ''} Não peça de novo o que já está "recebido e OK".`);
  }

  // Contratação
  const contr: string[] = [];
  const certs = await prisma.certidaoRequest.findMany({ where: { leadId, status: { notIn: ['CANCELLED'] }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 3, select: { matricula: true, status: true, paidAt: true, pixSentAt: true } }).catch(() => []);
  const stCert: Record<string, string> = { REQUESTED: 'pedido na fila da extensão', RUNNING: 'pedido sendo feito no portal', AWAITING_PAYMENT: 'PIX enviado, aguardando pagamento', ISSUED: 'EMITIDA e salva no Drive', FAILED: 'falhou' };
  for (const c of certs) contr.push(`certidão da matrícula ${c.matricula} (ONR): ${c.status === 'AWAITING_PAYMENT' && c.paidAt ? 'paga, aguardando a emissão' : stCert[c.status] || c.status}`);
  const vis = cf._vistoriaAi as { banco?: string; status?: string } | undefined;
  if (vis?.status) contr.push(`vistoria do imóvel (${vis.banco || 'banco'}): ${String(vis.status).replace(/_/g, ' ').toLowerCase()}`);
  const seg = cf._interSeguir as { status?: string } | undefined;
  if (seg?.status || cf._seguirStatus) contr.push(`"seguir com a proposta" do Inter: ${String(cf._seguirStatus || seg?.status).replace(/_/g, ' ').toLowerCase()}`);
  if (cf._transferenciaPendente) contr.push('imóvel comprado e ainda NÃO registrado/transferido no nome do cliente (precisa estar registrado antes da liberação do valor)');
  const manuais = Object.keys((cf._manualSteps || {}) as Record<string, unknown>);
  if (manuais.length) contr.push(`passos que a equipe faz à mão (contratação em modo manual): ${manuais.slice(0, 6).join(', ')}`);
  if (contr.length) partes.push(`CONTRATAÇÃO: ${contr.join('; ')}.`);

  // Agenda
  const agenda: string[] = [];
  if (cf._vendaFuturaAt) agenda.push(`Venda Futura: retomar em ${String(cf._vendaFuturaAt).slice(0, 10).split('-').reverse().join('/')}`);
  const tarefas = await prisma.task.findMany({ where: { leadId, done: false }, orderBy: { dueAt: 'asc' }, take: 3, select: { title: true, dueAt: true } }).catch(() => []);
  for (const t of tarefas) agenda.push(`tarefa "${t.title.slice(0, 60)}" para ${t.dueAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
  if (agenda.length) partes.push(`AGENDA: ${agenda.join('; ')}.`);

  return partes.length ? `${partes.join('\n')}\nUse estes fatos como verdade do sistema: nunca os contradiga e não prometa nem peça algo que já está feito ou em andamento aqui.` : '';
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

// ─── E-mails do processo (Fabio 22/10: "ela pode ler e interpretar e repassar informações sobre o e-mail ao cliente, algo bem resumido") ────────────────────────────────────────────────────────────
// Antes (regra de 27/09) a IA não lia e-mail nenhum. Caso Pedro: o Inter pediu por e-mail o documento que vincule a vaga de garagem ao apartamento e a IA, sem saber, diria "está tudo certo".
// Agora os e-mails recentes entram só no momento de RESPONDER o cliente (nunca disparam mensagem sozinhos) e a IA repassa o que o cliente precisa fazer, em 1–2 frases.
export const EMAIL_RELAY_RULES = `E-MAILS DO PROCESSO (Fabio 22/10): abaixo estão os e-mails recentes deste cliente (do banco/consultor, ou nossos). Leia, interprete e, quando fizer sentido na conversa, REPASSE ao cliente o que ele precisa saber — BEM RESUMIDO (1 a 2 frases), em linguagem simples:
- Repasse o que o e-mail PEDE AO CLIENTE (documento, informação, correção, assinatura, comparecimento) e diga como resolver. Ex.: o banco diz que a matrícula não cita a vaga de garagem e pede documento que a vincule ao apartamento → "O banco pediu um documento que mostre que a vaga de garagem pertence ao apartamento (a matrícula não cita a vaga). Pode ser a matrícula da vaga ou a escritura/convenção que fale dela. Consegue me mandar?".
- Se o cliente perguntar de andamento/vistoria/prazo, use o e-mail pra responder o que ele REALMENTE diz; sem e-mail que responda, não invente.
- NÃO copie o e-mail, NÃO cite nome de consultor/funcionário do banco, nem termos internos do banco, protocolo, número de proposta ou e-mail de engajamento. Se o cliente já foi avisado do mesmo assunto na conversa (veja o histórico), não repita.
- NÃO repasse por aqui resultado de crédito (aprovado, reprovado, condições): isso segue a regra de aprovação do CRM. E-mail que é só da A&F pro banco (envio de documentos, solicitação de vistoria) não é pro cliente.
- Se o e-mail pedir algo que você não entendeu bem ou que muda o processo, deixe a equipe resolver (pergunte à equipe) em vez de arriscar.`;

/** Texto limpo de um e-mail (corpo sem assinatura, aviso de confidencialidade, citações e imagens), curto. Pura (testável). */
export function cleanEmailForAi(content: string, max = 750): { subject: string; body: string } {
  const [first, ...rest] = String(content || '').split('\n');
  const subject = first.replace(/^📧\s*/, '').trim();
  const lines: string[] = [];
  for (const line of rest) {
    const t = line.trim();
    if (/^(Esta mensagem pode conter|This message may contain|De:|From:|Enviado:|Sent:|-----\s*Original|On .{5,80} wrote:|Em .{5,80} escreveu:)/i.test(t)) break;
    if (t.startsWith('>') || /^\[Imagem\]$/i.test(t) || /^📎\s*(image\d+\.\w+[,\s]*)+$/i.test(t)) continue;
    lines.push(t);
  }
  const body = lines.join(' ').replace(/\s+/g, ' ').trim();
  return { subject, body: body.length > max ? `${body.slice(0, max)}…` : body };
}

/** Bloco com os e-mails recentes do card (até 5, últimos 10 dias) pra IA que conversa com o cliente. '' se não houver nenhum relevante. */
export async function aiEmailsContext(leadId: string): Promise<string> {
  const rows = await prisma.message.findMany({
    where: { leadId, channel: 'EMAIL', createdAt: { gte: new Date(Date.now() - 10 * 86_400_000) } },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: { direction: true, content: true, createdAt: true },
  });
  const itens = rows
    .filter((m) => /^📧/.test(m.content) && !/Engajamento Autom[aá]tico/i.test(m.content.split('\n')[0]))
    .slice(0, 5)
    .reverse()
    .map((m) => {
      const { subject, body } = cleanEmailForAi(m.content);
      if (!body) return '';
      const quando = m.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `- ${m.direction === 'INBOUND' ? 'RECEBIDO (do banco/consultor)' : 'ENVIADO pela A&F'} em ${quando} — assunto "${subject.slice(0, 90)}": ${body}`;
    })
    .filter(Boolean);
  return itens.length ? `--- E-MAILS RECENTES DO PROCESSO ---\n${itens.join('\n')}` : '';
}

export function buildContextBlocks(ctx: SharedAiContext): string {
  return `--- ${todayContextLine()} ---

--- NOME DO CLIENTE ---
${ctx.nomeTexto}

--- ESCOPO DE ATENDIMENTO (produto deste chat) ---
${ctx.escopoTexto}

--- ETAPA ATUAL DO CARD (funil → etapa) ---
${ctx.etapaTexto}
${ctx.creditoTexto ? `
--- ESTADO DO CARD NO CRM (fatos reais do sistema: análise de crédito, documentos, contratação, agenda) ---
${ctx.creditoTexto}
` : ''}${ctx.perdidoTexto ? `
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

--- HISTÓRICO DESTA CONVERSA ---
${ctx.historicoTexto}`;
}

// ─── Ações que só a IA de auto-resposta pode tomar (mover etapa / ────────
// ─── preencher dados do card) — a Sugerir resposta nunca faz isso        ─
// sozinha, porque um humano sempre revisa e mexe no card ele mesmo.

/** Campos "fixos" da aba Principal (lead-sidebar.tsx) — não vêm de
 *  FieldDefinition, por isso ficam hardcoded aqui (mesmo critério já usado
 *  em site-lead.service.ts pros campos conhecidos). */
const BUILTIN_LEAD_FIELDS: { key: string; label: string }[] = [
  { key: 'falando_com', label: 'Nome de QUEM ESTÁ FALANDO no WhatsApp quando NÃO é o titular do crédito (ex.: a esposa que preencheu a proposta) — deixe vazio se quem fala é o próprio titular' },
  { key: 'cadastro_confirmado', label: 'Cliente CONFIRMOU que nome, CPF e data de nascimento da proposta estão corretos — preencha "Sim" SÓ quando ele disser isso (resposta à pergunta de confirmação do cadastro)' },
  { key: 'falando_com_relacao', label: 'Relação de quem está falando com o titular (Esposa, Marido, Filho(a), Pai/Mãe, Sócio(a), Contador(a), Outro)' },
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
  'troco', 'saldo_devedor',
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

/** Chave → nome curto dos campos que a IA pode preencher no card (os mesmos do buildFillableFieldsText). */
export async function fillableFieldLabels(accountId: string): Promise<Map<string, string>> {
  const defs = await prisma.fieldDefinition.findMany({ where: { accountId }, select: { key: true, name: true } });
  return new Map([
    ...BUILTIN_LEAD_FIELDS.map((f) => [f.key, f.label.split(/ \(| — /)[0]] as [string, string]),
    ...defs.map((d) => [d.key, d.name] as [string, string]),
  ]);
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
  /** Bancos que nunca rodaram e que a IA disse que estão/vão entrar em análise — o CRM pede a 1ª rodada (requestBankRunForAi). Inclui os que a rede de segurança achou no texto. */
  runBanks?: string[] | null;
  /** Bancos (SANTANDER | INTER) cuja simulação em PDF a IA quer mandar ao cliente — o PDF original do portal sai com a logo A&F (simulation-doc.service.ts). */
  sendSimulation?: string[] | null;
  /** true = a IA decidiu apresentar a aprovação: o CRM manda o aviso padrão (resumo + documentos + PDF) em vez de a IA escrever as condições. */
  sendApproval?: boolean;
  /** Prazo (meses) a simular sozinha no Inter (modo teste) e mandar ao cliente — requestSimulationForAi. */
  simulate?: { prazo?: number; valor?: number } | null;
  /** Banco APROVADO que o cliente disse que vai seguir (INTER | SANTANDER | CREDITAS): marca a ⭐ da proposta (chooseAnalysis), que preenche o Valor da venda e a aba Financiamento. */
  chooseBank?: string | null;
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
      // Quando pediu (Fabio 28/10): em Aguardando Documentação, 1 dia sem o cliente voltar a falar → Perdidos (prosseguir.processPediuParar).
      const cfStop = { ...(((await prisma.lead.findUnique({ where: { id: lead.id }, select: { customFields: true } }))?.customFields || {}) as Record<string, unknown>), _pediuPararAt: new Date().toISOString() };
      await prisma.lead.update({ where: { id: lead.id }, data: { tags, customFields: cfStop as any } });
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
      // Respondeu "não" ao "Você deseja seguir com o crédito aprovado?" (Fabio 29/10): aprovado que não andou leva a etiqueta.
      const { SEGUIR_APROVADO_Q } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
      const perguntou = await prisma.message.findFirst({ where: { leadId: lead.id, direction: 'OUTBOUND', deleted: false, content: { contains: SEGUIR_APROVADO_Q }, createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) } }, select: { id: true } });
      if (perguntou) {
        const { TAG_APROVADO_SEM_ANDAMENTO } = require('./prosseguir.service') as typeof import('./prosseguir.service');
        const atual = await prisma.lead.findUnique({ where: { id: lead.id }, select: { tags: true, customFields: true } });
        const { _seguirAprovadoAt, ...cfResto } = (atual?.customFields || {}) as Record<string, any>;
        await prisma.lead.update({ where: { id: lead.id }, data: { tags: Array.from(new Set([...(atual?.tags || []), TAG_APROVADO_SEM_ANDAMENTO])), customFields: cfResto } }).catch(() => {});
      }
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
    // Reprovado que voltou e segue pela CAIXA (Fabio 28/10): card Perdido em "Perdidos" reabre no funil de Vendas, em Aguardando Documentação.
    const reabriuCaixa = !!action.moveToStage && /aguardando doc/.test(normalize(action.moveToStage)) && !(action.markLost && action.markLost.trim())
      && (await (require('./reentry.service') as typeof import('./reentry.service')).reopenForCaixa(accountId, lead.id, action.moveReason || null, io).catch(() => false)
        // "Sim, quero seguir com o aprovado" de quem a IA já tinha mandado pra Perdidos (Iranildes 29/10).
        || await (require('./prosseguir.service') as typeof import('./prosseguir.service')).reopenSeguirAprovado(accountId, lead.id, action.moveReason || null, io).catch(() => false));
    if (action.moveToStage && !reabriuCaixa && !(action.markLost && action.markLost.trim())) {
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
          let vf = await prisma.stage.findFirst({ where: { pipelineId: atual.pipelineId, name: { contains: 'Venda Futura', mode: 'insensitive' } }, select: { id: true } });
          // Card em "Perdidos" (ou em funil sem a etapa): a retomada combinada leva pro funil de VENDAS do setor e REABRE o card — senão o disparo nunca sai, porque o poller só olha cards abertos em
          // "Venda Futura" (Fábio Roberto 21/10: disse "no início do ano eu vejo", a IA combinou 10/01/2027 e o card ficou Perdido).
          let reabriu = false;
          if (!vf) {
            const dept = (await prisma.pipeline.findUnique({ where: { id: atual.pipelineId }, select: { departmentId: true } }))?.departmentId;
            vf = dept ? await prisma.stage.findFirst({ where: { name: { contains: 'Venda Futura', mode: 'insensitive' }, pipeline: { departmentId: dept, name: { contains: 'Vendas', mode: 'insensitive' } } }, select: { id: true } }) : null;
            const st = await prisma.lead.findUnique({ where: { id: lead.id }, select: { status: true } });
            if (vf && st?.status !== 'OPEN') { await prisma.lead.update({ where: { id: lead.id }, data: { status: 'OPEN', lostReason: null, archived: false } }); reabriu = true; }
          }
          if (vf) {
            const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
            await updateLeadStage(lead.id, accountId, vf.id);
            await prisma.lead.update({ where: { id: lead.id }, data: { stageEnteredAt: new Date() } }).catch(() => {});
            await prisma.note.create({ data: { leadId: lead.id, type: 'STAGE_CHANGE', content: `🤖 IA moveu o card pra "Venda Futura"${reabriu ? ' (reabriu o card que estava Perdido)' : ''} — retomada combinada com o cliente` } }).catch(() => {});
          }
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

    // "Está em análise no Santander" (Fabio 26/10): a IA pode dizer, desde que o banco rode de verdade — 1ª rodada só nos bancos sem nenhuma análise no card.
    if (action.runBanks && action.runBanks.length) {
      try {
        const { requestBankRunForAi } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
        const r = await requestBankRunForAi(prisma as any, accountId, leadId, action.runBanks);
        const nomes = (r.banks.length ? r.banks : action.runBanks).map((b) => ({ CREDIMORAR: 'Santander', SANTANDER: 'Santander', INTER: 'Inter', CREDITAS: 'Creditas' } as Record<string, string>)[b] || b).join(' e ');
        if (r.ok) {
          await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `🤖 A IA disse ao cliente que o ${nomes} está em análise e esse banco nunca tinha rodado: pedi a análise de verdade (${r.detail}).` } }).catch(() => {});
          logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: `pediu a análise no ${nomes}` });
        } else if (!/j[aá] t[eê]m an[aá]lise/.test(r.detail)) {
          await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: `⚠️ A IA falou ao cliente do ${nomes} em análise, mas o CRM não conseguiu pedir a análise: ${r.detail}. Rode à mão na Análise de Crédito.` } }).catch(() => {});
        }
      } catch (e: any) { console.error('[IA] rodar banco que não rodou falhou:', e?.message); }
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

    // Cliente disse com qual banco vai seguir (Fabio 28/10: "a proposta que o cliente for seguir deve preencher o valor da venda"): mesma ação do botão "Seguir com esta" —
    // ⭐ na proposta aprovada mais recente desse banco, Valor da venda e aba Financiamento. Já escolhida: não mexe.
    if (action.chooseBank) {
      try {
        const bank = action.chooseBank === 'SANTANDER' ? 'CREDIMORAR' : action.chooseBank;
        const alvo = await prisma.creditAnalysis.findFirst({
          where: { leadId, bank, dryRun: false, source: { not: 'AI_SIM' }, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } },
          orderBy: { createdAt: 'desc' }, select: { id: true, chosen: true },
        });
        if (alvo && !alvo.chosen) {
          const { chooseAnalysis } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
          await chooseAnalysis(prisma as any, { accountId, id: alvo.id, userName: 'IA — o cliente disse na conversa que vai seguir com ela' });
          logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: `marcou a proposta escolhida pelo cliente (${action.chooseBank})` });
        }
      } catch (e: any) { console.error('[IA] marcar proposta escolhida falhou:', e?.message); }
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
        // O cliente corrigiu o TROCO (Fabio 21/10): o valor do crédito (saldo + troco) é ajustado e a análise refeita se já tinha rodado no valor antigo.
        if (patch.troco && Number(patch.troco) > 0 && String(patch.troco) !== String(((lead.customFields as any) || {}).troco ?? '')) {
          (require('./saldo-devedor.service') as typeof import('./saldo-devedor.service')).aplicarTrocoCorrigido(accountId, lead.id, Number(patch.troco), io as any).catch((e: any) => console.error('[Troco] ajuste do crédito:', e?.message));
        }
        // Cadastro divergente (Fabio 23/10): o cliente corrigiu nome/CPF/nascimento depois da pergunta → refaz a análise em TODOS os bancos com os dados certos.
        (require('./cadastro-divergente.service') as typeof import('./cadastro-divergente.service')).cadastroCorrigido(accountId, lead.id, Object.keys(patch), io as any).catch((e: any) => console.error('[Cadastro divergente] refazer análise:', e?.message));
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
