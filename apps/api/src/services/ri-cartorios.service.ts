import fs from 'fs';
import path from 'path';

/**
 * Mapa dos cartórios de Registro de Imóveis do RI Digital (Fabio 29/10: "conferência rápida de todas as listas dos estados").
 * Tirado da página pública "Informações dos Cartórios" (ridigital.org.br/CartorioNacional): por UF, a cidade como aparece no portal,
 * o número do Ofício, o nome, a abrangência de atendimento (municípios/bairros atendidos) e se tem Certidão Digital.
 * Serve pra corrigir o pedido ANTES de ir pra extensão: a escritura diz "3º Ofício de Brasília", mas no portal o 3º fica em ÁGUAS CLARAS (caso Alexandro);
 * cidade pequena sem cartório próprio é atendida pela comarca vizinha (abrangência).
 */
type Cart = { n: number | null; nome: string; ab?: string; cd?: boolean };
type Mapa = Record<string, Record<string, Cart[]>>; // UF → cidade do portal → cartórios

let cache: Mapa | null = null;
function mapa(): Mapa {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../assets/ri-cartorios.json'), 'utf8')) as Mapa; } catch { cache = {}; }
  return cache;
}

const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const numeroDe = (s: string) => { const m = /(\d{1,2})\s*(?:º|°|o\b|ª|\.?\s*of)/i.exec(String(s || '')) || /^\s*0?(\d{1,2})\b/.exec(String(s || '')); return m ? Number(m[1]) : NaN; };
const cita = (texto: string | undefined, cidade: string) => !!texto && new RegExp(`(^| )${norm(cidade)}( |$)`).test(norm(texto));
const rotulo = (n: number | null, cidade: string) => (n ? `${String(n).padStart(2, '0')}º - ${cidade.toUpperCase()}` : 'AUTO');

export type CartorioResolvido = { cidade: string; cartorio: string; motivo: string; semCertidaoDigital?: boolean };

/**
 * Confere cidade + cartório da escritura contra o mapa do portal. null = está certo (ou não dá pra saber).
 * Ordem: o nº existe na cidade → ok · o nº existe numa cidade que ATENDE a cidade da escritura → ela · a cidade está no portal sem esse nº e o nº é único no estado → ele ·
 * cidade sem cartório no portal → o cartório cuja abrangência cita a cidade (se só um).
 */
export function resolverCartorio(uf: string, cidade: string, cartorio: string): CartorioResolvido | null {
  const m = mapa()[String(uf || '').toUpperCase()];
  if (!m || !cidade) return null;
  const num = /^auto$/i.test(String(cartorio || '').trim()) ? NaN : numeroDe(cartorio);
  const chave = Object.keys(m).find((c) => norm(c) === norm(cidade));
  if (chave) {
    const daCidade = m[chave];
    if (Number.isFinite(num) ? daCidade.some((c) => c.n === num) : daCidade.length === 1) return null;
  }
  const todos = Object.entries(m).flatMap(([cid, cs]) => cs.map((c) => ({ cid, ...c })));
  const comNum = Number.isFinite(num) ? todos.filter((c) => c.n === num) : [];
  const fim = (c: { cid: string; n: number | null; cd?: boolean }, motivo: string): CartorioResolvido => ({ cidade: c.cid, cartorio: rotulo(c.n, c.cid), motivo, semCertidaoDigital: c.cd === false || undefined });
  if (comNum.length) {
    const atende = comNum.filter((c) => cita(c.ab, cidade) || cita(c.nome, cidade));
    if (atende.length === 1) return fim(atende[0], `o ${num}º que atende ${cidade} fica no portal em ${atende[0].cid}`);
    // Só quando a cidade da escritura EXISTE no portal mas não tem esse nº (caso DF): cidade fora do portal + nº único no estado pode ser coincidência.
    if (comNum.length === 1 && chave) return fim(comNum[0], `o ${num}º de ${uf} fica no portal em ${comNum[0].cid}`);
  }
  if (!chave) {
    const atende = todos.filter((c) => cita(c.ab, cidade));
    const cidades = [...new Set(atende.map((c) => c.cid))];
    if (atende.length === 1 || (cidades.length === 1 && !Number.isFinite(num) && m[cidades[0]].length === 1)) return fim(atende[0], `${cidade} não tem cartório próprio no portal; é atendida por ${atende[0].nome} (${atende[0].cid})`);
  }
  return null;
}

/** Pro assistente: cartórios de RI do portal numa cidade (e os que a atendem pela abrangência); sem cidade, as cidades do estado com cartório. */
export function consultarCartorios(uf: string, cidade?: string) {
  const m = mapa()[String(uf || '').toUpperCase()];
  if (!m) return { erro: `não tenho o mapa de ${uf}` };
  if (!cidade) return { uf, cidadesComCartorio: Object.entries(m).map(([c, cs]) => `${c} (${cs.map((x) => (x.n ? `${x.n}º` : 'único')).join(', ')})`) };
  const chave = Object.keys(m).find((c) => norm(c) === norm(cidade));
  const naCidade = chave ? m[chave].map((c) => ({ cidadeNoPortal: chave, ...c })) : [];
  const atendem = Object.entries(m).flatMap(([cid, cs]) => cs.filter((c) => cid !== chave && cita(c.ab, cidade)).map((c) => ({ cidadeNoPortal: cid, ...c })));
  return { uf, cidade, naCidade, atendemPelaAbrangencia: atendem, obs: !naCidade.length && !atendem.length ? 'a cidade não tem cartório no portal e nenhuma abrangência a cita — confira no Mapa do Registro de Imóveis' : undefined };
}
