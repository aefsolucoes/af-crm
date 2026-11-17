/* CEP QUE NÃO EXISTE NOS CORREIOS (Fabio 17/11, Emerson: a conta da CAESB traz "71.996-171" — Arniqueira, área nova — e a CAIXA dá "CEP não localizado" no
 * cadastro). "O CRM faz a consulta de um CEP para a região; se não encontrar o mesmo CEP, deve utilizar um CEP geral." Ordem: o próprio CEP → o CEP geral da
 * localidade (5 primeiros dígitos + 000, quando existe) → o CEP válido mais próximo do mesmo setor (mesmos 5 primeiros dígitos). Brasília não tem CEP geral
 * (71996-000 não existe), então lá vale o mais próximo do setor. Fonte: ViaCEP (base dos Correios, a mesma que a CAIXA usa). Falha de rede = não troca. */

type Achado = { cep: string; logradouro: string; bairro: string };
export type CepCaixa = { cep: string; geral: boolean; de?: string };

const cache = new Map<string, { at: number; v: CepCaixa | null }>();
const TTL_MS = 24 * 3600_000;
const MAX_DIST = 60; // até 60 CEPs pra cima e pra baixo dentro do mesmo setor

/** undefined = não deu pra consultar (rede); null = CEP não existe. */
async function viaCep(cep: string): Promise<Achado | null | undefined> {
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return r.status === 400 ? null : undefined;
    const j = (await r.json()) as any;
    if (!j || j.erro) return null;
    return { cep: String(j.cep || cep).replace(/\D/g, ''), logradouro: String(j.logradouro || ''), bairro: String(j.bairro || '') };
  } catch { return undefined; }
}

/** Candidatos em ordem: CEP geral da localidade e depois os vizinhos do setor, do mais perto pro mais longe. Pura. */
export function candidatosDaRegiao(cep: string): string[] {
  const c = String(cep || '').replace(/\D/g, '');
  if (c.length !== 8) return [];
  const setor = c.slice(0, 5);
  const suf = Number(c.slice(5));
  const out: string[] = [`${setor}000`];
  for (let d = 1; d <= MAX_DIST; d++) for (const s of [suf - d, suf + d]) if (s >= 0 && s <= 999) out.push(`${setor}${String(s).padStart(3, '0')}`);
  return out.filter((x, i, a) => x !== c && a.indexOf(x) === i);
}

/** CEP pra usar no cadastro da CAIXA. `geral: true` = o CEP original não existe e este é o da região (de = logradouro/bairro dele). null = sem CEP válido. */
export async function cepParaCaixa(cep: string): Promise<CepCaixa | null> {
  const c = String(cep || '').replace(/\D/g, '');
  if (c.length !== 8) return null;
  const hit = cache.get(c);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const proprio = await viaCep(c);
  if (proprio !== null) return { cep: c, geral: false }; // existe, ou a consulta falhou (não troca sem ter certeza)
  let v: CepCaixa | null = null;
  const cands = candidatosDaRegiao(c);
  for (let i = 0; i < cands.length && !v; i += 6) {
    const lote = cands.slice(i, i + 6);
    const rs = await Promise.all(lote.map((x) => viaCep(x)));
    const k = rs.findIndex((r) => !!r);
    if (k >= 0) { const a = rs[k] as Achado; v = { cep: lote[k], geral: true, de: [a.logradouro, a.bairro].filter(Boolean).join(' — ') }; }
  }
  cache.set(c, { at: Date.now(), v });
  return v;
}
