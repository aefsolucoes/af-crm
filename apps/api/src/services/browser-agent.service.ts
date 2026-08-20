import { PrismaClient } from '@prisma/client';
import { getExtensionSocketId } from '../websocket';
import { searchKnowledge } from './knowledge.service';
import { resolveClientDriveDocuments, extractKeyFieldsFromDocs } from '../routes/ai';

const prisma = new PrismaClient();

type IO = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

// Mesmo formato de bloco de conteúdo já usado em apps/api/src/routes/ai.ts
// (support-chat) — screenshot vira {type:'image', source:{type:'base64', ...}},
// o mesmo jeito que um anexo de imagem já entra na conversa hoje.
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  source?: { type: 'base64'; media_type: string; data: string };
  tool_use_id?: string;
  content?: AnthropicContentBlock[] | string;
}

const VIEWPORT = { width: 1280, height: 800 };

/** Monta o system prompt do agente, com o MANUAL relevante da Base de
 *  Conhecimento (se houver algum cadastrado — ver Configurações → Base de
 *  Conhecimento) encaixado antes das regras de segurança. É o mesmo
 *  searchKnowledge já usado pelo assistente interno e pela IA do WhatsApp —
 *  um manual (PDF/Doc) explicando login/navegação de um site específico
 *  (ex.: "como emitir certidão no ONR", "como consultar dados no sistema X")
 *  vira contexto automático pro agente seguir o passo a passo certo, em vez
 *  de tentar adivinhar navegando às cegas. */
function buildBrowserAgentSystemPrompt(manualTexto: string): string {
  return `Você é o Agente de Navegador do AF CRM — controla um navegador Chrome REAL (a tela e o mouse/teclado de verdade do colaborador) para executar tarefas em sites externos ao CRM, a partir de um pedido em linguagem natural.

Como funciona: a cada passo você recebe uma SCREENSHOT real da aba ativa (${VIEWPORT.width}x${VIEWPORT.height} pixels — as coordenadas x,y que você usar em browser_click/browser_type são relativas a essa imagem) e decide a PRÓXIMA ação usando as ferramentas disponíveis. Depois de cada ação, você recebe uma nova screenshot mostrando o resultado.

${manualTexto ? `--- MANUAL DE REFERÊNCIA (da Base de Conhecimento, relevante pra essa tarefa) ---\n${manualTexto}\n\nSiga esse manual como guia principal de COMO navegar/agir neste site (onde clicar, ordem dos passos) — mas ainda decida cada ação olhando a screenshot de verdade, o site pode ter mudado desde que o manual foi escrito.\n` : ''}
Você pode PAUSAR a tarefa e falar com o operador (o colaborador que pediu essa tarefa) usando a ferramenta ask_human — ele responde ao vivo e você continua de onde parou:
- kind="question": use sempre que precisar de um dado que não tem certeza (CPF, valor de um campo do formulário, qual opção escolher numa tela ambígua) e não achou nos documentos do cliente nem na tela. NUNCA invente ou chute um valor — pergunte.
- kind="approval": use ANTES de confirmar/finalizar qualquer ação que pareça irreversível (enviar, comprar, assinar, emitir um documento oficial, submeter um formulário definitivo) — explique exatamente o que está prestes a fazer e espere a aprovação antes de clicar nesse botão.
- Chame ask_human SOZINHA no turno (sem combinar com outra ferramenta) e pare — a resposta do operador chega no próximo turno, como se fosse o resultado dessa ferramenta.

Regras fixas de segurança (sem exceção):
- NUNCA digite senha, CPF+senha, código de certificado digital, dados de cartão/pagamento, nem tente resolver um CAPTCHA. Se a tarefa exigir qualquer um desses passos, PARE e explique em texto (sem chamar mais nenhuma ferramenta, nem ask_human — ainda não existe como o operador assumir o controle da aba ao vivo) o que falta um humano fazer manualmente — não tente contornar.
- Vá com calma: olhe a screenshot com atenção antes de clicar, prefira poucos passos deliberados a muitos passos apressados.

Quando terminar a tarefa (ou quando precisar parar por causa da regra de senha/CAPTCHA acima), responda em TEXTO simples (sem chamar mais ferramentas) resumindo o que foi feito e o que falta, se algo faltar.`;
}

const BROWSER_AGENT_TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navega a aba para uma URL. Devolve uma screenshot fresca da página carregada.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL completa, com https://' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Clica num ponto (x,y) da tela, nas coordenadas da última screenshot recebida. Devolve uma screenshot fresca depois do clique.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        description: { type: 'string', description: 'O que você está clicando (ex.: "botão Pesquisar") — ajuda a auditar depois.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'browser_type',
    description: 'Digita texto no elemento atualmente em foco da página (clique nele antes, se precisar). NÃO use para senhas ou dados sensíveis. Devolve uma screenshot fresca.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'browser_key',
    description: 'Pressiona uma tecla especial no elemento em foco (Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight). Devolve uma screenshot fresca.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] } },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Rola a página. Devolve uma screenshot fresca depois de rolar.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels a rolar (padrão 400).' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Espera alguns segundos (ex.: pra a página terminar de carregar) e então tira uma screenshot fresca.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'No máximo 10 segundos.' },
        reason: { type: 'string' },
      },
      required: ['seconds', 'reason'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Só olha a tela de novo, sem fazer nenhuma ação (ex.: depois de um browser_wait).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_human',
    description:
      'Pausa a tarefa e pergunta ao operador antes de continuar. Use kind="question" quando precisar de uma informação que não tem certeza (dado do cliente, valor de campo, qual opção escolher). Use kind="approval" quando estiver prestes a confirmar uma ação irreversível (enviar, comprar, assinar, emitir, submeter) e precisar de aprovação explícita antes de clicar. Chame sozinha, sem combinar com outra ferramenta no mesmo turno — você recebe a resposta do operador no próximo turno.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['question', 'approval'] },
        message: { type: 'string', description: 'A pergunta ou o que está prestes a fazer, em português claro e direto pro operador entender e responder rápido.' },
      },
      required: ['kind', 'message'],
    },
  },
] as const;

/** Relaya um comando pra extensão do usuário (mesmo mecanismo das rotas de
 *  teste da Fase 0) e devolve o resultado bruto ({ok, screenshot} ou {error}). */
async function relayBrowserCommand(
  io: IO,
  userId: string,
  command: Record<string, unknown>
): Promise<{ ok?: boolean; error?: string; screenshot?: string }> {
  const socketId = getExtensionSocketId(userId);
  if (!socketId) {
    return { error: 'Extensão do Agente de Navegador não está conectada. Abra o Chrome com a extensão carregada e logada.' };
  }
  try {
    // io.to(...).timeout(...).emitWithAck(...) — mesmo padrão das rotas de
    // teste (Fase 0), agora reaproveitado dentro do loop de decisão.
    const result = (await (io as any).to(socketId).timeout(20000).emitWithAck('agent_command', command)) as unknown[];
    return (result?.[0] as any) ?? { error: 'Extensão não respondeu' };
  } catch (err: any) {
    return { error: `Extensão não respondeu a tempo: ${err?.message || 'timeout'}` };
  }
}

/** Executa uma tool do agente (relay pra extensão) e devolve os content
 *  blocks prontos pra virar um tool_result — texto + (se houver) a imagem. */
async function executeBrowserTool(
  io: IO,
  userId: string,
  name: string,
  input: Record<string, any>
): Promise<{ blocks: AnthropicContentBlock[]; ok: boolean; summary: string }> {
  let command: Record<string, unknown> | null = null;
  if (name === 'browser_navigate') command = { type: 'navigate', url: String(input.url || '') };
  else if (name === 'browser_click') command = { type: 'click', x: Number(input.x), y: Number(input.y) };
  else if (name === 'browser_type') command = { type: 'type', text: String(input.text ?? '') };
  else if (name === 'browser_key') command = { type: 'key', key: String(input.key || '') };
  else if (name === 'browser_scroll') command = { type: 'scroll', direction: String(input.direction || 'down'), amount: Number(input.amount) || 400 };
  else if (name === 'browser_wait') command = { type: 'wait', seconds: Math.min(Number(input.seconds) || 2, 10) };
  else if (name === 'browser_screenshot') command = { type: 'screenshot' };

  if (!command) {
    return { ok: false, summary: `Ferramenta desconhecida: ${name}`, blocks: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }] };
  }

  const result = await relayBrowserCommand(io, userId, command);
  if (result.error || !result.screenshot) {
    const msg = result.error || 'Sem screenshot na resposta';
    return { ok: false, summary: msg, blocks: [{ type: 'text', text: `Erro: ${msg}` }] };
  }

  return {
    ok: true,
    summary: 'Ação executada.',
    blocks: [
      { type: 'text', text: 'Ação executada com sucesso. Screenshot atual em anexo.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.screenshot } },
    ],
  };
}

/** Substitui screenshots de turnos antigos por um texto — mantém só as
 *  últimas `keepLast` (custo de tokens de visão cresce rápido, e o Json no
 *  banco também). Roda em cima do MESMO array usado na chamada seguinte à
 *  Anthropic, então também limita o tamanho do próximo request. */
function pruneOldScreenshots(convo: { role: string; content: any }[], keepLast = 2) {
  const toolResultTurns: number[] = [];
  convo.forEach((m, i) => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')) {
      toolResultTurns.push(i);
    }
  });
  const cutoff = Math.max(0, toolResultTurns.length - keepLast);
  const toPrune = new Set(toolResultTurns.slice(0, cutoff));
  for (const i of toPrune) {
    const msg = convo[i];
    msg.content = (msg.content as any[]).map((block) => {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
      return {
        ...block,
        content: block.content.map((c: any) => (c.type === 'image' ? { type: 'text', text: '[screenshot anterior removida]' } : c)),
      };
    });
  }
}

const MAX_STEPS = 40;

type Task = NonNullable<Awaited<ReturnType<typeof prisma.agentTask.findUnique>>>;

/** Contexto extra pro agente, montado UMA vez antes do loop (não muda passo
 *  a passo): 1) manual relevante da Base de Conhecimento (como navegar no
 *  site — login, onde clicar); 2) se a tarefa é de um lead específico, os
 *  dados desse cliente (nome, CPF, endereço, renda etc, extraídos dos
 *  documentos dele no Drive — mesma extração usada por preencher_
 *  formulario_editavel) — assim "preenche a PFI do Sebastião" já chega pro
 *  agente sabendo tanto COMO navegar quanto O QUE digitar. Reaproveitado
 *  tanto no início da tarefa quanto em cada retomada depois de uma pausa
 *  (ask_human) — é uma busca barata, não vale a pena persistir. */
async function buildSystemPromptForTask(task: Task, accountId: string, apiKey: string): Promise<string> {
  let manualTexto = '';
  try {
    const kbHits = await searchKnowledge(accountId, task.instruction, 5);
    if (kbHits.length) {
      manualTexto += kbHits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n');
    }
  } catch (err) {
    console.error('[Agente de Navegador] Busca na Base de Conhecimento falhou:', err);
  }
  if (task.leadId) {
    try {
      const lead = await prisma.lead.findFirst({ where: { id: task.leadId, accountId } });
      if (lead) {
        const resolved = await resolveClientDriveDocuments(accountId, lead.name);
        if (resolved.ok) {
          const transcricao = await extractKeyFieldsFromDocs(apiKey, resolved.docs);
          if (transcricao) {
            manualTexto += `${manualTexto ? '\n\n' : ''}--- DADOS DO CLIENTE "${lead.name}" (extraídos dos documentos dele no Drive) ---\n${transcricao}`;
          }
        }
      }
    } catch (err) {
      console.error('[Agente de Navegador] Falha ao carregar dados do cliente:', err);
    }
  }
  return buildBrowserAgentSystemPrompt(manualTexto);
}

interface PendingAction {
  toolUseId: string;
  kind: 'question' | 'approval';
  message: string;
  logId: string;
  otherResults: AnthropicContentBlock[];
}

/** Corpo do loop de decisão em si — chamado tanto do início de uma tarefa
 *  (runAgentLoop) quanto de uma retomada depois de uma pausa (ask_human,
 *  via continueAgentLoop). `startSeq` continua a numeração de
 *  AgentActionLog/stepCount de onde parou (nunca zera, mesmo numa retomada,
 *  senão duplicaria `seq` no log e na key do React). MAX_STEPS vale por
 *  "perna" de execução (do início ou de cada retomada) — não é orçamento
 *  vitalício da tarefa, simplificação deliberada: toda pausa é gated por um
 *  humano, não tem risco de loop infinito. */
async function executeLoop(
  taskId: string,
  userId: string,
  io: IO,
  systemPrompt: string,
  convo: { role: string; content: any }[],
  startSeq: number
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  let seq = startSeq;
  let finalText = 'A tarefa não terminou dentro do limite de passos — peça de novo dividindo em partes menores.';

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      // Alguém pode ter cancelado via POST /tasks/:id/cancel enquanto o loop rodava.
      const fresh = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } });
      if (!fresh || fresh.status === 'CANCELLED') {
        io.to(`user_${userId}`).emit('agent_task_status', { taskId, status: 'CANCELLED' });
        return;
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1024,
          system: systemPrompt,
          tools: BROWSER_AGENT_TOOLS,
          messages: convo,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Agente de Navegador] Erro Anthropic:', response.status, errText);
        await finishTask(taskId, userId, io, 'FAILED', undefined, `Erro da IA (${response.status}): ${errText.slice(0, 300)}`);
        return;
      }

      const data = (await response.json()) as { content: AnthropicContentBlock[]; stop_reason: string };

      if (data.stop_reason === 'tool_use') {
        const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');
        const askHumanBlock = toolUseBlocks.find((b) => b.name === 'ask_human');
        const otherBlocks = toolUseBlocks.filter((b) => b.name !== 'ask_human');
        const toolResults: AnthropicContentBlock[] = [];

        for (const block of otherBlocks) {
          seq += 1;
          const { blocks, ok, summary } = await executeBrowserTool(io, userId, block.name!, block.input || {});
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: blocks });

          await prisma.agentActionLog.create({
            data: { taskId, seq, tool: block.name!, input: block.input || {}, output: { ok, summary } as any },
          });
          await prisma.agentTask.update({ where: { id: taskId }, data: { stepCount: seq } });

          io.to(`user_${userId}`).emit('agent_step', {
            taskId,
            seq,
            tool: block.name,
            input: block.input,
            ok,
            summary,
            screenshot: blocks.find((b) => b.type === 'image')?.source?.data,
          });
        }

        convo.push({ role: 'assistant', content: data.content });

        if (askHumanBlock) {
          // Pausa: o turno do assistant já entrou no convo, mas o tool_result
          // do ask_human ainda falta — só entra quando o operador responder
          // (applyHumanResponse). Guarda os resultados das OUTRAS ferramentas
          // do mesmo turno (se o modelo combinou, mesmo sendo instruído a não
          // combinar) em pendingAction.otherResults pra completar o turno certo
          // na retomada.
          seq += 1;
          const kind: 'question' | 'approval' = askHumanBlock.input?.kind === 'approval' ? 'approval' : 'question';
          const message = String(askHumanBlock.input?.message || 'O agente precisa da sua ajuda pra continuar.');
          const log = await prisma.agentActionLog.create({
            data: { taskId, seq, tool: 'ask_human', input: { kind, message }, requiredApproval: kind === 'approval' },
          });
          const pendingAction: PendingAction = { toolUseId: askHumanBlock.id!, kind, message, logId: log.id, otherResults: toolResults };
          await prisma.agentTask.update({
            where: { id: taskId },
            data: {
              stepCount: seq,
              status: kind === 'approval' ? 'AWAITING_APPROVAL' : 'AWAITING_ANSWER',
              pendingAction: pendingAction as any,
              conversation: convo as any,
            },
          });
          io.to(`user_${userId}`).emit('agent_task_status', {
            taskId,
            status: kind === 'approval' ? 'AWAITING_APPROVAL' : 'AWAITING_ANSWER',
            pendingAction: { kind, message },
          });
          return;
        }

        convo.push({ role: 'user', content: toolResults });
        pruneOldScreenshots(convo);
        await prisma.agentTask.update({ where: { id: taskId }, data: { conversation: convo as any } });
        continue;
      }

      finalText = data.content.find((b) => b.type === 'text')?.text ?? finalText;
      break;
    }

    await finishTask(taskId, userId, io, 'COMPLETED', finalText);
  } catch (err: any) {
    console.error('[Agente de Navegador] Erro no loop:', err);
    await finishTask(taskId, userId, io, 'FAILED', undefined, err?.message || 'Erro inesperado no loop.');
  }
}

/** Inicia o loop de decisão de uma tarefa nova do zero — dispara em
 *  background a partir da rota POST /tasks, sem manter a requisição HTTP
 *  aberta (cada passo envolve uma ida-e-volta real até o Chrome do usuário,
 *  que pode levar segundos — inviável segurar isso numa única requisição). */
export async function runAgentLoop(taskId: string, accountId: string, userId: string, io: IO): Promise<void> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!task) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await finishTask(taskId, userId, io, 'FAILED', undefined, 'ANTHROPIC_API_KEY não configurada no servidor.');
    return;
  }

  await prisma.agentTask.update({ where: { id: taskId }, data: { status: 'RUNNING' } });
  io.to(`user_${userId}`).emit('agent_task_status', { taskId, status: 'RUNNING' });

  const systemPrompt = await buildSystemPromptForTask(task, accountId, apiKey);
  const convo: { role: string; content: any }[] = [{ role: 'user', content: task.instruction }];
  await executeLoop(taskId, userId, io, systemPrompt, convo, 0);
}

/** Aplica a resposta do operador (aprovar/recusar ou responder uma pergunta)
 *  a uma tarefa pausada em AWAITING_APPROVAL/AWAITING_ANSWER — completa o
 *  turno pendente e devolve a tarefa pra RUNNING. Não roda o loop em si (ver
 *  continueAgentLoop) — só a parte síncrona/rápida, pra rota poder responder
 *  200 na hora, igual o POST /tasks já faz hoje. Escopado só por accountId
 *  (não por userId de quem está respondendo) — mesmo critério já usado pela
 *  rota /cancel existente, qualquer um com a permissão browser_agent na
 *  conta pode agir sobre a tarefa. */
export async function applyHumanResponse(
  taskId: string,
  accountId: string,
  response: { approve: boolean } | { answer: string },
  io: IO
): Promise<{ ok: true; task: Task } | { ok: false; error: string; status: number }> {
  const task = await prisma.agentTask.findFirst({ where: { id: taskId, accountId } });
  if (!task) return { ok: false, error: 'Tarefa não encontrada', status: 404 };
  if (task.status !== 'AWAITING_APPROVAL' && task.status !== 'AWAITING_ANSWER') {
    return { ok: false, error: 'Essa tarefa não está esperando resposta agora.', status: 409 };
  }
  const pending = task.pendingAction as unknown as PendingAction | null;
  if (!pending) return { ok: false, error: 'Tarefa sem ação pendente registrada.', status: 409 };

  let resultText: string;
  let logOutput: Record<string, unknown>;
  if (pending.kind === 'approval') {
    if (!('approve' in response)) return { ok: false, error: 'Essa tarefa espera aprovação (approve: true/false).', status: 400 };
    resultText = response.approve
      ? 'Aprovado pelo operador. Pode prosseguir.'
      : 'Recusado pelo operador. NÃO tente executar essa ação de novo — finalize a tarefa explicando em texto o que ficou pendente.';
    logOutput = { ok: response.approve, summary: response.approve ? 'Aprovado pelo operador.' : 'Recusado pelo operador.', approved: response.approve };
  } else {
    if (!('answer' in response) || !response.answer.trim()) return { ok: false, error: 'Essa tarefa espera uma resposta em texto (answer).', status: 400 };
    resultText = response.answer.trim();
    logOutput = { ok: true, summary: `Resposta: "${resultText}"`, answer: resultText };
  }

  const toolResults: AnthropicContentBlock[] = [
    ...(pending.otherResults || []),
    { type: 'tool_result', tool_use_id: pending.toolUseId, content: [{ type: 'text', text: resultText }] },
  ];
  const convo = ((task.conversation as any[]) || []).slice();
  convo.push({ role: 'user', content: toolResults });
  pruneOldScreenshots(convo);

  await prisma.agentActionLog.update({ where: { id: pending.logId }, data: { output: logOutput as any } });
  const updated = await prisma.agentTask.update({
    where: { id: taskId },
    data: { status: 'RUNNING', pendingAction: null as any, conversation: convo as any },
  });
  io.to(`user_${task.userId}`).emit('agent_task_status', { taskId, status: 'RUNNING' });

  return { ok: true, task: updated };
}

/** Retoma o loop de uma tarefa depois de applyHumanResponse ter completado o
 *  turno pendente — recarrega a conversa persistida e o stepCount do banco
 *  (não recebe nada em memória: o processo pode até ter reiniciado entre a
 *  pausa e a resposta) e recalcula o system prompt (mesma busca de Base de
 *  Conhecimento + dados do cliente do início, é barato). */
export async function continueAgentLoop(taskId: string, accountId: string, io: IO): Promise<void> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!task) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await finishTask(taskId, task.userId, io, 'FAILED', undefined, 'ANTHROPIC_API_KEY não configurada no servidor.');
    return;
  }
  const systemPrompt = await buildSystemPromptForTask(task, accountId, apiKey);
  const convo = ((task.conversation as any[]) || []).slice();
  await executeLoop(taskId, task.userId, io, systemPrompt, convo, task.stepCount);
}

async function finishTask(
  taskId: string,
  userId: string,
  io: IO,
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
  resultSummary?: string,
  errorMessage?: string
) {
  await prisma.agentTask.update({
    where: { id: taskId },
    data: { status, resultSummary, errorMessage, completedAt: new Date() },
  });
  io.to(`user_${userId}`).emit('agent_task_status', { taskId, status, resultSummary, errorMessage });
}

/** Ao subir o processo, tarefas que ficaram "RUNNING" (o servidor reiniciou
 *  no meio) nunca mais vão terminar sozinhas — o loop delas morreu junto com
 *  o processo anterior, no meio de uma ação sem estado bem definido pra
 *  retomar. Marca como FAILED em vez de deixar penduradas pra sempre como
 *  "rodando". Diferente de AWAITING_APPROVAL/AWAITING_ANSWER (essas ficam
 *  penduradas de propósito — a conversa persistida sabe exatamente o que
 *  falta, continueAgentLoop retoma normalmente mesmo depois de um restart). */
export async function failOrphanedRunningTasks(): Promise<void> {
  const { count } = await prisma.agentTask.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', errorMessage: 'A API reiniciou no meio desta tarefa.', completedAt: new Date() },
  });
  if (count > 0) console.log(`[Agente de Navegador] ${count} tarefa(s) órfã(s) marcada(s) como falhas ao subir.`);
}
