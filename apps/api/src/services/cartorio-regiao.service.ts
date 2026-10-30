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

/** Documentação do imóvel chegou e o cliente NÃO tem matrícula nem cartório (Fabio 29/10: "o CRM pode fazer isso sozinho… procura no mapa pelo endereço e já deixa gravado no card").
 *  Cidade com 1 cartório → grava direto; cidade com vários → o que o CRM já aprendeu da região; senão pede à extensão uma CONSULTA ao Mapa do ONR (não é pedido de certidão). Uma vez por card. Nunca lança. */
export async function ensureCartorioPorEndereco(accountId: string, leadId: string): Promise<void> {
  try {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
    if (!lead) return;
    const cf = { ...((lead.customFields || {}) as Record<string, any>) };
    if (String(cf.cartorio_registro || '').trim() || String(cf.numero_matricula || '').trim() || cf._cartorioMapaAt) return;
    const offer = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
    if (offer.certidaoFromDocs(cf)) return; // os documentos já trazem matrícula + cartório
    const e = await offer.enderecoDoImovel(leadId, cf);
    if (!e) return;
    const salva = async (campos: Record<string, unknown>) => { const f = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }); await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((f?.customFields || {}) as any), ...campos } } }); };
    const { consultarCartorios } = require('./ri-cartorios.service') as typeof import('./ri-cartorios.service');
    const c = consultarCartorios(e.uf, e.cidade) as any;
    const naCidade: any[] = Array.isArray(c?.naCidade) ? c.naCidade : [];
    if (naCidade.length === 1) { await salva({ cartorio_registro: String(naCidade[0].nome || '').slice(0, 120), _cartorioMapaAt: new Date().toISOString() }); return; }
    const ap = await cartorioAprendido(accountId, { uf: e.uf, cidade: e.cidade, cep: e.endereco.cep, bairro: e.endereco.bairro });
    if (ap) { await salva({ cartorio_registro: ap.cartorio, _cartorioMapaAt: new Date().toISOString() }); return; }
    if (naCidade.length < 2) return;
    await salva({ _cartorioMapaAt: new Date().toISOString() });
    const { createCertidaoRequest } = require('./certidao.service') as typeof import('./certidao.service');
    await createCertidaoRequest(prisma as any, { accountId, leadId, uf: e.uf, cidade: e.cidade, cartorio: 'AUTO', pedidoPor: 'ENDERECO', endereco: e.endereco, source: 'MAPA', sendPix: false });
  } catch (err: any) { console.warn('[Cartório pelo endereço]', err?.message); }
}

/**
 * CARTÓRIO PELA WEB (Fabio 29/10: "como ele achou mais rápido" — o Claude com pesquisa na web achou o 1º Ofício do DF pela abrangência do TJDFT em segundos).
 * O próprio CRM pergunta ao Claude, com a ferramenta de pesquisa na web da Anthropic, qual Ofício de Registro de Imóveis atende o endereço. Só vale resposta com confiança ALTA
 * e fonte oficial (Tribunal de Justiça, ONR/RI Digital, Registro de Imóveis, site do cartório); senão devolve null e quem decide é o Mapa do ONR (extensão). Nunca lança.
 */
export async function cartorioPelaWeb(p: { uf: string; cidade: string; endereco: string; bairro?: string; cep?: string }): Promise<{ numero: number | null; cartorio: string; fonte: string; motivo: string; confianca: string } | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const sistema = 'Você descobre qual Cartório (Ofício) de Registro de Imóveis tem a competência (circunscrição) sobre um endereço no Brasil. Pesquise em fontes OFICIAIS: Tribunal de Justiça do estado (lista de circunscrições/abrangência), ONR/RI Digital, Registro de Imóveis do Brasil, site do próprio cartório, provimento da Corregedoria. Use bairro, distrito, subdistrito ou setor do endereço. Nunca chute: se as fontes não fecharem, confianca "baixa". Responda no FINAL só um JSON numa linha: {"numero":11,"cartorio":"11º Oficial de Registro de Imóveis de São Paulo","confianca":"alta|media|baixa","fonte":"url oficial","motivo":"1 frase"}. "numero" = nº do Ofício (null se for cartório único da comarca).';
    const messages: any[] = [{ role: 'user', content: `Endereço do imóvel: ${p.endereco}${p.bairro ? ` — bairro ${p.bairro}` : ''}${p.cep ? ` — CEP ${p.cep}` : ''} — ${p.cidade}/${p.uf}. Qual Cartório de Registro de Imóveis atende esse endereço?` }];
    let texto = '';
    // A pesquisa na web é ferramenta do servidor da Anthropic: a resposta pode vir "pausada" (pause_turn) no meio — continua até 4 vezes.
    for (let volta = 0; volta < 4; volta++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }], system: sistema, messages }),
      });
      if (!res.ok) { console.warn('[Cartório pela web] API', res.status, (await res.text().catch(() => '')).slice(0, 300)); return null; }
      const j: any = await res.json();
      texto += (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (j.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: j.content });
    }
    const m = /\{[^{}]*"confianca"[^{}]*\}/.exec(texto);
    if (!m) { console.warn('[Cartório pela web] sem JSON na resposta:', texto.replace(/\s+/g, ' ').slice(-300)); return null; }
    const r = JSON.parse(m[0]);
    // Alta ou MÉDIA (teste 29/10: a Fernanda veio 11º com confiança "média" 2 vezes — certo); baixa = não vale.
    const conf = String(r.confianca || '').toLowerCase();
    if (!['alta', 'media', 'média'].includes(conf) || !r.cartorio) { console.warn('[Cartório pela web] confiança baixa:', m[0].slice(0, 300)); return null; }
    if (!/(\.jus\.br|onr\.org\.br|ridigital|registrodeimoveis|\bri\b|cartorio|oficio|registro|\.gov\.br)/i.test(String(r.fonte || ''))) { console.warn('[Cartório pela web] fonte não oficial:', r.fonte); return null; }
    const numero = Number.isFinite(Number(r.numero)) && Number(r.numero) > 0 ? Number(r.numero) : null;
    return { numero, cartorio: String(r.cartorio).slice(0, 140), fonte: String(r.fonte || '').slice(0, 300), motivo: String(r.motivo || '').slice(0, 300), confianca: conf.replace('média', 'media') };
  } catch (e: any) { console.warn('[Cartório pela web]', e?.name === 'AbortError' ? 'demorou demais' : e?.message); return null; }
  finally { clearTimeout(timer); }
}
