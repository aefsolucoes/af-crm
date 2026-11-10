/** DATA DE EMISSÃO DO RG QUANDO FRENTE E VERSO VÊM EM ARQUIVOS SEPARADOS (Fabio 10/11, Sueli: "por que o CRM não conseguiu ler o RG?").
 *  O verso do RG antigo de SP traz a data de expedição e o número, mas não o nome: o arquivo fica "RG.jpg" e a junção da ficha por IA não liga a data à pessoa,
 *  então a ficha sai com "faltando: emissão do RG" e o cadastro da CAIXA não sai sozinho.
 *  Aqui, no código: participante com identidade RG sem emissão → a data do RG lido com o MESMO número (ou o mesmo CPF) nas leituras da ficha; sem leitura,
 *  a da conferência de documentos (`_docReview`) do mesmo titular. Só preenche quando as datas achadas concordam (uma só). Pura (testável). */

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** "dd/mm/aaaa" ou "aaaa-mm-dd" → "dd/mm/aaaa"; o resto → null. */
function dataBr(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

const unica = (xs: (string | null)[]): string | null => {
  const s = [...new Set(xs.filter((x): x is string => !!x))];
  return s.length === 1 ? s[0] : null;
};

/** "emissão do RG" (e variações) no "faltando" da ficha — nunca a da CNH. */
const FALTA_EMISSAO = /^(a )?(data (de|da) )?(emissao|expedicao)( d[oa] (rg|identidade|documento de identidade|carteira de identidade))?$/;

export function comEmissaoDoRg(participantes: any[], leituras: { arquivo: string; leitura: any }[] = [], docReview: Record<string, any> = {}): any[] {
  return (participantes || []).map((p) => {
    const id = p?.identidade;
    if (!id || String(id.tipo || 'RG').toUpperCase() !== 'RG' || dataBr(id.emissao)) return p;
    const num = dig(id.numero), cpf = dig(p.cpf);
    const pessoas = leituras.flatMap((x) => (Array.isArray(x?.leitura?.pessoas) ? x.leitura.pessoas : []));
    const daLeitura = unica(pessoas
      .filter((q: any) => q?.rg && ((num.length >= 5 && dig(q.rg.numero) === num) || (cpf.length === 11 && dig(q.cpf) === cpf)))
      .map((q: any) => dataBr(q.rg.emissao)));
    const nome = norm(p.nome);
    const daConferencia = daLeitura ? null : unica(Object.values(docReview || {})
      .filter((r: any) => r && /^rg$/i.test(String(r.tipo || '').trim()) && nome && norm(r.titular) === nome)
      .map((r: any) => dataBr(r.emissao)));
    const emissao = daLeitura || daConferencia;
    if (!emissao) return p;
    return {
      ...p,
      identidade: { ...id, emissao },
      faltando: (Array.isArray(p.faltando) ? p.faltando : []).filter((f: unknown) => !FALTA_EMISSAO.test(norm(f))),
      fontes: { ...(p.fontes || {}), emissao: daLeitura ? 'verso do RG (mesmo número/CPF)' : 'conferência de documentos' },
    };
  });
}
