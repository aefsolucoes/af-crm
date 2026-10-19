/** Nome de cliente (Lead/Contact) sempre em CAIXA ALTA, não importa como
 *  chegou — digitado num formulário, perfil do WhatsApp, cartão de contato
 *  compartilhado, importação de CSV, ou ferramenta do assistente de IA.
 *  Regra pedida pra manter os cards padronizados, mesmo que o colaborador
 *  (ou o cliente, via WhatsApp) escreva em caixa baixa/mista. */
export function normalizeClientName(name: string): string {
  return name.trim().toUpperCase();
}

/** Nome que dá pra usar pra chamar o cliente: só letras (com acento),
 *  espaço, apóstrofo, hífen e ponto. Com número, %, emoji, "_" e afins não é
 *  nome de verdade (perfil do WhatsApp, telefone) — aí não chama pelo nome
 *  (Fabio 08/10: a IA chamou um cliente de "53999257733"). */
export function isCallableName(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (!s || /[^\p{L}\s'.-]/u.test(s)) return false;
  return s.split(/\s+/)[0].replace(/[.'-]/g, '').length >= 2;
}

/** Primeiro nome (Capitalizado) do primeiro candidato que é nome de verdade; null se nenhum é. */
export function callableFirstName(...raws: unknown[]): string | null {
  for (const raw of raws) {
    if (!isCallableName(raw)) continue;
    const w = String(raw).trim().split(/\s+/)[0];
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }
  return null;
}

/** Total do crédito com SALDO DEVEDOR (Fabio 15/10): saldo + troco + uma folga de R$ 2 a 3 mil, sempre em número inteiro de milhar (sem centavos).
 *  Ex.: 138.369,69 + 2.000 = 140.369,69 → 141.000 (folga de 2,6 mil); 271.082,92 → 274.000. */
export function roundUpToThousand(v: number): number {
  return v > 0 ? Math.ceil((v + 2000) / 1000) * 1000 : v;
}

/** Divide uma resposta longa da IA em várias mensagens curtas de WhatsApp (Fabio 19/10: "quando for frases muito longas, quero que divida elas").
 *  Resposta curta (até `minTotal` caracteres) segue inteira. Primeiro separa por parágrafo (linha em branco); parágrafo comprido vira grupos de frases
 *  de até `maxPiece` caracteres; blocos de lista (várias linhas) e links ficam intactos; pedaços muito curtos se juntam ao vizinho; no máximo `maxParts`
 *  mensagens (o resto vai junto na última). Só a auto-resposta usa isso — o "Sugerir resposta" continua entregando o texto inteiro pra equipe. */
export function splitAiReply(text: string, opts: { minTotal?: number; maxPiece?: number; maxParts?: number } = {}): string[] {
  const { minTotal = 260, maxPiece = 170, maxParts = 6 } = opts;
  const whole = String(text || '').trim();
  if (!whole) return [];
  if (whole.length <= minTotal) return [whole];

  const abrev = /(?:^|\s)(?:sr|sra|srta|dr|dra|av|ex|obs|tel|cel|n[ºo°]|etc)\.$/i;
  const frases = (par: string): string[] => {
    const out: string[] = [];
    let atual = '';
    for (const pedaco of par.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ"“(\d])/u)) {
      if (atual && abrev.test(atual)) { atual += ` ${pedaco}`; continue; }
      if (atual && (atual.length + 1 + pedaco.length > maxPiece)) { out.push(atual); atual = pedaco; } else atual = atual ? `${atual} ${pedaco}` : pedaco;
    }
    if (atual) out.push(atual);
    return out;
  };

  let pecas: string[] = [];
  for (const par of whole.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    const ehLista = par.includes('\n') || /https?:\/\//i.test(par);
    pecas.push(...(par.length <= maxPiece || ehLista ? [par] : frases(par)));
  }
  // Pedaço muito curto (ex.: "Ou seja, ...") junta com o anterior se ainda couber.
  const juntas: string[] = [];
  for (const p of pecas) {
    const ultimo = juntas[juntas.length - 1];
    if (ultimo !== undefined && p.length < 70 && ultimo.length + 1 + p.length <= maxPiece) juntas[juntas.length - 1] = `${ultimo} ${p}`;
    else juntas.push(p);
  }
  pecas = juntas;
  if (pecas.length > maxParts) pecas = [...pecas.slice(0, maxParts - 1), pecas.slice(maxParts - 1).join('\n\n')];
  return pecas;
}
