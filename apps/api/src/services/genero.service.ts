import { prisma } from '../lib/prisma';
import { generoPeloNome } from './sexo-pelo-nome';

/**
 * GÊNERO DOS PARTICIPANTES NO CARD (Fabio 06/11: "tô criando um campo no CRM de gênero" → campos fixos "Gênero" e "Gênero 2" = genero_1/genero_2, ao lado
 * do nascimento de cada participante). Vazio, o CRM preenche: o "Gênero" da proposta (site/manual) e, sem ele, o primeiro nome (sexoPeloNome; nome duvidoso
 * fica vazio). NUNCA por cima do que a equipe pôs: `_generoAuto` guarda o que o próprio CRM gravou; se o nome do participante mudar, o CRM refaz só o dele.
 * Os formulários (ficha da CAIXA/BRB, Santander HE e FH, proposta pelos documentos) leem pelo `sexoParaFormulario`: o da equipe manda.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

const MARCAS_PROPOSTA = ['Proposta manual', 'Proposta —', 'DADOS BÁSICOS', 'Nome completo:'];

/** "Gênero: Feminino" / "Sexo: F" da proposta (1º que aparecer = 1º participante). Pura. */
export function generoDaProposta(texto: string): 'Feminino' | 'Masculino' | '' {
  const m = /(?:g[eê]nero|sexo)\s*\**\s*:\s*\**\s*(feminino|masculino|f\b|m\b)/i.exec(String(texto || ''));
  if (!m) return '';
  return /^f/i.test(m[1]) ? 'Feminino' : 'Masculino';
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
    if (String(cf[`nome_social_${i}`] || '').trim()) continue; // com nome social o gênero não se adivinha por nenhum dos dois nomes: fica o que está, a equipe decide (Fabio 07/11)
    const atual = String(cf[`genero_${i}`] || '').trim();
    const doCrm = !!atual && auto[i] === atual;
    if (atual && !(doCrm && autoNome[i] !== nome)) continue; // a equipe pôs, ou o CRM já gravou pra esse mesmo nome
    if (i === 1 && proposta === null) {
      const msg = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', OR: MARCAS_PROPOSTA.map((m) => ({ content: { contains: m } })) }, orderBy: { createdAt: 'desc' }, select: { content: true } });
      proposta = msg?.content || '';
    }
    const novo = (i === 1 && generoDaProposta(proposta || '')) || generoPeloNome(nome);
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
