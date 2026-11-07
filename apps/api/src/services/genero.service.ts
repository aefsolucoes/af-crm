import { prisma } from '../lib/prisma';
import { generoPeloNome } from './sexo-pelo-nome';
import { logActivity } from './activity.service';

/**
 * GÊNERO DOS PARTICIPANTES NO CARD (Fabio 06/11: "tô criando um campo no CRM de gênero" → campos fixos "Gênero" e "Gênero 2" = genero_1/genero_2, ao lado
 * do nascimento de cada participante). Vazio, o CRM preenche: o "Gênero" da proposta (site/manual) e, sem ele, o primeiro nome (sexoPeloNome; nome duvidoso
 * fica vazio). NUNCA por cima do que a equipe pôs: `_generoAuto` guarda o que o próprio CRM gravou; se o nome do participante mudar, o CRM refaz só o dele.
 * Os formulários (ficha da CAIXA/BRB, Santander HE e FH, proposta pelos documentos) leem pelo `sexoParaFormulario`: o da equipe manda.
 * DOCUMENTO PRIMEIRO (Fabio 07/11: "usar o gênero do documento"): o sexo IMPRESSO no documento de identidade (doc-review → `_docReview[id].sexo`) vai pro card
 * (atualizarGeneroPeloDocumento) por cima do que estava — inclusive com nome social — e conta como posto à mão (sai do `_generoAuto`), então manda nos formulários.
 * Se a equipe corrigir depois, vale a correção: o mesmo documento não é reaplicado (`_generoDoc` guarda o que já foi aplicado).
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

const MARCAS_PROPOSTA = ['Proposta manual', 'Proposta —', 'DADOS BÁSICOS', 'Nome completo:'];

/** "Gênero: Feminino" / "Sexo: F" da proposta (1º que aparecer = 1º participante). Pura. */
export function generoDaProposta(texto: string): 'Feminino' | 'Masculino' | '' {
  const m = /(?:g[eê]nero|sexo)\s*\**\s*:\s*\**\s*(feminino|masculino|f\b|m\b)/i.exec(String(texto || ''));
  if (!m) return '';
  return /^f/i.test(m[1]) ? 'Feminino' : 'Masculino';
}

/** "Gênero 2º: X" (e-mail do site) ou "Gênero: X" dentro do bloco do 2º PARTICIPANTE (proposta manual). Pura. */
export function generoDaProposta2(texto: string): 'Feminino' | 'Masculino' | '' {
  const t = String(texto || '');
  const rot = /(?:g[eê]nero|sexo)\s*2\s*[ºo°]?\s*\**\s*:\s*\**\s*(feminino|masculino|f\b|m\b)/i.exec(t);
  if (rot) return /^f/i.test(rot[1]) ? 'Feminino' : 'Masculino';
  const i = t.search(/2\s*[ºo°]\s*participante/i);
  if (i < 0) return '';
  const bloco = t.slice(i).split(/\n\s*\n|\n[^\n]*\*[A-ZÁÉÍÓÚÂÊÔÃÕÇ ]{4,}\*/)[0]; // até a linha em branco ou o próximo título (*IMÓVEL…*)
  return generoDaProposta(bloco);
}

/** Gênero do card pelo documento de identidade (Fabio 07/11): o documento mais recente de cada participante com o sexo impresso. Grava `genero_N`, tira do
 *  `_generoAuto` (passa a valer como posto à mão) e marca em `_generoDoc`; o mesmo valor não é reaplicado, então a correção da equipe depois fica. */
export async function atualizarGeneroPeloDocumento(leadId: string): Promise<string[]> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, accountId: true, customFields: true } });
  if (!l) return [];
  const cf = (l.customFields || {}) as Record<string, any>;
  const reviews = (cf._docReview || {}) as Record<string, { tipo?: string; titular?: string; sexo?: string }>;
  const ids = Object.keys(reviews).filter((id) => reviews[id]?.sexo === 'M' || reviews[id]?.sexo === 'F');
  if (!ids.length) return [];
  const { participanteDoTitular } = require('./renda-comprovante.service') as typeof import('./renda-comprovante.service');
  const atts = await prisma.messageAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } });
  const quando = new Map(atts.map((a) => [a.id, a.createdAt.getTime()]));
  const nome = (k: string) => String(cf[k] || '').trim();
  const melhor: Partial<Record<1 | 2, { sexo: string; quando: number; tipo: string }>> = {};
  for (const id of ids) {
    const r = reviews[id];
    const titulares = String(r.titular || '').split(/\s*;\s*/).filter(Boolean);
    if (titulares.length !== 1) continue;
    // Pelo nome de registro e, sem achar, pelo nome social (documento novo pode vir só com o nome social).
    const p = participanteDoTitular(nome('participante_1') || l.name, nome('participante_2'), titulares[0]) || participanteDoTitular(nome('nome_social_1'), nome('nome_social_2'), titulares[0]);
    if (!p) continue;
    const q = quando.get(id) || 0;
    if (!melhor[p] || q > melhor[p]!.quando) melhor[p] = { sexo: String(r.sexo), quando: q, tipo: String(r.tipo || 'documento') };
  }
  const jaAplicado = (cf._generoDoc || {}) as Record<string, string>;
  const mudancas: string[] = [];
  for (const p of [1, 2] as const) {
    const m = melhor[p];
    if (!m) continue;
    const valor = m.sexo === 'F' ? 'Feminino' : 'Masculino';
    if (jaAplicado[p] === valor) continue;
    const antes = nome(`genero_${p}`);
    const n = String(p);
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set((COALESCE("customFields", '{}'::jsonb) #- ARRAY['_generoAuto', ${n}]::text[]) #- ARRAY['_generoAutoNome', ${n}]::text[], ARRAY[${`genero_${p}`}]::text[], to_jsonb(${valor}::text), true), '{_generoDoc}', COALESCE("customFields"->'_generoDoc', '{}'::jsonb) || jsonb_build_object(${n}::text, ${valor}::text), true) WHERE id = ${leadId}`;
    if (antes !== valor) mudancas.push(`${nome(`nome_social_${p}`) || nome(`participante_${p}`) || l.name}: ${valor}${antes ? ` (era ${antes})` : ''} — pelo ${m.tipo}`);
  }
  if (mudancas.length) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🪪 Gênero do card pelo documento de identidade (é o que vai pros formulários dos bancos):\n${mudancas.map((x) => `• ${x}`).join('\n')}` } }).catch(() => {});
    logActivity({ accountId: l.accountId, userId: null, userName: 'Leitor de documentos', action: 'lead_edited', leadId, leadName: l.name, summary: 'preencheu o gênero do card pelo documento' } as any);
  }
  return mudancas;
}

/** Preenche genero_1/genero_2 vazios (ou o que o CRM gravou pra um nome que mudou). Devolve quantos gravou. */
export async function preencherGenero(leadId: string, io?: Io): Promise<number> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, isGroup: true } });
  if (!lead || lead.isGroup) return 0;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const auto = { ...(cf._generoAuto || {}) } as Record<string, string>;
  const autoNome = { ...(cf._generoAutoNome || {}) } as Record<string, string>;
  const patch: Record<string, string> = {};
  let proposta: string | null = null;
  for (const i of [1, 2]) {
    const nome = String(cf[`participante_${i}`] || '').trim();
    if (!nome) continue;
    if (cf._generoDoc?.[i]) continue; // já veio do documento (Fabio 07/11): nada de nome por cima
    if (String(cf[`nome_social_${i}`] || '').trim()) continue; // com nome social o gênero não se adivinha por nenhum dos dois nomes: fica o que está, a equipe decide (Fabio 07/11)
    const atual = String(cf[`genero_${i}`] || '').trim();
    const doCrm = !!atual && auto[i] === atual;
    if (atual && !(doCrm && autoNome[i] !== nome)) continue; // a equipe pôs, ou o CRM já gravou pra esse mesmo nome
    if (proposta === null) {
      const msg = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', OR: MARCAS_PROPOSTA.map((m) => ({ content: { contains: m } })) }, orderBy: { createdAt: 'desc' }, select: { content: true } });
      proposta = msg?.content || '';
    }
    const novo = (i === 1 ? generoDaProposta(proposta || '') : generoDaProposta2(proposta || '')) || generoPeloNome(nome);
    if (!novo || novo === atual) continue;
    patch[`genero_${i}`] = novo;
    auto[i] = novo;
    autoNome[i] = nome;
  }
  if (!Object.keys(patch).length) return 0;
  // Relê na hora de gravar: a equipe pode ter preenchido nesse meio tempo.
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  for (const k of Object.keys(patch)) {
    const i = k.slice(-1);
    const agora = String(fresh[k] || '').trim();
    if (agora && agora !== String(cf[k] || '').trim()) delete patch[k];
    else if (agora && (fresh._generoAuto || {})[i] !== agora) delete patch[k];
  }
  if (!Object.keys(patch).length) return 0;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, ...patch, _generoAuto: auto, _generoAutoNome: autoNome } } });
  if (io) io.to(`lead:${leadId}`).emit('lead_updated', { leadId });
  return Object.keys(patch).length;
}

let ultimaVarredura = 0;
/** De 10 em 10 min: cards mexidos desde a última passada com participante e sem gênero. A 1ª passada depois do deploy olha os últimos 120 dias. */
export async function varrerGenero(io?: Io): Promise<number> {
  const desde = new Date(ultimaVarredura ? ultimaVarredura - 60_000 : Date.now() - 120 * 86_400_000);
  ultimaVarredura = Date.now();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead"
     WHERE archived = false AND "isGroup" = false AND "updatedAt" > ${desde}
       AND ((COALESCE(TRIM("customFields"->>'participante_1'), '') <> '' AND COALESCE(TRIM("customFields"->>'genero_1'), '') = '')
         OR (COALESCE(TRIM("customFields"->>'participante_2'), '') <> '' AND COALESCE(TRIM("customFields"->>'genero_2'), '') = '')
         OR ("customFields"->'_generoAutoNome'->>'1' IS DISTINCT FROM "customFields"->>'participante_1' AND "customFields"->'_generoAuto'->>'1' = "customFields"->>'genero_1')
         OR ("customFields"->'_generoAutoNome'->>'2' IS DISTINCT FROM "customFields"->>'participante_2' AND "customFields"->'_generoAuto'->>'2' = "customFields"->>'genero_2'))
     ORDER BY "updatedAt" DESC LIMIT 3000`;
  let n = 0;
  for (const r of rows) n += await preencherGenero(r.id, io).catch((e: any) => { console.error('[Gênero]', r.id, e?.message); return 0; });
  if (n) console.log(`[Gênero] ${n} gênero(s) preenchido(s) (${rows.length} cards olhados)`);
  return n;
}
