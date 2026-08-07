import { Router, Response } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendOutboundWhatsApp, findOrCreateLeadByPhone, listConnectedWhatsAppNumbers, resolveStageTarget } from '../services/message.service';
import { searchKnowledge } from '../services/knowledge.service';
import {
  organizeLeadDocsToDrive, downloadDriveFile, findFolderByNameUnderRoot, listFolderContents,
  createFolder, renameFile, moveDriveItem, trashDriveItem, folderLink,
} from '../services/google.service';
import { deleteLead } from '../services/lead.service';
import { effectivePermissions, PERMISSION_KEYS, PermissionKey } from '../lib/permissions';

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
- find_lead: busca um lead já cadastrado pelo NOME ou pelo TELEFONE. Quando o colaborador der um número e perguntar se existe cliente com ele (ex: "tem algum cliente com o número 61 8454-9012?"), use find_lead com o parâmetro phone — a busca ignora pontuação, o DDI 55 e o 9º dígito do celular, e procura no contato e nos campos do cadastro. Não invente dígitos: passe o número como o colaborador escreveu.
- get_recent_messages: lê o histórico de mensagens de um lead.
- send_whatsapp_message: envia para um lead JÁ existente (por leadId).
- send_whatsapp_to_number: quando o colaborador fornecer um NÚMERO de telefone (ex: "manda mensagem para o 61 99999-9999"), use esta ferramenta — ela cria o contato/lead automaticamente e envia. Sempre que o pedido incluir um número, use send_whatsapp_to_number diretamente, sem exigir que o lead já exista. Aceita stageId (para criar o card num funil/estágio específico) e fromNumberId (número de WhatsApp de origem).
- list_whatsapp_numbers: lista os números de WhatsApp conectados (id + apelido). Use antes de enviar quando houver MAIS DE UM número conectado e o colaborador não tiver dito de qual enviar: mostre os apelidos e PERGUNTE qual usar. Se só houver um conectado, use-o sem perguntar. Passe o id escolhido em fromNumberId ao enviar.
- list_pipelines: lista os funis e seus estágios (com ids). Use para achar o stageId quando o colaborador pedir para criar o card num funil/estágio específico (ex: "no funil Follow-up, estágio Remarketing números"). Depois passe esse stageId em send_whatsapp_to_number. Você TEM, sim, como criar o card num estágio específico — nunca diga que não consegue.
- move_lead_to_stage: move um card JÁ EXISTENTE para outro funil/estágio. Use quando pedirem para mover/colocar um card em outro lugar (ex: "move o card do João para Remarketing"). Antes, use find_lead (leadId) e list_pipelines (stageId). Você CONSEGUE mover cards de funil e de estágio — nunca diga que não consegue.
- salvar_documentos_no_drive: quando o colaborador pedir para "criar a pasta do cliente", "organizar a documentação" ou "salvar os documentos no Drive", use esta ferramenta. Primeiro use find_lead para achar o cliente, depois chame salvar_documentos_no_drive com o leadId e o nome da pasta (o nome do cliente, salvo se o colaborador pedir outro nome). Se o colaborador indicar uma sub-pasta de destino (ex: "faça uma pasta em LEADS ATIVOS"), passe-a em pastaDestino; senão, deixe vazio e ela cria direto na pasta-raiz. Importante: só crie a pasta e suba os documentos quando o colaborador pedir — os arquivos ficam guardados até esse pedido. Ela JÁ SALVA sozinha o link da pasta no card do cliente (campo "Pasta no Drive", que aparece na aba Principal do card). Depois, informe ao colaborador o link da pasta e quais arquivos foram enviados. Se, em qualquer outro momento, o colaborador pedir para "salvar o link dessa pasta no card" (ex: depois de criar/renomear/mover uma pasta com outra ferramenta), use update_lead com fields: { link_pasta_drive: <link> } — o campo é criado sozinho na primeira vez que for usado.
- ler_documento_identificacao: quando o colaborador pedir para "ler a CNH desse cliente", "pegar os dados do documento/identidade que ele mandou", "extrair CPF e nascimento do RG" etc, use esta ferramenta. Primeiro use find_lead para achar o cliente, depois chame ler_documento_identificacao com o leadId — ela procura primeiro na PASTA DO CLIENTE no Drive e, se não achar nada lá, cai para a foto/PDF mais recente enviado pelo cliente no WhatsApp (se o colaborador apontar um arquivo específico, use nomeArquivo ou attachmentId). Ela retorna nome completo, CPF, data de nascimento e, se o documento for um comprovante de renda, a renda. SEMPRE mostre os dados extraídos ao colaborador antes de gravar (a leitura pode errar) e, se ele confirmar, use update_lead com fields para preencher participante_1 (nome), cpf_1, nascimento_1 e/ou renda_1 — só os campos que vieram diferentes de null. NUNCA invente um dado que o documento não mostrou com clareza.
- listar_pasta_drive / criar_pasta_drive / renomear_item_drive / mover_item_drive / excluir_item_drive: acesso completo ao Google Drive das pastas de clientes. listar_pasta_drive mostra o que tem numa pasta (do cliente, via leadId, ou qualquer uma pelo nome/ID). criar_pasta_drive cria uma pasta nova em qualquer lugar. renomear_item_drive renomeia arquivo/pasta — para "renomear a pasta do cliente para o nome completo em caixa alta" sem que o colaborador dite o texto exato, use leadId (sem itemId) e novoNome como o nome do lead em MAIÚSCULAS. mover_item_drive move um item para dentro de outra pasta. excluir_item_drive apaga (manda pra lixeira) um arquivo/pasta — é AÇÃO IRREVERSÍVEL, segue a regra de confirmação dupla abaixo.
- create_lead / update_lead / archive_lead / delete_lead: criar, editar, arquivar e EXCLUIR cards do funil.
- list_users / create_user / update_user / delete_user: gerenciar a equipe (criar, editar nome/e-mail/senha/função/permissões e EXCLUIR/tirar acesso). Para "tirar acesso" use update_user (mudando função/permissões) ou delete_user.
Você tem acesso completo ao CRM, MAS sempre respeitando o nível de acesso do colaborador: cada ferramenta checa a permissão dele. Se uma ferramenta retornar erro de permissão, explique com educação que ele não tem acesso àquela ação e não tente por outro caminho.
CONFIRMAÇÃO DUPLA obrigatória para ações IRREVERSÍVEIS (excluir card, excluir usuário / tirar acesso, excluir arquivo/pasta do Drive): antes de executar, pergunte se o colaborador confirma; quando ele confirmar, pergunte MAIS UMA VEZ ("Tem certeza? Isso não pode ser desfeito.") e só após a SEGUNDA confirmação chame a ferramenta com confirmed:true. Nunca passe confirmed:true sem ter perguntado duas vezes. Se a ferramenta retornar needsConfirmation, é porque faltou confirmar — não invente que foi feito.
Nunca envie uma mensagem nem salve documentos sem que o colaborador tenha pedido isso na conversa atual. Depois de agir, confirme exatamente o que foi feito.
IMPORTANTE: só afirme que uma mensagem foi ENVIADA quando a ferramenta retornar success: true. Se a ferramenta retornar success: false, NÃO diga que enviou — avise o colaborador que a mensagem NÃO foi enviada e explique o motivo do campo "error" (por exemplo, quando o número não tem WhatsApp ou o QR Code está desconectado). Nunca invente um status "SENT".
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

async function executeAgentTool(
  name: string,
  input: Record<string, any>,
  accountId: string,
  io: any,
  userId?: string
): Promise<unknown> {
  // Permissões efetivas do colaborador que está usando o assistente. Toda ação
  // sensível checa isto; ações irreversíveis exigem confirmação dupla (o modelo
  // pergunta duas vezes e só então passa confirmed:true — ver system prompt).
  const me = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true, permissions: true } }) : null;
  const perms = effectivePermissions(me?.role || 'AGENT', me?.permissions ?? null);
  const deny = (key: PermissionKey, acao: string) =>
    ({ success: false as const, error: `Você não tem permissão para ${acao}. (Falta o acesso "${key}".)` });

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
      const leads = await prisma.lead.findMany({
        where: { accountId, archived: false },
        include: { contact: true },
        take: 500,
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
        phone: l.contact?.whatsappPhone || l.contact?.phone || null,
      }));
    }

    const leads = await prisma.lead.findMany({
      where: { accountId, archived: false, name: { contains: nameQuery, mode: 'insensitive' } },
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
      where: { leadId: String(input.leadId), lead: { accountId } },
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
      where: { accountId },
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
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
    const target = await resolveStageTarget(
      accountId,
      input.pipelineId ? String(input.pipelineId) : undefined,
      input.stageId ? String(input.stageId) : undefined,
    );
    if (!target) return { success: false, error: 'Funil/estágio de destino não encontrado. Use list_pipelines para obter o stageId.' };
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
    const lead = await prisma.lead.findFirst({ where: { id: String(input.leadId || ''), accountId } });
    if (!lead) return { success: false, error: 'Lead não encontrado' };
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

    // Se pediram um funil/estágio específico, resolve e valida antes de criar o card.
    let target: { pipelineId: string; stageId: string } | undefined;
    if (input.stageId || input.pipelineId) {
      const resolved = await resolveStageTarget(
        accountId,
        input.pipelineId ? String(input.pipelineId) : undefined,
        input.stageId ? String(input.stageId) : undefined,
      );
      if (!resolved) return { success: false, error: 'Funil/estágio não encontrado. Use list_pipelines para obter o stageId correto.' };
      target = resolved;
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
          let chosen = files[0] || null;
          if (nomeArquivo) {
            chosen = files.find((f) => f.name.toLowerCase().includes(nomeArquivo)) || chosen;
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

  return { error: `Ferramenta desconhecida: ${name}` };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
}

router.post('/support-chat', async (req: AuthRequest, res: Response) => {
  const { messages, conversationId } = req.body as { messages?: ChatMessage[]; conversationId?: string };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages é obrigatório e deve ser uma lista não vazia' });
    return;
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

    let reply = 'Não consegui gerar uma resposta agora.';

    // Loop de tool-use: idas e voltas com o modelo por requisição. Folga maior
    // para envios em lote (ex.: mandar para vários números + criar os cards).
    for (let i = 0; i < 12; i++) {
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
        const toolResults = await Promise.all(toolUseBlocks.map(async (block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(await executeAgentTool(block.name!, block.input || {}, accountId, io, req.user!.id)),
        })));

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
