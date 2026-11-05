import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';

type Io = any;

/** POR QUE DESISTIU (Fabio 05/11, Wagner — em Vistoria do Imóvel: "consegui o empréstimo por outros meios"): "sempre que um cliente desistir de uma operação no meio
 *  do processo, tente entender o que motivou isso, coloque a IA para aprender isso".
 *  Card marcado Perdido por qualquer caminho (botão, IA, automações — todos passam por moveLeadToPerdidos, que deixa a nota "ao ser marcado como Perdido") que estava NO MEIO
 *  DO PROCESSO (já tinha análise de crédito ou estava em contratação):
 *  - a IA lê a conversa inteira e grava o motivo (`_desistencia`) + nota no card;
 *  - o cliente não disse o PORQUÊ: IA ligada e janela aberta → pergunta com jeito, 1x (se ninguém perguntou ainda); IA desligada → nota + push com a pergunta pra equipe.
 *    Resposta do cliente em até 3 dias → relê e atualiza;
 *  - motivo claro (ou 3 dias sem resposta) → vira um 💡 Aprender pro administrador (balão "Dúvidas da IA"): "sim" guarda a lição na Base de Conhecimento, e a IA passa a usá-la.
 *  Reprovação, desqualificação e cliente que só sumiu não contam (não foi o cliente que desistiu). */

const DESDE = '2026-11-05T00:00:00Z'; // perdidos de antes não são relidos
const PRAZO_RESPOSTA_MS = 3 * 86_400_000;
const WINDOW_MS = 23 * 3_600_000;
const NAO_FOI_O_CLIENTE_RX = /reprov|desqualific|negad|n[ãa]o aprov|rural|cess[ãa]o de direitos|sem retorno|n[ãa]o respond|sem resposta|duplicad|teste/i;
const JA_PERGUNTOU_RX = /(o que (pesou|motivou|levou|fez)|por que|porque|motivo)[^?]*\?/i;

type Desistencia = {
  em: string; de?: string; quem: 'CLIENTE' | 'BANCO' | 'AF' | 'SEM_RESPOSTA' | 'NAO_SE_APLICA';
  categoria?: string; motivo?: string; causaClara?: boolean; perguntaEm?: string; aprendido?: boolean; final?: boolean; lidoEm: string;
};
type Leitura = { quem: Desistencia['quem']; categoria: string; motivo: string; causaClara: boolean; pergunta: string; titulo: string; licao: string };

const SYSTEM = `Você analisa por que um cliente da A&F Soluções Financeiras (correspondente de crédito: Home Equity — empréstimo com imóvel em garantia — e financiamento imobiliário) saiu de uma operação que estava NO MEIO DO PROCESSO. O card acabou de ser marcado como Perdido. Leia a conversa INTEIRA e responda SÓ com JSON:
{"quem":"CLIENTE|BANCO|AF|SEM_RESPOSTA","categoria":"OUTRO_LUGAR|TAXA_PARCELA|VALOR|DEMORA|DOCUMENTACAO|NAO_PRECISA_MAIS|PESSOAL|INSEGURANCA|ATENDIMENTO|OUTRO","motivo":"<1 frase: o que levou à saída, com o que o cliente disse>","causaClara":true,"pergunta":"<só se quem=CLIENTE e causaClara=false: 1 pergunta pro cliente, gentil e curta, em tom de conversa, pra entender o que pesou; senão vazio>","titulo":"<até 8 palavras>","licao":"<lição GERAL pra A&F e pra IA de atendimento, sem nome, CPF, valores ou qualquer dado do cliente: o que fazer diferente pra outro cliente não desistir pelo mesmo motivo; vazio se não há o que aprender>"}
Regras:
- quem: CLIENTE = o cliente disse que desistiu, não quer mais, não precisa mais ou conseguiu em outro lugar; BANCO = reprovação ou condição do banco encerrou; AF = a A&F encerrou (desqualificado, imóvel não serve); SEM_RESPOSTA = o cliente só sumiu.
- causaClara = o cliente disse o PORQUÊ. "Desisti", "não quero mais", "não preciso mais" sem explicar → false. "Consegui por outros meios" diz ONDE, não POR QUE (foi mais rápido? taxa menor? valor maior? alguém emprestou?) → false, a menos que ele tenha explicado.
- Olhe a conversa toda: demora entre as etapas, pedidos repetidos de documento, taxa questionada, cobranças, dúvidas sem resposta — isso ajuda a achar a causa e a lição. NÃO invente: se não dá pra saber, diga que não ficou claro.
- A pergunta (Fabio: "tente entender o que motivou isso") agradece, diz em poucas palavras que é pra gente melhorar e pergunta o que pesou — ex.: "Posso te perguntar o que pesou na decisão? Foi a taxa, o prazo, a demora do processo…? Sua resposta ajuda a gente a melhorar 🙏". Se ele conseguiu em outro lugar: "…foi condição melhor ou saiu mais rápido?". Nunca insistente, nunca oferece o crédito de novo, nunca pede documento.`;

async function gravar(leadId: string, d: Desistencia): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_desistencia}', ${JSON.stringify(d)}::jsonb, true) WHERE id = ${leadId}`;
}

/** "(estava em: Em contratação Home Equity / Vistoria do Imóvel)" da nota de moveLeadToPerdidos. Pura (testável). */
export function estavaEm(nota: string): string {
  return /\(estava em: ([^)]+)\)/.exec(nota || '')?.[1]?.trim() || '';
}

async function conversa(leadId: string): Promise<string> {
  const msgs = await prisma.message.findMany({
    where: { leadId, deleted: false, content: { not: '' } },
    orderBy: { createdAt: 'desc' }, take: 80,
    select: { direction: true, content: true, createdAt: true },
  });
  return msgs.reverse().map((m) => `[${m.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}] ${m.direction === 'INBOUND' ? 'Cliente' : 'A&F'}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
}

async function ler(nome: string, de: string, lostReason: string, texto: string): Promise<Leitura | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !texto) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096, // o raciocínio conta nesse limite
      system: SYSTEM,
      messages: [{ role: 'user', content: `Cliente: ${nome}\nOnde o card estava: ${de || '(não registrado)'}\nMotivo anotado ao marcar Perdido: ${lostReason || '(nenhum)'}\n\nCONVERSA:\n${texto}` }],
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res) console.error('[Desistência] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  try {
    const j = JSON.parse((data?.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!['CLIENTE', 'BANCO', 'AF', 'SEM_RESPOSTA'].includes(j.quem)) return null;
    const s = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    return { quem: j.quem, categoria: s(j.categoria, 30).toUpperCase(), motivo: s(j.motivo, 300), causaClara: j.causaClara === true, pergunta: s(j.pergunta, 300), titulo: s(j.titulo, 80), licao: s(j.licao, 1200) };
  } catch { return null; }
}

async function nota(leadId: string, content: string): Promise<void> {
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
}

async function aprender(accountId: string, leadId: string, d: Desistencia, r: Leitura, texto: string, io?: Io): Promise<void> {
  if (d.aprendido || r.quem !== 'CLIENTE' || !r.licao) return;
  const { createLearnQuestion } = require('./ai-team-question.service') as typeof import('./ai-team-question.service');
  await createLearnQuestion({ accountId, leadId, io, tipo: 'DESISTENCIA', titulo: `Desistência — ${r.titulo || r.categoria}`, resumo: `desistiu ${d.de ? `em ${d.de}` : 'no meio do processo'} — ${r.motivo}`, licao: r.licao, excerpt: texto.slice(-3000) }).catch((e: any) => console.error('[Desistência] aprendizado:', e?.message));
  d.aprendido = true;
}

/** Lê (ou relê, depois da resposta do cliente) a desistência de um card e faz o que falta. */
async function analisar(accountId: string, leadId: string, d0: Partial<Desistencia> & { em: string }, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, status: true, lostReason: true, rejectedAt: true, aiAutoReplyActive: true, userId: true } });
  if (!lead) return;
  const agora = new Date().toISOString();
  const d: Desistencia = { quem: 'NAO_SE_APLICA', ...d0, lidoEm: agora };
  // Não foi o cliente (reprovado, desqualificado, sumiu) ou não estava no meio do processo: só marca como visto.
  const reprovado = lead.rejectedAt && Math.abs(lead.rejectedAt.getTime() - Date.parse(d.em)) < 2 * 86_400_000;
  const noProcesso = /contrata/i.test(d.de || '') || (await prisma.creditAnalysis.count({ where: { leadId, status: { not: 'TEST' } } })) > 0;
  if (!d0.quem && (reprovado || NAO_FOI_O_CLIENTE_RX.test(lead.lostReason || '') || !noProcesso)) { await gravar(leadId, { ...d, final: true }); return; }
  const texto = await conversa(leadId);
  const r = await ler(lead.name, d.de || '', lead.lostReason || '', texto);
  if (!r) return; // tenta de novo na próxima rodada
  Object.assign(d, { quem: r.quem, categoria: r.categoria, motivo: r.motivo, causaClara: r.causaClara });
  if (r.quem !== 'CLIENTE') { await gravar(leadId, { ...d, final: true }); return; }
  const releitura = !!d0.perguntaEm;
  const cab = `🧭 Por que desistiu${d.de ? ` (estava em ${d.de})` : ''}: ${r.motivo}${r.categoria ? ` [${r.categoria}]` : ''}`;
  if (r.causaClara || releitura) {
    await aprender(accountId, leadId, d, r, texto, io);
    d.final = true;
    await gravar(leadId, d);
    await nota(leadId, `${cab}${releitura ? (r.causaClara ? ' — o cliente explicou.' : ' — mesmo depois da pergunta, não ficou claro.') : ''}${d.aprendido ? ' 💡 Lição mandada pro administrador aprovar (balão "Dúvidas da IA"); aprovada, vai pra Base de Conhecimento.' : ''}`);
    return;
  }
  // O cliente não disse o porquê: alguém (a IA da conversa ou a equipe) já perguntou depois que ele desistiu?
  const desde = new Date(Date.parse(d.em) - 15 * 60_000);
  const perguntas = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', deleted: false, createdAt: { gte: desde } }, orderBy: { createdAt: 'desc' }, take: 5, select: { content: true, createdAt: true } });
  const jaPerguntou = perguntas.find((m) => JA_PERGUNTOU_RX.test(m.content));
  if (jaPerguntou) {
    d.perguntaEm = jaPerguntou.createdAt.toISOString();
    await gravar(leadId, d);
    await nota(leadId, `${cab} — o porquê ainda não ficou claro; a pergunta já foi feita, o CRM relê quando ele responder.`);
    return;
  }
  const lastIn = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const aberta = !!lastIn && Date.now() - lastIn.createdAt.getTime() < WINDOW_MS;
  if (lead.aiAutoReplyActive && aberta && r.pergunta) {
    const sent = await sendOutboundWhatsApp({ accountId, leadId, content: r.pergunta, io: io || undefined });
    d.perguntaEm = agora;
    await gravar(leadId, d);
    await nota(leadId, `${cab} — o porquê não ficou claro. ${sent.success ? `A IA perguntou com jeito: "${r.pergunta}"` : `A pergunta não saiu (${(sent as any).error || 'erro'}); se puder, pergunte: "${r.pergunta}"`}`);
    return;
  }
  // IA desligada (a equipe está conversando) ou janela fechada: a equipe pergunta — o CRM relê se ele responder em até 3 dias.
  d.perguntaEm = agora;
  await gravar(leadId, d);
  await nota(leadId, `${cab} — o porquê não ficou claro.${r.pergunta ? ` Pra entender, pergunte com jeito: "${r.pergunta}"` : ''}${aberta ? '' : ' (janela de 24 h fechada: só por template)'}`);
  try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: `Desistiu: ${r.motivo}`.slice(0, 140) + ' — pergunte com jeito o que pesou', leadId }, [lead.userId]).catch(() => {}); } catch { /* push opcional */ } // só o responsável do card
}

/** Poller (1 min, no laço do credit-auto). */
export async function processDesistencias(accountId: string, io?: Io): Promise<void> {
  // 1) Recém-perdidos (3 min depois: a conversa assenta e a IA já mandou a resposta dela).
  const novos = await prisma.$queryRaw<{ id: string; em: Date; content: string }[]>`
    SELECT l.id, n."createdAt" AS em, n.content
    FROM "Lead" l
    JOIN LATERAL (SELECT "createdAt", content FROM "Note" WHERE "leadId" = l.id AND content LIKE '%ao ser marcado como Perdido%' ORDER BY "createdAt" DESC LIMIT 1) n ON true
    WHERE l."accountId" = ${accountId} AND l.status = 'LOST' AND (l."customFields"->'_desistencia') IS NULL
      AND n."createdAt" >= greatest(${DESDE}::timestamptz, now() - interval '3 days') AND n."createdAt" <= now() - interval '3 minutes'
    LIMIT 3`;
  for (const n of novos) await analisar(accountId, n.id, { em: n.em.toISOString(), de: estavaEm(n.content) || undefined }, io).catch((e) => console.error('[Desistência]', e?.message));

  // 2) Esperando o porquê: o cliente respondeu (e parou de escrever há 2 min) → relê; 3 dias sem resposta → fecha com o que tem; card reaberto → não é mais desistência.
  const esperando = await prisma.$queryRaw<{ id: string; status: string; d: Desistencia }[]>`
    SELECT id, status::text AS status, "customFields"->'_desistencia' AS d FROM "Lead"
    WHERE "accountId" = ${accountId} AND ("customFields"->'_desistencia'->>'perguntaEm') IS NOT NULL AND coalesce("customFields"->'_desistencia'->>'final', 'false') <> 'true'
    LIMIT 10`;
  for (const e of esperando) {
    try {
      const d = e.d;
      if (e.status !== 'LOST') { await gravar(e.id, { ...d, final: true, lidoEm: new Date().toISOString() }); await nota(e.id, '🧭 Card reaberto: a desistência foi desconsiderada.'); continue; }
      const lastIn = await prisma.message.findFirst({ where: { leadId: e.id, direction: 'INBOUND', createdAt: { gt: new Date(d.perguntaEm!) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (lastIn && Date.now() - lastIn.createdAt.getTime() >= 2 * 60_000) { await analisar(accountId, e.id, d, io); continue; }
      if (!lastIn && Date.now() - Date.parse(d.perguntaEm!) > PRAZO_RESPOSTA_MS) {
        // Sem resposta: a lição sai com o que se sabe (ex.: "conseguiu em outro lugar no meio da vistoria").
        const lead = await prisma.lead.findUnique({ where: { id: e.id }, select: { name: true, lostReason: true } });
        const texto = await conversa(e.id);
        const r = lead ? await ler(lead.name, d.de || '', lead.lostReason || '', texto) : null;
        if (!r) continue;
        if (r.quem === 'CLIENTE') await aprender(accountId, e.id, d, r, texto, io);
        await gravar(e.id, { ...d, final: true, lidoEm: new Date().toISOString() });
        if (d.aprendido) await nota(e.id, `🧭 O cliente não respondeu por que desistiu; a lição foi pro administrador com o que se sabe: ${r.motivo}`);
      }
    } catch (err: any) { console.error('[Desistência] esperando:', err?.message); }
  }
}
