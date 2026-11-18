/**
 * RESPONDER EM CIMA DE UMA MENSAGEM (citação do WhatsApp) pela IA — Fabio 18/11: "preciso que a IA no whatsapp tbm possa responder em cima da msg de um cliente ou nossa,
 * quando queira se referir a algum documento ou msg". Na conversa que a IA lê, cada mensagem que dá pra citar (veio/foi pela API Oficial: id "wamid…") leva um número curto
 * (#57); a IA devolve "replyTo": "#57" no JSON e o CRM manda a resposta citando aquela mensagem (context.message_id na Meta) e grava replyTo* na Message pra Inbox mostrar.
 * Número inválido ou mensagem sem wamid → a resposta sai sem citação, igual a antes. Este arquivo é só a parte pura (sem banco), pra testar sozinha.
 */

/** O que o CRM precisa pra citar: o wamid (vai pra Meta) e o que fica "congelado" na Message pra Inbox mostrar a citação. */
export interface AlvoCitacao {
  externalId: string;
  fromMe: boolean;
  content: string;
  sender: string;
}

/** Só mensagem da API Oficial dá pra citar — a Meta só aceita responder a um wamid do mesmo canal (as do Baileys/QR e as sem id não servem). */
export function ehCitavel(m: { externalId?: string | null; deleted?: boolean | null }): boolean {
  return !!m.externalId && m.externalId.startsWith('wamid') && !m.deleted;
}

/** Rótulo que aparece na conversa lida pela IA. */
export function rotuloCitacao(n: number): string {
  return `#${n}`;
}

/** "replyTo" vindo do JSON da IA ("#57", "57", 57, "msg 57") → "57"; null/vazio/"null"/lixo → null. */
export function normalizarRefCitacao(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? String(raw) : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || /^(null|none|nenhum[a]?|n[ãa]o)$/i.test(t)) return null;
  const m = t.match(/^(?:#|n[ºo°]\s*|msg\s*|mensagem\s*|m)?\s*(\d{1,5})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? String(n) : null;
}

/** Ref da IA → alvo da citação (ou null: sem citação). `ultimaRef` = número da ÚLTIMA mensagem da conversa: citar ela é redundante (a resposta já vem logo abaixo) → sem citação. */
export function resolverCitacao(raw: unknown, mapa: Map<string, AlvoCitacao> | null | undefined, ultimaRef?: string | null): AlvoCitacao | null {
  if (!mapa?.size) return null;
  const ref = normalizarRefCitacao(raw);
  if (!ref || (ultimaRef && ref === ultimaRef)) return null;
  return mapa.get(ref) || null;
}

/** Texto curto da mensagem citada, como a Inbox mostra: arquivo com legenda → a legenda; arquivo sem → "📎 nome"; o resto, o texto. */
export function previewCitacao(content: string | null | undefined): string {
  let t = String(content || '');
  if (/^📎/.test(t) && t.includes(' — ')) t = t.split(' — ').slice(1).join(' — ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
}

/** Trava: o número (#57) é só pro CRM — se a IA escreveu um dos números da conversa no texto ao cliente, ele sai (com os parênteses em volta, se tiver). */
export function semRefsNoTexto(reply: string, mapa: Map<string, AlvoCitacao> | null | undefined): string {
  if (!reply || !mapa?.size || !reply.includes('#')) return reply;
  let mudou = false;
  const tira = (all: string, n: string, resto = '') => { if (!mapa.has(n)) return all; mudou = true; return resto; };
  let out = reply
    .replace(/\s*\((?:mensagem|msg)?\s*#(\d{1,5})\)/gi, (all, n) => tira(all, n))
    .replace(/(\s|^)#(\d{1,5})\b/g, (all, pre, n) => tira(all, n, pre));
  if (!mudou) return reply;
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?;:])/g, '$1').trim();
  return out || reply;
}

/** Alvo → campos replyTo* do sendOutboundWhatsApp (sem alvo: nada, a mensagem sai sem citação). */
export function paramsCitacao(alvo: AlvoCitacao | null | undefined): { replyToExternalId?: string; replyToFromMe?: boolean; replyToContent?: string; replyToSender?: string } {
  if (!alvo?.externalId) return {};
  return { replyToExternalId: alvo.externalId, replyToFromMe: alvo.fromMe, replyToContent: alvo.content, replyToSender: alvo.sender };
}
