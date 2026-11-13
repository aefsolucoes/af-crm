import { prisma } from '../lib/prisma';

// ─── Nome certo pelos documentos (Fabio 13/11: "a pasta do cliente e o card do cliente devem ser renomeados, após o envio da documentação, com o nome certo do cliente de
// acordo com a documentação apresentada, tanto primeiro proponente quanto o segundo"). Roda quando a ficha de cadastro é lida dos documentos da pasta (Documentação Recebida):
// participante_1/participante_2 ganham o nome completo do documento, o card passa a ter o nome completo do 1º e a pasta do Drive também.
// Segurança: só troca quando é a MESMA pessoa — o CPF da ficha bate com o do card, ou o nome do documento contém todos os nomes do card na mesma ordem ("Vicente Paulo" →
// "Vicente Paulo Ventura"). Nome diferente sem CPF que confirme (ex.: CNH de outra pessoa) não troca nada: fica uma nota pra equipe conferir.

const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du']);
const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limpa = (s: unknown) => String(s || '').replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => sem(s).split(' ').filter((t) => t && !PARTICULAS.has(t));
const digitos = (s: unknown) => String(s || '').replace(/\D/g, '');

/** "VICENTE PAULO DOS SANTOS" → "Vicente Paulo dos Santos". Pura. */
export function nomeEmTitulo(nome: string): string {
  return limpa(nome).toLowerCase().split(' ').map((w, i) => (i > 0 && PARTICULAS.has(sem(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** O nome do documento contém todos os nomes do card, na mesma ordem? Pura. */
export function contemNaOrdem(card: string, doc: string): boolean {
  const c = tokens(card), d = tokens(doc);
  if (!c.length) return false;
  let j = 0;
  for (const t of d) if (j < c.length && t === c[j]) j++;
  return j === c.length;
}

export async function renomearPelosDocumentos(accountId: string, leadId: string): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const ps: any[] = (Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : []).filter((p: any) => p && p.conjugeIncluido !== true);
  const trocas: { n: number; de: string; para: string }[] = [];
  const conferir: string[] = [];
  for (const n of [1, 2]) {
    const card = limpa(cf[`participante_${n}`]);
    if (!card) continue;
    const p = ps.find((x) => Number(x.ordem) === n) || (n === 1 && ps.length === 1 ? ps[0] : null);
    const doc = limpa(p?.nome);
    if (!doc || tokens(doc).join(' ') === tokens(card).join(' ')) continue;
    const cpfDoc = digitos(p?.cpf), cpfCard = digitos(cf[`cpf_${n}`]);
    const mesmaPessoa = (cpfDoc.length === 11 && cpfDoc === cpfCard) || contemNaOrdem(card, doc);
    if (!mesmaPessoa) { conferir.push(`${n}º proponente: card "${card}" × documento "${doc}"`); continue; }
    trocas.push({ n, de: card, para: nomeEmTitulo(doc) });
  }
  if (conferir.length && !cf._nomeDocConferirAt) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_nomeDocConferirAt}', to_jsonb(${new Date().toISOString()}::text), true) WHERE id = ${leadId}`;
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🪪 Não renomeei o card pelos documentos: o nome lido não bate com o do card e o CPF não confirma que é a mesma pessoa — ${conferir.join('; ')}. Confira (pode ser documento de outra pessoa).` } }).catch(() => {});
  }
  if (!trocas.length) return;
  for (const t of trocas) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), ${`{participante_${t.n}}`}::text[], to_jsonb(${t.para}::text), true) WHERE id = ${leadId}`;
  }
  const t1 = trocas.find((t) => t.n === 1);
  let pasta = '';
  if (t1) {
    const novoNome = t1.para.toUpperCase();
    await prisma.lead.update({ where: { id: leadId }, data: { name: novoNome } });
    const link = String(cf.link_pasta_drive || '').trim();
    if (link) {
      try {
        const g = await import('./google.service');
        await g.renameFile(accountId, g.extractFolderId(link), novoNome);
        pasta = ` A pasta do Drive também virou "${novoNome}".`;
      } catch (e: any) { pasta = ` A pasta do Drive NÃO foi renomeada (${String(e?.message || e).slice(0, 100)}) — renomeie à mão.`; }
    }
  }
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🪪 Nome corrigido pelos documentos: ${trocas.map((t) => `${t.n}º proponente "${t.de}" → "${t.para}"`).join('; ')}.${t1 ? ` O card agora se chama "${t1.para.toUpperCase()}".` : ''}${pasta}` } }).catch(() => {});
}
