import { PrismaClient } from '@prisma/client';

/**
 * Ligação da EQUIPE feita/atendida pelo CRM: o navegador grava os dois lados
 * e manda o áudio aqui ao desligar. Transcreve (ElevenLabs Scribe, separando
 * quem fala), identifica quem é a equipe e quem é o cliente, resume e grava:
 *  - Call.transcript / Call.summary (material pra IA aprender o jeito da equipe);
 *  - nota no card com resumo, próximo passo e transcrição.
 * O áudio em si não é guardado (nada em disco). Pedido do Fabio 26/09:
 * "quero que a IA aprenda com tudo que fazemos".
 */

const prisma = new PrismaClient();

type Word = { text: string; type?: string; speaker_id?: string; start?: number };

async function transcribe(buffer: Buffer, mimeType: string): Promise<{ lines: string; seconds: number }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY não configurada');
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'por');
  form.append('diarize', 'true');
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), /mp4/.test(mimeType) ? 'ligacao.m4a' : 'ligacao.webm');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Transcrição falhou (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  const words: Word[] = data.words || [];
  const segs: { sp: string; t: string }[] = [];
  for (const w of words) {
    if (w.type === 'spacing') { if (segs.length) segs[segs.length - 1].t += w.text; continue; }
    const sp = w.speaker_id || 'speaker_0';
    if (!segs.length || segs[segs.length - 1].sp !== sp) segs.push({ sp, t: w.text });
    else segs[segs.length - 1].t += w.text;
  }
  const last = words[words.length - 1] as any;
  return { lines: segs.map((s) => `${s.sp}: ${s.t.trim()}`).join('\n'), seconds: Math.round(last?.end || 0) };
}

async function summarize(raw: string, ctx: { teamMember: string; client: string; direction: string }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const system = `Você recebe a transcrição automática de uma ligação de WhatsApp entre alguém da equipe da A&F Soluções Financeiras (correspondente bancário: financiamento habitacional, crédito com garantia de imóvel, consórcio) e um cliente. Os locutores vêm como speaker_0, speaker_1...
Quem ${ctx.direction === 'OUTBOUND' ? 'ligou' : 'atendeu'} pela equipe: ${ctx.teamMember}. Cliente: ${ctx.client}.
Tarefas:
1. Identifique quem é a equipe e quem é o cliente (a equipe se apresenta, explica produto, pede dados; pode haver uma terceira voz da equipe ao fundo) e reescreva a transcrição trocando speaker_X por "${ctx.teamMember.split(' ')[0]}" / "Cliente" (outra pessoa da equipe ao fundo: "Equipe"). Mantenha as falas como foram ditas.
2. Resuma em 2 a 4 frases o que foi conversado (situação do cliente, valores e renda se falados, objeções).
3. O que ficou combinado como próximo passo (1 frase).
Responda SOMENTE JSON: {"transcricao": "...", "resumo": "...", "proximo_passo": "..."}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, system, messages: [{ role: 'user', content: raw.slice(0, 60000) }] }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { content: { type: string; text?: string }[] };
  const text = data.content?.find((b) => b.type === 'text')?.text || '';
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '') as { transcricao: string; resumo: string; proximo_passo: string }; } catch { return null; }
}

export async function processCallRecording(params: { accountId: string; waCallId: string; userId: string; audio: Buffer; mimeType: string }) {
  const { accountId, waCallId, userId, audio, mimeType } = params;
  const call = await prisma.call.findFirst({
    where: { waCallId, accountId },
    select: { id: true, leadId: true, direction: true, lead: { select: { name: true } }, answeredBy: { select: { name: true } } },
  });
  if (!call) throw new Error('Ligação não encontrada');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const teamMember = call.answeredBy?.name || user?.name || 'Equipe';

  const { lines, seconds } = await transcribe(audio, mimeType);
  if (!lines.trim()) { console.log(`[Gravação] ${waCallId.slice(-10)}: sem fala na gravação`); return; }
  const s = await summarize(lines, { teamMember, client: call.lead?.name || 'cliente', direction: call.direction });
  const transcript = s?.transcricao || lines;

  await prisma.call.update({ where: { id: call.id }, data: { transcript, summary: s ? `${s.resumo}${s.proximo_passo ? `\nPróximo passo: ${s.proximo_passo}` : ''}` : null } });
  if (call.leadId) {
    const dur = seconds >= 60 ? `${Math.floor(seconds / 60)}min${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`;
    await prisma.note.create({
      data: {
        leadId: call.leadId, type: 'CALL', userId,
        content: [
          `📝 Ligação de ${teamMember} com o cliente (${dur}) — gravada e transcrita`,
          s?.resumo ? `\nResumo: ${s.resumo}` : '',
          s?.proximo_passo ? `Próximo passo: ${s.proximo_passo}` : '',
          `\nTranscrição:\n${transcript}`,
        ].filter(Boolean).join('\n').slice(0, 20000),
      },
    });
  }
  console.log(`[Gravação] ${waCallId.slice(-10)}: transcrita (${seconds}s) e resumida${call.leadId ? ' — nota no card' : ''}`);
}

/**
 * Pra IA do WhatsApp: o que foi falado nas últimas ligações da equipe com
 * esse cliente (resumo + próximo passo), pra ela não perguntar de novo o que
 * o cliente já contou por telefone e seguir o que ficou combinado.
 */
export async function callSummaryContext(leadId: string): Promise<string> {
  const calls = await prisma.call.findMany({
    where: { leadId, summary: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { summary: true, createdAt: true, answeredBy: { select: { name: true } } },
  });
  if (!calls.length) return '';
  const fmt = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `LIGAÇÕES DA EQUIPE COM ESTE CLIENTE (resumo automático da gravação — use pra não perguntar de novo o que ele já contou e pra seguir o que ficou combinado; não cite que a ligação foi gravada):
${calls.map((c) => `- ${fmt(c.createdAt)}${c.answeredBy?.name ? ` (${c.answeredBy.name.split(' ')[0]})` : ''}: ${c.summary}`).join('\n')}`;
}
