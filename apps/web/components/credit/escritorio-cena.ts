/* ESCRITÓRIO DOS BANCOS — a cena em pixel art (canvas), sem React. Arte própria, desenhada pixel a pixel (sem imagem nem biblioteca).
 *
 * Quem decide ONDE cada bonequinho fica é o componente (escritorio-bancos.tsx: mesa = rodando, café = sem fila, xadrez = problema). Aqui fica o desenho e o
 * CAMINHAR (Fabio 11/11: "faz os bonequinhos andarem pelo salão quando forem para trabalhar ou tomar café"): quando o lugar de um banco muda, o bonequinho
 * levanta, sai pelo vão ao lado da mesa, atravessa o salão pelo corredor da frente (passa pela porta da divisória) e vai até o lugar novo — de frente quando
 * vem pra perto, de costas quando se afasta e de lado quando atravessa, com o passo animado. Quem anda na frente das mesas é desenhado num segundo canvas
 * (`topo`), por cima das plaquinhas; quem ainda está atrás da própria mesa fica no canvas de baixo, escondido por ela. */

export type Lugar = 'mesa' | 'cafe' | 'xadrez';
export interface Boneco { key: string; nome: string; cor: string; hair: [string, string, string]; skin: [string, string]; shirt: [string, string, string]; tie: string | null; longo: boolean }
/** Onde o bonequinho deve estar: canto de cima/esquerda do sprite já no lugar (na mesa: sentado). `provisorio` = ainda carregando — não vira caminhada. */
export interface Alvo { lugar: Lugar; x: number; y: number; proximo?: boolean; provisorio?: boolean }
export type Dir = 'baixo' | 'cima' | 'dir' | 'esq';

const OUT = '#241A16';
export const H = 106; // piso com folga embaixo: é o corredor (com a passadeira) por onde eles atravessam o salão
/** Linha (canto de cima do sprite) do corredor: na frente das mesas, com os pés em cima da passadeira. */
const CORREDOR = 74;
/** Velocidade da caminhada, em pixels da cena por segundo, e quantos pixels dura cada quadro do passo. */
const VEL = 74;
const PX_POR_QUADRO = 9;
const hash = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;

export interface Layout { W: number; estacoes: [number, number][]; div: number; cafe0: number; xad0: number; zona: number; cafe: [number, number][]; xadrez: [number, number][] }
export function layoutPara(n: number): Layout {
  const estacoes = Array.from({ length: n }, (_, k) => [52 + k * 64, 50] as [number, number]);
  // café e xadrez com um lugar por banco, lado a lado (fora do horário todos vão pro café)
  const zona = 8 + n * 24, div = 20 + n * 64 + 10, cafe0 = div + 6, xad0 = cafe0 + zona;
  const fila = (x0: number) => Array.from({ length: n }, (_, i) => [x0 + 6 + i * 24, 44] as [number, number]);
  return { W: xad0 + zona, estacoes, div, cafe0, xad0, zona, cafe: fila(cafe0), xadrez: fila(xad0) };
}

type Ctx = CanvasRenderingContext2D;
const mk = (g: Ctx) => {
  const R = (x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
  const P = (x: number, y: number, c: string) => R(x, y, 1, 1, c);
  const box = (x: number, y: number, w: number, h: number, fill: string) => { R(x - 1, y - 1, w + 2, h + 2, OUT); R(x, y, w, h, fill); };
  return { R, P, box };
};

// ---------------- os bonequinhos (16 × 28) ----------------
// Letras: O contorno · H/h/i cabelo (base, sombra, brilho) · S/s pele · E/e olho · m boca · q bochecha · T/t/u camisa · c colarinho · X gravata ·
// P/p calça · B/b sapato.
const FRENTE = [
  '....OOOOOOOO....', '..OOHHHiiHHHOO..', '.OHHHHHiHHHHHhO.', '.OHHHHHHHHHHHhO.', 'OHHHHHHHHHHHHhhO', 'OHHHSSHHHSSSHhhO',
  'OHHSSSSSSSSSShHO', 'OHSSSSSSSSSSSsHO', 'OSSSeESSSSeESssO', 'OSSSEESSSSEESssO', 'OSqSSSSssSSSqssO', '.OSSSSSmmSSSSsO.',
  '..OsSSSSSSSSsO..', '...OOssssssOO...', '..OOTTTccTTTOO..', '.OTTTTTXXTTTTtO.', 'OuTTTTTXXTTTTttO', 'OuTOTTTXXTTTOttO',
  'OTTOTTTTTTTTOttO', 'OTTOTTTTTTTtOttO', 'OSSOPPPPPPPPOssO', '.OOOPPPPPPPpOOO.', '...OPPPPPPPpO...', '...OPPPOOPPpO...',
  '...OPPpOOPPpO...', '...OPPpOOPPpO...', '...OBbBOOBbBO...', '...OOOOOOOOOO...',
];
// De costas: a cabeça é só cabelo (orelhas aparecendo dos lados); o corpo é o da frente sem colarinho nem gravata.
const COSTAS = [
  '....OOOOOOOO....', '..OOHHHiiHHHOO..', '.OHHHHHiHHHHHhO.', '.OHHHHHHHHHHHhO.', 'OHHHHHHHHHHHHhhO', 'OHHHHiHHHHHHHhhO',
  'OHHHHiHHHHHhHhhO', 'OHHHHHHHHHHhHhhO', 'OHHHHHHHHHHhhhhO', 'OsHHHHHHHHHhhhsO', 'OSHHHHHHHHhhhhsO', '.OhHHHHHHhhhhhO.',
  '..OhhhHHhhhhhO..', '...OOssssssOO...', '..OOTTTTTTTTOO..', '.OTTTTTTTTTTTtO.', 'OuTTTTTTTTTTTttO', 'OuTOTTTTTTTTOttO',
  ...FRENTE.slice(18),
];
// De lado, virado pra DIREITA (pra esquerda é o espelho): perfil com um olho só, tronco mais estreito, um braço balançando e as pernas em tesoura.
const LADO_CABECA = [
  '....OOOOOOOO....', '..OOHHHHHiiHOO..', '.OhHHHHHHHiHHHO.', '.OhHHHHHHHHHHHO.', 'OhhHHHHHHHHHHHHO', 'OhhHHHHHHSSHSSHO',
  'OhhHHHHSSSSSSSSO', 'OhhHHHSSSSSSSSSO', 'OhhHHSSSSSSeESSO', 'OhhHHSsSSSSEESSO', 'OhHHHSSSSSSSqSSO', '.OhHHSSSSSSSSmO.',
  '..OhhSSSSSSSsO..', '...OOOssssOOO...',
];
// tronco + braço + pernas (linhas 14–27) em cada momento do passo
const LADO_PASSANDO = [ // pernas juntas, braço caído
  '.....OTTTTO.....', '....OTTttTTO....', '....OTTttTTO....', '....OTTttTTO....', '....OTTttTtO....', '....OTOSSOtO....', '....OPPOOPPO....',
  '....OPPPPPPO....', '.....OPPPpO.....', '.....OPPPpO.....', '.....OPPPpO.....', '.....OPPPpO.....', '.....OBBBBbO....', '.....OOOOOOO....',
];
const LADO_PASSO_1 = [ // perna de cá na frente, braço pra trás
  '.....OTTTTO.....', '....OTTttTTO....', '....OTttTTTO....', '....OTttTTTO....', '....OttTTTtO....', '...OSSOTTTtO....', '....OOPPPPPO....',
  '....OPPPPPPO....', '....OPPPPPPO....', '...OPPpOOPPPO...', '..OPPpO..OPPPO..', '..OPpO....OPPO..', '.OBBbO....OBBBO.', '.OOOOO....OOOOO.',
];
const LADO_PASSO_2 = [ // perna de lá na frente (mais escura), braço pra frente
  '.....OTTTTO.....', '....OTTttTTO....', '....OTTTttTO....', '....OTTTttTO....', '....OTTTTttO....', '....OTTTTOSSO...', '....OPPPPPOO....',
  '....OPPPPPPO....', '....OPPPPPPO....', '...OPPPOOpppO...', '..OPPPO..OpppO..', '..OPPO....OppO..', '.OBBBO....ObbbO.', '.OOOOO....OOOOO.',
];
// De frente/de costas (linhas 19–27): uma perna pisa e a outra sobe; o braço do lado contrário desce.
const PASSO_A = [
  'OSSOTTTTTTTtOttO', '.OOOPPPPPPPPOttO', '...OPPPPPPPpOssO', '...OPPPPPPPpOOO.', '...OPPPOOPPpO...',
  '...OPPpOOPPpO...', '...OPPpOOBbBO...', '...OBbBOOOOOO...', '...OOOOO........',
];
const PASSO_B = [
  'OTTOTTTTTTTtOssO', 'OTTOPPPPPPPPOOO.', 'OSSOPPPPPPPpO...', '.OOOPPPPPPPpO...', '...OPPPOOPPpO...',
  '...OPPpOOPPpO...', '...OBbBOOPPpO...', '...OOOOOOBbBO...', '........OOOOO...',
];
const remendar = (base: string[], de: number, linhas: string[]) => base.map((l, j) => (j >= de && j < de + linhas.length ? linhas[j - de] : l));
const LADO = [...LADO_CABECA, ...LADO_PASSANDO];
const ANDANDO: Record<'frente' | 'costas' | 'lado', string[][]> = {
  frente: [remendar(FRENTE, 19, PASSO_A), FRENTE, remendar(FRENTE, 19, PASSO_B), FRENTE],
  costas: [remendar(COSTAS, 19, PASSO_A), COSTAS, remendar(COSTAS, 19, PASSO_B), COSTAS],
  lado: [remendar(LADO, 14, LADO_PASSO_1), LADO, remendar(LADO, 14, LADO_PASSO_2), LADO],
};
/** Sobe-e-desce do corpo em cada quadro: mais alto quando as pernas passam uma pela outra. */
const BALANCO = [0, -1, 0, -1];

function paleta(b: Boneco): Record<string, string> {
  return { O: OUT, H: b.hair[0], h: b.hair[1], i: b.hair[2], S: b.skin[0], s: b.skin[1], E: '#1B1B1B', e: '#FFFFFF', m: '#9E4B44', q: '#F09A8E',
    T: b.shirt[0], t: b.shirt[1], u: b.shirt[2], c: '#F5F5F5', X: b.tie || b.shirt[0], P: '#2F3E66', p: '#222D4A', B: '#1E1E1E', b: '#4A4A4A' };
}
/** Cabelo comprido em cada vista (o da frente é o de sempre; de costas cobre a nuca e os ombros; de lado desce pelas costas). */
function comCabeloLongo(linhas: string[], vista: 'frente' | 'costas' | 'lado'): string[][] {
  const rows = linhas.map((r) => r.split(''));
  const poe = (j: number, i: number, t: string) => t.split('').forEach((ch, d) => { rows[j][i + d] = ch; });
  if (vista === 'frente') {
    for (let j = 6; j <= 12; j++) { rows[j][1] = 'H'; rows[j][14] = 'h'; }
    for (let j = 13; j <= 15; j++) { rows[j][0] = 'O'; rows[j][1] = 'H'; rows[j][2] = 'H'; rows[j][13] = 'h'; rows[j][14] = 'h'; rows[j][15] = 'O'; }
  } else if (vista === 'costas') {
    poe(9, 0, 'OHHHHHHHHHHhhhhO'); poe(10, 0, 'OHHHHHHHHHHhhhhO'); poe(11, 0, 'OHHHHHHHHHhhhhhO'); poe(12, 0, 'OHHHiHHHHHhhhhhO');
    poe(13, 0, 'OHHHiHHHHHhhhhhO'); poe(14, 0, 'OHHHHHHHHhhhhhhO'); poe(15, 1, 'OHHHHHHHhhhhhO'); poe(16, 2, 'OhHHHHhhhhhO'); poe(17, 4, 'OOOOOOOO');
  } else {
    poe(11, 0, '.OhHH'); poe(12, 0, '.OhHHH'); poe(13, 0, '.OhHHH'); poe(14, 0, '.OhHHH'); poe(15, 0, '..OhHH'); poe(16, 0, '...OhH'); poe(17, 0, '....OO');
  }
  return rows;
}
const cacheQuadros = new Map<string, string[][]>();
function quadro(vista: 'frente' | 'costas' | 'lado', n: number, longo: boolean): string[][] {
  const chave = `${vista}${n}${longo ? 'L' : ''}`;
  let q = cacheQuadros.get(chave);
  if (!q) { const linhas = ANDANDO[vista][n]; q = longo ? comCabeloLongo(linhas, vista) : linhas.map((r) => r.split('')); cacheQuadros.set(chave, q); }
  return q;
}
function carimbar(g: Ctx, rows: string[][], pal: Record<string, string>, x: number, y: number, linhas = rows.length, espelho = false) {
  for (let j = 0; j < linhas; j++) {
    const r = rows[j];
    for (let i = 0; i < 16; i++) { const ch = r[i]; if (ch !== '.') { g.fillStyle = pal[ch]; g.fillRect(espelho ? x + 15 - i : x + i, y + j, 1, 1); } }
  }
}
/** Bonequinho parado, de frente (`linhas` < 28 corta embaixo: é o sentado). */
function stamp(g: Ctx, b: Boneco, x: number, y: number, linhas: number) {
  carimbar(g, quadro('frente', 1, b.longo), paleta(b), x, y, linhas);
  if (!b.tie && linhas > 17) { const { P } = mk(g); P(x + 10, y + 16, '#FFFFFF'); P(x + 10, y + 17, '#D8DCE4'); }
}
const sombra = (g: Ctx, x: number, y: number) => { g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(x + 8, y + 28, 7, 1.6, 0, 0, Math.PI * 2); g.fill(); };
/** Um quadro da caminhada (0–3) na direção dada. Exportado pra conferir a arte fora da tela do CRM. */
export function quadroAndando(g: Ctx, b: Boneco, x: number, y: number, dir: Dir, n: number) {
  const vista = dir === 'baixo' ? 'frente' : dir === 'cima' ? 'costas' : 'lado', yy = y + BALANCO[n % 4];
  sombra(g, x, y);
  carimbar(g, quadro(vista, n % 4, b.longo), paleta(b), x, yy, 28, dir === 'esq');
  if (vista === 'frente' && !b.tie) { const { P } = mk(g); P(x + 10, yy + 16, '#FFFFFF'); P(x + 10, yy + 17, '#D8DCE4'); }
}

// ---------------- o salão ----------------
// Escritório "arrojado" (Fabio 11/11): janelão do chão ao teto com a cidade lá fora (o céu acompanha a hora: dia, fim de tarde, noite), piso de concreto
// polido com o reflexo das janelas, passadeira no corredor, divisória de vidro com porta, mesas brancas com fita de LED na cor do banco (acesa quando ele
// está trabalhando), café com piso de madeira, balcão de pedra, pendentes e letreiro de neon, e o xadrez com janela de grade e neon vermelho.
export type Periodo = 'dia' | 'tarde' | 'noite';
export const periodoDe = (hora: number): Periodo => (hora >= 6 && hora < 17 ? 'dia' : hora >= 17 && hora < 19 ? 'tarde' : 'noite');
const CEU: Record<Periodo, { faixas: string[]; longe: string; perto: string; luz: string; acesas: number }> = {
  dia: { faixas: ['#69AEF2', '#82BDF5', '#9BCBF8', '#B6DAFA', '#D2E9FC'], longe: '#A3B8D8', perto: '#7C93BA', luz: '#DCEAFA', acesas: 0.5 },
  tarde: { faixas: ['#2B2C6C', '#5A3E8C', '#A34E8A', '#E3705E', '#F7B56C'], longe: '#5B3F80', perto: '#2A2350', luz: '#FFD27A', acesas: 0.42 },
  noite: { faixas: ['#090E2A', '#0D1434', '#121B42', '#17224E', '#1D2A5A'], longe: '#1B2450', perto: '#0A0F26', luz: '#FFD86B', acesas: 0.34 },
};
const LETRAS: Record<string, string[]> = {
  C: ['111', '100', '100', '100', '111'], A: ['010', '101', '111', '101', '101'], F: ['111', '100', '110', '100', '100'], E: ['111', '100', '110', '100', '111'],
  X: ['101', '101', '010', '101', '101'], D: ['110', '101', '101', '101', '110'], R: ['110', '101', '110', '101', '101'], Z: ['111', '001', '010', '100', '111'],
};
/** Letreiro de neon (letras 3×5): primeiro o brilho em volta, depois o tubo. "É" = E com o acento em cima. */
function neon(g: Ctx, texto: string, x: number, y: number, tubo: string, brilho: string) {
  const pts: [number, number][] = [];
  texto.split('').forEach((ch, n) => {
    const l = LETRAS[ch === 'É' ? 'E' : ch]; if (!l) return;
    l.forEach((linha, j) => linha.split('').forEach((bit, i) => { if (bit === '1') pts.push([x + n * 4 + i, y + j]); }));
    if (ch === 'É') { pts.push([x + n * 4 + 1, y - 2]); pts.push([x + n * 4 + 2, y - 3]); }
  });
  g.fillStyle = brilho; g.globalAlpha = 0.22; for (const [px, py] of pts) g.fillRect(px - 2, py - 2, 5, 5);
  g.globalAlpha = 0.55; for (const [px, py] of pts) g.fillRect(px - 1, py - 1, 3, 3);
  g.globalAlpha = 1; g.fillStyle = tubo; for (const [px, py] of pts) g.fillRect(px, py, 1, 1);
}
function planta(g: Ctx, x: number, y: number, vaso = '#F2F4F8', vasoSombra = '#C9CFDA') {
  const { R, P } = mk(g);
  R(x + 3, y + 11, 8, 8, OUT); R(x + 4, y + 12, 6, 6, vaso); R(x + 9, y + 12, 1, 6, vasoSombra); R(x + 4, y + 12, 6, 1, '#3A2A1E');
  for (const [dx, dy] of [[7, 0], [4, 2], [10, 2], [2, 5], [12, 5], [5, 5], [9, 5], [7, 3], [3, 8], [11, 8], [7, 7]]) { R(x + dx - 1, y + dy, 3, 4, '#256B3A'); P(x + dx, y + dy, '#5CC06C'); P(x + dx, y + dy + 1, '#3E9A4A'); }
}
/** A cidade pelo janelão, de x0 a x1 (linhas 2–16 da parede). */
function cidade(g: Ctx, x0: number, x1: number, per: Periodo) {
  const { R, P } = mk(g), c = CEU[per];
  for (let y = 2; y < 17; y++) R(x0, y, x1 - x0, 1, c.faixas[Math.min(4, Math.floor((y - 2) / 3))]);
  const meio = x0 + Math.floor((x1 - x0) * 0.72);
  if (per === 'noite') {
    for (let x = x0; x < x1; x++) for (let y = 2; y < 10; y++) if (hash(x * 3 + 1, y * 7) > 0.975) P(x, y, hash(x, y) > 0.5 ? '#FFFFFF' : '#9FB0E8');
    R(meio, 3, 4, 4, '#F4F1DC'); P(meio, 3, c.faixas[0]); P(meio + 3, 3, c.faixas[0]); P(meio, 6, c.faixas[0]); P(meio + 3, 6, c.faixas[0]); P(meio + 2, 4, '#D9D5BC');
  } else if (per === 'dia') {
    R(meio, 3, 4, 4, '#FFE27A'); R(meio + 1, 4, 2, 2, '#FFF6C4'); P(meio, 3, c.faixas[0]); P(meio + 3, 3, c.faixas[0]); P(meio, 6, c.faixas[1]); P(meio + 3, 6, c.faixas[1]);
    for (let x = x0 + 14; x < x1 - 20; x += 61) { R(x, 5, 9, 2, '#FFFFFF'); R(x + 2, 4, 5, 1, '#FFFFFF'); if (x + 31 < x1) R(x + 24, 8, 7, 1, '#EEF6FF'); } // a nuvem pequena não passa do fim do janelão
  } else {
    R(meio - 1, 12, 8, 5, '#FFD98A'); R(meio, 11, 6, 1, '#FFD98A'); R(meio + 1, 13, 4, 3, '#FFF0C2');
    for (let x = x0 + 9; x < x1 - 24; x += 47) R(x, 7 + (x % 3), 12, 1, '#F7B56C');
  }
  for (const [cor, hmin, hvar, semente, chance] of [[c.longe, 6, 8, 11, c.acesas * 0.5], [c.perto, 3, 7, 29, c.acesas]] as [string, number, number, number, number][]) {
    for (let x = x0; x < x1;) {
      const w = 4 + Math.floor(hash(x, semente) * 6), h = hmin + Math.floor(hash(x, semente + 1) * hvar), ww = Math.min(w, x1 - x);
      R(x, 17 - h, ww, h, cor);
      if (hash(x, semente + 3) > 0.8 && ww > 3) R(x + Math.floor(ww / 2), 17 - h - 2, 1, 2, cor); // antena
      for (let yy = 17 - h + 1; yy < 16; yy += 2) for (let xx = x + 1; xx < x + ww - 1; xx += 2) if (hash(xx, yy + semente) < chance) P(xx, yy, c.luz);
      x += w + (hash(x, semente + 2) > 0.7 ? 1 : 0);
    }
  }
}
/** Piso de tábuas (café). */
function tabuas(g: Ctx, x0: number, x1: number) {
  const { P } = mk(g);
  for (let y = 20; y < H; y++) {
    const tabua = Math.floor(y / 6);
    for (let x = x0; x < x1; x++) {
      let cor = tabua % 2 ? '#A9683A' : '#A26236';
      if (y % 6 === 5 || (x + tabua * 17) % 40 === 0) cor = '#7E4C28';
      else if (hash(x, y) > 0.93) cor = '#98592F';
      else if (hash(x + 7, y) > 0.97) cor = '#B97A48';
      P(x, y, cor);
    }
  }
}

/** Fundo fixo (paredes, piso, café, xadrez): desenhado uma vez por período do dia. */
function fundo(L: Layout, per: Periodo): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = L.W; c.height = H;
  const g = c.getContext('2d')!, { R, P, box } = mk(g), W = L.W, PASSADEIRA = H - 12;
  // PISO do salão: concreto polido claro, em placas grandes desencontradas
  for (let y = 20; y < H; y++) {
    const fiada = Math.floor((y - 20) / 14), desloc = fiada % 2 ? 13 : 0;
    for (let x = 0; x < L.cafe0; x++) {
      let cor = '#C5CBD7';
      if ((y - 20) % 14 === 13 || (x + desloc) % 26 === 25) cor = '#B1B8C7';
      else if (hash(x, y) > 0.94) cor = '#CED4DF';
      else if (hash(x + 3, y) > 0.972) cor = '#BAC1CF';
      P(x, y, cor);
    }
  }
  // PAREDE do salão: janelão com a cidade; montantes, vidro com reflexo e peitoril
  R(0, 0, W, 20, '#161B30');
  cidade(g, 2, L.div - 1, per);
  const vaos: [number, number][] = [];
  for (let x = 2; x < L.div - 1; x += 34) { const fim = Math.min(x + 33, L.div - 1); vaos.push([x, fim]); R(fim, 1, 1, 17, '#161B30'); }
  g.fillStyle = '#FFFFFF';
  for (const [a, b] of vaos) { if (b - a < 20) continue; g.globalAlpha = 0.16; for (let d = 0; d < 9; d++) g.fillRect(a + 5 + d, 12 - d, 1, 1); g.globalAlpha = 0.1; for (let d = 0; d < 12; d++) g.fillRect(a + 9 + d, 15 - d, 2, 1); }
  g.globalAlpha = 1;
  R(0, 0, W, 2, '#10142A'); R(0, 17, W, 3, '#232B45'); R(0, 17, W, 1, '#4C5A85'); R(0, 19, W, 1, '#0E1222');
  // reflexo das janelas no piso polido + sombra da parede
  g.fillStyle = '#FFFFFF';
  const claro = per === 'dia' ? 1 : per === 'tarde' ? 0.6 : 0.3; // de noite quase não entra luz pela janela
  for (const [a, b] of vaos) { g.globalAlpha = 0.13 * claro; g.fillRect(a + 2, 21, b - a - 4, 9); g.globalAlpha = 0.07 * claro; g.fillRect(a + 5, 30, b - a - 10, 11); }
  g.globalAlpha = 1;
  R(0, 20, L.div, 1, 'rgba(10,14,30,.30)'); R(0, 21, L.div, 1, 'rgba(10,14,30,.12)');
  // CAFÉ: madeira no piso, parede escura com pendentes, neon e prateleira; balcão de pedra com a máquina
  tabuas(g, L.cafe0, L.xad0);
  R(L.cafe0, 2, L.zona, 15, '#1D2540');
  for (let x = L.cafe0 + 1; x < L.xad0; x += 4) R(x, 2, 1, 15, '#222C4C');
  R(L.cafe0, 20, L.zona, 1, 'rgba(10,14,30,.35)'); R(L.cafe0, 21, L.zona, 1, 'rgba(10,14,30,.15)');
  neon(g, 'CAFÉ', L.cafe0 + 56, 7, '#FFE3F2', '#FF4FA3');
  if (L.zona >= 100) { // prateleira com garrafas e xícaras
    const px = L.cafe0 + 78, pw = L.zona - 86;
    R(px, 12, pw, 1, '#E2B27A'); R(px, 13, pw, 1, '#7E4C28');
    const itens = ['#4FAE6A', '#F5F5F5', '#D64545', '#E8B84A', '#F5F5F5', '#3F7FD6', '#9B59B6'];
    for (let x = px + 1, k = 0; x < px + pw - 2; x += 3, k++) { const h = k % 2 ? 3 : 5; R(x, 12 - h, 2, h, itens[k % 7]); if (h === 5) P(x, 12 - h, '#FFFFFF'); }
  }
  box(L.cafe0 + 4, 24, 46, 10, '#2C3246'); R(L.cafe0 + 4, 24, 46, 1, '#59617D'); R(L.cafe0 + 4, 25, 46, 1, '#3B4260');
  for (let x = L.cafe0 + 6; x < L.cafe0 + 48; x++) if (hash(x, 27) > 0.8) P(x, 26 + Math.floor(hash(x, 3) * 4), '#3F4762');
  R(L.cafe0 + 4, 31, 46, 3, '#B9844C'); R(L.cafe0 + 4, 31, 46, 1, '#E2B27A'); R(L.cafe0 + 4, 33, 46, 1, '#8A5A30'); R(L.cafe0 + 3, 35, 48, 1, 'rgba(0,0,0,.25)');
  box(L.cafe0 + 7, 15, 12, 12, '#C9CED8'); R(L.cafe0 + 7, 15, 12, 2, '#EEF1F6'); R(L.cafe0 + 8, 18, 10, 3, '#2A2F3C'); R(L.cafe0 + 10, 22, 2, 3, '#7C8496'); R(L.cafe0 + 14, 22, 2, 3, '#7C8496');
  P(L.cafe0 + 9, 19, '#E24B4B'); P(L.cafe0 + 11, 19, '#5CC06C'); R(L.cafe0 + 9, 25, 8, 1, '#2A2F3C');
  box(L.cafe0 + 23, 26, 3, 3, '#F5F5F5'); R(L.cafe0 + 23, 26, 3, 1, '#6B3E1F'); box(L.cafe0 + 29, 26, 3, 3, '#F5F5F5'); R(L.cafe0 + 29, 26, 3, 1, '#6B3E1F');
  box(L.cafe0 + 36, 25, 5, 4, '#E8B84A'); R(L.cafe0 + 36, 25, 5, 1, '#F7DE95'); box(L.cafe0 + 44, 26, 3, 3, '#5CC06C'); P(L.cafe0 + 45, 25, '#256B3A');
  for (const px of [L.cafe0 + 13, L.cafe0 + 27, L.cafe0 + 41]) { // pendentes sobre o balcão
    R(px, 0, 1, 6, '#0B0E1C'); R(px - 2, 7, 5, 2, '#E0B050'); R(px - 1, 6, 3, 1, '#E0B050'); R(px - 2, 8, 5, 1, '#B8862E'); P(px, 9, '#FFF3B8');
    g.fillStyle = '#FFE9A8'; g.globalAlpha = 0.14; g.fillRect(px - 3, 9, 7, 3); g.fillRect(px - 2, 12, 5, 3); g.globalAlpha = 1;
  }
  planta(g, L.cafe0 + L.zona - 21, 20, '#2C3246', '#1D2233');
  // XADREZ: piso quadriculado, parede de tijolinho escuro com janela de grade e neon vermelho
  for (let y = 20; y < H; y++) for (let x = L.xad0; x < W; x++) P(x, y, ((Math.floor((x - L.xad0) / 8) + Math.floor((y - 20) / 8)) % 2) ? '#E7E9EE' : '#22232B');
  R(L.xad0, 2, L.zona, 15, '#2B2434');
  for (let y = 4; y < 17; y += 3) { R(L.xad0, y, L.zona, 1, '#221C2A'); for (let x = L.xad0 + ((y / 3) % 2 ? 3 : 7); x < W; x += 8) R(x, y - 2, 1, 2, '#221C2A'); }
  box(L.xad0 + 8, 5, 19, 9, CEU[per].faixas[2]); R(L.xad0 + 8, 5, 19, 3, CEU[per].faixas[1]);
  for (let x = L.xad0 + 10; x < L.xad0 + 27; x += 3) R(x, 5, 1, 9, '#0C0C10');
  R(L.xad0 + 7, 14, 21, 1, '#3A3246');
  neon(g, 'XADREZ', W - 31, 7, '#FFE0E0', '#FF3B3B');
  R(L.xad0, 20, L.zona, 1, 'rgba(10,14,30,.35)');
  // PASSADEIRA do corredor: do salão até o xadrez, passando pela porta
  R(0, PASSADEIRA, L.xad0, 11, '#27335E'); R(0, PASSADEIRA, L.xad0, 1, '#3D4E8A'); R(0, PASSADEIRA + 10, L.xad0, 1, '#19213F');
  R(0, PASSADEIRA + 2, L.xad0, 1, '#D2A94E'); R(0, PASSADEIRA + 8, L.xad0, 1, '#D2A94E');
  for (let x = 0; x < L.xad0; x++) for (let y = PASSADEIRA + 3; y < PASSADEIRA + 8; y++) if (hash(x, y) > 0.9) P(x, y, '#2E3B6C');
  // faixa zebrada na entrada do xadrez
  for (let y = 20; y < H; y++) for (let x = L.xad0 - 2; x < L.xad0 + 2; x++) P(x, y, (x + y) % 6 < 3 ? '#F2C230' : '#1A1A1E');
  // DIVISÓRIA de vidro entre o salão e o café, com a PORTA embaixo (é por ela que eles atravessam)
  const porta = CORREDOR - 9;
  R(L.div, 17, 6, porta - 17, '#161B30'); R(L.div + 1, 20, 4, porta - 22, '#9FD8EE'); R(L.div + 2, 20, 1, porta - 22, '#D8F3FB'); R(L.div + 4, 20, 1, porta - 22, '#7FBFD8');
  for (let y = 30; y < porta - 4; y += 12) R(L.div + 1, y, 4, 1, '#161B30');
  R(L.div - 1, porta - 3, 8, 4, OUT); R(L.div, porta - 2, 6, 2, '#59617D');
  R(L.div, porta + 1, 6, PASSADEIRA - porta - 1, '#8B93A7'); R(L.div, porta + 1, 1, PASSADEIRA - porta - 1, '#6E7689'); R(L.div + 5, porta + 1, 1, PASSADEIRA - porta - 1, '#6E7689');
  planta(g, 5, 22);
  return c;
}

function cadeira(g: Ctx, cx: number, dy: number, vazia: boolean, cor: string) {
  const { R } = mk(g);
  R(cx - 9, dy - 17, 18, 12, OUT); R(cx - 8, dy - 16, 16, 10, '#3A4152'); R(cx - 8, dy - 16, 16, 2, cor); R(cx - 6, dy - 12, 12, 1, '#2C3242'); R(cx - 6, dy - 9, 12, 1, '#2C3242');
  if (vazia) { R(cx - 10, dy - 6, 20, 6, OUT); R(cx - 9, dy - 5, 18, 5, '#2C3242'); R(cx - 9, dy - 5, 18, 1, '#4A5266'); }
}
function mesa(g: Ctx, cx: number, dy: number, b: Boneco, ligado: boolean, f: number, k: number) {
  const { R, P, box } = mk(g), dx = cx - 25;
  R(dx - 1, dy + 18, 52, 2, 'rgba(10,14,30,.28)');
  // tampo branco, frente escura e a fita de LED na cor do banco (acesa quando ele está trabalhando)
  box(dx, dy, 50, 18, '#EEF1F6'); R(dx, dy, 50, 1, '#FFFFFF'); R(dx, dy + 11, 50, 1, '#C3CAD6');
  R(dx, dy + 12, 50, 6, '#262C40'); R(dx, dy + 17, 50, 1, '#171B2A'); R(dx + 24, dy + 13, 1, 4, '#1B2032');
  if (ligado) { R(dx, dy + 12, 50, 1, b.cor); g.fillStyle = b.cor; g.globalAlpha = 0.35; g.fillRect(dx, dy + 13, 50, 1); g.globalAlpha = 0.14; g.fillRect(dx, dy + 14, 50, 1); g.globalAlpha = 1; } else R(dx, dy + 12, 50, 1, '#3A4260');
  // monitor largo: painel escuro com as barrinhas do banco
  box(dx + 5, dy + 7, 8, 2, '#2F3440'); R(dx + 8, dy + 1, 2, 6, '#3B414E'); box(dx + 1, dy - 12, 16, 12, '#12151D');
  if (ligado) {
    R(dx + 2, dy - 11, 14, 10, '#0F1B36'); R(dx + 2, dy - 11, 14, 2, '#1B2B55'); P(dx + 3, dy - 10, '#5CC06C'); R(dx + 5, dy - 10, 5, 1, '#8FA6D8');
    for (let n = 0; n < 4; n++) { const h = 2 + ((n * 3 + f) % 5); R(dx + 3 + n * 3, dy - 2 - h, 2, h, b.cor); }
    P(dx + 14, dy - 6 + (f % 3), '#FFFFFF');
    g.fillStyle = b.cor; g.globalAlpha = 0.18; g.fillRect(dx + 2, dy + 1, 15, 2); g.globalAlpha = 1;
  } else { R(dx + 2, dy - 11, 14, 10, '#1A1F2B'); R(dx + 4, dy - 9, 1, 5, '#262D3D'); R(dx + 5, dy - 10, 1, 3, '#262D3D'); P(dx + 14, dy - 3, '#E24B4B'); }
  box(cx - 7, dy + 3, 14, 3, '#2F3440'); for (let x = cx - 6; x < cx + 6; x += 2) P(x, dy + 4, '#6A7390');
  box(cx + 10, dy + 4, 3, 3, '#2F3440'); P(cx + 11, dy + 4, '#6A7390');
  // cada mesa tem um detalhe diferente: caneca, plantinha ou caderno
  if (k % 3 === 1) { box(dx + 42, dy + 4, 4, 4, '#F2F4F8'); R(dx + 43, dy + 1, 2, 3, '#3E9A4A'); P(dx + 42, dy + 2, '#5CC06C'); P(dx + 45, dy + 2, '#5CC06C'); P(dx + 44, dy, '#5CC06C'); } else {
    box(dx + 41, dy + 2, 5, 6, '#F5F5F5'); R(dx + 42, dy + 3, 3, 1, '#6B3E1F'); P(dx + 47, dy + 4, OUT); P(dx + 47, dy + 5, OUT);
    if (k % 3 === 2) { box(dx + 31, dy + 3, 6, 5, b.cor); R(dx + 31, dy + 3, 1, 5, '#FFFFFF'); }
  }
}
function sentado(g: Ctx, b: Boneco, cx: number, dy: number) {
  const { P } = mk(g), x = cx - 8, pal = paleta(b);
  stamp(g, b, x, dy - 20, 19);
  'OTTOTTTTTTTTOttO'.split('').forEach((ch, i) => P(x + i, dy - 1, pal[ch]));
}
function maos(g: Ctx, b: Boneco, cx: number, dy: number, f: number, digitando: boolean) {
  const { R } = mk(g), pal = paleta(b), e = digitando ? f % 2 : 0, d = digitando ? (f + 1) % 2 : 0;
  R(cx - 8, dy, 4, 3, OUT); R(cx - 7, dy, 2, 2, pal.T); R(cx - 6, dy + 2 + e, 3, 2, OUT); R(cx - 5, dy + 2 + e, 2, 1, pal.S);
  R(cx + 4, dy, 4, 3, OUT); R(cx + 5, dy, 2, 2, pal.t); R(cx + 3, dy + 2 + d, 3, 2, OUT); R(cx + 3, dy + 2 + d, 2, 1, pal.S);
}
function emPe(g: Ctx, b: Boneco, x: number, y: number, f: number, cafe: boolean) {
  const { R, P, box } = mk(g);
  sombra(g, x, y);
  const yy = y - (f % 4 === 0 ? 1 : 0);
  stamp(g, b, x, yy, 28);
  if (cafe) {
    box(x + 12, yy + 18, 4, 4, '#F5F5F5'); R(x + 12, yy + 18, 4, 1, '#6B3E1F'); P(x + 16, yy + 19, OUT); P(x + 16, yy + 20, OUT);
    const v = f % 3; P(x + 13 + (v % 2), yy + 15 - v, 'rgba(255,255,255,.8)'); P(x + 14 - (v % 2), yy + 13 - v, 'rgba(255,255,255,.55)');
  }
}
function seta(g: Ctx, x: number, y: number, f: number) {
  const { R, P } = mk(g), d = f % 2;
  R(x - 3, y - 6 + d, 7, 1, '#FFD34D'); R(x - 2, y - 5 + d, 5, 1, '#FFD34D'); R(x - 1, y - 4 + d, 3, 1, '#FFD34D'); P(x, y - 3 + d, '#FFD34D');
}

// ---------------- a cena viva ----------------
interface Ponto { x: number; y: number }
interface Ator { alvo: Alvo; px: number; py: number; rota: Ponto[]; dir: Dir; andou: number }
const igual = (a: Ponto, b: Ponto) => a.x === b.x && a.y === b.y;
const perto = (a: number, b: number) => Math.abs(a - b) < 0.01;
/** (px, py) está em cima do trecho reto a→b? */
const noTrecho = (px: number, py: number, a: Ponto, b: Ponto) =>
  (a.y === b.y && perto(py, a.y) && px >= Math.min(a.x, b.x) - 0.01 && px <= Math.max(a.x, b.x) + 0.01)
  || (a.x === b.x && perto(px, a.x) && py >= Math.min(a.y, b.y) - 0.01 && py <= Math.max(a.y, b.y) + 0.01);

export type Cena = ReturnType<typeof criarCena>;
/** A cena de um produto (um bonequinho por banco, na ordem das mesas). Guarda onde cada um ESTÁ agora — o componente só diz onde cada um deve estar. */
export function criarCena(L: Layout, bonecos: Boneco[], relogio: () => Date = () => new Date()) {
  const atores: (Ator | undefined)[] = [];
  let fundoPronto: HTMLCanvasElement | null = null, fundoDe: Periodo | null = null;
  const assento = (k: number): Ponto => ({ x: L.estacoes[k][0] - 8, y: L.estacoes[k][1] - 20 });
  /** Vão à direita da mesa (entre ela e a próxima, ou a divisória): por onde ele sai de trás da mesa e desce pro corredor. */
  const vao = (k: number) => L.estacoes[k][0] + 24;
  const andando = (k: number) => !!atores[k]?.rota.length;
  /** Ainda atrás da própria mesa (na linha da cadeira): a mesa cobre as pernas, então vai no canvas de baixo. */
  const atrasDaMesa = (k: number) => { const at = atores[k]; return !!at && at.py <= assento(k).y + 0.01; };

  /** De onde ele está até o corredor. */
  function ateOCorredor(at: Ator, k: number): Ponto[] {
    if (at.py >= CORREDOR - 0.01) return [];
    const a = assento(k);
    if (perto(at.py, a.y) && at.px >= a.x - 0.01 && at.px <= vao(k) + 0.01) return [{ x: vao(k), y: a.y }, { x: vao(k), y: CORREDOR }];
    return [{ x: at.px, y: CORREDOR }];
  }
  /** Do corredor até o lugar. */
  const doCorredor = (a: Alvo, k: number): Ponto[] => (a.lugar === 'mesa'
    ? [{ x: vao(k), y: CORREDOR }, { x: vao(k), y: a.y }, { x: a.x, y: a.y }]
    : [{ x: a.x, y: CORREDOR }, { x: a.x, y: a.y }]);
  /** Tira ponto repetido, vai-e-volta (P, Q, P) e o 1º ponto quando ele já está no trecho seguinte (iria até lá só pra voltar). */
  function enxugar(r: Ponto[], px: number, py: number): Ponto[] {
    const out: Ponto[] = [];
    for (const p of r) {
      if (out.length && igual(out[out.length - 1], p)) continue;
      if (out.length >= 2 && igual(out[out.length - 2], p)) { out.pop(); continue; }
      out.push(p);
    }
    while (out.length >= 2 && noTrecho(px, py, out[0], out[1])) out.shift();
    while (out.length && perto(out[0].x, px) && perto(out[0].y, py)) out.shift();
    return out;
  }
  const zonaDe = (x: number): Lugar => (x >= L.xad0 ? 'xadrez' : x >= L.cafe0 ? 'cafe' : 'mesa');

  /** Onde cada bonequinho deve estar agora (na ordem dos bonecos). Lugar novo vira caminhada; `animar` falso (ou alvo provisório) põe direto no lugar. */
  function definir(alvos: Alvo[], animar: boolean) {
    alvos.forEach((novo, k) => {
      const at = atores[k];
      if (!at || !animar || at.alvo.provisorio || novo.provisorio) { atores[k] = { alvo: novo, px: novo.x, py: novo.y, rota: [], dir: 'baixo', andou: 0 }; return; }
      const mesmo = at.alvo.lugar === novo.lugar && at.alvo.x === novo.x && at.alvo.y === novo.y;
      at.alvo = novo; // `proximo` muda sem ele sair do lugar
      if (mesmo) return;
      // Mesmo cômodo e já na linha dos lugares (o vizinho saiu e a fila andou): só chega pro lado.
      const direto = novo.lugar !== 'mesa' && perto(at.py, novo.y) && zonaDe(at.px) === novo.lugar;
      at.rota = direto ? enxugar([{ x: novo.x, y: novo.y }], at.px, at.py) : enxugar([...ateOCorredor(at, k), ...doCorredor(novo, k)], at.px, at.py);
      if (!at.rota.length) { at.px = novo.x; at.py = novo.y; }
    });
    atores.length = alvos.length;
  }

  /** Anda `dtMs` milissegundos. Devolve true quando alguém CHEGOU neste passo (o componente redesenha as plaquinhas). */
  function avancar(dtMs: number): boolean {
    let chegou = false;
    for (const at of atores) {
      if (!at || !at.rota.length) continue;
      let resta = (VEL * dtMs) / 1000;
      while (resta > 0 && at.rota.length) {
        const p = at.rota[0], dx = p.x - at.px, dy = p.y - at.py, d = Math.hypot(dx, dy);
        if (d > 0.001) at.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'dir' : 'esq') : dy > 0 ? 'baixo' : 'cima';
        if (d <= resta) { at.px = p.x; at.py = p.y; at.andou += d; resta -= d; at.rota.shift(); } else { at.px += (dx / d) * resta; at.py += (dy / d) * resta; at.andou += resta; resta = 0; }
      }
      if (!at.rota.length) { at.px = at.alvo.x; at.py = at.alvo.y; at.dir = 'baixo'; at.andou = 0; chegou = true; }
    }
    return chegou;
  }

  const caminhando = (g: Ctx, k: number) => { const at = atores[k]!; quadroAndando(g, bonecos[k], Math.round(at.px), Math.round(at.py), at.dir, Math.floor(at.andou / PX_POR_QUADRO) % 4); };
  /** Ponto em cima da cabeça (seta do escolhido, ícone do estado, plaquinha de quem anda). */
  function marca(k: number): Ponto {
    const at = atores[k];
    if (!at) return { x: 0, y: 0 };
    if (!andando(k) && at.alvo.lugar === 'mesa') return { x: L.estacoes[k][0], y: L.estacoes[k][1] - 20 };
    return { x: Math.round(at.px) + 8, y: Math.round(at.py) };
  }
  /** Área do clique: a mesa inteira de quem está sentado; senão, o bonequinho onde ele estiver. */
  function area(k: number): { x: number; y: number; w: number; h: number } {
    const at = atores[k];
    if (!at) return { x: 0, y: 0, w: 0, h: 0 };
    if (!andando(k) && at.alvo.lugar === 'mesa') return { x: L.estacoes[k][0] - 25, y: L.estacoes[k][1] - 22, w: 50, h: 42 };
    return { x: Math.round(at.px) - 2, y: Math.round(at.py) - 2, w: 20, h: 32 };
  }

  /** Desenha a cena: `g` = canvas de baixo (salão, mesas, quem está parado); `topo` = canvas de cima, transparente (quem atravessa o salão). */
  function desenhar(g: Ctx, topo: Ctx | null, f: number, escolhido: string | null) {
    const per = periodoDe(relogio().getHours());
    if (!fundoPronto || fundoDe !== per) { fundoPronto = fundo(L, per); fundoDe = per; }
    g.drawImage(fundoPronto, 0, 0);
    const naMesa = (k: number) => !!atores[k] && !andando(k) && atores[k]!.alvo.lugar === 'mesa';
    bonecos.forEach((b, k) => cadeira(g, L.estacoes[k][0], L.estacoes[k][1], !naMesa(k), b.cor));
    bonecos.forEach((b, k) => { if (naMesa(k)) sentado(g, b, L.estacoes[k][0], L.estacoes[k][1]); else if (andando(k) && atrasDaMesa(k)) caminhando(g, k); });
    bonecos.forEach((b, k) => {
      mesa(g, L.estacoes[k][0], L.estacoes[k][1], b, naMesa(k), f + k, k);
      if (naMesa(k)) maos(g, b, L.estacoes[k][0], L.estacoes[k][1], f + k, !atores[k]!.alvo.proximo);
    });
    bonecos.forEach((b, k) => { const at = atores[k]; if (at && !andando(k) && at.alvo.lugar !== 'mesa') emPe(g, b, at.alvo.x, at.alvo.y, f + k, at.alvo.lugar === 'cafe'); });
    const frente = topo || g;
    if (topo) topo.clearRect(0, 0, L.W, H);
    bonecos.map((_b, k) => k).filter((k) => andando(k) && !atrasDaMesa(k)).sort((a, b) => atores[a]!.py - atores[b]!.py).forEach((k) => caminhando(frente, k));
    const ks = bonecos.findIndex((b) => b.key === escolhido);
    if (ks >= 0 && atores[ks]) { const m = marca(ks); seta(andando(ks) && !atrasDaMesa(ks) ? frente : g, m.x, m.y, f); }
  }

  return {
    definir, avancar, desenhar, marca, area,
    temAndando: () => atores.some((at) => !!at?.rota.length),
    /** Canto de cima/esquerda do bonequinho agora e se ele está andando. */
    posicao: (k: number) => { const at = atores[k]; return { x: at ? Math.round(at.px) : 0, y: at ? Math.round(at.py) : 0, andando: andando(k) }; },
  };
}
