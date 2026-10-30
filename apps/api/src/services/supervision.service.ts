import { prisma } from '../lib/prisma';
import { buildSharedAiContext, aiEmailsContext } from './ai-shared.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * SUPERVISÃO DE SEXTA (Fabio 28/10): toda sexta às 08:00 (Brasília) o CRM pega cada card ABERTO num funil "Em contratação…" (Home Equity e Habitacional)
 * — SÓ esses (Fabio 29/10: os de Aguardando Documentação com a IA desligada NÃO entram; tinha sido pedido por engano),
 * lê a conversa inteira + o estado do card, e a IA escreve: resumo, onde o processo está, o que está pendente, a mensagem sugerida pro cliente e o que a equipe
 * deveria fazer. Manda UM push pro Fabio, que passa card por card em /supervisao: enviar a sugestão (editada ou não), abrir o card, marcar feito ou pular.
 * Sobrou pendente às 14:00 da sexta → um lembrete. Nada sai pro cliente sem clique. Janela de 24 h fechada = não dá pra mandar texto (a tela avisa).
 */

const MODEL = 'claude-sonnet-5';
const BRT = 3 * 3600_000;
const SUPERVISOR_EMAIL = 'fabio@aefsolucoesfinanceiras.com.br'; // Fabio 28/10: "pode mandar para mim"

const brtNow = () => new Date(Date.now() - BRT);
/** Data (BRT) da sexta desta semana, AAAA-MM-DD — chave da lista. */
export function weekKeyFor(d: Date = new Date()): string {
  const b = new Date(d.getTime() - BRT);
  const diff = (b.getUTCDay() - 5 + 7) % 7; // dias desde a última sexta
  b.setUTCDate(b.getUTCDate() - diff);
  return b.toISOString().slice(0, 10);
}

const SYSTEM = `Você é o supervisor de atendimento da A&F Soluções Financeiras (correspondente bancário: crédito com garantia de imóvel/Home Equity e financiamento habitacional).
Recebe UM cliente que está na fase de CONTRATAÇÃO (crédito aprovado; documentos, vistoria, contrato, registro). Leia a conversa inteira e o estado do card e escreva para o dono da empresa revisar, sem enrolação.

Responda SOMENTE com JSON, sem markdown:
{"resumo":"2 a 4 frases: quem é, o que já aconteceu e onde o processo está","situacao":"uma frase curta com a etapa real (ex.: aguardando o laudo do Inter)","pendencias":"o que falta, em itens separados por '; ' (vazio se nada)","sugestao":"a mensagem pronta para mandar ao cliente AGORA pelo WhatsApp, no tom da equipe, curta, sem emoji, chamando pelo primeiro nome — ou vazio se o certo agora é NÃO falar com o cliente (ex.: a bola está com o banco e ele já foi avisado ontem)","acao":"o que a equipe deveria fazer além da mensagem (cobrar o banco, pedir certidão, solicitar vistoria…) — ou vazio"}

E-MAILS DO PROCESSO (Fabio 30/10): leia também os e-mails do banco/consultor e os da A&F. O que o banco pediu ou travou por e-mail (laudo/vistoria sem agendar, documento faltando, correção, cliente sem retorno) entra no resumo, nas pendências e na ação — dizendo quem providencia (cliente, vendedor/corretor ou a equipe). Se o banco espera algo do CLIENTE e a conversa não mostra que ele já foi avisado, a sugestão repassa isso bem resumido, em linguagem simples, sem citar nome de consultor, protocolo ou número de proposta. Resultado de crédito que veio por e-mail não vai na sugestão. E-mail da A&F pro banco ainda sem resposta há dias = ação de cobrar o banco.

Regras: nunca invente fato, valor ou prazo que não esteja na conversa/estado/e-mails; nunca anuncie aprovação de crédito em texto livre; se o cliente fez uma pergunta que ficou sem resposta, a sugestão responde a pergunta (ou diz que a equipe vai verificar); se ele está parado há dias sem mandar o que falta, a sugestão cobra com gentileza o item específico.`;

function parse(raw: string): { resumo: string; situacao: string; pendencias: string; sugestao: string; acao: string } | null {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const s = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    if (!s(j.resumo, 10)) return null;
    return { resumo: s(j.resumo, 1200), situacao: s(j.situacao, 300), pendencias: s(j.pendencias, 600), sugestao: s(j.sugestao, 1500), acao: s(j.acao, 600) };
  } catch { return null; }
}

async function ask(contexto: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: contexto }] }),
      });
      if (!r.ok) { console.error('[Supervisão] Anthropic', r.status, (await r.text()).slice(0, 200)); continue; }
      const data = await r.json() as { content: { type: string; text?: string }[] };
      const out = parse(data.content?.find((b) => b.type === 'text')?.text || '');
      if (out) return out;
    } catch (e: any) { console.error('[Supervisão] falha:', e?.message); }
  }
  return null;
}

async function supervisorIds(accountId: string): Promise<string[]> {
  const u = await prisma.user.findFirst({ where: { accountId, email: SUPERVISOR_EMAIL }, select: { id: true } });
  return u ? [u.id] : [];
}

function push(accountId: string, ids: string[], title: string, body: string) {
  if (!ids.length) return;
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, url: '/supervisao' }, ids).catch(() => {}); } catch { /* aviso */ }
}

/** Resume UM cliente (sem gravar nada). */
/** E-mails do processo pra supervisão: 21 dias, até 8, com o Engajamento Automático do Inter. */
const emailsDaSupervisao = (leadId: string) => aiEmailsContext(leadId, { dias: 21, max: 8, chars: 1200, comEngajamento: true }).catch(() => '');

export async function summarizeLead(accountId: string, leadId: string, leadName: string) {
  const l = { id: leadId, name: leadName };
    const ctx = await buildSharedAiContext(accountId, l.id, '', { fullHistory: true, historyRoleLabels: { inbound: 'Cliente', outbound: 'Atendente' } }).catch(() => null);
    if (!ctx) return null;
    const ultimaIn = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const janela = ultimaIn && Date.now() - ultimaIn.createdAt.getTime() < 23 * 3600_000 ? 'ABERTA (dá pra mandar texto)' : 'FECHADA (só template; a sugestão vai ser enviada pela equipe quando ele responder)';
    const hoje = brtNow().toISOString().slice(0, 10);
    const emails = await emailsDaSupervisao(l.id);
    const contexto = [
      `Hoje: ${hoje}. Cliente: ${l.name}. Etapa: ${ctx.etapaTexto}. Banco: ${ctx.bancoTexto || '?'}. Janela do WhatsApp: ${janela}.`,
      ctx.nomeTexto ? `Como chamar: ${ctx.nomeTexto}` : '',
      ctx.creditoTexto ? `--- ESTADO DO CARD ---\n${ctx.creditoTexto}` : '',
      `--- CONVERSA ---\n${ctx.historicoTexto}`,
      emails,
    ].filter(Boolean).join('\n\n');
    return ask(contexto);
}

/** Monta (ou completa) a lista da semana. force = roda fora do horário (botão "Gerar agora"). Devolve quantos cards entraram. */
export async function buildWeeklySupervision(accountId: string, opts: { force?: boolean; notify?: boolean; refazerComEmail?: boolean } = {}): Promise<{ weekKey: string; criados: number; total: number; refeitos?: number }> {
  const weekKey = weekKeyFor();
  const leads = await prisma.lead.findMany({
    where: { accountId, archived: false, status: 'OPEN', isGroup: false, pipeline: { name: { startsWith: 'Em contrata' } } },
    select: { id: true, name: true }, orderBy: { updatedAt: 'asc' },
  });
  const ja = new Set((await prisma.supervisionItem.findMany({ where: { accountId, weekKey }, select: { leadId: true } })).map((x) => x.leadId));
  let criados = 0;
  for (const l of leads) {
    if (ja.has(l.id)) continue;
    const out = await summarizeLead(accountId, l.id, l.name);
    if (!out) continue;
    await prisma.supervisionItem.create({ data: { accountId, leadId: l.id, weekKey, ...out } }).catch(() => {});
    criados++;
  }
  // Itens da semana feitos antes de a supervisão ler e-mail (Fabio 30/10): os PENDENTES de card com e-mail no período são refeitos no lugar (enviados/feitos/pulados ficam).
  let refeitos = 0;
  if (opts.refazerComEmail) {
    const pend = await prisma.supervisionItem.findMany({ where: { accountId, weekKey, status: 'PENDING' }, select: { id: true, leadId: true } });
    const nomes = new Map((await prisma.lead.findMany({ where: { id: { in: pend.map((p) => p.leadId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    for (const it of pend) {
      if (!(await emailsDaSupervisao(it.leadId))) continue;
      const out = await summarizeLead(accountId, it.leadId, nomes.get(it.leadId) || '');
      if (!out) continue;
      await prisma.supervisionItem.update({ where: { id: it.id }, data: out }).catch(() => {});
      ctxCache.delete(it.id);
      refeitos++;
    }
  }
  const total = await prisma.supervisionItem.count({ where: { accountId, weekKey } });
  if (opts.notify !== false && total > 0) push(accountId, await supervisorIds(accountId), '📋 Supervisão de sexta', `${total} cliente(s) em contratação pra revisar, um por um.`);
  return { weekKey, criados, total, refeitos };
}

const ran = new Set<string>();
/** Poller (1 min): sexta 08:00 monta a lista e avisa; sexta 14:00 lembra do que ficou. */
export async function processWeeklySupervision(): Promise<void> {
  const b = brtNow();
  if (b.getUTCDay() !== 5) return;
  const h = b.getUTCHours();
  const weekKey = weekKeyFor();
  const contas = await prisma.account.findMany({ select: { id: true } });
  for (const c of contas) {
    const kGerar = `${c.id}:${weekKey}:gerar`, kLembrar = `${c.id}:${weekKey}:lembrar`;
    if (h >= 8 && !ran.has(kGerar)) {
      ran.add(kGerar);
      const existe = await prisma.supervisionItem.count({ where: { accountId: c.id, weekKey } });
      if (!existe) await buildWeeklySupervision(c.id).catch((e) => console.error('[Supervisão] gerar:', e?.message));
    }
    if (h >= 14 && !ran.has(kLembrar)) {
      ran.add(kLembrar);
      const pend = await prisma.supervisionItem.count({ where: { accountId: c.id, weekKey, status: 'PENDING' } });
      if (pend > 0) push(c.id, await supervisorIds(c.id), '📋 Supervisão: ainda faltam clientes', `${pend} cliente(s) da lista de hoje ainda sem revisão.`);
    }
  }
}

export async function listSupervision(accountId: string, weekKey = weekKeyFor()) {
  const items = await prisma.supervisionItem.findMany({ where: { accountId, weekKey }, orderBy: { createdAt: 'asc' } });
  const leads = await prisma.lead.findMany({ where: { id: { in: items.map((i) => i.leadId) } }, select: { id: true, name: true, stage: { select: { name: true } }, pipeline: { select: { name: true } }, customFields: true } });
  const ultimaIn = await prisma.message.groupBy({ by: ['leadId'], where: { leadId: { in: items.map((i) => i.leadId) }, direction: 'INBOUND', channel: 'WHATSAPP' }, _max: { createdAt: true } });
  const porLead = new Map(leads.map((l) => [l.id, l]));
  const janela = new Map(ultimaIn.map((x) => [x.leadId, x._max.createdAt]));
  return {
    weekKey,
    items: items.map((i) => {
      const l = porLead.get(i.leadId);
      const last = janela.get(i.leadId);
      return {
        ...i, leadName: l?.name || '?', etapa: `${l?.pipeline?.name || ''} → ${l?.stage?.name || ''}`,
        banco: String(((l?.customFields || {}) as any).instituicao || ''),
        janelaAberta: !!last && Date.now() - new Date(last).getTime() < 23 * 3600_000,
      };
    }),
  };
}

// Janela de 24 h fechada: template de "atualização do processo" da área (os dois já aprovados na Meta) + a mensagem fica guardada e sai sozinha quando o cliente responder (reply-pending).
const TEMPLATE_POR_AREA: { re: RegExp; nome: string; corpo: string }[] = [
  { re: /habita/i, nome: 'atualizacao_processo_habitacional', corpo: 'Oi {{1}}, tudo bem? Temos uma atualização sobre o seu processo de financiamento habitacional. Responda esta mensagem para que a gente possa te passar os detalhes.' },
  { re: /./, nome: 'atualizacao_processo_credito', corpo: 'Oi {{1}}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.' },
];

export async function actOnSupervision(accountId: string, userId: string, id: string, acao: 'SEND' | 'TEMPLATE' | 'SKIP' | 'DONE' | 'REOPEN', text?: string, io?: Io) {
  const it = await prisma.supervisionItem.findFirst({ where: { id, accountId } });
  if (!it) throw new Error('Item não encontrado');
  if (acao === 'TEMPLATE') {
    const t = String(text || '').trim();
    if (!t) throw new Error('Escreva a mensagem que vai sair quando o cliente responder');
    const lead = await prisma.lead.findFirst({ where: { id: it.leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
    if (!lead) throw new Error('Card não encontrado');
    const area = lead.pipeline?.department?.name || '';
    const tpl = TEMPLATE_POR_AREA.find((x) => x.re.test(area))!;
    const cf = (lead.customFields || {}) as Record<string, any>;
    const w = String(cf.falando_com || cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
    const nome = w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : 'tudo bem';
    const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
    const r: any = await sendOutboundWhatsAppTemplate({ accountId, leadId: it.leadId, templateName: tpl.nome, language: 'pt_BR', bodyParams: [nome], previewText: tpl.corpo.replace('{{1}}', nome), userId, io: io as any });
    if (!r.success) throw new Error(r.error || 'Falha ao enviar o template');
    const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
    await queueOnReply(prisma as any, { leadId: it.leadId, label: `supervisão ${it.weekKey}`, text: t, noteText: '⏳ Supervisão de sexta: template de atualização enviado; a mensagem revisada sai sozinha quando o cliente responder.' });
    return prisma.supervisionItem.update({ where: { id }, data: { status: 'SENT', sentText: `[template ${tpl.nome}; sai quando ele responder] ${t}`, handledAt: new Date() } });
  }
  if (acao === 'SEND') {
    const t = String(text || '').trim();
    if (!t) throw new Error('Escreva a mensagem');
    const ultimaIn = await prisma.message.findFirst({ where: { leadId: it.leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!ultimaIn || Date.now() - ultimaIn.createdAt.getTime() >= 24 * 3600_000) throw new Error('A janela de 24 h do WhatsApp está fechada: abra o card e use um template.');
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r: any = await sendOutboundWhatsApp({ accountId, leadId: it.leadId, content: t, userId, io: io as any });
    if (!r.success) throw new Error(r.error || 'Falha ao enviar');
    return prisma.supervisionItem.update({ where: { id }, data: { status: 'SENT', sentText: t, handledAt: new Date() } });
  }
  const status = acao === 'SKIP' ? 'SKIPPED' : acao === 'DONE' ? 'DONE' : 'PENDING';
  return prisma.supervisionItem.update({ where: { id }, data: { status, handledAt: acao === 'REOPEN' ? null : new Date() } });
}

// ─── Conversa por voz sobre o card (Fabio 28/10: "eu me comunico com o CRM por falas, ele faz o card e me dá sugestão e eu converso com ele como se fosse a IA") ───
// A voz é do navegador (fala → texto → aqui → texto → fala). A IA conversa com o Fabio sobre ESTE cliente: explica, ajusta a mensagem sugerida, responde dúvidas
// com base na conversa e no estado do card. NUNCA envia nada ao cliente: no máximo devolve uma mensagem nova pro rascunho; o envio continua no botão.
const VOICE_SYSTEM = `Você é a IA do CRM da A&F Soluções Financeiras conversando POR VOZ com o Fabio, dono da empresa, durante a supervisão semanal dos clientes em contratação.
Você conhece este cliente pela conversa de WhatsApp inteira, pelos e-mails do processo e pelo estado do card (abaixo). Fale como numa conversa falada: frases curtas, no máximo 4 frases, sem listas, sem markdown, sem emoji, sem ler links ou números longos.
Nunca invente fatos. Se não souber, diga que não está na conversa. Você NÃO envia nada ao cliente: se o Fabio pedir pra mudar a mensagem, devolva o texto novo em "mensagem"; pra mandar, ele clica em Enviar.
Responda SOMENTE com JSON, sem markdown: {"fala":"o que você responde em voz","mensagem":"novo texto da mensagem pro cliente, só se o Fabio pediu pra mudar/criar — senão vazio","comando":"PULAR | FEITO | PROXIMO | PARAR | vazio"}
Use comando quando o Fabio mandar pular, marcar como feito/resolvido, ir pro próximo ou parar a conversa.`;

const ctxCache = new Map<string, { at: number; texto: string }>();

export async function chatOnSupervision(accountId: string, id: string, history: { de: 'fabio' | 'ia'; texto: string }[], fala: string, rascunho: string) {
  const it = await prisma.supervisionItem.findFirst({ where: { id, accountId } });
  if (!it) throw new Error('Item não encontrado');
  let cache = ctxCache.get(id);
  if (!cache || Date.now() - cache.at > 30 * 60_000) {
    const ctx = await buildSharedAiContext(accountId, it.leadId, '', { fullHistory: true, historyRoleLabels: { inbound: 'Cliente', outbound: 'Atendente' } });
    if (!ctx) throw new Error('Card não encontrado');
    cache = { at: Date.now(), texto: [`Etapa: ${ctx.etapaTexto}. Banco: ${ctx.bancoTexto || '?'}.`, ctx.nomeTexto ? `Como chamar: ${ctx.nomeTexto}` : '', ctx.creditoTexto ? `--- ESTADO DO CARD ---\n${ctx.creditoTexto}` : '', `--- CONVERSA DO CLIENTE ---\n${ctx.historicoTexto}`, await emailsDaSupervisao(it.leadId)].filter(Boolean).join('\n\n') };
    ctxCache.set(id, cache);
  }
  const cartao = `--- O QUE A SUPERVISÃO MOSTROU ---\nResumo: ${it.resumo}\nOnde está: ${it.situacao || '-'}\nPendências: ${it.pendencias || '-'}\nSugestão pra equipe: ${it.acao || '-'}\nMensagem no rascunho agora: ${rascunho || '(vazia)'}`;
  const msgs = [
    { role: 'user', content: `${cartao}\n\n${cache.texto}\n\n(As próximas mensagens são a conversa por voz com o Fabio.)` },
    { role: 'assistant', content: '{"fala":"Entendido, pode perguntar.","mensagem":"","comando":""}' },
    ...history.slice(-12).map((h) => ({ role: h.de === 'fabio' ? 'user' : 'assistant', content: h.de === 'fabio' ? h.texto : JSON.stringify({ fala: h.texto, mensagem: '', comando: '' }) })),
    { role: 'user', content: String(fala || '').slice(0, 2000) },
  ];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('IA indisponível');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system: VOICE_SYSTEM, messages: msgs }),
  });
  if (!r.ok) throw new Error(`IA respondeu ${r.status}`);
  const data = await r.json() as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  const m = /\{[\s\S]*\}/.exec(raw);
  try {
    const j = JSON.parse(m ? m[0] : raw);
    const cmd = String(j.comando || '').toUpperCase();
    return { fala: String(j.fala || '').slice(0, 1200) || 'Não entendi, pode repetir?', mensagem: String(j.mensagem || '').trim().slice(0, 1500), comando: ['PULAR', 'FEITO', 'PROXIMO', 'PARAR'].includes(cmd) ? cmd : '' };
  } catch { return { fala: raw.replace(/[{}"]/g, '').slice(0, 600) || 'Não entendi, pode repetir?', mensagem: '', comando: '' }; }
}

// ─── Voz natural (ElevenLabs) pra conversa da supervisão (Fabio 29/10: "ficou muito ruim essa fala… queria algo mais natural") ───
// Modelo multilíngue rápido (eleven_flash_v2_5, fala português). Sem chave/crédito → 503 e a tela cai na voz do navegador.
// Vozes BRASILEIRAS da biblioteca da ElevenLabs (Fabio 29/10: "sotaque em pt-BR"; liberadas com o plano pago). Cada colaborador escolhe a sua na bolinha do Jarvis.
export const JARVIS_VOICES: { id: string; nome: string; desc: string }[] = [
  { id: 'GDzHdQOi6jjf8zaXhCYD', nome: 'Raquel', desc: 'feminina, jovem e animada' },
  { id: 'RGymW84CSmfVugnA5tvA', nome: 'Roberta', desc: 'feminina, tranquila e confiante' },
  { id: 'KHmfNHtEjHhLK9eER20w', nome: 'Fernanda', desc: 'feminina, formal e clara' },
  { id: 'GM2UA3fbsIaLHcswCDX9', nome: 'Nina', desc: 'feminina, suave e acolhedora' },
  { id: 'xWdpADtEio43ew1zGxUQ', nome: 'Matheus', desc: 'masculina, simpática e calma' },
  { id: 'lvkgCBi6spByiTZMPJEK', nome: 'Gabriel', desc: 'masculina, voz grave' },
];
// Padrão: brasileira (era a Matilda, americana — puxava pro sotaque de Portugal).
export const SUPERVISION_VOICE_ID = process.env.SUPERVISION_VOICE_ID || JARVIS_VOICES[0].id;
// Modelo da voz (Fabio 29/10: sotaque do Brasil) — trocável sem deploy pela variável SUPERVISION_TTS_MODEL.
const TTS_MODEL = process.env.SUPERVISION_TTS_MODEL || 'eleven_flash_v2_5';
export async function supervisionTts(text: string, voiceId?: string): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw Object.assign(new Error('Sem voz natural configurada'), { status: 503 });
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!t) throw Object.assign(new Error('Texto vazio'), { status: 400 });
  const voz = JARVIS_VOICES.some((v) => v.id === voiceId) ? voiceId! : SUPERVISION_VOICE_ID;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voz}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: t, model_id: TTS_MODEL, ...(TTS_MODEL === 'eleven_multilingual_v2' ? {} : { language_code: 'pt' }), voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
  });
  if (!r.ok) throw Object.assign(new Error(`Voz natural indisponível (${r.status}): ${(await r.text()).slice(0, 120)}`), { status: 503 });
  return Buffer.from(await r.arrayBuffer());
}
