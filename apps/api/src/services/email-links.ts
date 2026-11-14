/**
 * Links do HTML de um e-mail no TEXTO da conversa (Fabio 14/11, Pedro Francisco: o "Clique aqui" do e-mail do Inter com a lista de documentos
 * chegava na conversa do card sem o endereço — o HTML vira texto e o href se perdia). Aqui o endereço vai junto do texto do link:
 * "Clique aqui" → "Clique aqui (https://…)". A Inbox já transforma http(s) em link clicável e a IA passa a ver o endereço.
 * Só http/https/mailto; link de imagem (sem texto) e marcador vazio do disparador ("%%view_email_url%%") ficam de fora. Puro (testável).
 */

export type EmailLink = { texto: string; url: string };

const ENTIDADES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ', uacute: 'ú', ccedil: 'ç', Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Ccedil: 'Ç' };

function decodifica(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTIDADES[e] ?? ENTIDADES[e.toLowerCase()] ?? m;
  });
}

/** Endereço seguro do href: http(s) vira o próprio endereço (parênteses e espaços codificados, pra não quebrar o "(…)"); mailto vira só o e-mail. */
function urlSegura(href: string): string | null {
  const h = decodifica(href).trim();
  if (/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(h)) {
    const url = h.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/[<>"']/g, encodeURIComponent);
    return url.length <= 1500 ? url : null;
  }
  const mail = h.match(/^mailto:([^?\s]+@[^?\s]+\.[a-z]{2,})/i);
  return mail ? decodeURIComponent(mail[1]) : null;
}

const semEsquema = (s: string) => s.toLowerCase().replace(/^(https?:\/\/|mailto:)/, '').replace(/^www\./, '').replace(/\/+$/, '');

const semComentarios = (html: string | null | undefined) => String(html || '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const ANCORA = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/** O link vale? (http/https/mailto, com texto visível, texto que não é o próprio endereço) */
function avaliaAncora(attrs: string, inner: string): EmailLink | null {
  const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const url = href ? urlSegura(href[1] ?? href[2] ?? href[3] ?? '') : null;
  if (!url) return null;
  const texto = decodifica(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!texto || !/[\p{L}\p{N}]/u.test(texto)) return null; // link de imagem/ícone
  if (semEsquema(texto).includes(semEsquema(url))) return null; // o texto já é o próprio endereço
  return { texto: texto.slice(0, 200), url };
}

/** Links com texto visível de um HTML de e-mail, na ordem em que aparecem (no máximo 30). */
export function linksDoHtml(html: string | null | undefined): EmailLink[] {
  const out: EmailLink[] = [];
  for (const m of semComentarios(html).matchAll(ANCORA)) {
    const l = avaliaAncora(m[1], m[2]);
    if (l) out.push(l);
    if (out.length >= 30) break;
  }
  return out;
}

/** HTML com o endereço escrito logo depois do texto de cada link ("<a href=X>Clique aqui</a>" → "Clique aqui (X)") — passado depois pro
 *  conversor de HTML em texto, o endereço fica no lugar exato. No máximo 30 links; os outros só perdem a marcação (como antes). */
export function htmlComLinks(html: string | null | undefined): string {
  let n = 0;
  return semComentarios(html).replace(ANCORA, (todo, attrs: string, inner: string) => {
    const l = n < 30 ? avaliaAncora(attrs, inner) : null;
    if (!l) return todo;
    n++;
    return `${inner} (${l.url.replace(/&/g, '&amp;')})`;
  });
}

/** Põe "(endereço)" logo depois de cada texto de link achado no texto do e-mail, na ordem. Endereço que o texto já tem não repete. */
export function porLinksNoTexto(texto: string, links: EmailLink[]): string {
  let out = String(texto || '');
  let desde = 0;
  for (const { texto: t, url } of links) {
    if (out.includes(url)) continue;
    const palavras = t.split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!palavras.length) continue;
    const re = new RegExp(palavras.join('\\s*'), 'g');
    re.lastIndex = desde;
    const achou = re.exec(out);
    if (!achou) continue;
    const fim = achou.index + achou[0].length;
    if (/^\s*\(/.test(out.slice(fim, fim + 3)) && out.slice(fim, fim + 12).includes('http')) { desde = fim; continue; }
    const extra = ` (${url})`;
    out = out.slice(0, fim) + extra + out.slice(fim);
    desde = fim + extra.length;
  }
  return out;
}

/** Parte em TEXTO PURO do e-mail sem nenhum endereço, mas o HTML tem links: põe o endereço depois do texto de cada link. Texto puro que já
 *  traz endereços (http…) fica como está (o mesmo link às vezes vem com outro rastreio no HTML e repetiria). */
export function textoComLinks(texto: string, html: string | null | undefined): string {
  if (!html || /https?:\/\//i.test(texto)) return texto;
  return porLinksNoTexto(texto, linksDoHtml(html));
}
