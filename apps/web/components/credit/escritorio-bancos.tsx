'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { ExtensionsLivePanel, BancoLiveCard, colunasDe, useCreditLive, type Live } from './extensions-live-panel';
import { CaixaPanel } from './caixa-panel';

/* ESCRITÓRIO DOS BANCOS (Fabio 10/11: "os bonequinhos seriam os bancos; os que estivessem trabalhando ficariam sentados e os que não estivessem, por algum
 * motivo, ficariam em pé no xadrez"; "ele pode ficar no xadrez ou tomando café"). Pixel art própria, desenhada em canvas (sem imagem nem biblioteca).
 *  - Sentado na mesa: a extensão está rodando um cliente (ou o próximo da fila vai começar).
 *  - No café: online e sem cliente na fila (ou fora do horário 07h–22h).
 *  - Em pé no xadrez: problema — login vencido, extensão sem sinal ou automático pausado.
 * Clique no bonequinho: o cartão daquele banco (o mesmo das caixinhas: rodando, fila, agendadas, já rodados; na CAIXA, os botões do cadastro).
 * Dados: os mesmos do painel das extensões (GET /credit-analysis/live), o painel da CAIXA (GET /caixa-cadastro/painel) e a pausa geral (GET /credit-analysis/auto). */

type Lugar = 'mesa' | 'cafe' | 'xadrez';
interface Boneco { key: string; nome: string; cor: string; hair: [string, string, string]; skin: [string, string]; shirt: [string, string, string]; tie: string | null; longo: boolean }
interface EstadoBanco { lugar: Lugar; titulo: string; detalhe: string; proximo?: boolean }

const BONECOS_HE: Boneco[] = [
  { key: 'CREDIMORAR', nome: 'Santander', cor: '#EC0000', hair: ['#1E1A1A', '#0F0D0D', '#3A3333'], skin: ['#D9A07A', '#B97F5B'], shirt: ['#EC0000', '#A80000', '#FF4D4D'], tie: null, longo: true },
  { key: 'CREDITAS', nome: 'Creditas', cor: '#12A37E', hair: ['#E8C46A', '#BF9A45', '#F7DE95'], skin: ['#F6D2B5', '#DDAE8E'], shirt: ['#12A37E', '#0B7A5E', '#3FC79F'], tie: null, longo: true },
  { key: 'INTER', nome: 'Inter', cor: '#FF7A00', hair: ['#4A2F1F', '#33201A', '#6B4630'], skin: ['#F1C6A0', '#D9A27C'], shirt: ['#FF7A00', '#C95E00', '#FF9D45'], tie: null, longo: false },
  { key: 'CAIXA', nome: 'CAIXA', cor: '#005CA9', hair: ['#BDBDBD', '#8F8F8F', '#E0E0E0'], skin: ['#E8B590', '#C98F69'], shirt: ['#005CA9', '#00427A', '#2A7DC4'], tie: '#F39200', longo: false },
];

// Financiamento (FH): Credimorar (Bradesco e Santander numa simulação), Inter no nosso portal, Itaú no portal Itaú Imóveis, CAIXA e BRB (à mão).
const BONECOS_FH: Boneco[] = [
  { key: 'CREDIMORAR_FH', nome: 'Credimorar', cor: '#1F3A93', hair: ['#5A3A24', '#3E2718', '#7A5236'], skin: ['#E8B590', '#C98F69'], shirt: ['#1F3A93', '#152A6B', '#3554B8'], tie: '#CC092F', longo: false },
  { key: 'INTER_FH', nome: 'Inter', cor: '#FF7A00', hair: ['#4A2F1F', '#33201A', '#6B4630'], skin: ['#F1C6A0', '#D9A27C'], shirt: ['#FF7A00', '#C95E00', '#FF9D45'], tie: null, longo: false },
  { key: 'ITAU_FH', nome: 'Itaú', cor: '#EC7000', hair: ['#1A1412', '#0E0A09', '#33281F'], skin: ['#8D5A3B', '#6E4329'], shirt: ['#0B3D91', '#072A66', '#2A5BB5'], tie: '#EC7000', longo: false },
  { key: 'CAIXA_FH', nome: 'CAIXA', cor: '#005CA9', hair: ['#BDBDBD', '#8F8F8F', '#E0E0E0'], skin: ['#E8B590', '#C98F69'], shirt: ['#005CA9', '#00427A', '#2A7DC4'], tie: '#F39200', longo: false },
  { key: 'BRB_FH', nome: 'BRB', cor: '#00529B', hair: ['#2B1B14', '#1A100B', '#4A3022'], skin: ['#B07A55', '#8E5F40'], shirt: ['#3FA7E0', '#2A82B5', '#7CC6EE'], tie: '#00529B', longo: true },
];

interface CardCaixa { leadId: string; nome: string; status: string | null; atual: { tipo: string; ordem: number; desde: string } | null; participantes: { ordem: number; nome: string; cadastro: string | null }[]; conferencia: { status: string } | null; avaliacao: { status: string } | null }
const ACAO_CAIXA: Record<string, string> = { consultar: 'consultando o nome', cadastrar: 'cadastrando no Caixa Aqui', avaliar: 'Avaliação de Risco' };

const curto = (t: string, n = 34) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Onde o bonequinho de um banco com extensão fica. Pura. */
export function estadoDoBanco(l: Live | undefined, pausado: boolean): EstadoBanco {
  if (!l) return { lugar: 'cafe', titulo: 'carregando…', detalhe: '' };
  if (l.loginNeeded) return { lugar: 'xadrez', titulo: '🔑 login vencido', detalhe: 'entre no portal do banco' };
  const r = l.running[0];
  if (r) return { lugar: 'mesa', titulo: r.leadName, detalhe: r.step || (r.kind === 'CHECK' ? 'conferindo o resultado' : 'rodando a análise') };
  if (l.foraDoHorario) return { lugar: 'cafe', titulo: '🌙 fora do horário', detalhe: 'volta às 07h' };
  if (!l.online) return { lugar: 'xadrez', titulo: '📡 extensão sem sinal', detalhe: 'Chrome aberto e extensão ligada?' };
  const q = l.queue[0];
  if (q) return { lugar: 'mesa', titulo: q.leadName, detalhe: `próximo da fila${l.queued > 1 ? ` · ${l.queued} na fila` : ''}`, proximo: true };
  if (pausado) return { lugar: 'xadrez', titulo: '⏸ automático pausado', detalhe: 'só roda o que for pedido' };
  return { lugar: 'cafe', titulo: '☕ sem cliente na fila', detalhe: '' };
}

/** Banco rodado à mão (CAIXA e BRB no Financiamento): na mesa enquanto tem cliente em análise; senão no café. Pura. */
export function estadoManual(l: Live | undefined): EstadoBanco {
  if (!l) return { lugar: 'cafe', titulo: 'carregando…', detalhe: '' };
  const r = l.running[0];
  if (r) return { lugar: 'mesa', titulo: r.leadName, detalhe: 'em análise (à mão)' };
  const q = l.queue[0];
  if (q) return { lugar: 'mesa', titulo: q.leadName, detalhe: `pedido à mão${l.queued > 1 ? ` · ${l.queued} na fila` : ''}`, proximo: true };
  return { lugar: 'cafe', titulo: '✋ roda à mão', detalhe: 'com a documentação completa' };
}

/** CAIXA: pelo painel da fila do Caixa Aqui (consulta, cadastro, Avaliação de Risco). Pura. */
export function estadoDaCaixa(cards: CardCaixa[] | undefined): EstadoBanco {
  if (!cards) return { lugar: 'cafe', titulo: 'carregando…', detalhe: '' };
  const rodando = cards.find((c) => c.atual);
  if (rodando) return { lugar: 'mesa', titulo: rodando.nome, detalhe: ACAO_CAIXA[rodando.atual!.tipo] || rodando.atual!.tipo };
  const fila = cards.filter((c) => c.status === 'FILA' || c.participantes.some((p) => p.cadastro === 'FILA') || c.avaliacao?.status === 'FILA');
  if (fila.length) return { lugar: 'mesa', titulo: fila[0].nome, detalhe: `próximo da fila${fila.length > 1 ? ` · ${fila.length} na fila` : ''}`, proximo: true };
  const conferir = cards.filter((c) => c.conferencia?.status === 'PENDENTE').length;
  if (conferir) return { lugar: 'cafe', titulo: `☕ esperando a conferência (${conferir})`, detalhe: 'confira o cadastro no Caixa Aqui' };
  return { lugar: 'cafe', titulo: '☕ sem cliente na fila', detalhe: '' };
}

// ---------------- desenho (pixel art) ----------------
const OUT = '#241A16';
const CHAR = [
  '....OOOOOOOO....', '..OOHHHiiHHHOO..', '.OHHHHHiHHHHHhO.', '.OHHHHHHHHHHHhO.', 'OHHHHHHHHHHHHhhO', 'OHHHSSHHHSSSHhhO',
  'OHHSSSSSSSSSShHO', 'OHSSSSSSSSSSSsHO', 'OSSSeESSSSeESssO', 'OSSSEESSSSEESssO', 'OSqSSSSssSSSqssO', '.OSSSSSmmSSSSsO.',
  '..OsSSSSSSSSsO..', '...OOssssssOO...', '..OOTTTccTTTOO..', '.OTTTTTXXTTTTtO.', 'OuTTTTTXXTTTTttO', 'OuTOTTTXXTTTOttO',
  'OTTOTTTTTTTTOttO', 'OTTOTTTTTTTtOttO', 'OSSOPPPPPPPPOssO', '.OOOPPPPPPPpOOO.', '...OPPPPPPPpO...', '...OPPPOOPPpO...',
  '...OPPpOOPPpO...', '...OPPpOOPPpO...', '...OBbBOOBbBO...', '...OOOOOOOOOO...',
];
const H = 98; // piso com folga embaixo pras plaquinhas de quem está em pé (alternadas)
const hash = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;

interface Layout { W: number; estacoes: [number, number][]; div: number; cafe0: number; xad0: number; zona: number; cafe: [number, number][]; xadrez: [number, number][] }
function layoutPara(n: number): Layout {
  const estacoes = Array.from({ length: n }, (_, k) => [52 + k * 64, 50] as [number, number]);
  // café e xadrez com lugar pros 4 lado a lado (fora do horário todos vão pro café)
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

function paleta(b: Boneco): Record<string, string> {
  return { O: OUT, H: b.hair[0], h: b.hair[1], i: b.hair[2], S: b.skin[0], s: b.skin[1], E: '#1B1B1B', e: '#FFFFFF', m: '#9E4B44', q: '#F09A8E',
    T: b.shirt[0], t: b.shirt[1], u: b.shirt[2], c: '#F5F5F5', X: b.tie || b.shirt[0], P: '#2F3E66', p: '#222D4A', B: '#1E1E1E', b: '#4A4A4A' };
}
function stamp(g: Ctx, b: Boneco, x: number, y: number, linhas: number) {
  const { P } = mk(g), pal = paleta(b), rows = CHAR.map((r) => r.split(''));
  if (b.longo) {
    for (let j = 6; j <= 12; j++) { rows[j][1] = 'H'; rows[j][14] = 'h'; }
    for (let j = 13; j <= 15; j++) { rows[j][0] = 'O'; rows[j][1] = 'H'; rows[j][2] = 'H'; rows[j][13] = 'h'; rows[j][14] = 'h'; rows[j][15] = 'O'; }
  }
  for (let j = 0; j < linhas; j++) rows[j].forEach((ch, i) => { if (ch !== '.') P(x + i, y + j, pal[ch]); });
  if (!b.tie && linhas > 17) { P(x + 10, y + 16, '#FFFFFF'); P(x + 10, y + 17, '#D8DCE4'); }
}

function planta(g: Ctx, x: number, y: number) {
  const { R, P } = mk(g);
  R(x + 3, y + 11, 8, 7, OUT); R(x + 4, y + 12, 6, 5, '#B5653A'); R(x + 4, y + 12, 6, 1, '#D07C4A');
  for (const [dx, dy] of [[7, 0], [4, 2], [10, 2], [2, 5], [12, 5], [5, 5], [9, 5], [7, 3], [3, 8], [11, 8], [7, 7]]) { R(x + dx - 1, y + dy, 3, 4, '#2F7A3A'); P(x + dx, y + dy, '#55B060'); P(x + dx, y + dy + 1, '#3E9A4A'); }
}

/** Fundo fixo (paredes, piso, café, xadrez): desenhado uma vez. */
function fundo(L: Layout): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = L.W; c.height = H;
  const g = c.getContext('2d')!, { R, P, box } = mk(g), W = L.W;
  for (let y = 20; y < H; y++) {
    const tabua = Math.floor(y / 6);
    for (let x = 0; x < L.div; x++) {
      let cor = tabua % 2 ? '#B9793F' : '#B4743B';
      if (y % 6 === 5 || (x + tabua * 17) % 40 === 0) cor = '#93602F';
      else if (hash(x, y) > 0.93) cor = '#A86C37';
      else if (hash(x + 7, y) > 0.97) cor = '#C4874E';
      P(x, y, cor);
    }
  }
  R(0, 0, W, 20, '#34405E');
  for (let x = 0; x < W; x++) for (let y = 3; y < 16; y++) if (hash(x, y) > 0.96) P(x, y, '#3A4768');
  R(0, 0, W, 3, '#222A40'); R(0, 16, W, 1, '#4A5880'); R(0, 17, W, 3, '#232B42'); R(0, 19, W, 1, '#1A2033');
  for (let x = 22, k = 0; x < L.div - 40; x += 54, k++) {
    box(x, 4, 20, 10, '#6B4A2B'); R(x + 1, 5, 18, 8, '#8FC6FF'); R(x + 1, 10, 18, 3, '#5DAA57'); R(x + 4, 9, 6, 2, '#4E9649');
    if (k % 2 === 0) R(x + 14, 6, 2, 2, '#FFD34D'); else { R(x + 4, 6, 4, 1, '#FFFFFF'); R(x + 10, 7, 3, 1, '#FFFFFF'); }
  }
  box(L.div - 22, 5, 9, 9, '#F5F5F5'); P(L.div - 18, 7, OUT); P(L.div - 18, 8, OUT); P(L.div - 18, 9, OUT); P(L.div - 17, 9, OUT);
  // estante sobre o café
  box(L.cafe0 + 8, 3, 48, 12, '#6B4A2B');
  const cores = ['#D64545', '#3F7FD6', '#E8B84A', '#4FAE6A', '#9B59B6', '#E07B39', '#2F9C95'];
  for (let x = L.cafe0 + 10, k = 0; x < L.cafe0 + 54; k++) { const w = 2 + (k % 3 === 0 ? 1 : 0), h = 8 + (k % 2); R(x, 4 + (9 - h), w, h, cores[k % 7]); x += w + 1; }
  // divisória, café (carpete + balcão) e xadrez
  R(L.div, 20, 6, H - 20, '#232B42'); R(L.div + 1, 20, 4, H - 20, '#4A5878'); R(L.div + 1, 20, 4, 1, '#6A7AA0');
  R(L.cafe0, 20, L.zona, H - 20, '#2F4F88'); R(L.cafe0 + 2, 21, L.zona - 4, H - 22, '#3F67AE');
  for (let y = 23; y < H - 2; y += 4) for (let x = L.cafe0 + 4 + (y % 8 ? 2 : 0); x < L.cafe0 + L.zona - 4; x += 4) P(x, y, '#4A74BC');
  box(L.cafe0 + 4, 24, 44, 10, '#C99A62'); R(L.cafe0 + 4, 24, 44, 2, '#E2B27A'); R(L.cafe0 + 4, 32, 44, 2, '#9E6C3A');
  box(L.cafe0 + 7, 17, 10, 10, '#3A3F4B'); R(L.cafe0 + 8, 18, 8, 2, '#5A6172'); R(L.cafe0 + 10, 22, 4, 3, '#1F2530'); P(L.cafe0 + 12, 21, '#E24B4B');
  box(L.cafe0 + 22, 26, 3, 3, '#F5F5F5'); R(L.cafe0 + 22, 26, 3, 1, '#6B3E1F'); box(L.cafe0 + 28, 26, 3, 3, '#F5F5F5'); box(L.cafe0 + 35, 27, 2, 2, '#F5F5F5'); box(L.cafe0 + 40, 26, 4, 4, '#E8B84A');
  planta(g, L.cafe0 + L.zona - 20, 20);
  R(L.xad0, 20, 1, H - 20, '#1A1A1A');
  for (let y = 20; y < H; y++) for (let x = L.xad0 + 1; x < W; x++) P(x, y, ((Math.floor((x - L.xad0 - 1) / 8) + Math.floor((y - 20) / 8)) % 2) ? '#ECECEC' : '#2B2B2B');
  planta(g, L.div - 16, 22);
  return c;
}

function cadeira(g: Ctx, cx: number, dy: number, vazia: boolean) {
  const { R } = mk(g);
  R(cx - 9, dy - 17, 18, 12, OUT); R(cx - 8, dy - 16, 16, 10, '#5A4A7A'); R(cx - 8, dy - 16, 16, 2, '#7564A0'); R(cx - 6, dy - 13, 12, 1, '#4A3D66');
  if (vazia) { R(cx - 10, dy - 6, 20, 6, OUT); R(cx - 9, dy - 5, 18, 5, '#4A3D66'); R(cx - 9, dy - 5, 18, 1, '#6A5A8E'); }
}
function mesa(g: Ctx, cx: number, dy: number, b: Boneco, ligado: boolean, f: number) {
  const { R, P, box } = mk(g), dx = cx - 25;
  R(dx - 1, dy + 18, 52, 2, 'rgba(0,0,0,.22)');
  box(dx, dy, 50, 18, '#E4B57E'); R(dx, dy, 50, 1, '#F3CD9C');
  for (let y = dy + 3; y < dy + 12; y += 4) for (let x = dx + 2; x < dx + 48; x++) if (hash(x, y) > 0.55) P(x, y, '#D9A66D');
  R(dx, dy + 12, 50, 6, '#B9844C'); R(dx, dy + 17, 50, 1, '#9E6C3A'); R(dx, dy + 12, 50, 1, '#8A5A30'); R(cx - 3, dy + 14, 6, 1, '#6E4A26');
  box(dx + 4, dy + 7, 8, 2, '#2F3440'); R(dx + 7, dy + 2, 2, 5, '#3B414E'); box(dx + 1, dy - 12, 14, 14, '#262B35');
  if (ligado) {
    R(dx + 2, dy - 11, 12, 12, '#7FD0FF'); R(dx + 2, dy - 11, 12, 1, '#B5E6FF');
    for (let k = 0; k < 4; k++) { const h = 2 + ((k * 3 + f) % 6); R(dx + 3 + k * 3, dy - 1 - h, 2, h, b.cor); }
    P(dx + 3, dy - 10, '#FFFFFF');
  } else { R(dx + 2, dy - 11, 12, 12, '#1F2530'); R(dx + 4, dy - 9, 1, 5, '#2E3646'); R(dx + 5, dy - 10, 1, 3, '#2E3646'); }
  box(cx - 7, dy + 3, 14, 3, '#E7EAF0'); for (let x = cx - 6; x < cx + 6; x += 2) P(x, dy + 4, '#AEB4C0');
  box(cx + 10, dy + 4, 3, 3, '#E7EAF0');
  box(dx + 41, dy + 2, 5, 6, '#F5F5F5'); R(dx + 42, dy + 3, 3, 1, '#6B3E1F'); P(dx + 47, dy + 4, OUT); P(dx + 47, dy + 5, OUT);
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
  g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(x + 8, y + 28, 7, 1.6, 0, 0, Math.PI * 2); g.fill();
  const yy = y - (f % 4 === 0 ? 1 : 0);
  stamp(g, b, x, yy, CHAR.length);
  if (cafe) {
    box(x + 12, yy + 18, 4, 4, '#F5F5F5'); R(x + 12, yy + 18, 4, 1, '#6B3E1F'); P(x + 16, yy + 19, OUT); P(x + 16, yy + 20, OUT);
    const v = f % 3; P(x + 13 + (v % 2), yy + 15 - v, 'rgba(255,255,255,.8)'); P(x + 14 - (v % 2), yy + 13 - v, 'rgba(255,255,255,.55)');
  }
}
function seta(g: Ctx, x: number, y: number, f: number) {
  const { R, P } = mk(g), d = f % 2;
  R(x - 3, y - 6 + d, 7, 1, '#FFD34D'); R(x - 2, y - 5 + d, 5, 1, '#FFD34D'); R(x - 1, y - 4 + d, 3, 1, '#FFD34D'); P(x, y - 3 + d, '#FFD34D');
}

interface Posicionado { b: Boneco; st: EstadoBanco; cx: number; dy: number; x: number; y: number; area: { x: number; y: number; w: number; h: number }; marca: { x: number; y: number } }
function posicionar(L: Layout, bonecos: Boneco[], estados: Record<string, EstadoBanco>): Posicionado[] {
  let nc = 0, nx = 0;
  return bonecos.map((b, k) => {
    const st = estados[b.key], [cx, dy] = L.estacoes[k];
    if (st.lugar === 'mesa') return { b, st, cx, dy, x: cx - 8, y: dy - 20, area: { x: cx - 25, y: dy - 22, w: 50, h: 42 }, marca: { x: cx, y: dy - 20 } };
    const [x, y] = st.lugar === 'cafe' ? L.cafe[nc++ % L.cafe.length] : L.xadrez[nx++ % L.xadrez.length];
    return { b, st, cx, dy, x, y, area: { x: x - 2, y: y - 2, w: 20, h: 32 }, marca: { x: x + 8, y } };
  });
}

type Modo = 'escritorio' | 'mini' | 'caixas';
const CHAVE_MODO = 'analise-credito-escritorio';

export function EscritorioBancos({ produto = 'he' }: { produto?: 'he' | 'fh' }) {
  const he = produto === 'he';
  const bonecos = he ? BONECOS_HE : BONECOS_FH;
  const colunas = colunasDe(produto);
  const { data: live } = useCreditLive(produto);
  const { data: caixa } = useQuery<{ cards: CardCaixa[] }>({ queryKey: ['caixa-painel'], queryFn: async () => (await api.get('/api/caixa-cadastro/painel')).data, refetchInterval: 10_000, enabled: he });
  const { data: auto } = useQuery<{ paused?: boolean }>({ queryKey: ['credit-auto'], queryFn: async () => (await api.get('/api/credit-analysis/auto')).data, enabled: he });

  const [modo, setModo] = useState<Modo>('escritorio');
  const [escolhido, setEscolhido] = useState<string | null>(null);
  useEffect(() => { try { const m = localStorage.getItem(CHAVE_MODO); if (m === 'mini' || m === 'caixas' || m === 'escritorio') setModo(m); } catch { /* sem armazenamento: abre no escritório */ } }, []);
  const mudarModo = (m: Modo) => { setModo(m); try { localStorage.setItem(CHAVE_MODO, m); } catch { /* só não lembra */ } };

  const estados = useMemo(() => {
    const out: Record<string, EstadoBanco> = {};
    for (const b of bonecos) {
      const l = live?.find((x) => x.bank === b.key);
      out[b.key] = b.key === 'CAIXA' ? estadoDaCaixa(caixa?.cards) : colunas.find((c) => c.key === b.key)?.manual ? estadoManual(l) : estadoDoBanco(l, he && !!auto?.paused);
    }
    return out;
  }, [bonecos, colunas, he, live, caixa, auto]);
  const L = useMemo(() => layoutPara(bonecos.length), [bonecos.length]);
  const pos = useMemo(() => posicionar(L, bonecos, estados), [L, bonecos, estados]);

  const cvRef = useRef<HTMLCanvasElement>(null);
  const fundoRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef(0);
  const desenhar = useRef<() => void>(() => {});
  desenhar.current = () => {
    const cv = cvRef.current; if (!cv) return;
    const g = cv.getContext('2d'); if (!g) return;
    if (!fundoRef.current || fundoRef.current.width !== L.W) fundoRef.current = fundo(L);
    g.drawImage(fundoRef.current, 0, 0);
    const f = frameRef.current;
    pos.forEach((p, k) => {
      const sentadoAqui = p.st.lugar === 'mesa';
      cadeira(g, p.cx, p.dy, !sentadoAqui);
      if (sentadoAqui) sentado(g, p.b, p.cx, p.dy);
      mesa(g, p.cx, p.dy, p.b, sentadoAqui, f + k);
      if (sentadoAqui) maos(g, p.b, p.cx, p.dy, f + k, !p.st.proximo);
    });
    pos.forEach((p, k) => { if (p.st.lugar !== 'mesa') emPe(g, p.b, p.x, p.y, f + k, p.st.lugar === 'cafe'); });
    const sel = pos.find((p) => p.b.key === escolhido);
    if (sel) seta(g, sel.marca.x, sel.marca.y, f);
  };
  useEffect(() => { desenhar.current(); });
  useEffect(() => {
    if (modo !== 'escritorio') return;
    const calmo = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (calmo) return;
    let t: ReturnType<typeof setInterval> | null = null;
    const ligar = () => { if (t) clearInterval(t); t = document.hidden ? null : setInterval(() => { frameRef.current++; desenhar.current(); }, 320); };
    ligar();
    document.addEventListener('visibilitychange', ligar);
    return () => { if (t) clearInterval(t); document.removeEventListener('visibilitychange', ligar); };
  }, [modo]);

  function clique(ev: React.MouseEvent<HTMLCanvasElement>) {
    const r = ev.currentTarget.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * L.W, y = (ev.clientY - r.top) / r.height * H;
    const p = pos.find((q) => x >= q.area.x && x <= q.area.x + q.area.w && y >= q.area.y && y <= q.area.y + q.area.h);
    if (p) setEscolhido((e) => (e === p.b.key ? null : p.b.key));
  }

  const rodando = pos.filter((p) => p.st.lugar === 'mesa' && !p.st.proximo).length;
  const noCafe = pos.filter((p) => p.st.lugar === 'cafe').length;
  const problema = pos.filter((p) => p.st.lugar === 'xadrez').length;
  const naFila = new Set((live || []).flatMap((l) => [...l.queue, ...(l.scheduledList || [])].map((q) => q.leadId))).size;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const sel = escolhido ? bonecos.find((b) => b.key === escolhido) : null;

  const botao = 'text-xs px-2.5 py-1 rounded-lg border border-[#2C3A5E] text-[#D6DEEE] hover:bg-[#243052]';
  const icone = (t: string) => { const w = t.split(' ')[0]; return /^[A-Za-zÀ-ÿ0-9]/.test(w) ? '•' : w; };
  return (
    <div className="space-y-3">
      <div className="bg-[#1B2440] rounded-xl border border-[#2C3A5E] p-2.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div>
            <p className="text-sm font-semibold text-white">Bancos</p>
            <p className="text-xs text-[#9FB0D0]">{rodando} rodando · {noCafe} no café · {problema} com problema{naFila ? ` · ${naFila} cliente${naFila === 1 ? '' : 's'} na fila` : ''}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {modo !== 'mini' && <button type="button" className={botao} onClick={() => mudarModo('mini')}>Minimizar</button>}
            {modo !== 'escritorio' && <button type="button" className={botao} onClick={() => mudarModo('escritorio')}>Ver o escritório</button>}
            {modo !== 'caixas' && <button type="button" className={botao} onClick={() => mudarModo('caixas')}>Ver em caixinhas</button>}
          </div>
        </div>

        {modo === 'mini' && (
          <div className="flex flex-wrap gap-2 px-1 pb-1">
            {pos.map((p) => (
              <button key={p.b.key} type="button" onClick={() => { setEscolhido(p.b.key); mudarModo('escritorio'); }} className="inline-flex items-center gap-1.5 rounded-full border border-[#2C3A5E] px-2.5 py-0.5 text-xs text-[#D6DEEE] hover:bg-[#243052]">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.b.cor }} />
                <b>{p.b.nome}</b>
                <span className="text-[#9FB0D0]">{p.st.lugar === 'mesa' ? `${p.st.proximo ? 'próximo' : 'rodando'} ${curto(p.st.titulo, 22)}` : p.st.titulo.replace(/^\S+\s/, '')}</span>
              </button>
            ))}
          </div>
        )}

        {modo === 'escritorio' && (
          <>
            <div className="relative w-full overflow-hidden rounded-lg bg-[#141821]">
              <canvas ref={cvRef} width={L.W} height={H} onClick={clique} className="block w-full cursor-pointer [image-rendering:pixelated]" aria-label="Escritório dos bancos: sentado na mesa = rodando; no café = sem cliente na fila; em pé no xadrez = login vencido, sem sinal ou pausado" />
              {pos.map((p, k) => (p.st.lugar === 'mesa' ? (
                <div key={`tag-${p.b.key}`} className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded px-[0.6em] py-[0.15em] font-bold text-white shadow" style={{ left: pct(p.cx, L.W), top: pct(p.dy + 21, H), background: p.b.cor, fontSize: 'clamp(7px, 0.85vw, 11px)' }}>{p.b.nome}</div>
              ) : (
                <div key={`tag-${p.b.key}`} className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded px-[0.5em] py-[0.1em] font-bold text-white shadow" style={{ left: pct(p.x + 8, L.W), top: pct(p.y + 30 + (pos.filter((q, j) => j < k && q.st.lugar === p.st.lugar).length % 2) * 7, H), background: p.b.cor, fontSize: 'clamp(6px, 0.75vw, 10px)' }}>{p.b.nome}</div>
              )))}
              {pos.map((p) => (p.st.lugar === 'mesa' ? (
                <div key={`bal-${p.b.key}`} className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-white px-[0.7em] py-[0.3em] leading-tight text-slate-800 shadow-md" style={{ left: pct(p.cx, L.W), top: pct(p.dy - 21, H), fontSize: 'clamp(7px, 0.85vw, 11px)' }}>
                  {p.st.proximo ? 'Próximo: ' : 'Rodando: '}<b>{curto(p.st.titulo, 24)}</b>
                  <span className="block text-[0.85em] text-slate-500">{curto(p.st.detalhe)}</span>
                </div>
              ) : (
                <div key={`ico-${p.b.key}`} title={`${p.b.nome}: ${p.st.titulo.replace(/^\S+\s/, '')}`} className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-full bg-white px-[0.35em] leading-none shadow" style={{ left: pct(p.marca.x, L.W), top: pct(p.marca.y - 1, H), fontSize: 'clamp(8px, 0.95vw, 13px)' }}>{icone(p.st.titulo)}</div>
              )))}
            </div>
            {!sel && <p className="px-1 text-xs text-[#9FB0D0]">Clique num banco para ver a fila e os botões dele. ☕ sem cliente na fila · 🌙 fora do horário · 🔑 login vencido · 📡 extensão sem sinal · ⏸ automático pausado{he ? '' : ' · ✋ roda à mão'}</p>}
            {sel && (
              <div className="max-w-xl">
                {sel.key === 'CAIXA' ? <CaixaPanel /> : <BancoLiveCard b={colunas.find((c) => c.key === sel.key)!} l={live?.find((l) => l.bank === sel.key)} />}
              </div>
            )}
          </>
        )}
      </div>

      {modo === 'caixas' && <ExtensionsLivePanel produto={produto} />}
    </div>
  );
}
