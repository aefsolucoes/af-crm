import { prisma } from '../lib/prisma';

/**
 * CARTÓRIO POR REGIÃO, APRENDIDO (Fabio 29/10, Fernanda Karita: São Paulo tem 18 cartórios e o pedido por endereço não sabia qual).
 * O mapa do RI Digital (ri-cartorios.service) só lista os cartórios de cada cidade, sem os bairros de cada um. Aqui o CRM guarda, a cada certidão EMITIDA com o cartório escolhido,
 * os 5 primeiros dígitos do CEP e o bairro do imóvel → cartório. No próximo pedido por endereço na mesma cidade, sem cartório informado, ele usa o que já deu certo (CEP antes do bairro).
 */
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const chaves = (cep: unknown, bairro: unknown) => {
  const c = String(cep ?? '').replace(/\D/g, '');
  const b = norm(bairro);
  return [...(c.length >= 5 ? [`CEP:${c.slice(0, 5)}`] : []), ...(b ? [`BAIRRO:${b}`] : [])];
};

export async function aprenderCartorio(accountId: string, p: { uf: string; cidade: string; cartorio: string; cep?: string | null; bairro?: string | null }): Promise<void> {
  if (!p.cartorio || /^auto$/i.test(p.cartorio)) return; // sem saber qual foi, não aprende
  const uf = String(p.uf || '').toUpperCase(), cidade = norm(p.cidade);
  for (const chave of chaves(p.cep, p.bairro)) {
    await prisma.cartorioRegiao.upsert({
      where: { accountId_uf_cidade_chave_cartorio: { accountId, uf, cidade, chave, cartorio: p.cartorio } },
      create: { accountId, uf, cidade, chave, cartorio: p.cartorio },
      update: { hits: { increment: 1 } },
    }).catch(() => {});
  }
}

/** Capital de SP: subdistrito → Oficial (página "Circunscrições de RI Capital de São Paulo", registrodeimoveis.org.br/paginas-geral-096, lida em 29/10). Vale quando o BAIRRO do endereço é o nome do subdistrito;
 *  bairro que não é subdistrito (ex.: Vila da Paz) continua dependendo do que o CRM aprende. */
const SP_CAPITAL: Record<string, number> = Object.fromEntries(Object.entries({
  1: ['Vila Mariana', 'Liberdade'], 2: ['Santa Cecília', 'Perdizes'], 3: ['Brás', 'Santana', 'Vila Nova Cachoeirinha'], 4: ['Sé', 'Bela Vista', 'Jardim Paulista'],
  5: ['Santa Ifigênia', 'Consolação', 'Pari'], 6: ['Cambuci', 'Ipiranga', 'Vila Prudente'], 7: ['Belenzinho', 'Mooca', 'Alto da Mooca', 'Guaianazes', 'Guaianases'],
  8: ['Limão', 'Bom Retiro', 'Nossa Senhora do Ó', 'Freguesia do Ó', 'Casa Verde', 'Jabaquara'], 9: ['Tatuapé', 'Vila Formosa', 'Itaquera'], 10: ['Lapa', 'Vila Madalena', 'Pinheiros'],
  11: ['Santo Amaro', 'Capela do Socorro', 'Parelheiros'], 12: ['Penha', 'Ermelino Matarazzo', 'São Miguel Paulista'], 13: ['Jardim América', 'Cerqueira César'], 14: ['Saúde', 'Indianópolis'],
  15: ['Tucuruvi', 'Ibirapuera', 'Barra Funda'], 16: ['Pirituba', 'Aclimação', 'Vila Matilde', 'Jaguara'], 17: ['Vila Maria', 'Cangaíba', 'Vila Guilherme'], 18: ['Butantã', 'Brasilândia', 'Jaraguá', 'Perus'],
} as Record<string, string[]>).flatMap(([n, bs]) => bs.map((b) => [norm(b), Number(n)])));

/** Cartório já usado com sucesso nessa região (CEP de 5 dígitos primeiro, depois o bairro). null = ainda não sabe. */
export async function cartorioAprendido(accountId: string, p: { uf: string; cidade: string; cep?: string | null; bairro?: string | null }): Promise<{ cartorio: string; por: string } | null> {
  const uf = String(p.uf || '').toUpperCase(), cidade = norm(p.cidade);
  for (const chave of chaves(p.cep, p.bairro)) {
    const rows = await prisma.cartorioRegiao.findMany({ where: { accountId, uf, cidade, chave }, orderBy: { hits: 'desc' }, take: 2 }).catch(() => []);
    if (rows.length && (rows.length === 1 || rows[0].hits > rows[1].hits)) return { cartorio: rows[0].cartorio, por: chave.startsWith('CEP:') ? `CEP ${chave.slice(4)}-xxx` : `bairro ${chave.slice(7)}` };
  }
  if (uf === 'SP' && cidade === 'SAO PAULO') {
    const n = SP_CAPITAL[norm(p.bairro)];
    if (n) return { cartorio: `${String(n).padStart(2, '0')}º - SÃO PAULO`, por: `subdistrito ${p.bairro} (tabela oficial da Capital)` };
  }
  return null;
}

/** Depois que a certidão sai: grava a região do imóvel (endereço do pedido; no pedido por matrícula, o endereço da proposta/card). Nunca lança. */
export async function aprenderDoPedido(requestId: string): Promise<void> {
  try {
    const r = await prisma.certidaoRequest.findUnique({ where: { id: requestId }, select: { accountId: true, leadId: true, uf: true, cidade: true, cartorio: true, pedidoPor: true, endereco: true } });
    if (!r || /^auto$/i.test(r.cartorio)) return;
    let cep: string | undefined, bairro: string | undefined;
    if (r.pedidoPor === 'ENDERECO' && r.endereco) { const e = r.endereco as any; cep = e.cep; bairro = e.bairro; }
    else {
      const lead = await prisma.lead.findUnique({ where: { id: r.leadId }, select: { customFields: true } });
      const { enderecoDoImovel } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
      const e = await enderecoDoImovel(r.leadId, (lead?.customFields || {}) as Record<string, any>);
      if (!e) return;
      if (norm(e.cidade) !== norm(r.cidade) && !norm(r.cartorio).includes(norm(e.cidade))) return; // endereço de outra cidade: não mistura
      cep = e.endereco.cep; bairro = e.endereco.bairro;
    }
    await aprenderCartorio(r.accountId, { uf: r.uf, cidade: r.cidade, cartorio: r.cartorio, cep, bairro });
  } catch { /* aprender é bônus */ }
}
