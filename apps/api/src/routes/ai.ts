import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendOutboundWhatsApp, findOrCreateLeadByPhone, listConnectedWhatsAppNumbers, resolveStageTarget } from '../services/message.service';
import { searchKnowledge } from '../services/knowledge.service';
import { organizeLeadDocsToDrive } from '../services/google.service';

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
- find_lead: busca um lead já cadastrado pelo nome.
- get_recent_messages: lê o histórico de mensagens de um lead.
- send_whatsapp_message: envia para um lead JÁ existente (por leadId).
- send_whatsapp_to_number: quando o colaborador fornecer um NÚMERO de telefone (ex: "manda mensagem para o 61 99999-9999"), use esta ferramenta — ela cria o contato/lead automaticamente e envia. Sempre que o pedido incluir um número, use send_whatsapp_to_number diretamente, sem exigir que o lead já exista. Aceita stageId (para criar o card num funil/estágio específico) e fromNumberId (número de WhatsApp de origem).
- list_whatsapp_numbers: lista os números de WhatsApp conectados (id + apelido). Use antes de enviar quando houver MAIS DE UM número conectado e o colaborador não tiver dito de qual enviar: mostre os apelidos e PERGUNTE qual usar. Se só houver um conectado, use-o sem perguntar. Passe o id escolhido em fromNumberId ao enviar.
- list_pipelines: lista os funis e seus estágios (com ids). Use para achar o stageId quando o colaborador pedir para criar o card num funil/estágio específico (ex: "no funil Follow-up, estágio Remarketing números"). Depois passe esse stageId em send_whatsapp_to_number. Você TEM, sim, como criar o card num estágio específico — nunca diga que não consegue.
- move_lead_to_stage: move um card JÁ EXISTENTE para outro funil/estágio. Use quando pedirem para mover/colocar um card em outro lugar (ex: "move o card do João para Remarketing"). Antes, use find_lead (leadId) e list_pipelines (stageId). Você CONSEGUE mover cards de funil e de estágio — nunca diga que não consegue.
- salvar_documentos_no_drive: quando o colaborador pedir para "criar a pasta do cliente", "organizar a documentação" ou "salvar os documentos no Drive", use esta ferramenta. Primeiro use find_lead para achar o cliente, depois chame salvar_documentos_no_drive com o leadId e o nome da pasta (o nome do cliente, salvo se o colaborador pedir outro nome). Se o colaborador indicar uma sub-pasta de destino (ex: "faça uma pasta em LEADS ATIVOS"), passe-a em pastaDestino; senão, deixe vazio e ela cria direto na pasta-raiz. Importante: só crie a pasta e suba os documentos quando o colaborador pedir — os arquivos ficam guardados até esse pedido. Depois, informe ao colaborador o link da pasta e quais arquivos foram enviados.
Nunca envie uma mensagem nem salve documentos sem que o colaborador tenha pedido isso na conversa atual. Depois de agir, confirme exatamente o que foi feito.
IMPORTANTE: só afirme que uma mensagem foi ENVIADA quando a ferramenta retornar success: true. Se a ferramenta retornar success: false, NÃO diga que enviou — avise o colaborador que a mensagem NÃO foi enviada e explique o motivo do campo "error" (por exemplo, quando o número não tem WhatsApp ou o QR Code está desconectado). Nunca invente um status "SENT".
Responda em português, de forma curta, direta e prática, como se estivesse explicando para um colega de trabalho. Se a dúvida não tiver relação com o CRM ou o processo da empresa, explique educadamente que você só pode ajudar com isso.`;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const AGENT_TOOLS = [
  {
    name: 'find_lead',
    description: 'Busca leads/clientes pelo nome (ou parte do nome) para descobrir o ID do lead antes de ler mensagens ou enviar uma resposta. Retorna nome, telefone e id de cada lead encontrado.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome ou parte do nome do lead/cliente a buscar' },
      },
      required: ['name'],
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
];

async function executeAgentTool(
  name: string,
  input: Record<string, any>,
  accountId: string,
  io: any,
  userId?: string
): Promise<unknown> {
  if (name === 'find_lead') {
    const leads = await prisma.lead.findMany({
      where: { accountId, archived: false, name: { contains: String(input.name || ''), mode: 'insensitive' } },
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

  if (name === 'send_whatsapp_message') {
    const result = await sendOutboundWhatsApp({
      accountId,
      leadId: String(input.leadId),
      content: String(input.content || ''),
      fromNumberId: input.fromNumberId ? String(input.fromNumberId) : undefined,
      io,
    });
    return result;
  }

  if (name === 'send_whatsapp_to_number') {
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
      return {
        success: true,
        pasta: res.folderName,
        dentroDe: res.parentFolderName,
        link: res.folderUrl,
        enviados: res.uploaded,
        jaEstavamNaPasta: res.alreadyThere,
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao salvar no Drive' };
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
  const { messages } = req.body as { messages?: ChatMessage[] };

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

    res.json({ reply });
  } catch (err) {
    console.error('[AI] Erro support-chat:', err);
    res.status(500).json({ error: 'Erro interno ao processar IA' });
  }
});

export default router;
