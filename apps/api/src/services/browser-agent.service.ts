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
Regras fixas de segurança (ainda sem exceção nesta versão):
- NUNCA digite senha, CPF+senha, código de certificado digital, dados de cartão/pagamento, nem tente resolver um CAPTCHA. Se a tarefa exigir qualquer um desses passos, PARE e explique em texto (sem chamar mais nenhuma ferramenta) o que falta um humano fazer manualmente — não tente contornar.
- Não confirme/finalize nenhuma ação que pareça irreversível (enviar, comprar, assinar, emitir um documento oficial) sem deixar claro no seu relatório final que aquele passo específico ainda precisa de confirmação humana — nesta versão você ainda não tem um mecanismo de aprovação ao vivo, então é mais seguro parar um passo antes do ponto de não-volta e reportar.
- Vá com calma: olhe a screenshot com atenção antes de clicar, prefira poucos passos deliberados a muitos passos apressados.

Quando terminar a tarefa (ou quando precisar parar por algum dos motivos acima), responda em TEXTO simples (sem chamar mais ferramentas) resumindo o que foi feito e o que falta, se algo faltar.`;
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

/** Roda o loop de decisão de uma tarefa até o fim (texto final sem tool_use,
 *  limite de passos, cancelamento, ou erro) — dispara em background a partir
 *  da rota POST /tasks, sem manter a requisição HTTP aberta (cada passo
 *  envolve uma ida-e-volta real até o Chrome do usuário, que pode levar
 *  segundos — inviável segurar isso numa única requisição). */
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

  // Contexto extra pro agente, montado UMA vez antes do loop (não muda passo
  // a passo): 1) manual relevante da Base de Conhecimento (como navegar no
  // site — login, onde clicar); 2) se a tarefa é de um lead específico, os
  // dados desse cliente (nome, CPF, endereço, renda etc, extraídos dos
  // documentos dele no Drive — mesma extração usada por preencher_
  // formulario_editavel) — assim "preenche a PFI do Sebastião" já chega pro
  // agente sabendo tanto COMO navegar quanto O QUE digitar.
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
  const systemPrompt = buildBrowserAgentSystemPrompt(manualTexto);

  const convo: { role: string; content: any }[] = [{ role: 'user', content: task.instruction }];
  let seq = 0;
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
        const toolResults: AnthropicContentBlock[] = [];

        for (const block of toolUseBlocks) {
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
 *  o processo anterior. Marca como FAILED em vez de deixar penduradas pra
 *  sempre como "rodando". Retomar de verdade fica fora do escopo da Fase 1. */
export async function failOrphanedRunningTasks(): Promise<void> {
  const { count } = await prisma.agentTask.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', errorMessage: 'A API reiniciou no meio desta tarefa.', completedAt: new Date() },
  });
  if (count > 0) console.log(`[Agente de Navegador] ${count} tarefa(s) órfã(s) marcada(s) como falhas ao subir.`);
}
