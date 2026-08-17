import { Router, Response } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendOutboundWhatsApp, sendOutboundMedia, sendOutboundWhatsAppTemplate, findOrCreateLeadByPhone, listConnectedWhatsAppNumbers, resolveStageTarget } from '../services/message.service';
import { listMetaTemplates, createMetaTemplate, TemplateCategory } from '../services/whatsapp.service';
import { searchKnowledge, learnFromWhatsAppConversations } from '../services/knowledge.service';
import {
  organizeLeadDocsToDrive, downloadDriveFile, findFolderByNameUnderRoot, listFolderContents,
  createFolder, renameFile, moveDriveItem, trashDriveItem, folderLink, findFilesInFolderTree,
  listFolders, findFoldersByNamesInTree, listAllFilesInFolderTree,
} from '../services/google.service';
import { deleteLead } from '../services/lead.service';
import { effectivePermissions, PERMISSION_KEYS, PermissionKey } from '../lib/permissions';
import { getOrCreateInboxPipeline } from '../services/department.service';

const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'AGENT'];
function sanitizePermsInput(input: unknown): Record<string, boolean> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of PERMISSION_KEYS) out[k] = !!src[k];
  return out;
}

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

type AIMode = 'grammar' | 'professional' | 'friendly' | 'fun';

const SYSTEM_PROMPTS: Record<AIMode, string> = {
  grammar: 'Você é um assistente de escrita. Corrija APENAS erros gramaticais e ortográficos do texto a seguir, mantendo o tom e as palavras originais. Retorne somente o texto corrigido, sem explicações.',
  professional: 'Você é um especialista em comunicação corporativa. Reescreva o texto a seguir com tom profissional, formal e objetivo, mantendo o mesmo significado. Retorne somente o texto reescrito, sem explicações.',
  friendly: 'Você é um especialista em comunicação. Reescreva o texto a seguir com tom amigável, caloroso e próximo ao cliente, mantendo o mesmo significado. Retorne somente o texto reescrito, sem explicações.',
  fun: 'Você é um especialista em comunicação criativa. Reescreva o texto a seguir com tom divertido, leve e descontraído, mantendo o mesmo significado. Use emojis adequados. Retorne somente o texto reescrito, sem explicações.',
};

router.post('/rewrite', async (req: AuthRequest, res: Response) => {
  const { text, mode } = req.body as { text?: string; mode?: AIMode };

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Texto obrigatório' });
    return;
  }
  if (!mode || !SYSTEM_PROMPTS[mode]) {
    res.status(400).json({ error: 'Modo inválido. Use: grammar | professional | friendly | fun' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
    return;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPTS[mode],
        messages: [
          { role: 'user', content: text.trim() },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[AI] Anthropic error:', response.status, err);
      res.status(502).json({ error: `Erro Anthropic ${response.status}: ${err}` });
      return;
    }

    const data = await response.json() as { content: { type: string; text: string }[] };
    const result = data.content?.[0]?.text ?? text;
    res.json({ result });
  } catch (err) {
    console.error('[AI] Erro:', err);
    res.status(500).json({ error: 'Erro interno ao processar IA' });
  }
});

const SUPPORT_SYSTEM_PROMPT = `Você é o assistente interno de suporte do AF CRM, usado pelos funcionários da A&F Soluções Financeiras.
Seu papel é tirar dúvidas dos funcionários sobre como usar o sistema e sobre o processo de vendas/atendimento da empresa: funil de vendas, inbox unificada (WhatsApp), cadastro de leads e contatos, tarefas, SalesBot (automação de mensagens), templates e relatórios.
Você também pode, quando um colaborador pedir explicitamente, ler o histórico de conversa de um lead no WhatsApp e enviar uma mensagem ao cliente em nome do colaborador, usando as ferramentas disponíveis:
- consultar_leads: ACESSO AMPLO para contar, somar e listar leads por qualquer critério — funil, estágio, status, valor, tags, dono, data de criação e QUALQUER campo do cadastro (customFields — ex.: "quantas propostas temos com o BRB" usa campos: [{"chave":"instituicao","valor":"BRB"}]). Use SEMPRE que a pergunta envolver contar/somar/listar vários leads, mesmo que pareça um "relatório" — você TEM esse acesso, nunca diga que não tem. Se não souber a chave de um campo, use listar_campos_cadastro primeiro.
- listar_campos_cadastro: lista os campos personalizados do cadastro (chave, nome, aba, tipo) — use para descobrir a chave certa antes de filtrar por um campo em consultar_leads.
- find_lead: busca um lead já cadastrado pelo NOME ou pelo TELEFONE (um lead específico, não uma lista/contagem — para isso use consultar_leads). Quando o colaborador der um número e perguntar se existe cliente com ele (ex: "tem algum cliente com o número 61 8454-9012?"), use find_lead com o parâmetro phone — a busca ignora pontuação, o DDI 55 e o 9º dígito do celular, e procura no contato e nos campos do cadastro. Não invente dígitos: passe o número como o colaborador escreveu.
- get_recent_messages: lê o histórico de mensagens de um lead.
- send_whatsapp_message: envia para um lead JÁ existente (por leadId).
- send_whatsapp_to_number: quando o colaborador fornecer um NÚMERO de telefone (ex: "manda mensagem para o 61 99999-9999"), use esta ferramenta — ela cria o contato/lead automaticamente e envia. Sempre que o pedido incluir um número, use send_whatsapp_to_number diretamente, sem exigir que o lead já exista. Aceita stageId (para criar o card num funil/estágio específico) e fromNumberId (número de WhatsApp de origem).
- list_whatsapp_numbers: lista os números de WhatsApp conectados (id + apelido). Use antes de enviar quando houver MAIS DE UM número conectado e o colaborador não tiver dito de qual enviar: mostre os apelidos e PERGUNTE qual usar. Se só houver um conectado, use-o sem perguntar. Passe o id escolhido em fromNumberId ao enviar.
- list_pipelines: lista os funis e seus estágios (com ids). Use para achar o stageId quando o colaborador pedir para criar o card num funil/estágio específico (ex: "no funil Follow-up, estágio Remarketing números"). Depois passe esse stageId em send_whatsapp_to_number. Você TEM, sim, como criar o card num estágio específico — nunca diga que não consegue.
- move_lead_to_stage: move um card JÁ EXISTENTE para outro funil/estágio. Use quando pedirem para mover/colocar um card em outro lugar (ex: "move o card do João para Remarketing"). Antes, use find_lead (leadId) e list_pipelines (stageId). Você CONSEGUE mover cards de funil e de estágio — nunca diga que não consegue.
- perguntar_colaborador / ver_minhas_perguntas_pendentes / responder_pergunta_pendente: sistema de "recado" entre colaboradores sobre dados de um card. Quando o colaborador pedir para "perguntar pra Fulano" algo sobre um ou mais leads (ex.: "pergunta pra Andreia o banco desses clientes sem instituição preenchida"), use perguntar_colaborador — informe o destinatário e uma pergunta por leadId (campo pode ser "nome", "valor" ou uma chave de listar_campos_cadastro). A pergunta NÃO é respondida na hora: ela fica pendente até o Fulano usar o chat DELE. Nunca prometa uma resposta imediata — diga algo como "deixei a pergunta pendente pra Andreia, ela vai ver na próxima vez que abrir o chat". Quando VOCÊ estiver conversando com alguém que tem pergunta(s) pendente(s) — isso é informado automaticamente no início desta conversa, se houver — traga a pergunta de forma natural (uma de cada vez se forem várias) e, assim que a pessoa responder, use responder_pergunta_pendente com o id certo para preencher o card sozinho. ver_minhas_perguntas_pendentes é só para o caso de o colaborador perguntar explicitamente se tem pendência.
- listar_templates_whatsapp / criar_template_whatsapp: gerenciar templates de mensagem do WhatsApp (API Oficial/Meta) — necessários para mandar mensagem pra cliente fora da janela de 24h. listar_templates_whatsapp mostra os já criados (com status de aprovação). criar_template_whatsapp cria um novo e manda pra aprovação da Meta (categorias MARKETING, UTILITY ou AUTHENTICATION — explique a diferença se o colaborador não souber qual usar). CONFIRMAÇÃO OBRIGATÓRIA antes de enviar: a primeira chamada sem confirmed:true só valida e devolve um resumo — leia esse resumo (nome, categoria, corpo) para o colaborador e só chame de novo com confirmed:true depois que ele confirmar. A aprovação em si demora (minutos a dias) e não depende do CRM — avise disso.
- listar_respostas_rapidas / criar_resposta_rapida / enviar_resposta_rapida: as "Respostas rápidas" (Templates → aba Respostas rápidas) são DIFERENTES dos templates da Meta — texto pronto reutilizável, SEM aprovação, disponível na hora pra equipe toda. listar mostra as que existem. criar_resposta_rapida cria uma nova (não precisa confirmar — só cria um texto, não envia a ninguém). enviar_resposta_rapida manda uma pra um cliente específico: {{nome}} já é preenchido sozinho, outras variáveis vêm em "variaveis" — se faltar alguma, PERGUNTE ao colaborador antes de enviar. CONFIRMAÇÃO OBRIGATÓRIA antes de enviar: primeira chamada sem confirmed:true só resolve e mostra o texto final — leia pro colaborador e só confirme depois que ele aprovar.
- enviar_template_whatsapp_lead: envia um template JÁ APROVADO da Meta para um cliente específico — é o jeito de reabrir a conversa quando já passou a janela de 24h. Use listar_templates_whatsapp antes pra saber o nome técnico exato e quantas variáveis {{1}},{{2}}... o corpo pede. CONFIRMAÇÃO OBRIGATÓRIA antes de enviar, mesmo padrão dos outros envios.
- aprender_com_conversas_whatsapp: analisa uma amostra das conversas mais recentes e extrai padrões de atendimento (dúvidas comuns, como a equipe costuma responder, objeções) direto pra Base de Conhecimento — NUNCA guarda nome, telefone ou dado de cliente específico, só o padrão generalizado. Use quando o colaborador pedir pro assistente "aprender com as conversas" ou similar. Demora alguns segundos.
- salvar_documentos_no_drive: quando o colaborador pedir para "criar a pasta do cliente", "organizar a documentação" ou "salvar os documentos no Drive", use esta ferramenta. Primeiro use find_lead para achar o cliente, depois chame salvar_documentos_no_drive com o leadId e o nome da pasta (o nome do cliente, salvo se o colaborador pedir outro nome). Se o colaborador indicar uma sub-pasta de destino (ex: "faça uma pasta em LEADS ATIVOS"), passe-a em pastaDestino; senão, deixe vazio e ela cria direto na pasta-raiz. Importante: só crie a pasta e suba os documentos quando o colaborador pedir — os arquivos ficam guardados até esse pedido. Ela JÁ SALVA sozinha o link da pasta no card do cliente (campo "Pasta no Drive", que aparece na aba Principal do card). Depois, informe ao colaborador o link da pasta e quais arquivos foram enviados. Se, em qualquer outro momento, o colaborador pedir para "salvar o link dessa pasta no card" (ex: depois de criar/renomear/mover uma pasta com outra ferramenta), use update_lead com fields: { link_pasta_drive: <link> } — o campo é criado sozinho na primeira vez que for usado.
- ler_documento_identificacao: quando o colaborador pedir para "ler a CNH desse cliente", "pegar os dados do documento/identidade que ele mandou", "extrair CPF e nascimento do RG" etc, use esta ferramenta. Primeiro use find_lead para achar o cliente, depois chame ler_documento_identificacao com o leadId — ela procura primeiro na PASTA DO CLIENTE no Drive e, se não achar nada lá, cai para a foto/PDF mais recente enviado pelo cliente no WhatsApp (se o colaborador apontar um arquivo específico, use nomeArquivo ou attachmentId). Ela retorna nome completo, CPF, data de nascimento e, se o documento for um comprovante de renda, a renda. SEMPRE mostre os dados extraídos ao colaborador antes de gravar (a leitura pode errar) e, se ele confirmar, use update_lead com fields para preencher participante_1 (nome), cpf_1, nascimento_1 e/ou renda_1 — só os campos que vieram diferentes de null. NUNCA invente um dado que o documento não mostrou com clareza.
- ANÁLISE LIVRE DE ANEXO NO CHAT: o colaborador pode anexar um arquivo (imagem ou PDF) direto nesta conversa, pelo botão de anexo — quando isso acontecer, o conteúdo do arquivo vem junto da mensagem dele. Não é uma ferramenta, é diferente de ler_documento_identificacao (que busca documentos já salvos no Drive/WhatsApp de um lead e grava os dados no cadastro): aqui é uma leitura livre do que foi anexado nesta conversa — analise, resuma, explique, compare ou extraia o que o colaborador pedir sobre o documento anexado. Só grave algo no cadastro de um lead (via update_lead) se o colaborador pedir isso explicitamente e disser de qual lead se trata.
- conferir_cadastro_com_documentos: quando o colaborador já preencheu o cadastro de um cliente (digitando com base nos documentos dele) e pede para CONFERIR se não errou nada — ex.: "confere esse cadastro com a documentação do cliente", "vê se bati os dados certo" — use esta ferramenta. Diferente de ler_documento_identificacao (que preenche um cadastro vazio), esta AUDITA um cadastro já preenchido contra todos os documentos da pasta do cliente no Drive. Primeiro find_lead para achar o leadId. Ela retorna as divergências encontradas (ou confirma que está tudo batendo) — mostre cada divergência ao colaborador e só corrija o cadastro (update_lead) depois que ele confirmar qual valor está certo, nunca sozinho.
- conferir_documento_com_pasta_drive: parecida com conferir_cadastro_com_documentos, mas o "lado A" da comparação NÃO é o cadastro no CRM — é um FORMULÁRIO/ARQUIVO específico, comparado contra os OUTROS documentos da pasta do cliente. Duas formas de indicar o formulário: o colaborador anexa na conversa (botão de anexo, não precisa de parâmetro), OU ele já está salvo na pasta do cliente no Drive (informe nomeArquivoReferencia com um trecho do nome — ex.: "ficha-cadastral", "formulário" — pode estar numa subpasta tipo "FORMULARIOS", a busca acha em qualquer nível). Use quando o pedido for algo como "confere esse formulário com a documentação desse cliente no Drive" (anexado) ou "confere o formulário que já está na pasta dele com o resto da documentação" (sem anexar nada, tudo já no Drive). Primeiro find_lead para achar de qual cliente é a pasta. Se o colaborador não anexou nada nem disse o nome do arquivo de referência, pergunte qual das duas formas ele quer. Mostre as divergências encontradas, nunca corrija nada sozinho.
- enviar_arquivo_whatsapp: envia um arquivo (PDF, foto etc) pelo WhatsApp ao cliente — você CONSEGUE, sim, encaminhar arquivos, não só texto; nunca diga que só sabe mandar mensagem de texto. Use quando o colaborador pedir para "mandar esse PDF para o cliente", "encaminhar esse arquivo pelo WhatsApp", "reenviar o documento que ele mandou" etc. Duas origens possíveis do arquivo: (1) attachmentId — reenvia um anexo que o PRÓPRIO CLIENTE já mandou na conversa do WhatsApp; (2) nomeArquivo (+ nomePasta opcional, padrão o nome do lead) — busca um arquivo pelo nome dentro da pasta do cliente no Drive. Se a busca por nomeArquivo encontrar mais de um arquivo parecido, ela retorna a lista — NUNCA escolha um sozinho, mostre as opções e pergunte qual enviar (regra de ambiguidade abaixo). CONFIRMAÇÃO ANTES DE ENVIAR (obrigatória, mesmo fora do caso de ambiguidade): a primeira chamada sem confirmed:true não envia nada — ela só resolve qual é o arquivo e devolve needsConfirmation. Ao receber isso, diga ao colaborador exatamente qual arquivo vai ser encaminhado e para qual cliente, e pergunte se ele quer incluir alguma mensagem (legenda) junto. Só chame a ferramenta de novo, com confirmed:true (e legenda, se ele pedir), depois que o colaborador responder.
- listar_pasta_drive / criar_pasta_drive / renomear_item_drive / mover_item_drive / excluir_item_drive: acesso completo ao Google Drive das pastas de clientes. listar_pasta_drive mostra o que tem numa pasta (do cliente, via leadId, ou qualquer uma pelo nome/ID). criar_pasta_drive cria uma pasta nova em qualquer lugar. renomear_item_drive renomeia arquivo/pasta — para "renomear a pasta do cliente para o nome completo em caixa alta" sem que o colaborador dite o texto exato, use leadId (sem itemId) e novoNome como o nome do lead em MAIÚSCULAS. mover_item_drive move um item para dentro de outra pasta. excluir_item_drive apaga (manda pra lixeira) um arquivo/pasta — é AÇÃO IRREVERSÍVEL, segue a regra de confirmação dupla abaixo.
- auditar_pastas_contratacao: compara os leads do funil "Em contratação" com as pastas deles no Drive e aponta quais estão fora de "1. LEADS ATIVOS" (em outra pasta, ou sem pasta nenhuma). Use quando o colaborador pedir para "conferir/organizar as pastas de contratação", "ver se as pastas dos leads ativos estão certas" etc. — ver a REGRA FIXA abaixo.
- preencher_link_drive_em_lote: quando o colaborador pedir para preencher/atualizar o campo "Pasta no Drive" (o link) de TODOS os leads de um funil de uma vez — ex.: "preenche o campo drive de todos os clientes do funil contratação com o link de cada um" — use esta ferramenta, NÃO tente fazer lead por lead na mão (é lento e pode estourar o limite de passos numa lista grande). Informe funilNome. Ela mesma resolve e preenche os que achou com certeza, e te devolve a lista dos que ficaram de fora (sem pasta encontrada ou ambíguos) para você resolver com o colaborador.
- create_lead / update_lead / archive_lead / delete_lead: criar, editar, arquivar e EXCLUIR cards do funil.
- adicionar_nota_lead: registra um comentário/observação em texto livre no histórico de um ou mais cards (aparece no timeline do lead) — use quando o colaborador pedir para "anotar", "registrar" ou "jogar essa informação nos cards" algo que é status/observação, não um campo estruturado (para dado estruturado, use update_lead com fields). Aceita várias notas de vários leads numa chamada só — se o colaborador mandar uma lista com vários clientes de uma vez, resolva TODOS os leadIds primeiro (find_lead/consultar_leads) e chame adicionar_nota_lead UMA vez com todas as notas juntas, em vez de uma chamada por cliente.
- criar_tarefa_lead: cria uma tarefa vinculada a um card específico (aparece na aba Tarefas e no Dashboard do responsável). Use quando o colaborador pedir para "criar uma tarefa", "lembrar de ligar/cobrar/enviar algo", "agendar um follow-up" etc para um cliente. Use find_lead antes para o leadId. Se não disser a data, use hoje; se não disser a hora, use um horário razoável.
- list_users / create_user / update_user / delete_user: gerenciar a equipe (criar, editar nome/e-mail/senha/função/permissões e EXCLUIR/tirar acesso). Para "tirar acesso" use update_user (mudando função/permissões) ou delete_user.
Você tem acesso completo ao CRM, MAS sempre respeitando o nível de acesso do colaborador: cada ferramenta checa a permissão dele. Se uma ferramenta retornar erro de permissão, explique com educação que ele não tem acesso àquela ação e não tente por outro caminho.
REGRA FIXA — pastas do funil "Em contratação": todo lead nesse funil deve ter a pasta dele dentro de "1. LEADS ATIVOS" no Drive. Quando o colaborador pedir para conferir/organizar isso, use auditar_pastas_contratacao — ela retorna a lista de leads do funil com a situação de cada um (ok, fora do lugar — com o local atual, ou pasta não encontrada). Apresente as divergências ao colaborador e resolva UMA DE CADA VEZ, perguntando antes de agir em cada uma (nunca mova todas de uma vez sozinho, mesmo que pareça óbvio): se a pasta existe em outro lugar, confirme e use mover_item_drive para trazer para "1. LEADS ATIVOS"; se não existe, confirme e crie lá (criar_pasta_drive ou salvar_documentos_no_drive, se for organizar documentos do zero).
AMBIGUIDADE ao localizar algo (principalmente no Drive): NUNCA escolha sozinho quando houver mais de uma opção plausível — nomes de pasta parecidos, mais de uma pasta de ANO/MÊS (ex.: "3. CONCLUIDOS" tem uma sub-pasta por ano, e cada ano tem uma por mês — "08. AGOSTO" existe dentro de 2025 E de 2026), mais de um arquivo que bate com o pedido, mais de um lead com nome parecido, etc. Isso vale tanto quando uma ferramenta retorna mais de um resultado quanto quando VOCÊ MESMO está navegando pasta a pasta com listar_pasta_drive (ex.: abriu "CONCLUIDOS", viu vários anos, e precisa decidir em qual entrar) — nesse caso PARE, liste as opções encontradas e pergunte ao colaborador qual é a certa antes de mover, renomear, criar dentro ou excluir qualquer coisa. Se o colaborador disser só "mês de agosto" sem dizer o ano, não assuma — use a data de hoje (informada no início desta conversa) como referência e, mesmo assim, confirme antes de agir se houver dúvida.
CONFIRMAÇÃO DUPLA obrigatória para ações IRREVERSÍVEIS (excluir card, excluir usuário / tirar acesso, excluir arquivo/pasta do Drive): antes de executar, pergunte se o colaborador confirma; quando ele confirmar, pergunte MAIS UMA VEZ ("Tem certeza? Isso não pode ser desfeito.") e só após a SEGUNDA confirmação chame a ferramenta com confirmed:true. Nunca passe confirmed:true sem ter perguntado duas vezes. Se a ferramenta retornar needsConfirmation, é porque faltou confirmar — não invente que foi feito.
Nunca envie uma mensagem nem salve documentos sem que o colaborador tenha pedido isso na conversa atual. Depois de agir, confirme exatamente o que foi feito.
IMPORTANTE: só afirme que uma mensagem foi ENVIADA quando a ferramenta retornar success: true. Se a ferramenta retornar success: false, NÃO diga que enviou — avise o colaborador que a mensagem NÃO foi enviada e explique o motivo do campo "error" (por exemplo, quando o número não tem WhatsApp ou o QR Code está desconectado). Nunca invente um status "SENT".
PASSO A PASSO ao explicar um PROCEDIMENTO do sistema (ex.: "como eu cadastro um lead", "como configuro o SalesBot"): apresente como uma lista numerada de etapas curtas e claras, uma ação por linha — nunca em um parágrafo único ou numa mensagem enorme com tudo junto. Se o procedimento tiver muitas etapas, apresente as primeiras e pergunte se o colaborador quer continuar, em vez de despejar tudo de uma vez.
RESPOSTAS CURTAS: seja breve. Na maioria das vezes, 1 a 3 frases bastam — depois de executar uma ação, diga só o que foi feito (ex.: "Pronto, movi o card do João para Remarketing."), sem repetir o pedido do colaborador nem explicar o raciocínio. Não adicione avisos, ressalvas ou contexto extra que não foi pedido. Só fuja desse tamanho curto quando for: uma lista de opções para o colaborador escolher (ambiguidade), um passo a passo pedido explicitamente, ou dados que o colaborador pediu para ver (ex.: resultado de uma busca). Corte qualquer frase de abertura ou fechamento genérica ("Claro!", "Aqui está...", "Espero ter ajudado" etc.) — vá direto ao ponto.
Responda em português, de forma curta, direta e prática, como se estivesse explicando para um colega de trabalho. Se a dúvida não tiver relação com o CRM ou o processo da empresa, explique educadamente que você só pode ajudar com isso.`;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Chave fixa do campo "Pasta no Drive" (tipo LINK) no cadastro do lead. O
// assistente cria essa FieldDefinition sozinho na primeira vez que precisa
// salvar um link de pasta — não exige nenhuma configuração manual antes.
const DRIVE_LINK_FIELD_KEY = 'link_pasta_drive';

async function ensureDriveLinkField(accountId: string): Promise<void> {
  const existing = await prisma.fieldDefinition.findFirst({ where: { accountId, key: DRIVE_LINK_FIELD_KEY } });
  if (existing) return;
  await prisma.fieldDefinition.create({
    data: { accountId, name: 'Pasta no Drive', key: DRIVE_LINK_FIELD_KEY, type: 'LINK', tab: 'Principal', order: 999 },
  }).catch((err) => console.error('[AI] Falha ao criar campo "Pasta no Drive":', (err as any)?.message)); // não é crítico: o link ainda é salvo em customFields, só o rótulo bonito no painel que pode faltar
}

const AGENT_TOOLS = [
  {
    name: 'consultar_leads',
    description: 'Busca, filtra e TOTALIZA leads/cards por qualquer critério — funil, estágio, status, faixa de valor, tags, dono do card, data de criação e também por CAMPOS DO CADASTRO (customFields — ex.: Instituição/banco, Finalidade, Administradora do consórcio, Corretor/Indicação etc, use listar_campos_cadastro se não souber a chave certa). Use esta ferramenta sempre que a pergunta pedir CONTAR, SOMAR ou LISTAR vários leads por um critério (ex.: "quantas propostas temos com o BRB", "qual o valor total em Análise Jurídica", "quantos leads o Carlos tem", "leads criados este mês") — NÃO diga que não tem acesso a esse tipo de relatório, use esta ferramenta. Para achar UM lead específico pelo nome/telefone, use find_lead. Retorna total (contagem de TODOS que bateram, não só os listados), somaValor (soma do campo valor de todos que bateram) e uma amostra (até 100) com os dados de cada um.',
    input_schema: {
      type: 'object',
      properties: {
        pipelineNome: { type: 'string', description: 'Nome do funil (ex.: "Em contratação"). Aceita nome parecido, não precisa ser exato. Opcional — sem isso, busca em todos os funis.' },
        estagioNome: { type: 'string', description: 'Nome do estágio (ex.: "Análise Jurídica"). Opcional.' },
        status: { type: 'string', enum: ['OPEN', 'WON', 'LOST'], description: 'Status do lead. Opcional.' },
        arquivados: { type: 'boolean', description: 'true = só leads arquivados. Padrão (omitido ou false) = só ativos.' },
        valorMin: { type: 'number', description: 'Valor mínimo do negócio (opcional).' },
        valorMax: { type: 'number', description: 'Valor máximo do negócio (opcional).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filtra leads que tenham QUALQUER uma dessas tags (opcional).' },
        donoNome: { type: 'string', description: 'Nome do usuário responsável pelo card (opcional).' },
        criadoDe: { type: 'string', description: 'Data mínima de criação, formato AAAA-MM-DD (opcional).' },
        criadoAte: { type: 'string', description: 'Data máxima de criação, formato AAAA-MM-DD (opcional).' },
        campos: {
          type: 'array',
          description: 'Filtros nos campos do cadastro (customFields). Ex.: [{"chave":"instituicao","valor":"BRB"}] para leads com Instituição contendo "BRB". "valor" faz correspondência parcial, sem diferenciar maiúsculas/acentos — omita "valor" para exigir só que o campo tenha algum valor preenchido. Vários itens no array = todos precisam bater (E lógico). Use listar_campos_cadastro para ver as chaves existentes.',
          items: { type: 'object', properties: { chave: { type: 'string' }, valor: { type: 'string' } }, required: ['chave'] },
        },
        limite: { type: 'number', description: 'Quantos leads detalhar na resposta (padrão 30, máximo 100). O total e a soma sempre consideram TODOS os que bateram, não só os listados aqui.' },
      },
    },
  },
  {
    name: 'listar_campos_cadastro',
    description: 'Lista todos os campos personalizados do cadastro de lead (chave, nome de exibição, aba e tipo) — use antes de consultar_leads quando não souber a chave exata de um campo (ex.: para saber que o campo do banco/financeira se chama "instituicao").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'perguntar_colaborador',
    description: 'Deixa uma ou mais perguntas pendentes para OUTRO colaborador responder — sobre qualquer campo de um card (nome, valor, prazo, instituição, ou qualquer campo do cadastro). Use quando o colaborador atual pedir para "perguntar pra Fulano" algo sobre um lead (ex.: "pergunta pra Andreia o banco desses clientes que não têm instituição preenchida"). A pergunta NÃO é respondida na hora: ela fica pendente e aparece automaticamente na próxima vez que o destinatário (Fulano) usar o CHAT DELE — o assistente traz a pergunta na conversa dela de forma natural, e quando ela responder, o campo é preenchido sozinho no card. Informe destinatarioNome e uma lista de perguntas, uma por lead (use find_lead/consultar_leads antes para achar os leadIds certos). campo deve ser "nome", "valor" ou uma chave de listar_campos_cadastro.',
    input_schema: {
      type: 'object',
      properties: {
        destinatarioNome: { type: 'string', description: 'Nome do colaborador que deve responder (ex.: "Andreia").' },
        perguntas: {
          type: 'array',
          description: 'Uma pergunta por lead.',
          items: {
            type: 'object',
            properties: {
              leadId: { type: 'string', description: 'ID do lead (via find_lead ou consultar_leads).' },
              campo: { type: 'string', description: '"nome", "valor" ou a chave do campo do cadastro (via listar_campos_cadastro) que a resposta vai preencher.' },
              pergunta: { type: 'string', description: 'Texto da pergunta, já pronto para mostrar ao destinatário (ex.: "Qual a instituição financeira do cliente João Silva?").' },
            },
            required: ['leadId', 'campo', 'pergunta'],
          },
        },
      },
      required: ['destinatarioNome', 'perguntas'],
    },
  },
  {
    name: 'ver_minhas_perguntas_pendentes',
    description: 'Lista as perguntas que outros colaboradores pediram para você (o colaborador atual da conversa) responder, ainda sem resposta. Normalmente você já recebe isso automaticamente no início da conversa quando houver pendências — use esta ferramenta só se o colaborador perguntar explicitamente "tenho pergunta pendente?" ou similar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'responder_pergunta_pendente',
    description: 'Registra a resposta do colaborador atual a uma pergunta pendente (perguntar_colaborador) e PREENCHE sozinho o campo correspondente no card do lead. Use assim que o colaborador responder, dentro da própria conversa, a uma pergunta que você trouxe para ela. Depois de responder, confirme o que foi preenchido.',
    input_schema: {
      type: 'object',
      properties: {
        perguntaId: { type: 'string', description: 'ID da pergunta pendente (veio junto da pergunta trazida na conversa, ou de ver_minhas_perguntas_pendentes).' },
        resposta: { type: 'string', description: 'Resposta dada pelo colaborador, no formato pronto para gravar no campo.' },
      },
      required: ['perguntaId', 'resposta'],
    },
  },
  {
    name: 'listar_templates_whatsapp',
    description: 'Lista os templates de mensagem do WhatsApp (API Oficial/Meta) já criados na conta, com nome, categoria, idioma e status de aprovação (PENDING, APPROVED, REJECTED etc). Use quando o colaborador pedir para "ver os templates", "quais modelos já temos", "esse template já foi aprovado" etc.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'criar_template_whatsapp',
    description: 'Cria um novo template de mensagem do WhatsApp e envia para aprovação da Meta — necessário para poder mandar mensagem para um cliente fora da janela de 24h de atendimento (API Oficial). A aprovação pode levar minutos a dias e não depende do CRM. Categorias: MARKETING (promoções/ofertas), UTILITY (avisos/atualizações relacionados a uma transação, ex.: "sua proposta foi aprovada"), AUTHENTICATION (código de verificação — a Meta gera o texto sozinha, não aceita corpo customizado, só footer com o prazo de expiração do código). Para variáveis dinâmicas no corpo (ex.: nome do cliente), use {{1}}, {{2}} etc. CONFIRMAÇÃO OBRIGATÓRIA: a primeira chamada (sem confirmed:true) não envia nada — ela só valida os dados e retorna needsConfirmation com um resumo do template. Leia o resumo para o colaborador (nome técnico, categoria, corpo) e só chame de novo com confirmed:true depois que ele confirmar — enviar para aprovação da Meta não é algo pra desfazer com facilidade.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome do template em linguagem natural (ex.: "Proposta aprovada") — é convertido sozinho para o formato técnico exigido pela Meta (minúsculo, com _ no lugar de espaço/acento).' },
        category: { type: 'string', enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], description: 'Categoria do template.' },
        language: { type: 'string', description: 'Idioma no formato da Meta (padrão "pt_BR" se não informado).' },
        body: { type: 'string', description: 'Corpo da mensagem (obrigatório para MARKETING/UTILITY; ignorado em AUTHENTICATION). Use {{1}}, {{2}} etc para variáveis.' },
        footer: { type: 'string', description: 'Rodapé opcional (texto curto, até 60 caracteres).' },
        codeExpirationMinutes: { type: 'number', description: 'Só para AUTHENTICATION: minutos até o código expirar (padrão 10).' },
        confirmed: { type: 'boolean', description: 'Só true depois que o colaborador já viu o resumo do template e confirmou o envio para aprovação.' },
      },
      required: ['name', 'category'],
    },
  },
  {
    name: 'listar_respostas_rapidas',
    description: 'Lista as "Respostas rápidas" (Templates → aba Respostas rápidas) — textos prontos salvos no CRM, SEM precisar de aprovação da Meta (diferente de listar_templates_whatsapp, que é só para os da API Oficial). Use para ver o que já existe antes de criar um novo ou de enviar um pra algum cliente.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'criar_resposta_rapida',
    description: 'Cria uma nova "Resposta rápida" (Templates → aba Respostas rápidas) — texto pronto reutilizável, sem aprovação da Meta, disponível pra equipe toda imediatamente. Use {{variavel}} no corpo pra partes que mudam por cliente (ex.: {{nome}}). Não precisa de confirmação — só cria um texto, não envia nada a ninguém.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Nome do template (ex.: "Boas-vindas Consórcio").' },
      category: { type: 'string', enum: ['vendas', 'suporte', 'cobranca', 'boas_vindas', 'follow_up', 'geral'], description: 'Categoria (padrão "geral" se não informado).' },
      body: { type: 'string', description: 'Texto do template. Use {{variavel}} para partes que mudam por cliente.' },
    }, required: ['name', 'body'] },
  },
  {
    name: 'enviar_resposta_rapida',
    description: 'Envia uma "Resposta rápida" já existente para um cliente específico, pelo WhatsApp. {{nome}} é preenchido sozinho com o nome do lead; outras variáveis do template (se houver) devem vir em "variaveis". CONFIRMAÇÃO OBRIGATÓRIA: a primeira chamada (sem confirmed:true) não envia nada — só resolve o template, preenche as variáveis que der e devolve needsConfirmation com o texto final e o cliente. Se sobrar alguma variável sem preencher, PERGUNTE o valor ao colaborador antes de confirmar. Leia o resumo pro colaborador e só chame de novo com confirmed:true depois que ele confirmar.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead/cliente (via find_lead).' },
      templateName: { type: 'string', description: 'Nome (ou parte do nome) da Resposta rápida a enviar.' },
      variaveis: { type: 'object', description: 'Valores para {{variavel}} do corpo, por chave (ex.: { "produto": "Consórcio Volkswagen" }). "nome" já é preenchido sozinho com o nome do lead, só passe se quiser sobrescrever.' },
      confirmed: { type: 'boolean', description: 'Só true depois que o colaborador viu o texto final e confirmou o envio.' },
    }, required: ['leadId', 'templateName'] },
  },
  {
    name: 'enviar_template_whatsapp_lead',
    description: 'Envia um template JÁ APROVADO pela Meta (via API Oficial) para um cliente específico — necessário pra reabrir a conversa quando já passaram mais de 24h desde a última mensagem dele. Use listar_templates_whatsapp antes pra confirmar o nome técnico e quantas variáveis {{1}}, {{2}}... o corpo tem. CONFIRMAÇÃO OBRIGATÓRIA: a primeira chamada (sem confirmed:true) não envia nada — só devolve needsConfirmation com um resumo. Leia pro colaborador e só chame de novo com confirmed:true depois que ele confirmar.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead/cliente (via find_lead).' },
      templateName: { type: 'string', description: 'Nome técnico exato do template aprovado (via listar_templates_whatsapp).' },
      language: { type: 'string', description: 'Idioma do template (padrão "pt_BR").' },
      bodyParams: { type: 'array', items: { type: 'string' }, description: 'Valores para {{1}}, {{2}}... do corpo do template, na ordem — vazio se o template não tiver variáveis.' },
      previewText: { type: 'string', description: 'O texto do template já com as variáveis preenchidas, para mostrar na conversa (opcional, mas recomendado — monte a partir do corpo visto em listar_templates_whatsapp).' },
      confirmed: { type: 'boolean', description: 'Só true depois que o colaborador viu o resumo e confirmou o envio.' },
    }, required: ['leadId', 'templateName'] },
  },
  {
    name: 'aprender_com_conversas_whatsapp',
    description: 'Analisa uma amostra das conversas de WhatsApp mais recentes e extrai padrões de atendimento (dúvidas comuns e como a equipe costuma responder, objeções) direto para a Base de Conhecimento — NUNCA guarda nome, telefone ou qualquer dado que identifique um cliente específico, só o padrão generalizado. Use quando o colaborador pedir para o assistente "aprender com as conversas", "puxar experiência do WhatsApp pra base de conhecimento" etc. Demora alguns segundos (analisa várias conversas de uma vez). Precisa da pasta da Base de Conhecimento já configurada (Configurações → Agente IA).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_lead',
    description: 'Busca leads/clientes pelo NOME (ou parte) ou pelo TELEFONE. Informe name para buscar por nome, ou phone para buscar por número. A busca por telefone ignora pontuação, o DDI 55 e o 9º dígito do celular, e procura tanto no contato quanto nos campos do cadastro. Retorna nome, telefone e id de cada lead encontrado.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome ou parte do nome do lead/cliente a buscar' },
        phone: { type: 'string', description: 'Telefone a buscar, em qualquer formato (ex: "(61) 8454-9012" ou "61984549012"). A busca ignora pontuação, o DDI 55 e o 9º dígito.' },
      },
      required: [],
    },
  },
  {
    name: 'get_recent_messages',
    description: 'Busca as últimas mensagens trocadas com um lead no WhatsApp, para entender o contexto antes de responder.',
    input_schema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'ID do lead (obtido via find_lead)' },
        limit: { type: 'number', description: 'Quantidade de mensagens a retornar (padrão 10)' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'send_whatsapp_message',
    description: 'Envia uma mensagem de WhatsApp para um lead/cliente JÁ EXISTENTE (identificado por leadId) em nome do colaborador. Use somente quando o colaborador pedir explicitamente para responder/enviar algo ao cliente.',
    input_schema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'ID do lead (obtido via find_lead)' },
        content: { type: 'string', description: 'Texto exato da mensagem a enviar ao cliente' },
        fromNumberId: { type: 'string', description: 'Opcional. ID do número de WhatsApp a usar (obtido via list_whatsapp_numbers). Se omitido, usa o número da conversa ou o único conectado.' },
      },
      required: ['leadId', 'content'],
    },
  },
  {
    name: 'send_whatsapp_to_number',
    description: 'Inicia uma conversa e envia uma mensagem de WhatsApp para um NÚMERO DE TELEFONE fornecido pelo colaborador (mesmo que ainda não exista lead/contato). Cria o contato e o lead automaticamente se necessário. Use quando o colaborador fornecer um número (ex: "manda para o 61 99999-9999") em vez de um nome já cadastrado. Pode criar o card num funil/estágio específico (stageId) e enviar por um número de WhatsApp específico (fromNumberId).',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Número de telefone com DDD (ex: 61999999999). Pode incluir DDI 55.' },
        content: { type: 'string', description: 'Texto exato da mensagem a enviar' },
        name: { type: 'string', description: 'Nome do cliente, se o colaborador informar (opcional)' },
        fromNumberId: { type: 'string', description: 'Opcional. ID do número de WhatsApp de origem (obtido via list_whatsapp_numbers). Se houver mais de um número conectado e o colaborador não disser qual, pergunte antes.' },
        stageId: { type: 'string', description: 'Opcional. ID do estágio onde criar o card (obtido via list_pipelines). Já define o funil. Se o colaborador citar um funil/estágio por nome, use list_pipelines para achar o id.' },
        pipelineId: { type: 'string', description: 'Opcional. ID do funil (obtido via list_pipelines). Use só se o colaborador indicar o funil mas não o estágio — cria no 1º estágio dele.' },
      },
      required: ['phone', 'content'],
    },
  },
  {
    name: 'list_whatsapp_numbers',
    description: 'Lista os números de WhatsApp conectados via QR Code na conta (id, apelido e telefone). Use quando houver mais de um número e o colaborador não tiver dito de qual número enviar/encaminhar — mostre os apelidos e pergunte qual usar antes de enviar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_pipelines',
    description: 'Lista os funis de vendas e seus estágios (com ids). Use para descobrir o stageId/pipelineId quando o colaborador pedir para criar o card num funil/estágio específico (ex: "no funil Follow-up, estágio Remarketing").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'move_lead_to_stage',
    description: 'Move um lead/card JÁ EXISTENTE para outro funil/estágio. Use quando o colaborador pedir para mover/colocar um card em outro estágio ou funil (ex: "move o card do João para Remarketing"). Antes, use find_lead (para o leadId) e list_pipelines (para o stageId de destino).',
    input_schema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'ID do lead/card a mover (obtido via find_lead)' },
        stageId: { type: 'string', description: 'ID do estágio de destino (obtido via list_pipelines). Já define o funil.' },
        pipelineId: { type: 'string', description: 'Opcional. ID do funil de destino (via list_pipelines); usa o 1º estágio dele se stageId não for informado.' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'salvar_documentos_no_drive',
    description: 'Cria (ou reutiliza) a pasta do cliente no Google Drive e sobe todos os documentos que o cliente enviou no WhatsApp e que ainda não foram salvos. Por padrão a pasta do cliente é criada dentro da pasta-raiz configurada; se o colaborador indicar uma sub-pasta de destino (ex: "em LEADS ATIVOS"), passe-a em pastaDestino. Use quando o colaborador pedir para "organizar a documentação", "criar a pasta do cliente no Drive" ou "salvar os documentos". Retorna o link da pasta.',
    input_schema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'ID do lead (obtido via find_lead)' },
        nomePasta: { type: 'string', description: 'Nome da pasta do cliente. Se o colaborador não especificar, use o nome do lead/cliente.' },
        pastaDestino: { type: 'string', description: 'Opcional. Sub-pasta dentro da raiz onde criar a pasta do cliente (ex: "LEADS ATIVOS"). Se o colaborador não indicar, deixe vazio para usar a pasta-raiz.' },
      },
      required: ['leadId', 'nomePasta'],
    },
  },
  {
    name: 'ler_documento_identificacao',
    description: 'Lê uma foto ou PDF de documento (CNH, RG, ou comprovante de renda/holerite) e extrai nome completo, CPF, data de nascimento e renda (quando o documento for um comprovante de renda). Use quando o colaborador pedir para "ler a CNH desse cliente", "pegar os dados do documento/identidade", "extrair CPF e nascimento do RG que ele mandou" etc. Primeiro use find_lead para achar o leadId. ORDEM DE BUSCA do documento: 1) procura na PASTA DO CLIENTE no Drive (a mesma que salvar_documentos_no_drive usa/cria — por nome, use nomePasta se o colaborador indicou um nome diferente do nome do lead); se houver mais de um arquivo lá, tenta reconhecer pelo nome (ex: contém "cnh", "rg", "holerite") ou, se o colaborador apontou um arquivo, use nomeArquivo para casar pelo nome; 2) se não achar nada útil na pasta do Drive, cai para o anexo (foto/PDF) mais recente enviado pelo cliente no WhatsApp — ou o attachmentId indicado, se o colaborador apontou um anexo específico da conversa. Depois de extrair, MOSTRE os dados ao colaborador para ele conferir (leitura de documento pode errar) e, se ele confirmar, use update_lead com fields — participante_1 (nome), cpf_1 (CPF), nascimento_1 (data de nascimento) e/ou renda_1 (renda) — preenchendo só os campos que vieram diferentes de null. NUNCA invente um dado que o documento não mostrou com clareza.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead (via find_lead)' },
      nomePasta: { type: 'string', description: 'Nome da pasta do cliente no Drive, se diferente do nome do lead (opcional).' },
      nomeArquivo: { type: 'string', description: 'Trecho do nome do arquivo a ler dentro da pasta do cliente, se o colaborador apontou um específico (opcional).' },
      attachmentId: { type: 'string', description: 'ID de um anexo específico da conversa do WhatsApp a ler (opcional — usado só se o colaborador apontar um anexo da conversa, não da pasta do Drive).' },
    }, required: ['leadId'] },
  },
  {
    name: 'conferir_cadastro_com_documentos',
    description: 'Confere se os dados JÁ PREENCHIDOS no cadastro do lead (nome, valor e campos personalizados) batem com os documentos do cliente salvos na pasta dele no Drive — usado para AUDITAR um cadastro que já foi digitado, não para preencher um vazio (isso é o ler_documento_identificacao). Use quando o colaborador pedir para "conferir esse cadastro com a documentação", "ver se não errei nenhum dado", "revisar o cadastro com os documentos do cliente" etc. Primeiro use find_lead para achar o leadId. REGRA FIXA: ela procura os documentos de referência dentro da subpasta "COMPRADOR" da pasta do cliente (onde a equipe guarda a documentação de conferência); se essa subpasta não existir, procura na pasta do cliente inteira. Ignora qualquer coisa dentro de uma subpasta chamada "DESNECESSARIOS". Retorna uma lista de divergências encontradas (campo, o que está no cadastro, o que está no documento, e em qual arquivo), ou confirma que não achou nenhuma. Pode não conseguir ler todos os documentos se a pasta tiver muitos arquivos grandes (ela avisa quais ficaram de fora). SEMPRE mostre as divergências encontradas ao colaborador um a um — NUNCA corrija o cadastro sozinho; só use update_lead depois que ele confirmar qual valor está certo.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead (via find_lead)' },
      nomePasta: { type: 'string', description: 'Nome da pasta do cliente no Drive, se diferente do nome do lead (opcional).' },
    }, required: ['leadId'] },
  },
  {
    name: 'conferir_documento_com_pasta_drive',
    description: 'Confere um FORMULÁRIO/DOCUMENTO específico (ex.: ficha cadastral, formulário de proposta) contra os OUTROS documentos do cliente na pasta dele no Drive (CNH, comprovante de renda, de residência etc) — diferente de conferir_cadastro_com_documentos (que compara com o cadastro já salvo no CRM). O formulário de referência pode vir de DUAS formas: (1) o colaborador anexa o arquivo NESTA CONVERSA (botão de anexo do chat) — nesse caso não precisa informar nomeArquivoReferencia, ela usa o anexo sozinha; (2) o formulário já está DENTRO da pasta do cliente no Drive (ex.: "ficha-cadastral" ou "formulário", às vezes numa subpasta "FORMULARIOS") — informe nomeArquivoReferencia com um trecho do nome, sem precisar anexar nada de novo. Primeiro use find_lead para achar o leadId; se for usar nomeArquivoReferencia e não souber o nome exato, pode listar a pasta antes (listar_pasta_drive). Se achar mais de um arquivo parecido com nomeArquivoReferencia, ela retorna as opções — não escolha sozinho, pergunte ao colaborador. Se o colaborador pedir a conferência sem ter anexado nada E sem indicar nomeArquivoReferencia, pergunte qual das duas formas ele quer usar. REGRA FIXA: os OUTROS documentos (o material de referência pra comparar) vêm da subpasta "COMPRADOR" da pasta do cliente, quando existir (senão, da pasta do cliente inteira) — ignora qualquer coisa dentro de uma subpasta "DESNECESSARIOS". Retorna as divergências encontradas entre o formulário e os demais documentos (ou confirma que está tudo batendo). SEMPRE mostre as divergências ao colaborador — nunca corrija nada sozinho.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead/cliente cuja pasta no Drive será usada como referência (via find_lead)' },
      nomePasta: { type: 'string', description: 'Nome da pasta do cliente no Drive, se diferente do nome do lead (opcional).' },
      nomeArquivoReferencia: { type: 'string', description: 'Trecho do nome do formulário/ficha JÁ SALVO na pasta do cliente no Drive, para usar como referência em vez de um anexo do chat (opcional — use isto OU deixe o colaborador anexar o arquivo na conversa).' },
    }, required: ['leadId'] },
  },
  {
    name: 'enviar_arquivo_whatsapp',
    description: 'Envia um arquivo (PDF, foto, etc) pelo WhatsApp para o cliente do lead — via QR Code. Use quando o colaborador pedir para "mandar esse PDF para o cliente", "encaminhar esse arquivo pelo WhatsApp" ou "reenviar o documento que ele mandou". Informe leadId e a origem do arquivo: attachmentId (reenvia um anexo que o cliente já mandou nesta conversa) OU nomeArquivo (busca um arquivo pelo nome dentro da pasta do cliente no Drive — inclusive dentro de SUBPASTAS, ex.: um arquivo "ITBI PLINIO.pdf" guardado dentro de uma subpasta "ITBI"; use nomePasta se a pasta do cliente tiver nome diferente do lead). Se a busca por nomeArquivo encontrar mais de um arquivo parecido, ela retorna a lista de opções (com a subpasta de cada um) — NUNCA escolha sozinho, pergunte ao colaborador qual enviar antes de chamar de novo com o nome mais específico ou o attachmentId certo. CONFIRMAÇÃO OBRIGATÓRIA: na primeira chamada (sem confirmed:true), ela só RESOLVE o arquivo e retorna needsConfirmation — informe ao colaborador exatamente qual arquivo (e para qual cliente) e pergunte se ele quer incluir uma mensagem/legenda junto; só chame de novo com confirmed:true (e legenda, se pedida) depois que ele confirmar.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead (via find_lead)' },
      attachmentId: { type: 'string', description: 'ID de um anexo já recebido do cliente na conversa do WhatsApp, para reenviá-lo (opcional).' },
      nomeArquivo: { type: 'string', description: 'Trecho do nome do arquivo a enviar, buscado na pasta do cliente no Drive (opcional se attachmentId for dado).' },
      nomePasta: { type: 'string', description: 'Nome da pasta do cliente no Drive, se diferente do nome do lead (opcional, usado só com nomeArquivo).' },
      legenda: { type: 'string', description: 'Texto/legenda opcional que acompanha o arquivo — pergunte ao colaborador antes de enviar se ele quer incluir uma.' },
      confirmed: { type: 'boolean', description: 'Só true depois que o colaborador já foi informado do arquivo/cliente e confirmou o envio (e disse se quer legenda).' },
    }, required: ['leadId'] },
  },
  {
    name: 'listar_pasta_drive',
    description: 'Lista os arquivos e sub-pastas dentro de uma pasta do Drive. Use para "ver o que tem na pasta do cliente", "mostrar os documentos que já foram salvos", "o que tem dentro de LEADS ATIVOS" etc. Informe leadId (via find_lead) para listar a pasta do cliente (por padrão usa o nome do lead; use nomePasta se o colaborador indicar outro nome), OU nomePasta sozinho para listar qualquer pasta pelo nome (ex: "LEADS ATIVOS"), OU pastaId se já souber o ID exato (obtido de uma listagem/criação anterior).',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead — lista a pasta desse cliente (opcional se nomePasta ou pastaId forem dados).' },
      nomePasta: { type: 'string', description: 'Nome de uma pasta a procurar e listar (opcional).' },
      pastaId: { type: 'string', description: 'ID de uma pasta do Drive já conhecido (opcional).' },
    } },
  },
  {
    name: 'criar_pasta_drive',
    description: 'Cria uma pasta nova no Drive, em qualquer lugar (não só a pasta de um cliente). Use quando o colaborador pedir para "criar uma pasta chamada X", opcionalmente "dentro de Y". Se dentroDe não for informado, cria direto na pasta-raiz.',
    input_schema: { type: 'object', properties: {
      nome: { type: 'string', description: 'Nome da nova pasta.' },
      dentroDe: { type: 'string', description: 'Nome da pasta onde criar esta (opcional — sem isso, cria na pasta-raiz).' },
    }, required: ['nome'] },
  },
  {
    name: 'renomear_item_drive',
    description: 'Renomeia um arquivo ou pasta do Drive. Use quando o colaborador pedir para "renomear a pasta do cliente para o nome completo em caixa alta", "mudar o nome desse arquivo" etc. Informe itemId (obtido via listar_pasta_drive ou de uma criação/organização anterior) OU leadId (sem itemId, renomeia diretamente a pasta atual desse cliente no Drive — encontrada pelo nome do lead, ou por nomePastaAtual se o colaborador indicar). Se o colaborador pedir "em caixa alta com o nome completo do cliente" e não especificar novoNome, use o nome do lead em MAIÚSCULAS.',
    input_schema: { type: 'object', properties: {
      itemId: { type: 'string', description: 'ID do arquivo/pasta do Drive a renomear (opcional se leadId for dado).' },
      leadId: { type: 'string', description: 'ID do lead — renomeia a pasta atual desse cliente no Drive (opcional se itemId for dado).' },
      nomePastaAtual: { type: 'string', description: 'Nome atual da pasta do cliente, se diferente do nome do lead (opcional, usado só com leadId).' },
      novoNome: { type: 'string', description: 'Novo nome do arquivo/pasta.' },
    }, required: ['novoNome'] },
  },
  {
    name: 'mover_item_drive',
    description: 'Move um arquivo ou pasta do Drive para dentro de outra pasta. Use quando o colaborador pedir para "mover essa pasta para dentro de LEADS ATIVOS", "colocar esse documento em outra pasta" etc. Informe itemId (via listar_pasta_drive) e o destino: novaPastaNome (nome de uma pasta existente) ou novaPastaId (se já souber o ID).',
    input_schema: { type: 'object', properties: {
      itemId: { type: 'string', description: 'ID do arquivo/pasta a mover.' },
      novaPastaNome: { type: 'string', description: 'Nome da pasta de destino (opcional se novaPastaId for dado).' },
      novaPastaId: { type: 'string', description: 'ID da pasta de destino, se já conhecido (opcional).' },
    }, required: ['itemId'] },
  },
  {
    name: 'excluir_item_drive',
    description: 'EXCLUI (move para a lixeira) um arquivo ou pasta do Drive — IRREVERSÍVEL para efeitos do CRM. Exige permissão de gerenciar o funil. Antes de executar, pergunte ao colaborador DUAS vezes se confirma; só passe confirmed:true após a SEGUNDA confirmação. Use itemId (via listar_pasta_drive).',
    input_schema: { type: 'object', properties: {
      itemId: { type: 'string' },
      confirmed: { type: 'boolean', description: 'Só true após confirmar DUAS vezes com o colaborador.' },
    }, required: ['itemId'] },
  },
  {
    name: 'auditar_pastas_contratacao',
    description: 'Compara os leads do funil "Em contratação" com as pastas deles no Drive e retorna quais estão fora de lugar (deveriam estar em "1. LEADS ATIVOS"). Para cada lead do funil, informa: ok (pasta já está no lugar certo), fora_do_lugar (achou a pasta, mas em outro lugar — retorna localAtual e itemId para mover) ou nao_encontrada (não achou nenhuma pasta com o nome do lead). Não move nada sozinha — só relata. Use o resultado para ir revisando as divergências UMA DE CADA VEZ com o colaborador, conforme a REGRA FIXA no início deste prompt.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'preencher_link_drive_em_lote',
    description: 'Preenche o campo "Pasta no Drive" (link) no cadastro de VÁRIOS leads de uma vez, para os leads de um funil inteiro — use quando o colaborador pedir algo como "preenche o campo do drive de todos os clientes do funil contratação", "coloca o link da pasta de cada lead desse funil" etc. Informe funilNome (ex.: "contratação" — não precisa ser o nome exato, casa por trecho). Ela busca, numa única varredura, a pasta de cada lead do funil no Drive: se achar exatamente uma, preenche o link sozinha (SEM precisar de confirmação — é só preencher um campo, não uma ação destrutiva); leads que já tinham o campo preenchido são pulados (não sobrescreve); leads sem pasta encontrada ou com mais de uma pasta parecida (ambíguo) ficam de fora, listados no resultado, para o colaborador resolver manualmente. Tem um teto de leads por chamada — se o funil for maior, ela avisa quantos ficaram de fora (truncado) e pode ser chamada de novo.',
    input_schema: { type: 'object', properties: {
      funilNome: { type: 'string', description: 'Nome (ou trecho do nome) do funil, ex.: "contratação".' },
    }, required: ['funilNome'] },
  },
  {
    name: 'create_lead',
    description: 'Cria um novo card/lead no funil. Use quando pedirem para "criar um card/cliente". Exige permissão de gerenciar o funil.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'Nome do cliente/card' },
      phone: { type: 'string', description: 'Telefone (opcional)' },
      value: { type: 'number', description: 'Valor do negócio (opcional)' },
      stageId: { type: 'string', description: 'Estágio de destino (via list_pipelines). Sem ele, cai na Caixa de Entrada.' },
      pipelineId: { type: 'string', description: 'Funil de destino (opcional).' },
    }, required: ['name'] },
  },
  {
    name: 'update_lead',
    description: 'Edita um card existente: nome, valor e/ou campos do cadastro (customFields por chave). Use find_lead antes. Exige permissão de gerenciar o funil.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead (via find_lead)' },
      name: { type: 'string' },
      value: { type: 'number' },
      fields: { type: 'object', description: 'Campos do cadastro por chave (ex: { "cpf_1": "000...", "corretorindicacao": "Fulano" })' },
    }, required: ['leadId'] },
  },
  {
    name: 'adicionar_nota_lead',
    description: 'Adiciona um comentário/nota no histórico de um ou mais cards — aparece na aba de atividades do lead, junto com o resto do timeline. Use quando o colaborador pedir para "anotar", "registrar", "jogar essa informação no card" etc, algo em formato de texto livre (status, observação, andamento) que não é um campo estruturado do cadastro (para isso, use update_lead). Aceita VÁRIOS de uma vez — uma nota por lead, numa única chamada, sem precisar chamar a ferramenta separadamente para cada cliente.',
    input_schema: { type: 'object', properties: {
      notas: {
        type: 'array',
        description: 'Uma nota por lead (use find_lead antes para achar cada leadId).',
        items: { type: 'object', properties: {
          leadId: { type: 'string', description: 'ID do lead (via find_lead)' },
          content: { type: 'string', description: 'Texto da nota/comentário.' },
        }, required: ['leadId', 'content'] },
      },
    }, required: ['notas'] },
  },
  {
    name: 'criar_tarefa_lead',
    description: 'Cria uma tarefa vinculada a um card/lead — aparece na aba Tarefas e no Dashboard do responsável. Use quando o colaborador pedir para "criar uma tarefa", "lembrar de ligar/enviar/cobrar", "agendar um follow-up" etc para um cliente específico. Use find_lead antes para achar o leadId.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string', description: 'ID do lead (via find_lead)' },
      title: { type: 'string', description: 'Título/descrição da tarefa (ex.: "Ligar para confirmar documentação").' },
      dueAt: { type: 'string', description: 'Data/hora de vencimento (AAAA-MM-DD ou AAAA-MM-DDTHH:mm). Se o colaborador não der hora, use um horário razoável (09:00). Se não der data, use hoje.' },
      responsavelNome: { type: 'string', description: 'Nome do colaborador responsável pela tarefa, se for diferente de quem está pedindo (opcional — padrão é quem está na conversa agora).' },
    }, required: ['leadId', 'title'] },
  },
  {
    name: 'archive_lead',
    description: 'Arquiva (ou restaura) um card. archived=true arquiva, false restaura. Exige permissão de gerenciar o funil.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' },
      archived: { type: 'boolean', description: 'true = arquivar (padrão), false = restaurar' },
    }, required: ['leadId'] },
  },
  {
    name: 'delete_lead',
    description: 'EXCLUI um card permanentemente (IRREVERSÍVEL). Antes, confirme com o colaborador DUAS vezes; só passe confirmed:true após as duas confirmações. Exige permissão de gerenciar o funil.',
    input_schema: { type: 'object', properties: {
      leadId: { type: 'string' },
      confirmed: { type: 'boolean', description: 'Só true após confirmar DUAS vezes com o colaborador.' },
    }, required: ['leadId'] },
  },
  {
    name: 'list_users',
    description: 'Lista os usuários da equipe (id, nome, e-mail, função). Exige permissão de usuários.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_user',
    description: 'Cria um usuário da equipe. Exige permissão de usuários. Defina uma senha inicial (mín. 6). role: ADMIN, MANAGER ou AGENT.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' },
      role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'AGENT'] },
    }, required: ['name', 'email', 'password'] },
  },
  {
    name: 'update_user',
    description: 'Edita um usuário: nome, e-mail, senha, função (role) e/ou permissões. "Tirar acesso" = mudar role/permissions. Exige permissão de usuários.',
    input_schema: { type: 'object', properties: {
      userId: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' },
      password: { type: 'string' }, role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'AGENT'] },
      permissions: { type: 'object', description: 'Mapa permissão→boolean (ex: { "finance": false })' },
    }, required: ['userId'] },
  },
  {
    name: 'delete_user',
    description: 'EXCLUI um usuário e tira o acesso (IRREVERSÍVEL; leads/tarefas passam para quem excluiu). Confirme DUAS vezes antes; só passe confirmed:true depois. Exige permissão de usuários.',
    input_schema: { type: 'object', properties: {
      userId: { type: 'string' },
      confirmed: { type: 'boolean', description: 'Só true após confirmar DUAS vezes.' },
    }, required: ['userId'] },
  },
];

const DRIVE_DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
// Nome contém termos comuns de documento — usado só pra priorizar QUAIS
// documentos baixar primeiro dentro do orçamento abaixo, nunca pra filtrar
// (documento sem nome "óbvio" ainda entra, só fica por último). Documento de
// IDENTIDADE (CNH/RG) vem numa camada própria, ACIMA dos demais — é sempre a
// referência mais confiável pra bater nome/CPF/nascimento, e sem essa
// prioridade um cliente com vários contracheques/comprovantes na pasta podia
// empurrar a própria CNH pra fora do orçamento (achado num caso real: a foto
// da CNH, maior que os PDFs de holerite, ficava de fora e a conferência
// passava batido justo o documento que tinha o erro).
const DRIVE_DOC_NAME_HEUR_IDENTIDADE = /cnh|\brg\b|identidade|habilita/i;
const DRIVE_DOC_NAME_HEUR_OUTROS = /holerite|contracheque|comprovante|renda|resid[êe]ncia|endere[çc]o|certid[ãa]o|contrato|cpf|itbi|matr[íi]cula|iptu/i;

/**
 * Acha a pasta do cliente no Drive e baixa até um orçamento de arquivos
 * (foto/PDF, inclusive em subpastas) pra conferência com documentação —
 * compartilhado entre conferir_cadastro_com_documentos e
 * conferir_documento_com_pasta_drive, que só diferem em CONTRA O QUE
 * comparam esses documentos (o cadastro no CRM vs. um formulário específico).
 */
async function resolveClientDriveDocuments(
  accountId: string,
  leadName: string,
  nomePastaInput?: string,
  excludeFileId?: string
): Promise<
  | { ok: true; docs: { name: string; mimeType: string; buffer: Buffer }[]; deixadosDeFora: string[] }
  | { ok: false; error: string }
> {
  const nomePasta = String(nomePastaInput || leadName || '').trim();
  const folder = nomePasta ? await findFolderByNameUnderRoot(accountId, nomePasta) : null;
  if (!folder) return { ok: false, error: `Não encontrei a pasta "${nomePasta}" no Drive. Confirme o nome da pasta do cliente com o colaborador.` };

  // REGRA FIXA: a documentação de conferência do cliente fica dentro da
  // subpasta "COMPRADOR" (quando existir) — não na pasta do cliente toda,
  // que também tem coisa como FORMULARIOS (o próprio formulário a conferir,
  // não material de referência). Se não existir essa subpasta, cai pra pasta
  // do cliente inteira (compatibilidade com clientes organizados diferente).
  const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  let scanRootId = folder.folderId;
  try {
    const subfolders = await listFolders(accountId, folder.folderId);
    const compradorFolder = subfolders.find((f) => normalize(f.name) === 'comprador');
    if (compradorFolder) scanRootId = compradorFolder.id;
  } catch { /* segue com a pasta do cliente inteira */ }

  let allFiles: { id: string; name: string; mimeType: string; path: string; size: number }[] = [];
  try {
    allFiles = (await listAllFilesInFolderTree(accountId, scanRootId))
      // "DESNECESSARIOS" é usado pela equipe pra guardar documento
      // duplicado/velho que não deve entrar na conferência.
      .filter((f) => DRIVE_DOC_TYPES.includes(f.mimeType) && f.id !== excludeFileId && !normalize(f.path).includes('desnecess'));
  } catch (err: any) {
    return { ok: false, error: `Falha ao listar a pasta do Drive: ${err?.message || 'erro desconhecido'}` };
  }
  if (allFiles.length === 0) return { ok: false, error: `Não achei nenhum documento (foto/PDF) na pasta "${nomePasta}"${scanRootId !== folder.folderId ? ' (subpasta COMPRADOR)' : ''}.` };

  // Prioriza: 1º documento de identidade (CNH/RG), 2º outros "óbvios"
  // (comprovante/contracheque/certidão etc), 3º o resto — e dentro de cada
  // camada, os menores primeiro (cabe mais no orçamento de tamanho).
  const tier = (name: string) => (DRIVE_DOC_NAME_HEUR_IDENTIDADE.test(name) ? 0 : DRIVE_DOC_NAME_HEUR_OUTROS.test(name) ? 1 : 2);
  allFiles.sort((a, b) => {
    const at = tier(a.name);
    const bt = tier(b.name);
    if (at !== bt) return at - bt;
    return a.size - b.size;
  });

  const MAX_DOCS = 8;
  const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  const chosen: typeof allFiles = [];
  const deixadosDeFora: string[] = [];
  let total = 0;
  for (const f of allFiles) {
    if (chosen.length >= MAX_DOCS || total + f.size > MAX_TOTAL_BYTES) { deixadosDeFora.push(f.name); continue; }
    chosen.push(f);
    total += f.size;
  }
  if (chosen.length === 0) return { ok: false, error: 'Os documentos dessa pasta são grandes demais para analisar de uma vez — peça ao colaborador para apontar um arquivo específico.' };

  const docs: { name: string; mimeType: string; buffer: Buffer }[] = [];
  for (const f of chosen) {
    try {
      const buffer = await downloadDriveFile(accountId, f.id, f.mimeType);
      docs.push({ name: f.name, mimeType: f.mimeType, buffer });
    } catch {
      deixadosDeFora.push(f.name);
    }
  }
  if (docs.length === 0) return { ok: false, error: 'Não consegui baixar nenhum documento dessa pasta.' };

  return { ok: true, docs, deixadosDeFora };
}

async function executeAgentTool(
  name: string,
  input: Record<string, any>,
  accountId: string,
  io: any,
  userId?: string,
  attachment?: { mimeType?: string; dataBase64?: string } | null
): Promise<unknown> {
  // Permissões efetivas do colaborador que está usando o assistente. Toda ação
  // sensível checa isto; ações irreversíveis exigem confirmação dupla (o modelo
  // pergunta duas vezes e só então passa confirmed:true — ver system prompt).
  const me = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true, permissions: true, departmentId: true } }) : null;
  const perms = effectivePermissions(me?.role || 'AGENT', me?.permissions ?? null);
  const deny = (key: PermissionKey, acao: string) =>
    ({ success: false as const, error: `Você não tem permissão para ${acao}. (Falta o acesso "${key}".)` });
  // Mesma regra de setor do resto do CRM: admin vê tudo; colaborador só o
  // próprio setor (sem setor definido ainda = sem filtro, por compatibilidade).
  const scopeDepartmentId = me?.role === 'ADMIN' ? null : (me?.departmentId ?? null);
  const pipelineDeptScope = scopeDepartmentId ? { OR: [{ departmentId: scopeDepartmentId }, { departmentId: null }] } : {};

  // Rede de segurança: se QUALQUER ferramenta abaixo lançar uma exceção não
  // tratada (ex.: API do Drive fora do ar, erro de rede), isso derrubava a
  // resposta inteira do assistente com "Erro interno ao processar IA" — pior
  // ainda num pedido em lote (várias ferramentas de uma vez), onde UM lead
  // com problema travava todos os outros. Agora vira um resultado de erro
  // normal, que o modelo consegue ler e contornar (avisar o colaborador,
  // pular esse item e seguir com os demais).
  try {
  if (name === 'listar_campos_cadastro') {
    const fields = await prisma.fieldDefinition.findMany({ where: { accountId }, orderBy: [{ tab: 'asc' }, { order: 'asc' }] });
    return fields.map((f) => ({ chave: f.key, nome: f.name, aba: f.tab, tipo: f.type }));
  }

  if (name === 'perguntar_colaborador') {
    const destNome = String(input.destinatarioNome || '').trim();
    if (!destNome) return { success: false, error: 'Informe destinatarioNome.' };
    const perguntas = Array.isArray(input.perguntas) ? input.perguntas : [];
    if (perguntas.length === 0) return { success: false, error: 'Informe ao menos uma pergunta em perguntas.' };

    const candidatos = await prisma.user.findMany({ where: { accountId, name: { contains: destNome, mode: 'insensitive' } } });
    if (candidatos.length === 0) return { success: false, error: `Nenhum colaborador encontrado com o nome "${destNome}".` };
    if (candidatos.length > 1) {
      return { success: false, error: `Mais de um colaborador bate com "${destNome}": ${candidatos.map((u) => u.name).join(', ')}. Pergunte ao colaborador qual é o certo.` };
    }
    const destinatario = candidatos[0];
    if (destinatario.id === userId) return { success: false, error: 'Você não pode perguntar para si mesmo — informe outro colaborador.' };

    const criadas: { id: string; leadId: string; campo: string }[] = [];
    const erros: string[] = [];
    for (const p of perguntas as { leadId?: string; campo?: string; pergunta?: string }[]) {
      const leadId = String(p.leadId || '').trim();
      const campo = String(p.campo || '').trim();
      const perguntaTexto = String(p.pergunta || '').trim();
      if (!leadId || !campo || !perguntaTexto) { erros.push('Item inválido (faltou leadId, campo ou pergunta).'); continue; }
      const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
      if (!lead) { erros.push(`Lead ${leadId} não encontrado.`); continue; }
      const created = await prisma.assistantQuestion.create({
        data: { accountId, askedByUserId: userId!, targetUserId: destinatario.id, leadId, campo, pergunta: perguntaTexto },
      });
      criadas.push({ id: created.id, leadId, campo });
    }

    // Toca um som só pra ela (sala pessoal, não a conta inteira) — avisa que
    // tem pergunta pendente esperando na próxima vez que abrir o chat dela.
    if (criadas.length > 0 && io) {
      io.to(`user_${destinatario.id}`).emit('assistant_question', { count: criadas.length });
    }

    return {
      success: true,
      destinatario: destinatario.name,
      criadas: criadas.length,
      erros: erros.length ? erros : undefined,
    };
  }

  if (name === 'ver_minhas_perguntas_pendentes') {
    if (!userId) return { success: false, error: 'Sem usuário identificado.' };
    const pendentes = await prisma.assistantQuestion.findMany({
      where: { targetUserId: userId, accountId, answered: false },
      include: { lead: { select: { name: true } }, askedBy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return pendentes.map((p) => ({
      id: p.id, cliente: p.lead.name, campo: p.campo, pergunta: p.pergunta,
      perguntadoPor: p.askedBy.name, criadoEm: p.createdAt,
    }));
  }

  if (name === 'responder_pergunta_pendente') {
    if (!userId) return { success: false, error: 'Sem usuário identificado.' };
    const perguntaId = String(input.perguntaId || '').trim();
    const resposta = String(input.resposta || '').trim();
    if (!perguntaId || !resposta) return { success: false, error: 'Informe perguntaId e resposta.' };

    const pergunta = await prisma.assistantQuestion.findFirst({ where: { id: perguntaId, targetUserId: userId, accountId } });
    if (!pergunta) return { success: false, error: 'Pergunta não encontrada (ou não é sua).' };
    if (pergunta.answered) return { success: false, error: 'Essa pergunta já tinha sido respondida.' };

    const lead = await prisma.lead.findFirst({ where: { id: pergunta.leadId, accountId } });
    if (!lead) return { success: false, error: 'O lead dessa pergunta não existe mais.' };

    const data: Record<string, unknown> = {};
    if (pergunta.campo === 'nome') {
      data.name = resposta;
    } else if (pergunta.campo === 'valor') {
      const cleaned = resposta.replace(/[^\d,.-]/g, '');
      const num = cleaned.includes(',') && cleaned.includes('.')
        ? parseFloat(cleaned.replace(/\./g, '').replace(',', '.'))
        : cleaned.includes(',') ? parseFloat(cleaned.replace(',', '.')) : parseFloat(cleaned);
      if (Number.isNaN(num)) return { success: false, error: `Não consegui entender "${resposta}" como um valor numérico.` };
      data.value = num;
    } else {
      const cf = (lead.customFields && typeof lead.customFields === 'object' ? lead.customFields : {}) as Record<string, unknown>;
      data.customFields = { ...cf, [pergunta.campo]: resposta };
    }

    const [updatedLead] = await prisma.$transaction([
      prisma.lead.update({ where: { id: lead.id }, data }),
      prisma.assistantQuestion.update({ where: { id: pergunta.id }, data: { resposta, answered: true, answeredAt: new Date() } }),
    ]);

    if (io) io.to(`account_${accountId}`).emit('lead_moved', { lead: updatedLead });

    return { success: true, cliente: lead.name, campo: pergunta.campo, valorSalvo: resposta };
  }

  if (name === 'listar_templates_whatsapp') {
    if (!perms.templates) return deny('templates', 'ver os templates de WhatsApp');
    try {
      const templates = await listMetaTemplates(accountId, scopeDepartmentId);
      return { success: true, templates: templates.map((t: any) => ({ nome: t.name, categoria: t.category, idioma: t.language, status: t.status, motivoRejeicao: t.rejected_reason || null })) };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao buscar templates' };
    }
  }

  if (name === 'criar_template_whatsapp') {
    if (!perms.templates) return deny('templates', 'criar templates de WhatsApp');
    const nome = String(input.name || '').trim();
    const category = String(input.category || '') as TemplateCategory;
    if (!nome || !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
      return { success: false, error: 'Informe name e category (MARKETING, UTILITY ou AUTHENTICATION).' };
    }
    if (category !== 'AUTHENTICATION' && !String(input.body || '').trim()) {
      return { success: false, error: 'body é obrigatório para as categorias MARKETING e UTILITY.' };
    }

    if (input.confirmed !== true) {
      const resumo = category === 'AUTHENTICATION'
        ? `código de verificação (a Meta gera o texto sozinha), expira em ${input.codeExpirationMinutes || 10} min`
        : `"${String(input.body || '').trim()}"${input.footer ? ` — rodapé: "${String(input.footer).trim()}"` : ''}`;
      return {
        success: false,
        needsConfirmation: true,
        template: { nome, categoria: category, idioma: input.language || 'pt_BR', resumo },
        error: `Antes de enviar, leia para o colaborador: template "${nome}" (categoria ${category}, idioma ${input.language || 'pt_BR'}) com o conteúdo: ${resumo}. Confirme que está correto e que ele quer enviar para aprovação da Meta — isso não é algo pra desfazer com facilidade. Só chame de novo com confirmed:true depois que ele confirmar.`,
      };
    }

    try {
      const result = await createMetaTemplate(accountId, {
        name: nome,
        category,
        language: input.language ? String(input.language) : undefined,
        body: input.body ? String(input.body) : undefined,
        footer: input.footer ? String(input.footer) : undefined,
        codeExpirationMinutes: typeof input.codeExpirationMinutes === 'number' ? input.codeExpirationMinutes : undefined,
      }, scopeDepartmentId);
      return { success: true, enviadoParaAprovacao: true, resultado: result };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao enviar template para aprovação' };
    }
  }

  if (name === 'listar_respostas_rapidas') {
    const templates = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        ...(scopeDepartmentId ? { OR: [{ departmentId: scopeDepartmentId }, { departmentId: null }] } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return templates.map((t) => ({ id: t.id, nome: t.name, categoria: t.category, corpo: t.body, variaveis: t.variables }));
  }

  if (name === 'criar_resposta_rapida') {
    if (!perms.templates) return deny('templates', 'criar respostas rápidas');
    const nome = String(input.name || '').trim();
    const body = String(input.body || '').trim();
    if (!nome || !body) return { success: false, error: 'Informe name e body.' };
    const variaveis = [...new Set((body.match(/\{\{([^}]+)\}\}/g) || []).map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];
    const template = await prisma.messageTemplate.create({
      data: { accountId, name: nome, category: input.category ? String(input.category) : 'geral', body, variables: variaveis, departmentId: scopeDepartmentId },
    });
    return { success: true, id: template.id, nome: template.name };
  }

  if (name === 'enviar_resposta_rapida') {
    if (!perms.inbox_reply) return deny('inbox_reply', 'enviar mensagens');
    const leadId = String(input.leadId || '').trim();
    const templateName = String(input.templateName || '').trim();
    if (!leadId || !templateName) return { success: false, error: 'Informe leadId e templateName.' };

    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { pipeline: { select: { departmentId: true } } } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    if (scopeDepartmentId && lead.pipeline.departmentId && lead.pipeline.departmentId !== scopeDepartmentId) {
      return { success: false, error: 'Esse lead é de outro departamento.' };
    }

    const candidatos = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        name: { contains: templateName, mode: 'insensitive' },
        ...(scopeDepartmentId ? { OR: [{ departmentId: scopeDepartmentId }, { departmentId: null }] } : {}),
      },
    });
    if (candidatos.length === 0) return { success: false, error: `Nenhuma resposta rápida encontrada com "${templateName}". Use listar_respostas_rapidas para ver as que existem.` };
    if (candidatos.length > 1) return { success: false, error: `Mais de uma resposta rápida bate com "${templateName}": ${candidatos.map((t) => t.name).join(', ')}. Pergunte ao colaborador qual é a certa.` };
    const template = candidatos[0];

    const variaveis: Record<string, string> = { nome: lead.name, ...(input.variaveis && typeof input.variaveis === 'object' ? input.variaveis : {}) };
    const textoFinal = template.body.replace(/\{\{([^}]+)\}\}/g, (_m, key) => {
      const v = variaveis[String(key).trim()];
      return v !== undefined ? String(v) : `{{${key}}}`;
    });
    const faltando = [...new Set((textoFinal.match(/\{\{([^}]+)\}\}/g) || []).map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];

    if (input.confirmed !== true) {
      return {
        success: false,
        needsConfirmation: true,
        cliente: lead.name,
        template: template.name,
        textoFinal,
        variaveisFaltando: faltando.length ? faltando : undefined,
        error: faltando.length
          ? `Faltam valores para: ${faltando.join(', ')}. Pergunte ao colaborador antes de enviar e chame de novo com "variaveis" preenchidas.`
          : `Antes de enviar, leia para o colaborador o texto final: "${textoFinal}" — vai para ${lead.name}. Confirme e só então chame de novo com confirmed:true.`,
      };
    }
    if (faltando.length) return { success: false, error: `Ainda faltam valores para: ${faltando.join(', ')}. Não pode enviar assim.` };

    const result = await sendOutboundWhatsApp({ accountId, leadId, content: textoFinal, userId, io });
    return result;
  }

  if (name === 'enviar_template_whatsapp_lead') {
    if (!perms.inbox_reply) return deny('inbox_reply', 'enviar mensagens');
    const leadId = String(input.leadId || '').trim();
    const templateName = String(input.templateName || '').trim();
    if (!leadId || !templateName) return { success: false, error: 'Informe leadId e templateName.' };

    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { pipeline: { select: { departmentId: true } } } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    if (scopeDepartmentId && lead.pipeline.departmentId && lead.pipeline.departmentId !== scopeDepartmentId) {
      return { success: false, error: 'Esse lead é de outro departamento.' };
    }

    const bodyParams = Array.isArray(input.bodyParams) ? input.bodyParams.map((p: unknown) => String(p)) : [];
    const previewText = input.previewText ? String(input.previewText) : `[Template: ${templateName}]`;

    if (input.confirmed !== true) {
      return {
        success: false,
        needsConfirmation: true,
        cliente: lead.name,
        template: templateName,
        variaveis: bodyParams,
        error: `Antes de enviar, confirme com o colaborador: template "${templateName}" para ${lead.name}${bodyParams.length ? `, com as variáveis: ${bodyParams.join(', ')}` : ''}. Só chame de novo com confirmed:true depois que ele confirmar.`,
      };
    }

    const result = await sendOutboundWhatsAppTemplate({
      accountId, leadId, templateName,
      language: input.language ? String(input.language) : 'pt_BR',
      bodyParams, previewText, userId, io,
    });
    return result;
  }

  if (name === 'aprender_com_conversas_whatsapp') {
    if (!perms.settings) return deny('settings', 'gerenciar a Base de Conhecimento');
    try {
      const result = await learnFromWhatsAppConversations(accountId);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao aprender com as conversas' };
    }
  }

  if (name === 'consultar_leads') {
    const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const where: Record<string, unknown> = { accountId, archived: input.arquivados === true };

    if (input.status && ['OPEN', 'WON', 'LOST'].includes(String(input.status))) where.status = input.status;
    if (typeof input.valorMin === 'number' || typeof input.valorMax === 'number') {
      const value: Record<string, number> = {};
      if (typeof input.valorMin === 'number') value.gte = input.valorMin;
      if (typeof input.valorMax === 'number') value.lte = input.valorMax;
      where.value = value;
    }
    if (input.criadoDe || input.criadoAte) {
      const createdAt: Record<string, Date> = {};
      if (input.criadoDe) createdAt.gte = new Date(String(input.criadoDe));
      if (input.criadoAte) createdAt.lte = new Date(`${input.criadoAte}T23:59:59`);
      where.createdAt = createdAt;
    }
    if (input.pipelineNome) {
      const pipelines = await prisma.pipeline.findMany({ where: { accountId } });
      const match = pipelines.filter((p) => normalize(p.name).includes(normalize(String(input.pipelineNome))));
      if (match.length === 0) return { success: false, error: `Nenhum funil encontrado com "${input.pipelineNome}".` };
      where.pipelineId = { in: match.map((p) => p.id) };
    }
    if (input.estagioNome) {
      const stages = await prisma.stage.findMany({ where: { pipeline: { accountId } } });
      const match = stages.filter((s) => normalize(s.name).includes(normalize(String(input.estagioNome))));
      if (match.length === 0) return { success: false, error: `Nenhum estágio encontrado com "${input.estagioNome}".` };
      where.stageId = { in: match.map((s) => s.id) };
    }
    if (input.donoNome) {
      const users = await prisma.user.findMany({ where: { accountId, name: { contains: String(input.donoNome), mode: 'insensitive' } } });
      if (users.length === 0) return { success: false, error: `Nenhum usuário encontrado com "${input.donoNome}".` };
      where.userId = { in: users.map((u) => u.id) };
    }

    const candidatos = await prisma.lead.findMany({
      where,
      include: {
        stage: { select: { name: true } },
        pipeline: { select: { name: true } },
        contact: { select: { phone: true, whatsappPhone: true } },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 3000, // teto de segurança — filtros abaixo (tags/campos) rodam em memória
    });

    let filtrados = candidatos;

    if (Array.isArray(input.tags) && input.tags.length > 0) {
      const wanted = (input.tags as unknown[]).map((t) => normalize(String(t)));
      filtrados = filtrados.filter((l) => (l.tags || []).some((t) => wanted.includes(normalize(t))));
    }

    if (Array.isArray(input.campos) && input.campos.length > 0) {
      filtrados = filtrados.filter((l) => {
        const cf = l.customFields && typeof l.customFields === 'object' ? (l.customFields as Record<string, unknown>) : {};
        return (input.campos as { chave?: string; valor?: string }[]).every((filtro) => {
          const chave = String(filtro?.chave || '').trim();
          if (!chave) return true;
          const atual = cf[chave];
          if (atual === undefined || atual === null || atual === '') return false;
          if (filtro.valor === undefined || filtro.valor === '') return true; // só exige que o campo tenha algum valor
          return normalize(String(atual)).includes(normalize(String(filtro.valor)));
        });
      });
    }

    const total = filtrados.length;
    const somaValor = filtrados.reduce((s, l) => s + (l.value || 0), 0);
    const limite = Math.min(Math.max(Number(input.limite) || 30, 1), 100);
    const amostra = filtrados.slice(0, limite).map((l) => ({
      id: l.id,
      nome: l.name,
      valor: l.value,
      status: l.status,
      funil: l.pipeline.name,
      estagio: l.stage.name,
      dono: l.user.name,
      telefone: l.contact?.whatsappPhone || l.contact?.phone || null,
      tags: l.tags,
    }));

    return { success: true, total, somaValor, mostrando: amostra.length, leads: amostra };
  }

  // Telefone pra MOSTRAR ao modelo/colaborador: nunca um @lid cru (identificador
  // interno do WhatsApp, não telefone) — se whatsappPhone for isso, mostra o
  // contact.phone de verdade, senão fica claro que não tem telefone cadastrado.
  const displayPhone = (contact?: { phone?: string | null; whatsappPhone?: string | null } | null): string | null => {
    const wp = contact?.whatsappPhone;
    if (wp && !wp.includes('@')) return wp;
    return contact?.phone || null;
  };

  if (name === 'find_lead') {
    const nameQuery = String(input.name || '').trim();
    const phoneQuery = String(input.phone || '').trim();

    // Busca por telefone: ignora formatação, DDI 55 e o 9º dígito do celular.
    // Compara pelo "núcleo" (últimos 8 dígitos), cobrindo o contato e os campos
    // personalizados do cadastro (customFields), que guardam o telefone digitado.
    if (phoneQuery) {
      const digits = phoneQuery.replace(/\D/g, '');
      const core = digits.length > 8 ? digits.slice(-8) : digits;
      if (core.length < 4) return [];
      // Teto bem acima do tamanho real da conta (era 500 — a conta já tem 600+
      // leads ativos, e leads fora desse limite ficavam invisíveis pra busca
      // por telefone, mesmo existindo de verdade). Sem where extra porque o
      // telefone pode estar só num campo do cadastro (customFields), não em
      // contact.phone — não dá pra empurrar esse filtro pro SQL com segurança
      // (os valores têm formatação inconsistente: com/sem parênteses e hífen).
      const leads = await prisma.lead.findMany({
        where: { accountId, archived: false, pipeline: pipelineDeptScope },
        include: { contact: true },
        take: 5000,
      });
      const matches = leads.filter(l => {
        const cf = l.customFields && typeof l.customFields === 'object'
          ? Object.values(l.customFields as Record<string, unknown>) : [];
        const candidates = [l.contact?.phone, l.contact?.whatsappPhone, ...cf];
        return candidates.some(c => typeof c === 'string' && c.replace(/\D/g, '').includes(core));
      }).slice(0, 5);
      return matches.map(l => ({
        id: l.id,
        name: l.name,
        phone: displayPhone(l.contact),
      }));
    }

    const leads = await prisma.lead.findMany({
      where: { accountId, archived: false, name: { contains: nameQuery, mode: 'insensitive' }, pipeline: pipelineDeptScope },
      include: { contact: true },
      take: 5,
    });
    return leads.map(l => ({
      id: l.id,
      name: l.name,
      phone: l.contact?.whatsappPhone || l.contact?.phone || null,
    }));
  }

  if (name === 'get_recent_messages') {
    const messages = await prisma.message.findMany({
      where: { leadId: String(input.leadId), lead: { accountId, pipeline: pipelineDeptScope } },
      orderBy: { createdAt: 'desc' },
      take: typeof input.limit === 'number' ? input.limit : 10,
    });
    return messages.reverse().map(m => ({
      direction: m.direction,
      content: m.content,
      createdAt: m.createdAt,
    }));
  }

  if (name === 'list_whatsapp_numbers') {
    return await listConnectedWhatsAppNumbers(accountId);
  }

  if (name === 'list_pipelines') {
    const pipelines = await prisma.pipeline.findMany({
      where: { accountId, ...pipelineDeptScope },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    return pipelines.map(p => ({
      id: p.id,
      name: p.name,
      stages: p.stages.map(s => ({ id: s.id, name: s.name })),
    }));
  }

  if (name === 'move_lead_to_stage') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'mover cards no funil');
    const leadId = String(input.leadId || '');
    if (!leadId) return { success: false, error: 'leadId é obrigatório' };
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { pipeline: { select: { departmentId: true } } } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    if (scopeDepartmentId && lead.pipeline.departmentId && lead.pipeline.departmentId !== scopeDepartmentId) {
      return { success: false, error: 'Esse lead é de outro departamento.' };
    }
    const target = await resolveStageTarget(
      accountId,
      input.pipelineId ? String(input.pipelineId) : undefined,
      input.stageId ? String(input.stageId) : undefined,
    );
    if (!target) return { success: false, error: 'Funil/estágio de destino não encontrado. Use list_pipelines para obter o stageId.' };
    if (scopeDepartmentId) {
      const destPipelineCheck = await prisma.pipeline.findUnique({ where: { id: target.pipelineId }, select: { departmentId: true } });
      if (destPipelineCheck?.departmentId && destPipelineCheck.departmentId !== scopeDepartmentId) {
        return { success: false, error: 'Esse funil de destino é de outro departamento.' };
      }
    }
    const [destStage, destPipeline] = await Promise.all([
      prisma.stage.findUnique({ where: { id: target.stageId } }),
      prisma.pipeline.findUnique({ where: { id: target.pipelineId } }),
    ]);
    const movedLead = await prisma.lead.update({
      where: { id: leadId },
      data: {
        pipelineId: target.pipelineId,
        stageId: target.stageId,
        notes: {
          create: {
            content: `Movido para ${destPipeline?.name || 'funil'} · ${destStage?.name || 'estágio'} pelo Assistente AF CRM`,
            type: 'STAGE_CHANGE',
            userId,
          },
        },
      },
    });
    if (io) io.to(`account_${accountId}`).emit('lead_moved', { lead: movedLead });
    return { success: true, movedTo: { funil: destPipeline?.name, estagio: destStage?.name } };
  }

  // ── Cards (leads): criar, editar, arquivar, excluir ────────────────────────
  if (name === 'create_lead') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'criar cards');
    const nome = String(input.name || '').trim();
    if (!nome) return { success: false, error: 'Informe o nome do cliente/card' };
    let target = (input.stageId || input.pipelineId)
      ? await resolveStageTarget(accountId, input.pipelineId ? String(input.pipelineId) : undefined, input.stageId ? String(input.stageId) : undefined)
      : null;
    if (!target) {
      const pipeline = await prisma.pipeline.findFirst({
        where: { accountId }, include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
      });
      if (!pipeline?.stages.length) return { success: false, error: 'Nenhum funil configurado' };
      target = { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
    }
    const owner = await prisma.user.findFirst({ where: { accountId } });
    const custom: Record<string, unknown> = { participante_1: nome };
    if (input.phone) custom.telefone_1 = String(input.phone);
    const lead = await prisma.lead.create({
      data: {
        name: nome, accountId, pipelineId: target.pipelineId, stageId: target.stageId,
        userId: userId || owner!.id, status: 'OPEN',
        ...(typeof input.value === 'number' ? { value: input.value } : {}),
        customFields: custom as any,
      },
    });
    if (io) io.to(`account_${accountId}`).emit('lead_moved', { lead });
    return { success: true, leadId: lead.id, name: lead.name };
  }

  if (name === 'update_lead') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'editar cards');
    const lead = await prisma.lead.findFirst({ where: { id: String(input.leadId || ''), accountId }, include: { pipeline: { select: { departmentId: true } } } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    if (scopeDepartmentId && lead.pipeline.departmentId && lead.pipeline.departmentId !== scopeDepartmentId) {
      return { success: false, error: 'Esse lead é de outro departamento.' };
    }
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = String(input.name).trim();
    if (typeof input.value === 'number') data.value = input.value;
    if (input.fields && typeof input.fields === 'object') {
      const cf = (lead.customFields as Record<string, unknown>) || {};
      data.customFields = { ...cf, ...(input.fields as Record<string, unknown>) };
      if (DRIVE_LINK_FIELD_KEY in (input.fields as Record<string, unknown>)) await ensureDriveLinkField(accountId);
    }
    const updated = await prisma.lead.update({ where: { id: lead.id }, data });
    if (io) io.to(`account_${accountId}`).emit('lead_moved', { lead: updated });
    return { success: true, leadId: updated.id };
  }

  if (name === 'adicionar_nota_lead') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'adicionar notas nos cards');
    const notas = Array.isArray(input.notas) ? input.notas : [];
    if (notas.length === 0) return { success: false, error: 'Informe ao menos uma nota em notas.' };

    const criadas: string[] = [];
    const erros: string[] = [];
    for (const n of notas as { leadId?: string; content?: string }[]) {
      const leadId = String(n.leadId || '').trim();
      const content = String(n.content || '').trim();
      if (!leadId || !content) { erros.push('Item inválido (faltou leadId ou content).'); continue; }
      const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
      if (!lead) { erros.push(`Lead ${leadId} não encontrado.`); continue; }
      await prisma.note.create({ data: { leadId, content, type: 'COMMENT', userId } });
      criadas.push(lead.name);
    }

    return { success: criadas.length > 0, notasCriadas: criadas.length, clientes: criadas, erros: erros.length ? erros : undefined };
  }

  if (name === 'criar_tarefa_lead') {
    if (!perms.tasks) return deny('tasks', 'criar tarefas');
    const leadId = String(input.leadId || '').trim();
    const title = String(input.title || '').trim();
    if (!leadId || !title) return { success: false, error: 'Informe leadId e title.' };
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };

    let assigneeId = userId;
    if (input.responsavelNome) {
      const candidatos = await prisma.user.findMany({ where: { accountId, name: { contains: String(input.responsavelNome), mode: 'insensitive' } } });
      if (candidatos.length === 0) return { success: false, error: `Nenhum colaborador encontrado com "${input.responsavelNome}".` };
      if (candidatos.length > 1) return { success: false, error: `Mais de um colaborador bate com "${input.responsavelNome}": ${candidatos.map((u) => u.name).join(', ')}. Pergunte ao colaborador qual é o certo.` };
      assigneeId = candidatos[0].id;
    }
    if (!assigneeId) return { success: false, error: 'Não foi possível identificar o responsável pela tarefa.' };

    let dueAt = new Date();
    if (input.dueAt) {
      const parsed = new Date(String(input.dueAt));
      if (Number.isNaN(parsed.getTime())) return { success: false, error: `Não consegui entender a data "${input.dueAt}".` };
      dueAt = parsed;
    }

    const task = await prisma.task.create({
      data: { title, dueAt, userId: assigneeId, leadId },
      include: { user: { select: { name: true } } },
    });

    if (io) io.to(`account_${accountId}`).emit('task_created', { task });

    return { success: true, taskId: task.id, cliente: lead.name, responsavel: task.user.name, vencimento: task.dueAt };
  }

  if (name === 'archive_lead') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'arquivar cards');
    const lead = await prisma.lead.findFirst({ where: { id: String(input.leadId || ''), accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    const archived = input.archived !== false;
    await prisma.lead.update({ where: { id: lead.id }, data: { archived } });
    if (io) io.to(`account_${accountId}`).emit('lead_moved', { lead: { ...lead, archived } });
    return { success: true, archived };
  }

  if (name === 'delete_lead') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'excluir cards');
    const lead = await prisma.lead.findFirst({ where: { id: String(input.leadId || ''), accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    if (input.confirmed !== true) {
      return { success: false, needsConfirmation: true, error: `Ação IRREVERSÍVEL: excluir o card "${lead.name}". Pergunte ao colaborador DUAS vezes se confirma; só então chame de novo com confirmed:true.` };
    }
    await deleteLead(lead.id, accountId);
    if (io) io.to(`account_${accountId}`).emit('lead_deleted', { leadId: lead.id });
    return { success: true, deleted: lead.name };
  }

  // ── Usuários (equipe): listar, criar, editar, excluir/tirar acesso ─────────
  if (name === 'list_users') {
    if (!perms.users) return deny('users', 'ver a equipe');
    return await prisma.user.findMany({ where: { accountId }, select: { id: true, name: true, email: true, role: true } });
  }

  if (name === 'create_user') {
    if (!perms.users) return deny('users', 'criar usuários');
    const nome = String(input.name || '').trim();
    const email = String(input.email || '').trim().toLowerCase();
    const senha = String(input.password || '');
    if (!nome || !email || !senha) return { success: false, error: 'Informe nome, e-mail e senha' };
    if (senha.length < 6) return { success: false, error: 'A senha deve ter ao menos 6 caracteres' };
    if (await prisma.user.findUnique({ where: { email } })) return { success: false, error: 'Já existe um usuário com esse e-mail' };
    const role = VALID_ROLES.includes(input.role as Role) ? (input.role as Role) : 'AGENT';
    const user = await prisma.user.create({
      data: { name: nome, email, password: await bcrypt.hash(senha, 10), role, accountId, permissions: sanitizePermsInput(input.permissions) ?? undefined },
      select: { id: true, name: true, email: true, role: true },
    });
    return { success: true, user };
  }

  if (name === 'update_user') {
    if (!perms.users) return deny('users', 'editar usuários');
    const target = await prisma.user.findFirst({ where: { id: String(input.userId || ''), accountId } });
    if (!target) return { success: false, error: 'Usuário não encontrado' };
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = String(input.name).trim();
    if (input.email !== undefined) {
      const email = String(input.email).trim().toLowerCase();
      if (email && email !== target.email) {
        if (await prisma.user.findUnique({ where: { email } })) return { success: false, error: 'Já existe um usuário com esse e-mail' };
        data.email = email;
      }
    }
    if (input.password) {
      if (String(input.password).length < 6) return { success: false, error: 'A senha deve ter ao menos 6 caracteres' };
      data.password = await bcrypt.hash(String(input.password), 10);
    }
    if (input.role && VALID_ROLES.includes(input.role as Role)) {
      if (target.role === 'ADMIN' && input.role !== 'ADMIN') {
        const admins = await prisma.user.count({ where: { accountId, role: 'ADMIN' } });
        if (admins <= 1) return { success: false, error: 'A conta precisa de pelo menos um administrador' };
      }
      data.role = input.role as Role;
    }
    if (input.permissions !== undefined) data.permissions = sanitizePermsInput(input.permissions);
    const user = await prisma.user.update({ where: { id: target.id }, data, select: { id: true, name: true, email: true, role: true } });
    return { success: true, user };
  }

  if (name === 'delete_user') {
    if (!perms.users) return deny('users', 'excluir usuários / tirar acesso');
    const targetId = String(input.userId || '');
    if (targetId === userId) return { success: false, error: 'Você não pode excluir a sua própria conta' };
    const target = await prisma.user.findFirst({ where: { id: targetId, accountId } });
    if (!target) return { success: false, error: 'Usuário não encontrado' };
    if (input.confirmed !== true) {
      return { success: false, needsConfirmation: true, error: `Ação IRREVERSÍVEL: excluir/tirar acesso de "${target.name}". Pergunte ao colaborador DUAS vezes se confirma; só então chame de novo com confirmed:true.` };
    }
    if (target.role === 'ADMIN') {
      const admins = await prisma.user.count({ where: { accountId, role: 'ADMIN' } });
      if (admins <= 1) return { success: false, error: 'Não é possível excluir o último administrador' };
    }
    const heir = userId!;
    await prisma.$transaction([
      prisma.lead.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.task.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.note.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.transaction.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.user.delete({ where: { id: target.id } }),
    ]);
    return { success: true, deleted: target.name };
  }

  if (name === 'send_whatsapp_message') {
    if (!perms.inbox_reply) return deny('inbox_reply', 'enviar mensagens');
    if (scopeDepartmentId) {
      const targetLead = await prisma.lead.findFirst({
        where: { id: String(input.leadId), accountId },
        include: { pipeline: { select: { departmentId: true } } },
      });
      if (!targetLead) return { success: false, error: 'Lead não encontrado' };
      if (targetLead.pipeline.departmentId && targetLead.pipeline.departmentId !== scopeDepartmentId) {
        return { success: false, error: 'Esse lead é de outro departamento.' };
      }
    }
    const result = await sendOutboundWhatsApp({
      accountId,
      leadId: String(input.leadId),
      content: String(input.content || ''),
      fromNumberId: input.fromNumberId ? String(input.fromNumberId) : undefined,
      userId,
      io,
    });
    return result;
  }

  if (name === 'send_whatsapp_to_number') {
    if (!perms.inbox_reply) return deny('inbox_reply', 'enviar mensagens');
    const phone = String(input.phone || '').trim();
    if (!phone) return { success: false, error: 'Número de telefone não informado' };

    // Se pediram um funil/estágio específico, resolve e valida antes de criar o card
    // (e checa que é do PRÓPRIO setor, se o colaborador tiver um).
    let target: { pipelineId: string; stageId: string } | undefined;
    if (input.stageId || input.pipelineId) {
      const resolved = await resolveStageTarget(
        accountId,
        input.pipelineId ? String(input.pipelineId) : undefined,
        input.stageId ? String(input.stageId) : undefined,
      );
      if (!resolved) return { success: false, error: 'Funil/estágio não encontrado. Use list_pipelines para obter o stageId correto.' };
      if (scopeDepartmentId) {
        const destPipelineCheck = await prisma.pipeline.findUnique({ where: { id: resolved.pipelineId }, select: { departmentId: true } });
        if (destPipelineCheck?.departmentId && destPipelineCheck.departmentId !== scopeDepartmentId) {
          return { success: false, error: 'Esse funil é de outro departamento.' };
        }
      }
      target = resolved;
    } else if (scopeDepartmentId) {
      // Sem funil/estágio pedido — cria (se precisar) na Caixa de Entrada do
      // PRÓPRIO setor do colaborador, não num funil qualquer da conta.
      const inbox = await getOrCreateInboxPipeline(accountId, scopeDepartmentId);
      if (inbox.stages[0]) target = { pipelineId: inbox.id, stageId: inbox.stages[0].id };
    }

    const lead = await findOrCreateLeadByPhone(accountId, phone, input.name ? String(input.name) : undefined, target);
    if (!lead) return { success: false, error: 'Não foi possível criar o lead (funil/usuário não configurado)' };
    const result = await sendOutboundWhatsApp({
      accountId,
      leadId: lead.leadId,
      content: String(input.content || ''),
      fromNumberId: input.fromNumberId ? String(input.fromNumberId) : undefined,
      userId,
      io,
    });
    return { ...result, leadCreated: lead.created };
  }

  if (name === 'salvar_documentos_no_drive') {
    const leadId = String(input.leadId || '');
    const nomePasta = String(input.nomePasta || '').trim();
    const pastaDestino = String(input.pastaDestino || '').trim();
    if (!leadId || !nomePasta) return { success: false, error: 'leadId e nomePasta são obrigatórios' };
    // confirma que o lead é da conta
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    try {
      const res = await organizeLeadDocsToDrive({ accountId, leadId, clientFolderName: nomePasta, destinationFolderName: pastaDestino || undefined });
      if (res.noRoot) return { success: false, error: 'Pasta-raiz dos clientes não definida. Configure em Configurações → Google Drive.' };

      // Salva o link da pasta no card do cliente (campo "Pasta no Drive"), criando
      // o campo sozinho na primeira vez — não bloqueia a resposta se falhar.
      try {
        await ensureDriveLinkField(accountId);
        const cf = (lead.customFields as Record<string, unknown>) || {};
        await prisma.lead.update({ where: { id: lead.id }, data: { customFields: { ...cf, [DRIVE_LINK_FIELD_KEY]: res.folderUrl } } });
      } catch (err) {
        console.error('[AI] Falha ao salvar o link da pasta no card:', (err as any)?.message);
      }

      return {
        success: true,
        pasta: res.folderName,
        dentroDe: res.parentFolderName,
        link: res.folderUrl,
        enviados: res.uploaded,
        jaEstavamNaPasta: res.alreadyThere,
        linkSalvoNoCard: true,
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao salvar no Drive' };
    }
  }

  if (name === 'ler_documento_identificacao') {
    const leadId = String(input.leadId || '');
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };

    const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    let buffer: Buffer | null = null;
    let mimeType = '';
    let fileName = '';
    let fonte: 'drive' | 'whatsapp' = 'whatsapp';

    if (input.attachmentId) {
      // Anexo específico da conversa do WhatsApp, apontado pelo colaborador.
      const att = await prisma.messageAttachment.findFirst({ where: { id: String(input.attachmentId), leadId } });
      if (!att) return { success: false, error: 'Anexo não encontrado.' };
      if (!SUPPORTED.includes(att.mimeType)) return { success: false, error: `Tipo de arquivo não suportado (${att.mimeType}).` };
      try {
        buffer = att.data ? Buffer.from(att.data) : att.driveFileId ? await downloadDriveFile(accountId, att.driveFileId, att.mimeType) : null;
      } catch (err: any) {
        return { success: false, error: `Falha ao baixar o anexo: ${err?.message || 'erro desconhecido'}` };
      }
      if (buffer) { mimeType = att.mimeType; fileName = att.fileName; fonte = 'whatsapp'; }
    } else {
      // 1ª tentativa: a pasta do cliente no Drive.
      const nomePasta = String(input.nomePasta || lead.name || '').trim();
      try {
        const folder = nomePasta ? await findFolderByNameUnderRoot(accountId, nomePasta) : null;
        if (folder) {
          const files = (await listFolderContents(accountId, folder.folderId)).filter((f) => !f.isFolder && SUPPORTED.includes(f.mimeType));
          const nomeArquivo = String(input.nomeArquivo || '').trim().toLowerCase();
          let chosen: { id: string; name: string; mimeType: string } | null = files[0] || null;
          if (nomeArquivo) {
            chosen = files.find((f) => f.name.toLowerCase().includes(nomeArquivo)) || null;
            // Não achou no nível direto da pasta — procura em subpastas (ex.: "ITBI" dentro da pasta do cliente).
            if (!chosen) {
              const deep = (await findFilesInFolderTree(accountId, folder.folderId, nomeArquivo)).filter((f) => SUPPORTED.includes(f.mimeType));
              if (deep.length === 1) chosen = deep[0];
            }
          } else {
            const heur = files.find((f) => /cnh|rg|identidade|habilita|holerite|contracheque|comprovante|renda/i.test(f.name));
            if (heur) chosen = heur;
          }
          if (chosen) {
            buffer = await downloadDriveFile(accountId, chosen.id, chosen.mimeType);
            mimeType = chosen.mimeType; fileName = chosen.name; fonte = 'drive';
          }
        }
      } catch (err) {
        console.error('[AI] Busca na pasta do Drive falhou:', (err as any)?.message);
        // não interrompe — cai no fallback do WhatsApp abaixo
      }

      // 2ª tentativa (fallback): a foto/PDF mais recente enviada pelo cliente no WhatsApp.
      if (!buffer) {
        const att = await prisma.messageAttachment.findFirst({
          where: { leadId, OR: [{ mimeType: { startsWith: 'image/' } }, { mimeType: 'application/pdf' }] },
          orderBy: { createdAt: 'desc' },
        });
        if (att) {
          try {
            buffer = att.data ? Buffer.from(att.data) : att.driveFileId ? await downloadDriveFile(accountId, att.driveFileId, att.mimeType) : null;
          } catch (err: any) {
            return { success: false, error: `Falha ao baixar o documento: ${err?.message || 'erro desconhecido'}` };
          }
          if (buffer) { mimeType = att.mimeType; fileName = att.fileName; fonte = 'whatsapp'; }
        }
      }
    }

    if (!buffer) return { success: false, error: 'Nenhum documento (foto ou PDF) encontrado — nem na pasta do cliente no Drive, nem na conversa do WhatsApp.' };
    if (!SUPPORTED.includes(mimeType)) return { success: false, error: `Tipo de arquivo não suportado para leitura (${mimeType}). Peça uma foto (JPG/PNG) ou PDF do documento.` };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { success: false, error: 'ANTHROPIC_API_KEY não configurada' };

    const isPdf = mimeType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };

    try {
      const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1024,
          system: 'Você extrai dados de documentos de identificação e comprovantes brasileiros (CNH, RG, carteira de trabalho, contracheque/holerite etc). Responda SOMENTE com um JSON válido, sem markdown e sem texto antes ou depois, no formato exato: {"nomeCompleto": string|null, "cpf": string|null, "dataNascimento": string|null, "renda": string|null}. CPF no formato 000.000.000-00; data de nascimento no formato DD/MM/AAAA; renda como número em texto (ex: "5000.00") e SÓ se o documento for claramente um comprovante de renda/holerite — senão null. Se não conseguir ler algum campo com certeza no documento, use null nesse campo. NUNCA invente valores.',
          messages: [{
            role: 'user',
            content: [contentBlock, { type: 'text', text: 'Extraia os dados deste documento.' }],
          }],
        }),
      });

      if (!visionRes.ok) {
        const errText = await visionRes.text();
        return { success: false, error: `Erro ao ler o documento: ${visionRes.status} ${errText.slice(0, 200)}` };
      }

      const visionData = await visionRes.json() as { content: { type: string; text?: string }[] };
      const raw = visionData.content?.find((b) => b.type === 'text')?.text || '{}';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

      return {
        success: true,
        fileName,
        fonte: fonte === 'drive' ? 'pasta do cliente no Drive' : 'conversa do WhatsApp',
        extraido: {
          nomeCompleto: parsed.nomeCompleto ?? null,
          cpf: parsed.cpf ?? null,
          dataNascimento: parsed.dataNascimento ?? null,
          renda: parsed.renda ?? null,
        },
      };
    } catch (err: any) {
      return { success: false, error: `Falha ao processar o documento: ${err?.message || 'erro desconhecido'}` };
    }
  }

  if (name === 'conferir_cadastro_com_documentos') {
    const leadId = String(input.leadId || '');
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };

    const resolved = await resolveClientDriveDocuments(accountId, lead.name, input.nomePasta ? String(input.nomePasta) : undefined);
    if (!resolved.ok) return { success: false, error: resolved.error };
    const { docs, deixadosDeFora } = resolved;

    // Monta o "cadastro atual" a partir do nome/valor do lead + campos personalizados preenchidos.
    const fieldDefs = await prisma.fieldDefinition.findMany({ where: { accountId }, orderBy: [{ tab: 'asc' }, { order: 'asc' }] });
    const cf = (lead.customFields || {}) as Record<string, unknown>;
    const linhasCadastro: string[] = [`Nome do lead/cliente: ${lead.name || '(vazio)'}`];
    if (lead.value != null) linhasCadastro.push(`Valor: ${lead.value}`);
    for (const fd of fieldDefs) {
      const v = cf[fd.key];
      if (v !== undefined && v !== null && String(v).trim() !== '') linhasCadastro.push(`${fd.name} (${fd.key}): ${v}`);
    }
    if (linhasCadastro.length <= 1) return { success: false, error: 'Esse cadastro não tem campos preenchidos para conferir.' };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { success: false, error: 'ANTHROPIC_API_KEY não configurada' };

    const content: Record<string, unknown>[] = [];
    for (const d of docs) {
      content.push({ type: 'text', text: `Documento: ${d.name}` });
      content.push(
        d.mimeType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.buffer.toString('base64') } }
          : { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.buffer.toString('base64') } }
      );
    }
    content.push({
      type: 'text',
      text: `Dados atualmente registrados no cadastro deste cliente:\n${linhasCadastro.join('\n')}\n\nCompare cada dado do cadastro acima com o que aparece nos documentos. Aponte SOMENTE divergências claras e que você tenha certeza (ex.: nome escrito diferente, CPF com dígito trocado, valor diferente do documento). NÃO aponte um campo do cadastro se ele não aparecer em nenhum documento — nesse caso simplesmente não dá pra conferir esse campo, ignore-o.`,
    });

    try {
      const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1500,
          system: 'Você audita cadastros de clientes de uma financeira comparando os dados já digitados com os documentos oficiais dela (RG, CNH, comprovante de renda/residência, certidões, contratos etc). Responda SOMENTE com um JSON válido, sem markdown, no formato exato: {"divergencias": [{"campo": string, "valorCadastro": string, "valorDocumento": string, "documento": string, "observacao": string}], "resumo": string}. "divergencias" só deve conter casos em que você tem certeza da diferença — nunca aponte algo que não esteja claramente legível no documento, e nunca inclua um campo que não apareça em nenhum documento. Se não encontrar nenhuma divergência, devolva "divergencias": [] e um "resumo" dizendo que está tudo batendo com o que foi possível conferir.',
          messages: [{ role: 'user', content }],
        }),
      });
      if (!visionRes.ok) {
        const errText = await visionRes.text();
        return { success: false, error: `Erro ao conferir os documentos: ${visionRes.status} ${errText.slice(0, 200)}` };
      }
      const visionData = await visionRes.json() as { content: { type: string; text?: string }[] };
      const raw = visionData.content?.find((b) => b.type === 'text')?.text || '{}';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

      return {
        success: true,
        documentosAnalisados: docs.map((d) => d.name),
        documentosDeixadosDeFora: deixadosDeFora.length ? deixadosDeFora : undefined,
        divergencias: Array.isArray(parsed.divergencias) ? parsed.divergencias : [],
        resumo: parsed.resumo || null,
      };
    } catch (err: any) {
      return { success: false, error: `Falha ao processar os documentos: ${err?.message || 'erro desconhecido'}` };
    }
  }

  if (name === 'conferir_documento_com_pasta_drive') {
    const leadId = String(input.leadId || '');
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };

    const nomePastaInput = input.nomePasta ? String(input.nomePasta) : undefined;
    const nomeArquivoReferencia = String(input.nomeArquivoReferencia || '').trim();

    // Resolve o documento de REFERÊNCIA (o "formulário"): ou veio anexado no
    // chat, ou já está salvo na própria pasta do cliente no Drive.
    let refMimeType = '';
    let refBase64 = '';
    let refLabel = '';
    let excludeFileId: string | undefined;

    if (attachment?.dataBase64 && attachment.mimeType) {
      if (!DRIVE_DOC_TYPES.includes(attachment.mimeType)) {
        return { success: false, error: `Tipo de arquivo anexado não suportado (${attachment.mimeType}).` };
      }
      refMimeType = attachment.mimeType;
      refBase64 = attachment.dataBase64;
      refLabel = 'anexado pelo colaborador nesta conversa';
    } else if (nomeArquivoReferencia) {
      const folder = await findFolderByNameUnderRoot(accountId, nomePastaInput || lead.name);
      if (!folder) return { success: false, error: `Não encontrei a pasta "${nomePastaInput || lead.name}" no Drive. Confirme o nome da pasta do cliente com o colaborador.` };

      let candidatos: { id: string; name: string; mimeType: string; path: string }[] = [];
      try {
        candidatos = (await findFilesInFolderTree(accountId, folder.folderId, nomeArquivoReferencia)).filter((f) => DRIVE_DOC_TYPES.includes(f.mimeType));
      } catch (err: any) {
        return { success: false, error: `Falha ao buscar o arquivo na pasta do Drive: ${err?.message || 'erro desconhecido'}` };
      }
      if (candidatos.length === 0) return { success: false, error: `Não achei nenhum arquivo com "${nomeArquivoReferencia}" no nome, na pasta do cliente no Drive.` };
      if (candidatos.length > 1) {
        return { success: false, needsDisambiguation: true, opcoes: candidatos.map((c) => ({ nome: c.name, pasta: c.path })), error: `Achei mais de um arquivo parecido com "${nomeArquivoReferencia}" — pergunte ao colaborador qual é o formulário certo e chame de novo com um nome mais específico.` };
      }
      const escolhido = candidatos[0];
      let buffer: Buffer;
      try {
        buffer = await downloadDriveFile(accountId, escolhido.id, escolhido.mimeType);
      } catch (err: any) {
        return { success: false, error: `Falha ao baixar "${escolhido.name}" do Drive: ${err?.message || 'erro desconhecido'}` };
      }
      refMimeType = escolhido.mimeType;
      refBase64 = buffer.toString('base64');
      refLabel = `arquivo "${escolhido.name}" já salvo na pasta do cliente no Drive${escolhido.path ? ` (em ${escolhido.path})` : ''}`;
      excludeFileId = escolhido.id;
    } else {
      return { success: false, error: 'Não tem nenhum arquivo anexado nesta conversa, e nenhum nomeArquivoReferencia foi informado. Pergunte ao colaborador: ele quer anexar o formulário na conversa, ou já tem o formulário salvo na pasta do cliente no Drive (nesse caso, qual o nome do arquivo)?' };
    }

    const resolved = await resolveClientDriveDocuments(accountId, lead.name, nomePastaInput, excludeFileId);
    if (!resolved.ok) return { success: false, error: resolved.error };
    const { docs, deixadosDeFora } = resolved;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { success: false, error: 'ANTHROPIC_API_KEY não configurada' };

    const content: Record<string, unknown>[] = [
      { type: 'text', text: `FORMULÁRIO/CADASTRO PREENCHIDO A CONFERIR (${refLabel}):` },
      refMimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: refBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: refMimeType, data: refBase64 } },
    ];
    for (const d of docs) {
      content.push({ type: 'text', text: `Documento de referência do cliente (Drive): ${d.name}` });
      content.push(
        d.mimeType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.buffer.toString('base64') } }
          : { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.buffer.toString('base64') } }
      );
    }
    content.push({
      type: 'text',
      text: 'Compare os dados preenchidos no FORMULÁRIO acima com o que aparece nos documentos de referência do cliente (Drive), listados depois dele. Aponte SOMENTE divergências claras e que você tenha certeza (ex.: nome escrito diferente, CPF com dígito trocado, valor/data diferente do documento). NÃO aponte um campo do formulário se ele não aparecer em nenhum documento de referência — nesse caso simplesmente não dá pra conferir esse campo, ignore-o.',
    });

    try {
      const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1500,
          system: 'Você audita formulários/cadastros de clientes de uma financeira comparando um formulário preenchido com os documentos oficiais do cliente (RG, CNH, comprovante de renda/residência, certidões, contratos etc). Responda SOMENTE com um JSON válido, sem markdown, no formato exato: {"divergencias": [{"campo": string, "valorFormulario": string, "valorDocumento": string, "documento": string, "observacao": string}], "resumo": string}. "divergencias" só deve conter casos em que você tem certeza da diferença — nunca aponte algo que não esteja claramente legível no documento, e nunca inclua um campo do formulário que não apareça em nenhum documento de referência. Se não encontrar nenhuma divergência, devolva "divergencias": [] e um "resumo" dizendo que está tudo batendo com o que foi possível conferir.',
          messages: [{ role: 'user', content }],
        }),
      });
      if (!visionRes.ok) {
        const errText = await visionRes.text();
        return { success: false, error: `Erro ao conferir os documentos: ${visionRes.status} ${errText.slice(0, 200)}` };
      }
      const visionData = await visionRes.json() as { content: { type: string; text?: string }[] };
      const raw = visionData.content?.find((b) => b.type === 'text')?.text || '{}';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

      return {
        success: true,
        documentosReferenciaAnalisados: docs.map((d) => d.name),
        documentosDeixadosDeFora: deixadosDeFora.length ? deixadosDeFora : undefined,
        divergencias: Array.isArray(parsed.divergencias) ? parsed.divergencias : [],
        resumo: parsed.resumo || null,
      };
    } catch (err: any) {
      return { success: false, error: `Falha ao processar os documentos: ${err?.message || 'erro desconhecido'}` };
    }
  }

  if (name === 'enviar_arquivo_whatsapp') {
    if (!perms.inbox_reply) return deny('inbox_reply', 'enviar arquivos');
    const leadId = String(input.leadId || '');
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };

    const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

    // 1ª etapa: só RESOLVE qual arquivo seria enviado (sem baixar nem mandar
    // nada ainda) — precisa disso antes de pedir confirmação ao colaborador.
    let fileName = '';
    let mimeType = '';
    let attRef: { id: string; data: any; driveFileId: string | null } | null = null;
    let driveRef: { id: string; mimeType: string } | null = null;

    if (input.attachmentId) {
      const att = await prisma.messageAttachment.findFirst({ where: { id: String(input.attachmentId), leadId } });
      if (!att) return { success: false, error: 'Anexo não encontrado.' };
      fileName = att.fileName; mimeType = att.mimeType; attRef = att;
    } else {
      const nomeArquivo = String(input.nomeArquivo || '').trim();
      if (!nomeArquivo) return { success: false, error: 'Informe nomeArquivo (o arquivo a enviar) ou attachmentId.' };
      const nomePasta = String(input.nomePasta || lead.name || '').trim();
      const folder = nomePasta ? await findFolderByNameUnderRoot(accountId, nomePasta) : null;
      if (!folder) return { success: false, error: `Pasta do cliente "${nomePasta}" não encontrada no Drive.` };
      // Busca em TODA a árvore da pasta do cliente (não só no nível direto) —
      // é comum o arquivo estar dentro de uma subpasta temática (ex.: "ITBI").
      const files = await findFilesInFolderTree(accountId, folder.folderId, nomeArquivo);
      if (files.length === 0) return { success: false, error: `Nenhum arquivo com "${nomeArquivo}" no nome foi encontrado na pasta do cliente (nem em subpastas).` };
      if (files.length > 1) {
        const lista = files.map((f) => `${f.name}${f.path ? ` (em ${f.path})` : ''}`).join('; ');
        return { success: false, error: `Mais de um arquivo bate com "${nomeArquivo}": ${lista}. Pergunte ao colaborador qual enviar (pode chamar de novo com um nome mais específico).` };
      }
      fileName = files[0].name; mimeType = files[0].mimeType; driveRef = files[0];
    }

    if (!SUPPORTED.includes(mimeType)) return { success: false, error: `Tipo de arquivo não suportado para envio pelo WhatsApp (${mimeType}).` };

    // 2ª etapa: CONFIRMAÇÃO — antes de baixar/enviar de verdade, exige que o
    // colaborador já tenha sido informado do arquivo e perguntado sobre legenda.
    if (input.confirmed !== true) {
      return {
        success: false,
        needsConfirmation: true,
        arquivo: fileName,
        cliente: lead.name,
        error: `Antes de enviar, informe ao colaborador que vai encaminhar "${fileName}" para ${lead.name} e pergunte se ele quer incluir alguma mensagem (legenda) junto. Só chame esta ferramenta de novo com confirmed:true (e legenda, se ele quiser) depois que o colaborador confirmar.`,
      };
    }

    let buffer: Buffer | null = null;
    try {
      buffer = attRef
        ? (attRef.data ? Buffer.from(attRef.data) : attRef.driveFileId ? await downloadDriveFile(accountId, attRef.driveFileId, mimeType) : null)
        : driveRef
        ? await downloadDriveFile(accountId, driveRef.id, mimeType)
        : null;
    } catch (err: any) {
      return { success: false, error: `Falha ao baixar o arquivo: ${err?.message || 'erro desconhecido'}` };
    }
    if (!buffer) return { success: false, error: 'Não foi possível obter o conteúdo do arquivo.' };

    const result = await sendOutboundMedia({
      accountId, leadId, buffer, fileName, mimeType,
      caption: input.legenda ? String(input.legenda) : undefined,
      userId, io,
    });
    return result;
  }

  if (name === 'listar_pasta_drive') {
    let folderId = String(input.pastaId || '').trim();
    let folderLabel = '';
    if (!folderId) {
      let nomePasta = String(input.nomePasta || '').trim();
      if (!nomePasta && input.leadId) {
        const lead = await prisma.lead.findFirst({ where: { id: String(input.leadId), accountId } });
        if (!lead) return { success: false, error: 'Lead não encontrado' };
        nomePasta = lead.name;
      }
      if (!nomePasta) return { success: false, error: 'Informe leadId, nomePasta ou pastaId.' };
      const folder = await findFolderByNameUnderRoot(accountId, nomePasta);
      if (!folder) return { success: false, error: `Pasta "${nomePasta}" não encontrada no Drive.` };
      folderId = folder.folderId;
      folderLabel = nomePasta;
    }
    try {
      const items = await listFolderContents(accountId, folderId);
      return {
        success: true,
        pasta: folderLabel || undefined,
        itens: items.map((i) => ({ id: i.id, nome: i.name, tipo: i.isFolder ? 'pasta' : 'arquivo', link: i.link })),
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao listar a pasta' };
    }
  }

  if (name === 'criar_pasta_drive') {
    const nome = String(input.nome || '').trim();
    if (!nome) return { success: false, error: 'nome é obrigatório' };
    const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
    if (!conn?.rootFolderId) return { success: false, error: 'Pasta-raiz dos clientes não definida. Configure em Configurações → Google Drive.' };
    try {
      let parentId = conn.rootFolderId;
      const dentroDe = String(input.dentroDe || '').trim();
      if (dentroDe) {
        const parent = await findFolderByNameUnderRoot(accountId, dentroDe);
        if (!parent) return { success: false, error: `Pasta "${dentroDe}" não encontrada no Drive.` };
        parentId = parent.folderId;
      }
      const folder = await createFolder(accountId, nome, parentId);
      return { success: true, pasta: folder.name, id: folder.id, jaExistia: folder.existed, link: folderLink(folder.id) };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao criar a pasta' };
    }
  }

  if (name === 'renomear_item_drive') {
    const novoNome = String(input.novoNome || '').trim();
    if (!novoNome) return { success: false, error: 'novoNome é obrigatório' };
    let itemId = String(input.itemId || '').trim();
    if (!itemId) {
      const leadId = String(input.leadId || '');
      if (!leadId) return { success: false, error: 'Informe itemId ou leadId.' };
      const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
      if (!lead) return { success: false, error: 'Lead não encontrado' };
      const nomePastaAtual = String(input.nomePastaAtual || lead.name || '').trim();
      const folder = nomePastaAtual ? await findFolderByNameUnderRoot(accountId, nomePastaAtual) : null;
      if (!folder) return { success: false, error: `Pasta do cliente "${nomePastaAtual}" não encontrada no Drive.` };
      itemId = folder.folderId;
    }
    try {
      await renameFile(accountId, itemId, novoNome);
      return { success: true, novoNome };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao renomear' };
    }
  }

  if (name === 'mover_item_drive') {
    const itemId = String(input.itemId || '').trim();
    if (!itemId) return { success: false, error: 'itemId é obrigatório' };
    let novaPastaId = String(input.novaPastaId || '').trim();
    if (!novaPastaId) {
      const novaPastaNome = String(input.novaPastaNome || '').trim();
      if (!novaPastaNome) return { success: false, error: 'Informe novaPastaNome ou novaPastaId.' };
      const folder = await findFolderByNameUnderRoot(accountId, novaPastaNome);
      if (!folder) return { success: false, error: `Pasta de destino "${novaPastaNome}" não encontrada no Drive.` };
      novaPastaId = folder.folderId;
    }
    try {
      const moved = await moveDriveItem(accountId, itemId, novaPastaId);
      return { success: true, item: moved.name };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao mover' };
    }
  }

  if (name === 'excluir_item_drive') {
    if (!perms.funnel_manage) return deny('funnel_manage', 'excluir arquivos/pastas do Drive');
    const itemId = String(input.itemId || '').trim();
    if (!itemId) return { success: false, error: 'itemId é obrigatório' };
    if (input.confirmed !== true) {
      return { success: false, needsConfirmation: true, error: 'Ação IRREVERSÍVEL: excluir este item do Drive. Pergunte ao colaborador DUAS vezes se confirma; só então chame de novo com confirmed:true.' };
    }
    try {
      const trashed = await trashDriveItem(accountId, itemId);
      return { success: true, deleted: trashed.name };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao excluir' };
    }
  }

  if (name === 'auditar_pastas_contratacao') {
    const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    const pipelines = await prisma.pipeline.findMany({ where: { accountId }, include: { stages: true } });
    const pipeline = pipelines.find((p) => normalize(p.name).includes('contratacao'));
    if (!pipeline) return { success: false, error: 'Não encontrei o funil "Em contratação".' };

    const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
    if (!conn?.rootFolderId) return { success: false, error: 'Pasta-raiz dos clientes não definida no Drive. Configure em Configurações → Google Drive.' };

    const rootSubfolders = await listFolders(accountId, conn.rootFolderId);
    const leadsAtivosFolder = rootSubfolders.find((f) => normalize(f.name).includes('leads ativos'));
    if (!leadsAtivosFolder) return { success: false, error: 'Não encontrei a pasta "LEADS ATIVOS" na raiz do Drive.' };

    const stageIds = pipeline.stages.map((s) => s.id);
    const LIMITE = 80; // evita estourar tempo/rate-limit do Drive numa conta com muitos leads nesse funil
    const leads = await prisma.lead.findMany({
      where: { accountId, archived: false, pipelineId: pipeline.id, stageId: { in: stageIds } },
      include: { stage: { select: { name: true } } },
      take: LIMITE,
    });

    // Fase 1 (rápida, 1 chamada): lista o conteúdo direto de LEADS ATIVOS e
    // casa por nome — resolve a maioria dos leads sem varrer a árvore inteira.
    const leadsAtivosContents = await listFolderContents(accountId, leadsAtivosFolder.id);
    const emLugarCerto = new Set(leadsAtivosContents.filter((f) => f.isFolder).map((f) => normalize(f.name)));

    const pendentes = leads.filter((l) => !emLugarCerto.has(normalize(l.name)));
    const ok = leads.length - pendentes.length;

    // Fase 2 (só para quem não bateu na Fase 1): UMA única varredura paralela
    // da árvore do Drive procurando o nome de todos os pendentes de uma vez —
    // bem mais rápido do que varrer a árvore inteira uma vez por lead.
    const divergencias: Record<string, unknown>[] = [];
    if (pendentes.length > 0) {
      const found = await findFoldersByNamesInTree(accountId, conn.rootFolderId, pendentes.map((l) => l.name));
      for (const lead of pendentes) {
        const matches = found.get(lead.name.trim().toLowerCase()) || [];
        if (matches.length === 0) {
          divergencias.push({ leadId: lead.id, nome: lead.name, estagio: lead.stage.name, situacao: 'nao_encontrada' });
        } else if (matches.length > 1) {
          divergencias.push({ leadId: lead.id, nome: lead.name, estagio: lead.stage.name, situacao: 'ambiguo', locais: matches.map((m) => m.path) });
        } else {
          divergencias.push({ leadId: lead.id, nome: lead.name, estagio: lead.stage.name, situacao: 'fora_do_lugar', localAtual: matches[0].path, itemId: matches[0].id });
        }
      }
    }

    return {
      success: true,
      funil: pipeline.name,
      pastaAlvo: leadsAtivosFolder.name,
      pastaAlvoId: leadsAtivosFolder.id,
      totalLeads: leads.length,
      truncado: leads.length === LIMITE,
      ok,
      divergencias,
    };
  }

  if (name === 'preencher_link_drive_em_lote') {
    const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const funilNome = String(input.funilNome || '').trim();
    if (!funilNome) return { success: false, error: 'Informe funilNome.' };

    const pipelines = await prisma.pipeline.findMany({ where: { accountId, ...pipelineDeptScope }, include: { stages: true } });
    const pipeline = pipelines.find((p) => normalize(p.name).includes(normalize(funilNome)));
    if (!pipeline) return { success: false, error: `Nenhum funil encontrado com "${funilNome}".` };

    const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
    if (!conn?.rootFolderId) return { success: false, error: 'Pasta-raiz dos clientes não definida no Drive. Configure em Configurações → Google Drive.' };

    const stageIds = pipeline.stages.map((s) => s.id);
    const LIMITE = 80; // evita estourar tempo/rate-limit do Drive numa conta com muitos leads nesse funil
    const leads = await prisma.lead.findMany({
      where: { accountId, archived: false, pipelineId: pipeline.id, stageId: { in: stageIds } },
      take: LIMITE,
    });
    if (leads.length === 0) return { success: false, error: `Nenhum lead ativo no funil "${pipeline.name}".` };

    // Já preenchidos — pula sem sobrescrever (o colaborador pode ter colocado
    // um link diferente de propósito).
    const semLink = leads.filter((l) => {
      const cf = (l.customFields || {}) as Record<string, unknown>;
      const v = cf[DRIVE_LINK_FIELD_KEY];
      return !v || String(v).trim() === '';
    });
    const jaTinham = leads.length - semLink.length;
    if (semLink.length === 0) {
      return { success: true, funil: pipeline.name, totalLeads: leads.length, jaTinhamLink: jaTinham, preenchidos: 0, mensagem: 'Todos os leads desse funil já tinham o campo preenchido.' };
    }

    // UMA varredura paralela da árvore do Drive procurando o nome de todos de
    // uma vez — mesma técnica do auditar_pastas_contratacao, bem mais rápido
    // do que uma busca por lead.
    const found = await findFoldersByNamesInTree(accountId, conn.rootFolderId, semLink.map((l) => l.name));

    let preenchidos = 0;
    const naoEncontrados: string[] = [];
    const ambiguos: { nome: string; locais: string[] }[] = [];
    await ensureDriveLinkField(accountId);

    for (const lead of semLink) {
      const matches = found.get(lead.name.trim().toLowerCase()) || [];
      if (matches.length === 0) {
        naoEncontrados.push(lead.name);
      } else if (matches.length > 1) {
        ambiguos.push({ nome: lead.name, locais: matches.map((m) => m.path) });
      } else {
        try {
          const cf = (lead.customFields || {}) as Record<string, unknown>;
          await prisma.lead.update({ where: { id: lead.id }, data: { customFields: { ...cf, [DRIVE_LINK_FIELD_KEY]: folderLink(matches[0].id) } } });
          preenchidos++;
        } catch (err) {
          naoEncontrados.push(lead.name); // falhou ao salvar — trata como pendente, não trava o lote
        }
      }
    }

    return {
      success: true,
      funil: pipeline.name,
      totalLeads: leads.length,
      jaTinhamLink: jaTinham,
      preenchidos,
      naoEncontrados,
      ambiguos,
      truncado: leads.length === LIMITE,
    };
  }

  return { error: `Ferramenta desconhecida: ${name}` };
  } catch (err: any) {
    console.error(`[AI] Erro inesperado na ferramenta ${name}:`, err);
    return { success: false, error: `Erro inesperado ao executar ${name}: ${err?.message || 'erro desconhecido'}` };
  }
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  source?: { type: 'base64'; media_type: string; data: string };
}

const SUPPORTED_CHAT_ATTACHMENTS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_CHAT_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB

router.post('/support-chat', async (req: AuthRequest, res: Response) => {
  const { messages, conversationId, attachment } = req.body as {
    messages?: ChatMessage[];
    conversationId?: string;
    /** Arquivo anexado pelo colaborador diretamente nesta mensagem (botão de anexo do chat). */
    attachment?: { fileName?: string; mimeType?: string; dataBase64?: string };
  };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages é obrigatório e deve ser uma lista não vazia' });
    return;
  }

  if (attachment?.dataBase64) {
    if (!attachment.mimeType || !SUPPORTED_CHAT_ATTACHMENTS.includes(attachment.mimeType)) {
      res.status(400).json({ error: 'Tipo de arquivo não suportado. Envie uma imagem (JPG/PNG) ou PDF.' });
      return;
    }
    const sizeBytes = Math.ceil((attachment.dataBase64.length * 3) / 4);
    if (sizeBytes > MAX_CHAT_ATTACHMENT_BYTES) {
      res.status(400).json({ error: 'Arquivo muito grande (máximo 8 MB).' });
      return;
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
    return;
  }

  const accountId = req.user!.accountId;
  const io = req.app.get('io');

  try {
    const agentConfig = await prisma.agentConfig.findUnique({ where: { accountId } });
    let systemPrompt = agentConfig?.systemPrompt?.trim() || SUPPORT_SYSTEM_PROMPT;

    // Data de hoje (fuso de Brasília) — sem isso o modelo não sabe em que ano/mês
    // está e pode escolher a pasta errada em estruturas organizadas por ano/mês
    // no Drive (ex.: escolher "CONCLUIDOS/2025" quando o mês atual é de 2026).
    const hojeBR = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' });
    systemPrompt = `Hoje é ${hojeBR}. Use esta data como referência sempre que precisar saber o mês/ano atual — por exemplo, ao decidir em qual pasta de ano/mês salvar ou mover algo no Drive.\n\n${systemPrompt}`;

    // Perguntas pendentes de outros colaboradores para ESTE colaborador (ver
    // perguntar_colaborador) — trazidas automaticamente pro início da conversa
    // dele, sem precisar de tela nova. Limita a 8 pra não sobrecarregar a
    // primeira resposta se houver muitas.
    try {
      const pendentes = await prisma.assistantQuestion.findMany({
        where: { targetUserId: req.user!.id, accountId, answered: false },
        include: { lead: { select: { name: true } }, askedBy: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: 8,
      });
      if (pendentes.length) {
        const lista = pendentes.map((p) => `- [id: ${p.id}] ${p.askedBy.name} pediu pra perguntar sobre o cliente "${p.lead.name}": ${p.pergunta}`).join('\n');
        systemPrompt = `IMPORTANTE: este colaborador tem ${pendentes.length} pergunta(s) pendente(s) que outro colega pediu para você fazer a ele:\n${lista}\n\nTraga isso à tona na conversa de forma natural (pode ser logo na primeira resposta) — uma pergunta de cada vez se forem várias, sem despejar tudo de uma vez. Assim que ele responder cada uma, use responder_pergunta_pendente com o id certo para preencher o card sozinho e marcar como respondida. Não invente respostas por ele.\n\n${systemPrompt}`;
      }
    } catch (err) {
      console.error('[AI] Falha ao buscar perguntas pendentes:', err);
    }

    // Base de Conhecimento: injeta os trechos relevantes à pergunta atual, para o
    // assistente responder com base no material da empresa (e citar o documento).
    // Funciona mesmo com prompt personalizado, pois o contexto é anexado aqui.
    try {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || '';
      if (lastUser) {
        const hits = await searchKnowledge(accountId, lastUser);
        if (hits.length) {
          const contexto = hits.map((h, i) => `[${i + 1}] (${h.fileName})\n${h.content}`).join('\n\n');
          systemPrompt += `\n\n---\nBASE DE CONHECIMENTO (material interno da empresa). Use estes trechos para responder à pergunta, seguindo as regras de estilo definidas acima. NÃO mencione o nome do arquivo nem diga de onde tirou a informação — a não ser que o colaborador pergunte explicitamente a fonte. Se a resposta não estiver nos trechos, diga que não encontrou na base:\n\n${contexto}`;
        }
      }
    } catch (err) {
      console.error('[AI] Busca na base de conhecimento falhou:', err);
    }

    const convo: { role: string; content: string | AnthropicContentBlock[] }[] =
      messages.map((m) => ({ role: m.role, content: m.content }));

    // Arquivo anexado nesta mensagem (botão de anexo do chat): entra como bloco
    // de conteúdo na ÚLTIMA mensagem do colaborador, só para esta chamada à
    // Anthropic — o que fica salvo no histórico da conversa continua sendo
    // texto simples (ver fullMessages mais abaixo), então não pesa o banco.
    if (attachment?.dataBase64 && attachment.mimeType) {
      const lastIdx = convo.length - 1;
      if (lastIdx >= 0 && convo[lastIdx].role === 'user') {
        const textoAtual = typeof convo[lastIdx].content === 'string' ? (convo[lastIdx].content as string) : '';
        const isPdf = attachment.mimeType === 'application/pdf';
        const fileBlock: AnthropicContentBlock = {
          type: isPdf ? 'document' : 'image',
          source: { type: 'base64', media_type: attachment.mimeType, data: attachment.dataBase64 },
        };
        convo[lastIdx] = {
          role: 'user',
          content: [fileBlock, { type: 'text', text: textoAtual || 'Analise este documento.' }],
        };
      }
    }

    let reply = 'Essa tarefa tinha passos demais para eu terminar de uma vez — pode pedir de novo separando em partes menores (ex.: alguns clientes por mensagem)?';

    // Loop de tool-use: idas e voltas com o modelo por requisição. Folga maior
    // para pedidos em lote (ex.: mandar para vários números, criar vários
    // cards, ou atualizar vários leads de uma vez — cada nome que não bate de
    // primeira com find_lead consome uma ida a mais).
    for (let i = 0; i < 24; i++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1024,
          system: systemPrompt,
          tools: AGENT_TOOLS,
          messages: convo,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('[AI] Anthropic error:', response.status, err);
        res.status(502).json({ error: `Erro Anthropic ${response.status}: ${err}` });
        return;
      }

      const data = await response.json() as { content: AnthropicContentBlock[]; stop_reason: string };

      if (data.stop_reason === 'tool_use') {
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        // Cada chamada isolada num try/catch próprio — sem isso, UMA ferramenta
        // que lançasse uma exceção (mesmo com a rede de segurança dentro de
        // executeAgentTool, por garantia dupla) derrubava a resposta inteira
        // com "Erro interno ao processar IA", mesmo num lote com dezenas de
        // outras chamadas que teriam dado certo.
        const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
          let result: unknown;
          try {
            result = await executeAgentTool(block.name!, block.input || {}, accountId, io, req.user!.id, attachment);
          } catch (err: any) {
            console.error(`[AI] Erro inesperado na ferramenta ${block.name}:`, err);
            result = { success: false, error: `Erro inesperado ao executar ${block.name}: ${err?.message || 'erro desconhecido'}` };
          }
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
        }));

        convo.push({ role: 'assistant', content: data.content });
        convo.push({ role: 'user', content: toolResults });
        continue;
      }

      reply = data.content.find(b => b.type === 'text')?.text ?? reply;
      break;
    }

    // Persiste o histórico da conversa (por colaborador).
    const userId = req.user!.id;
    const fullMessages = [...messages, { role: 'assistant', content: reply }];
    let convId = conversationId;
    if (convId) {
      const existing = await prisma.assistantConversation.findFirst({ where: { id: convId, userId } });
      if (existing) {
        await prisma.assistantConversation.update({ where: { id: convId }, data: { messages: fullMessages as any } });
      } else {
        convId = undefined;
      }
    }
    if (!convId) {
      const firstUser = messages.find((m) => m.role === 'user')?.content?.trim() || 'Nova conversa';
      const title = firstUser.length > 60 ? firstUser.slice(0, 60) + '…' : firstUser;
      const created = await prisma.assistantConversation.create({
        data: { accountId, userId, title, messages: fullMessages as any },
      });
      convId = created.id;
    }

    res.json({ reply, conversationId: convId });
  } catch (err) {
    console.error('[AI] Erro support-chat:', err);
    res.status(500).json({ error: 'Erro interno ao processar IA' });
  }
});

// ── Histórico do chat do assistente (por colaborador) ────────────────────────
// Lista as conversas do colaborador logado (mais recentes primeiro).
router.get('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const conversations = await prisma.assistantConversation.findMany({
      where: { userId: req.user!.id },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    res.json(conversations);
  } catch {
    res.status(500).json({ error: 'Erro ao listar conversas' });
  }
});

// Abre uma conversa (mensagens) para continuar de onde parou.
router.get('/conversations/:id', async (req: AuthRequest, res: Response) => {
  try {
    const conv = await prisma.assistantConversation.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json({ id: conv.id, title: conv.title, messages: conv.messages });
  } catch {
    res.status(500).json({ error: 'Erro ao abrir conversa' });
  }
});

// Exclui uma conversa do histórico.
router.delete('/conversations/:id', async (req: AuthRequest, res: Response) => {
  try {
    const conv = await prisma.assistantConversation.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    await prisma.assistantConversation.delete({ where: { id: conv.id } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir conversa' });
  }
});

export default router;
