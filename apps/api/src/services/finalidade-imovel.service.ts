import { prisma } from '../lib/prisma';

/**
 * FINALIDADE DO IMÓVEL PREENCHIDA SOZINHA (Fabio 06/11: "coloca o CRM para preencher automaticamente a finalidade do imóvel: residencial, apto, terreno, construção,
 * comercial, sala, loja, galpão"). Campo "Finalidade" do card (customFields.finalidade, aba Financiamento).
 *
 * De onde o CRM tira, nesta ordem de força (vale a MAIS ESPECÍFICA — "Residencial" + "APTO 201" no endereço = Apartamento):
 *  - a proposta (site/manual/e-mail): "Tipo do imóvel: Comercial", FH "Tipo: Residencial — Apartamento Residencial", "Finalidade: Construção", e o
 *    "Endereço do imóvel" (APTO/SALA/LOJA/GALPÃO no complemento) — nunca o endereço do cliente;
 *  - o endereço lido nos documentos do imóvel (matrícula, ônus, IPTU, escritura — `_docReview`);
 *  - o "Tipo do imóvel" do card (Casa → Residencial, Apartamento).
 * A conversa entra pela IA (extractedFields → normalizarFinalidade em applyAiExtractedActions).
 * NUNCA sobrescreve o que a equipe preencheu: só grava com o campo vazio, ou troca o "Residencial"/"Comercial" que o PRÓPRIO CRM gravou por um mais específico
 * (`_finalidadeAuto` guarda o que o CRM gravou; a equipe mudou = não mexe mais).
 */

export const FINALIDADES = ['Construção', 'Galpão', 'Loja', 'Sala', 'Terreno', 'Apartamento', 'Comercial', 'Residencial'] as const; // da mais específica pra mais geral
export type Finalidade = (typeof FINALIDADES)[number];
const GENERICAS: Finalidade[] = ['Comercial', 'Residencial'];

const sem = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Valor de um campo rotulado ("Tipo do imóvel", "Finalidade", o que a IA leu) → uma das finalidades, ou null. Pura (testável). */
export function normalizarFinalidade(valor: unknown): Finalidade | null {
  const n = sem(valor);
  if (!n.trim()) return null;
  if (/constru|\bobra\b|edificar/.test(n)) return 'Construção';
  if (/galp/.test(n)) return 'Galpão';
  if (/\bloja/.test(n)) return 'Loja';
  if (/\bsala\b|\bsalas\b|conjunto comercial/.test(n)) return 'Sala';
  if (/terreno|\blotes?\b|gleba/.test(n)) return 'Terreno';
  if (/apart|\b(ap|apt|apto)\b|cobertura|kitnet|quitinete|\bflat\b|studio|duplex/.test(n)) return 'Apartamento';
  if (/comerc|empresari|industri/.test(n)) return 'Comercial';
  if (/residen|\bcasa\b|sobrado|moradia|habitac/.test(n)) return 'Residencial';
  return null;
}

/** Complemento do ENDEREÇO do imóvel → só o que o endereço prova (APTO/SALA/LOJA/GALPÃO). "Quadra 10 Lote 5" é endereço comum de casa: não vira Terreno. Pura. */
export function finalidadeDoEndereco(endereco: unknown): Finalidade | null {
  const n = sem(endereco);
  if (!n.trim()) return null;
  if (/galp/.test(n)) return 'Galpão';
  if (/\bloja\s*\d|\bloja\b/.test(n)) return 'Loja';
  if (/\bsala\s*\d/.test(n)) return 'Sala';
  if (/\b(ap|apt|apto)\b\.?\s*n?[o°º]?\s*\d|\bapartamento\b|\bcobertura\b/.test(n)) return 'Apartamento';
  return null;
}

/** A mais específica (ordem de FINALIDADES). */
export function maisEspecifica(...xs: (Finalidade | null | undefined)[]): Finalidade | null {
  const ok = xs.filter((x): x is Finalidade => !!x);
  return ok.length ? ok.sort((a, b) => FINALIDADES.indexOf(a) - FINALIDADES.indexOf(b))[0] : null;
}

/** Texto da proposta → finalidade. Lê só as linhas do imóvel (nunca "Tipo de residência"/"Tipo de vínculo"/"Tipo de renda" do cliente). Pura (testável). */
export function finalidadeDaProposta(texto: string): Finalidade | null {
  const achados: (Finalidade | null)[] = [];
  for (const bruta of String(texto || '').replace(/[*_]/g, '').split('\n')) {
    const linha = bruta.trim();
    const rot = /^(?:\W*\s*)?(tipo d[oe] im[oó]vel|tipo|finalidade|modalidade|objetivo)\s*:\s*(.+)$/i.exec(linha);
    if (rot) { achados.push(normalizarFinalidade(rot[2])); continue; }
    const end = /^(?:\W*\s*)?endere[cç]o do im[oó]vel\s*:\s*(.+)$/i.exec(linha);
    if (end) achados.push(finalidadeDoEndereco(end[1]));
  }
  return maisEspecifica(...achados);
}

const DOC_IMOVEL = /^(MATRICULA|CERTIDAO DE ONUS|CAPA IPTU|GUIA IPTU|IPTU|CND IPTU|CERTIDAO DE CADASTRO|CADASTRO IMOBILIARIO|ESCRITURA)/;

/** Endereços lidos nos documentos do imóvel (`_docReview` da conferência) → finalidade. Pura. */
export function finalidadeDosDocumentos(docReview: unknown): Finalidade | null {
  const revs = Object.values((docReview || {}) as Record<string, any>).filter((r) => r && DOC_IMOVEL.test(sem(r.tipo).toUpperCase()));
  return maisEspecifica(...revs.map((r) => finalidadeDoEndereco(r.endereco)));
}

const MARCAS_PROPOSTA = ['Tipo do im', 'Tipo de im', 'A SER COMPRADO', 'Finalidade:', 'Endereço do imóvel', 'Endereco do imovel'];

/** Preenche a Finalidade do card se estiver vazia (ou refina a que o próprio CRM gravou). Devolve o que gravou, ou null. */
export async function preencherFinalidade(leadId: string, io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } }, propostaTexto?: string): Promise<Finalidade | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, customFields: true, isGroup: true } });
  if (!lead || lead.isGroup) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const atual = String(cf.finalidade ?? '').trim();
  const doCrm = !!atual && cf._finalidadeAuto === atual;
  if (atual && !(doCrm && GENERICAS.includes(atual as Finalidade))) return null; // a equipe preencheu, ou o CRM já tem o específico

  // A proposta que acabou de chegar (o WhatsApp chama antes de gravar a mensagem) ou a última proposta da conversa.
  const prop = propostaTexto ? null : await prisma.message.findFirst({
    where: { leadId, direction: 'INBOUND', OR: MARCAS_PROPOSTA.map((m) => ({ content: { contains: m } })) },
    orderBy: { createdAt: 'desc' }, select: { content: true },
  });
  const daProposta = finalidadeDaProposta(propostaTexto || prop?.content || '');
  const dosDocs = finalidadeDosDocumentos(cf._docReview);
  const doCard = normalizarFinalidade(cf.imovel_tipo) || normalizarFinalidade(cf.tipo_imovel);
  const nova = maisEspecifica(daProposta, dosDocs, doCard);
  if (!nova || nova === atual || (atual && FINALIDADES.indexOf(nova) >= FINALIDADES.indexOf(atual as Finalidade))) return null;

  const fonte = nova === dosDocs && nova !== daProposta ? 'documento do imóvel' : nova === daProposta ? 'proposta' : 'tipo do imóvel do card';
  // Relê na hora de gravar: outro processo pode ter mexido no card (e a equipe pode ter preenchido nesse meio tempo).
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  const agora = String(fresh.finalidade ?? '').trim();
  if (agora && !(agora === atual && doCrm)) return null;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, finalidade: nova, _finalidadeAuto: nova } } });
  await prisma.note.create({ data: { leadId, type: 'DATA_EDIT', content: `🏠 Finalidade do imóvel preenchida pelo CRM: ${nova} (${fonte})${atual ? ` — era ${atual}` : ''}.` } }).catch(() => {});
  if (io) io.to(`lead:${leadId}`).emit('lead_updated', { leadId });
  return nova;
}

let ultimaVarredura = 0;
/** De 10 em 10 min: cards mexidos desde a última passada com a Finalidade vazia (ou a genérica que o CRM gravou). A 1ª passada depois do deploy olha os últimos 120 dias. */
export async function varrerFinalidade(io?: Parameters<typeof preencherFinalidade>[1]): Promise<number> {
  const desde = new Date(ultimaVarredura ? ultimaVarredura - 60_000 : Date.now() - 120 * 86_400_000);
  ultimaVarredura = Date.now();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead"
     WHERE archived = false AND "isGroup" = false AND "updatedAt" > ${desde}
       AND (COALESCE(TRIM("customFields"->>'finalidade'), '') = ''
            OR ("customFields"->>'finalidade' = "customFields"->>'_finalidadeAuto' AND "customFields"->>'finalidade' IN ('Residencial', 'Comercial')))
     ORDER BY "updatedAt" DESC LIMIT 2000`;
  let n = 0;
  for (const r of rows) {
    if (await preencherFinalidade(r.id, io).catch((e: any) => { console.error('[Finalidade]', r.id, e?.message); return null; })) n++;
  }
  if (n) console.log(`[Finalidade] ${n} card(s) preenchido(s) (${rows.length} olhados)`);
  return n;
}
