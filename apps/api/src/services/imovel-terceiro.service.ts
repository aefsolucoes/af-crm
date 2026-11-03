import { prisma } from '../lib/prisma';

/* SANTANDER × IMÓVEL EM NOME DE TERCEIRO (Fabio 03/11: "santander nao faz HE para imoveis em nome de terceiros").
 * Inter e Creditas aceitam o imóvel no nome de parente de 1º grau (regra de 15/10); o Santander só com o imóvel no nome de quem participa da proposta.
 * De onde o CRM sabe: (1) matrícula/ônus/escritura lida pela conferência (`_docReview[].dono/donoSituacao`) — vale mais que a conversa; (2) a conversa, lida UMA vez na entrada
 * da análise automática ("o imóvel é da minha mãe") → `_imovelTerceiro`.
 * Efeito: nenhuma rodada AUTOMÁTICA do Santander (createRequests grava "NÃO RODEI"; o clique de uma pessoa roda); Santander que já aprovou → nota + push pro responsável
 * pelo card (1x por dono); a IA da conversa não oferece o Santander. Cliente que comprou e ainda não transferiu (`_transferenciaPendente`) não entra: é outro assunto. */

type Cf = Record<string, any>;
export type Terceiro = { dono: string; relacao: string; fonte: 'documento' | 'conversa' };

const semAcento = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const DOC_DO_DONO = /^(MATRICULA|CERTIDAO DE ONUS|ESCRITURA)/;

/** O nome é de um participante de HOJE? (a leitura do documento pode ser de antes de a equipe incluir o dono na proposta). Pura. */
function ehParticipante(cf: Cf, nome: string, leadName?: string): boolean {
  const n = semAcento(nome);
  if (!n) return false;
  return [cf.participante_1, cf.participante_2, leadName].map(semAcento).filter((p) => p.length >= 8).some((p) => p === n || n.includes(p) || p.includes(n));
}

/** Imóvel do Home Equity no nome de quem NÃO participa da proposta (pessoa física). null = no nome de um participante, de empresa, ou não se sabe. Pura (testável). */
export function santanderTerceiro(cf: Cf, leadName?: string): Terceiro | null {
  if (cf._transferenciaPendente) return null;
  const { ehPessoaJuridica } = require('./doc-review.service') as typeof import('./doc-review.service');
  const docs = Object.values((cf._docReview || {}) as Record<string, any>).filter((r) => r && typeof r === 'object' && r.dono && DOC_DO_DONO.test(semAcento(r.tipo)));
  if (docs.some((r) => r.donoSituacao === 'PARTICIPANTE' || ehParticipante(cf, r.dono, leadName))) return null;
  const doc = docs.find((r) => (r.donoSituacao === 'OUTRO_SEM_RELACAO' || r.donoSituacao === 'PARENTE_1GRAU') && !ehPessoaJuridica(r.dono));
  if (doc) return { dono: String(doc.dono), relacao: doc.donoSituacao === 'PARENTE_1GRAU' ? 'parente de 1º grau' : '', fonte: 'documento' };
  const c = cf._imovelTerceiro;
  // Lido na conversa com OUTRO 2º participante: a equipe mexeu na proposta (talvez incluiu o dono) — não vale mais.
  if (c?.dono && semAcento(c.p2) === semAcento(cf.participante_2) && !ehParticipante(cf, c.dono, leadName)) return { dono: String(c.dono), relacao: String(c.relacao || ''), fonte: 'conversa' };
  return null;
}

/** "de MARIA SOUZA (mãe)" ou, quando o cliente só disse o parentesco, "da mãe do cliente" — vai depois de "no nome". */
const quem = (t: Terceiro) => {
  if (!/\s/.test(t.dono.trim()) && t.dono === t.dono.toLowerCase()) return `${/^(m[aã]e|av[oó]|irm[aã]|tia|sogra|esposa|filha|madrasta|prima|cunhada|enteada|nora|ex-esposa|ex-mulher)$/.test(t.dono) && t.dono !== 'avo' ? 'da' : 'do'} ${t.dono} do cliente`;
  return `de ${t.dono}${t.relacao && !semAcento(t.dono).includes(semAcento(t.relacao)) ? ` (${t.relacao})` : ''}`;
};
/** Texto do "NÃO RODEI" do Santander. */
export const textoNaoRodei = (t: Terceiro) => `o Santander não faz Home Equity com imóvel em nome de terceiro — ${t.fonte === 'documento' ? 'a matrícula está' : 'pela conversa, o imóvel está'} no nome ${quem(t)}, que não participa da proposta (Fabio 03/11).`;

/** Linha pra IA da conversa (bloco da análise de crédito). Vazio quando não se aplica. */
export function aiSantanderTerceiroLinha(cf: Cf, leadName?: string): string {
  const t = santanderTerceiro(cf, leadName);
  return t ? `- SANTANDER FORA: o imóvel está no nome ${quem(t)}, que não participa da proposta, e o Santander NÃO faz Home Equity com imóvel em nome de terceiro. NÃO ofereça, não prometa e não confirme seguir pelo Santander; fale só dos outros bancos. Se o cliente insistir no Santander, diga que vai confirmar com a equipe (askTeam).` : '';
}

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
async function salvar(leadId: string, patch: Cf) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Cf), ...patch } as any } });
}
/** Push ao colaborador responsável pelo card (Lead.userId); se ele não tem aparelho cadastrado, vai pra equipe toda. */
async function pushResponsavel(accountId: string, leadId: string, title: string, body: string) {
  try {
    const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true } });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const tem = l?.userId ? await prisma.pushSubscription.count({ where: { userId: l.userId } }) : 0;
    sendPushToAccount(accountId, { title, body, leadId }, tem && l?.userId ? [l.userId] : undefined).catch(() => {});
  } catch { /* aviso */ }
}

/** Depois de ler documento novo ou de o Santander aprovar: pedido automático do Santander na fila vira "NÃO RODEI"; aprovação do Santander que já saiu → nota + push (1x por dono). */
export async function avisarSantanderTerceiro(accountId: string, leadId: string): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Cf;
  const t = santanderTerceiro(cf, lead.name);
  if (!t) return;
  await prisma.creditAnalysis.updateMany({ where: { leadId, bank: 'CREDIMORAR', kind: 'RUN', status: 'REQUESTED', dryRun: false, requestedById: null }, data: { status: 'FAILED', finishedAt: new Date(), detail: `NÃO RODEI: ${textoNaoRodei(t)}` } });
  const chave = semAcento(t.dono);
  if (cf._santanderTerceiroAviso === chave) return;
  const ult = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'CREDIMORAR', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] } }, orderBy: { createdAt: 'desc' }, select: { status: true, chosen: true, proposalNumber: true } });
  if (!ult || ult.status === 'REJECTED') return;
  await salvar(leadId, { _santanderTerceiroAviso: chave });
  await note(leadId, `🏠 O imóvel está no nome ${quem(t)}, que não participa da proposta${t.fonte === 'conversa' ? ' (pelo que o cliente disse na conversa)' : ''}, e o Santander NÃO faz Home Equity com imóvel em nome de terceiro (Fabio 03/11). A aprovação do Santander${ult.proposalNumber ? ` (proposta nº ${ult.proposalNumber})` : ''} não serve como está${ult.chosen ? ' — e o cliente tinha escolhido o Santander' : ''}: siga pelos outros bancos. Se o dono do imóvel entrar como participante da proposta, o CRM deixa de barrar o Santander. Não mandei nada ao cliente.`);
  await pushResponsavel(accountId, leadId, `🏠 ${lead.name}: Santander não serve`, `Imóvel no nome ${quem(t)}, fora da proposta — o Santander não faz HE com imóvel de terceiro`.slice(0, 140));
}

// Gatilho barato da leitura da conversa: o cliente fala de dono/nome do imóvel, ou nós perguntamos em nome de quem está.
const RX_CLIENTE = /no nome d|em nome d|n[aã]o est[aá] no meu nome|propriet[aá]ri|herdeir|invent[aá]rio|esp[oó]lio|\b(im[oó]vel|casa|apartamento|apto|terreno)\s+(é|e|eh)\s+d[aoe]\s/i;
const RX_PERGUNTA = /em nome de quem|no nome de quem|quem [ée] o (dono|propriet)|est[aá] no seu nome/i;

/** Lê a conversa UMA vez (na entrada da análise automática do Home Equity) e grava `_imovelTerceiro` quando o cliente disse que o imóvel é de quem não participa da proposta.
 *  'ERRO' = a leitura falhou (tenta de novo na próxima volta). */
export async function detectarDonoNaConversa(leadId: string, proposalMarkers: string[]): Promise<Terceiro | null | 'ERRO'> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  if (cf._imovelTerceiroLidoAt) return santanderTerceiro(cf, lead?.name);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const msgs = (await prisma.message.findMany({
    where: { leadId, createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) } },
    orderBy: { createdAt: 'desc' }, take: 40, select: { direction: true, content: true, sentByUserId: true },
  })).reverse().filter((m) => !String(m.content || '').startsWith('📧') && !proposalMarkers.some((k) => String(m.content || '').includes(k)));
  const gatilho = msgs.some((m) => (m.direction === 'INBOUND' ? RX_CLIENTE : RX_PERGUNTA).test(m.content || ''));
  if (!gatilho) { await salvar(leadId, { _imovelTerceiroLidoAt: new Date().toISOString() }); return null; }
  const p1 = String(cf.participante_1 || lead?.name || '').trim(), p2 = String(cf.participante_2 || '').trim();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 400,
      system: `Você lê a conversa de um correspondente bancário (A&F, crédito com garantia de imóvel — Home Equity) com o cliente. Decida se o IMÓVEL DADO EM GARANTIA está no nome de alguém que NÃO participa da proposta.
PARTICIPANTES DA PROPOSTA: ${p1 || '(não informado)'}${p2 ? `; ${p2}` : ' (só ele)'}.
TERCEIRO = o cliente disse que o imóvel está no nome de outra pessoa (mãe, pai, irmão, avó, sogro, ex-cônjuge, herdeiros/inventário de falecido…) e essa pessoa NÃO está entre os participantes.
NÃO É TERCEIRO: imóvel no nome do próprio cliente ou de um participante; no nome do cônjuge com quem ele é casado; imóvel comprado e ainda não passado pro nome dele (escritura não transferida, contrato de gaveta) — é outro assunto; falar de OUTRO imóvel que não é a garantia; dúvida sem resposta do cliente.
Responda SÓ JSON: {"terceiro":true|false,"dono":"nome do dono, ou o parentesco se ele não disse o nome (ex.: 'mãe')","relacao":"parentesco com o cliente (ex.: 'mãe') ou vazio","motivo":"frase curta"}`,
      messages: [{ role: 'user', content: msgs.map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : m.sentByUserId ? 'EQUIPE' : 'NÓS (IA)'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') }],
    }),
  }).catch(() => null);
  if (!res?.ok) return 'ERRO';
  const d: any = await res.json().catch(() => null);
  let j: any = null;
  try { j = JSON.parse(String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { j = null; }
  const dono = String(j?.dono || '').trim().slice(0, 80);
  if (!j?.terceiro || !dono) { await salvar(leadId, { _imovelTerceiroLidoAt: new Date().toISOString() }); return null; }
  const t: Terceiro = { dono, relacao: String(j.relacao || '').trim().slice(0, 40), fonte: 'conversa' };
  await salvar(leadId, { _imovelTerceiro: { dono: t.dono, relacao: t.relacao, motivo: String(j.motivo || '').slice(0, 200), p2, at: new Date().toISOString() }, _imovelTerceiroLidoAt: new Date().toISOString() });
  await note(leadId, `🏠 Pela conversa, o imóvel está no nome ${quem(t)}, que não participa da proposta${j.motivo ? ` (${String(j.motivo).slice(0, 160)})` : ''}. O Santander não faz Home Equity com imóvel em nome de terceiro: a análise automática não roda nele (Inter e Creditas seguem). Se o dono do imóvel entrar como participante, o CRM deixa de barrar.`);
  return t;
}
