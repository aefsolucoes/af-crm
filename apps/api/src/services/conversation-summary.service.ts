import { prisma } from '../lib/prisma';
import { buildSharedAiContext, todayContextLine } from './ai-shared.service';

/**
 * Botão "Resumo" da conversa (Fabio 03/11: "preguiça de ler a conversa toda"). A IA lê a conversa INTEIRA e o estado do card e devolve um resumo curto pra quem
 * vai pegar o atendimento: quem é, o que quer, onde está, o que foi combinado, o que falta e o próximo passo. Só mostra — não manda nada pro cliente nem mexe no card
 * (a pessoa pode salvar o resumo nas anotações pela tela).
 */

const SUMMARY_RULES = `Você resume, pra alguém da equipe da A&F Soluções Financeiras (correspondente bancário: financiamento habitacional, Home Equity, consórcio), uma conversa de WhatsApp que ela não quer ler inteira. O resumo tem que bastar pra ela continuar o atendimento sem abrir a conversa.
FORMATO (texto puro, sem markdown, sem ** nem #; cada bloco começa com o emoji e o título; pule o bloco que não tiver nada):
📌 Em uma frase: quem é e em que pé está.
👤 Cliente: nome, quem fala no WhatsApp (se não é o titular), produto, valor pedido, imóvel (cidade/valor), banco — só o que aparecer.
📍 Situação: etapa do card e o estado real das análises, documentos e contratação.
🤝 Combinado: o que nós prometemos e o que o cliente prometeu, com a data (dd/mm).
⏳ Pendente: o que falta e de quem (cliente, equipe ou banco).
⚠️ Atenção: reclamação, objeção, urgência, prazo, ou algo errado que já foi dito ao cliente.
👉 Próximo passo: uma ação concreta pra equipe.
REGRAS:
- Curto: no máximo 2 linhas por bloco. Nada de repetir a conversa.
- Só fatos da conversa e do card. Não invente; se não dá pra saber, não escreva.
- Diga quem falou o quê quando importar ("o cliente disse…", "a equipe prometeu…").
- Mensagens marcadas como da equipe ou da IA contam como "nós".`;

export async function summarizeConversation(accountId: string, leadId: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, contact: { select: { name: true } } } });
  if (!lead) return null;
  const nome = lead.contact?.name || lead.name || 'Cliente';
  const ctx = await buildSharedAiContext(accountId, leadId, '', { fullHistory: true, historyRoleLabels: { inbound: nome, outbound: 'A&F (nós)' } });
  if (!ctx || /^\(sem histórico/.test(ctx.historicoTexto)) return null;
  const system = `${SUMMARY_RULES}

--- ${todayContextLine()} ---

--- CONTATO ---
${nome}
${ctx.nomeTexto}

--- CARD NO CRM (funil → etapa) ---
${ctx.etapaTexto}${ctx.bancoTexto ? `\nBanco do card: ${ctx.bancoTexto}` : ''}${ctx.creditoTexto ? `\n${ctx.creditoTexto}` : ''}${ctx.perdidoTexto ? `\n\nCARD PERDIDO:\n${ctx.perdidoTexto}` : ''}

--- CONVERSA (inteira) ---
${ctx.historicoTexto}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // O raciocínio conta no limite — limite baixo deixa a resposta vazia.
        max_tokens: 6000,
        system,
        messages: [{ role: 'user', content: 'Resuma a conversa.' }],
      }),
    });
    if (!res.ok) {
      console.error(`[Resumo] falhou (${res.status}) tentativa ${attempt}/2`);
      continue;
    }
    const data = await res.json() as { content: { type: string; text?: string }[] };
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
    if (text) return text.replace(/\*\*/g, '');
  }
  return null;
}
