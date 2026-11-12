import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/* NOMES DO DOCUMENTO DE IDENTIDADE CONFERIDOS COM O DOCUMENTO DE PÉ (Fabio 12/11).
 * O RG antigo aberto é escaneado deitado: o texto das duas páginas fica DE LADO (cada uma pra um lado) e pequeno. A leitura trocava letra parecida — o nome
 * da mãe "Rosa Belem" saiu "Rosa Belen" duas vezes, a ficha ficou com o erro (a regra manda a identidade vencer a certidão) e o cadastro da CAIXA ia trocar o
 * nome certo que já estava lá pelo errado.
 *  - `recortesDePe`: o documento nas 4 orientações, cada uma em duas metades ampliadas, pra IA reler só os nomes no recorte que estiver de pé.
 *  - `grafiaMaisVotada`: entre a 1ª leitura, a releitura e o que os outros documentos trazem, fica a grafia com mais votos (empate = a releitura). */

const chave = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Quantas letras mudam de um nome pro outro (Levenshtein). Pura. */
export function distanciaDeLetras(a: string, b: string): number {
  if (a === b) return 0;
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = cur;
  }
  return ant[b.length];
}

/** O mesmo nome escrito com 1 ou 2 letras de diferença ("Belen" × "Belem") — acento, caixa e pontuação não contam. Nome curto fica de fora. Pura. */
export function quaseOMesmoNome(a: unknown, b: unknown): boolean {
  const x = chave(a), y = chave(b);
  if (x.length < 8 || y.length < 8 || x === y) return false;
  return distanciaDeLetras(x, y) <= 2;
}

export const mesmoNome = (a: unknown, b: unknown): boolean => !!chave(a) && chave(a) === chave(b);

/** A grafia que fica: um voto pra 1ª leitura, um pra releitura (só vale se for o mesmo nome ou quase) e um pra cada outro documento que traz o mesmo nome ou
 *  quase. Empate = a releitura (feita com o documento de pé); sem releitura = a 1ª leitura. Pura. */
export function grafiaMaisVotada(primeira: unknown, relida: unknown, outras: unknown[]): string | null {
  const p = String(primeira ?? '').trim();
  const r0 = String(relida ?? '').trim();
  if (!p) return null; // o que a 1ª leitura não trouxe, a releitura não inventa
  const r = r0 && (mesmoNome(r0, p) || quaseOMesmoNome(r0, p)) ? r0 : '';
  const votos = new Map<string, { n: number; texto: string }>();
  const vota = (t: string) => { const k = chave(t); const v = votos.get(k) || { n: 0, texto: t }; v.n += 1; votos.set(k, v); };
  vota(p);
  if (r) vota(r);
  for (const o of outras) {
    const t = String(o ?? '').trim();
    if (!t) continue;
    if (mesmoNome(t, p) || quaseOMesmoNome(t, p) || (r && (mesmoNome(t, r) || quaseOMesmoNome(t, r)))) vota(t);
  }
  const maior = Math.max(...[...votos.values()].map((v) => v.n));
  const lideres = [...votos.entries()].filter(([, v]) => v.n === maior).map(([k]) => k);
  if (r && lideres.includes(chave(r))) return mesmoNome(r, p) ? p : r;
  if (lideres.includes(chave(p))) return p;
  return votos.get(lideres[0])!.texto;
}

const nome = (s: string) => PDFName.of(s);

/** Fotos de dentro de um PDF escaneado (uma por página), da maior pra menor: JPEG (DCT) sai direto; imagem crua RGB/cinza de 8 bits passa pelo sharp.
 *  PDF de texto (CNH digital, declaração) não tem foto grande → lista vazia. */
export async function imagensDoPdf(buffer: Buffer, max = 2): Promise<Buffer[]> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const achadas: { area: number; dados: () => Promise<Buffer | null> }[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(nome('Subtype')) !== nome('Image')) continue;
    const num = (k: string) => { const v = obj.dict.lookup(nome(k)); return v instanceof PDFNumber ? v.asNumber() : 0; };
    const width = num('Width'), height = num('Height');
    if (width * height < 250_000) continue; // ícone, máscara, carimbo
    const f = obj.dict.lookup(nome('Filter'));
    const filtros = f instanceof PDFArray ? f.asArray().map((x) => String(x)) : f ? [String(f)] : [];
    if (filtros.length === 1 && filtros[0] === '/DCTDecode') { achadas.push({ area: width * height, dados: async () => Buffer.from(obj.contents) }); continue; }
    if (filtros.length > 1 || (filtros[0] && filtros[0] !== '/FlateDecode') || num('BitsPerComponent') !== 8) continue;
    const cs = String(obj.dict.lookup(nome('ColorSpace')) || '');
    const channels = cs === '/DeviceRGB' ? 3 : cs === '/DeviceGray' ? 1 : 0;
    if (!channels) continue;
    achadas.push({ area: width * height, dados: async () => {
      const cru = Buffer.from(filtros.length ? decodePDFRawStream(obj).decode() : obj.contents);
      if (cru.length < width * height * channels) return null;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('sharp')(cru, { raw: { width, height, channels } }).jpeg({ quality: 92 }).toBuffer();
    } });
  }
  const out: Buffer[] = [];
  for (const a of achadas.sort((x, y) => y.area - x.area).slice(0, max)) { const b = await a.dados().catch(() => null); if (b) out.push(b); }
  return out;
}

/** O documento girado em 0°, 90°, 180° e 270°, cada giro em duas metades (com sobra no meio) ampliadas até o limite que a IA enxerga — num dos recortes o
 *  texto de cada página está de pé e grande. Foto vai direto; PDF, pelas fotos de dentro dele. Sem foto = lista vazia (não há o que reler). */
export async function recortesDePe(buffer: Buffer, mimeType: string): Promise<{ rotulo: string; jpeg: Buffer }[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');
  const fontes = mimeType === 'application/pdf' ? await imagensDoPdf(buffer) : [buffer];
  const out: { rotulo: string; jpeg: Buffer }[] = [];
  for (const [i, src] of fontes.entries()) {
    const base: Buffer = await sharp(src, { failOn: 'none' }).rotate().toBuffer(); // respeita a orientação gravada pela câmera
    for (const giro of [0, 90, 180, 270]) {
      const g = await sharp(base).rotate(giro).toBuffer({ resolveWithObject: true });
      const W: number = g.info.width, H: number = g.info.height;
      const emPe = H >= W; // corta na dimensão maior
      const total = emPe ? H : W, tam = Math.round(total * 0.56);
      for (const parte of [0, 1]) {
        const ini = parte === 0 ? 0 : total - tam;
        const regiao = emPe ? { left: 0, top: ini, width: W, height: tam } : { left: ini, top: 0, width: tam, height: H };
        const jpeg: Buffer = await sharp(g.data).extract(regiao).resize({ width: 1568, height: 1568, fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
        out.push({ rotulo: `${fontes.length > 1 ? `foto ${i + 1}, ` : ''}girado ${giro}°, metade ${parte + 1}`, jpeg });
      }
    }
  }
  return out;
}
