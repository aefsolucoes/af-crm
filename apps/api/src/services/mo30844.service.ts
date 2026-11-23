import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { Readable } from 'stream';
import { prisma } from '../lib/prisma';

/* ── MO30844 — "Autorização da Forma de Pagamento" (Formulário Cliente Crédito Imobiliário, 30.844 v011) — Fabio 23/11: "precisa colocar na extensão
 * para preencher ele também e colocar uma cópia na pasta formulários, pois o cliente também precisa assinar". O SIOPI avisa "CLIENTE DEVE ASSINAR O MO30844
 * PARA AUTORIZAR A FORMA DE PAGAMENTO". O CRM preenche o modelo Word da equipe (pasta CAIXA do Drive — assets/caixa/MO30844011.docx: 34 campos de
 * formulário do Word, na ordem abaixo), converte em PDF pelo Drive e guarda na pasta FORMULARIOS do card (o anterior vai pra FORMULARIOS ANTIGOS).
 * Marcações = as do modelo da equipe: débito em conta (X), boleto por WhatsApp (X) com o celular do titular, "Desconheço possuir as doenças" (X) pra cada
 * proponente do seguro; cancelamento do débito, tarifa de avaliação e "Declaro possuir" ficam em branco. Sai sozinho quando a conta é encaminhada. */

type Cf = Record<string, any>;
const MODELO = path.resolve(__dirname, '../../assets/caixa/MO30844011.docx');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const VAZIO = ' ';
const so = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const fmtCpf = (v: unknown) => { const d = so(v); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(v ?? ''); };
const fmtFone = (v: unknown) => { let d = so(v); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}` : d; };
const sp = (n: number) => String(n).padStart(2, '0');
const hojeBR = () => { const d = new Date(Date.now() - 3 * 3600_000); return `${sp(d.getUTCDate())}/${sp(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type DadosMo30844 = {
  cliente: string; cpf: string; agencia: string; conta: string; telefone: string;
  debito: boolean; cancelarDebito: boolean; whatsapp: boolean; tarifa: boolean;
  seguro: { nome: string; cpf: string }[]; // proponentes do seguro (quem compõe a renda) — até 4
  participantes: { nome: string; cpf: string }[]; // quem assina — até 4
  local: string; data: string;
};

/** Agência e conta do nº do Caixa Aqui ("3444.3701.000561930711-1" → 3444 / 000561930711-1 — como no MO30844 da Beatriz, v011). Pura. */
export function agenciaEConta(numero: string): { agencia: string; conta: string } {
  const m = /^\s*(\d{4})\.(\d{3,4})\.([\d.]+-\d)\s*$/.exec(String(numero || ''));
  if (m) return { agencia: m[1], conta: m[3] };
  const d = String(numero || '').trim();
  return { agencia: so(d).slice(0, 4), conta: d };
}

/** Os 34 campos do modelo, na ordem do documento (mapa de 23/11). Pura. */
export function valoresDosCampos(d: DadosMo30844): string[] {
  const x = (b: boolean) => (b ? 'X' : VAZIO);
  const seg = [0, 1, 2, 3].map((i) => d.seguro[i]);
  const par = [0, 1, 2, 3].map((i) => d.participantes[i]);
  return [
    d.cliente, d.cpf, d.agencia, d.conta, // 0–3
    x(d.debito), x(d.cancelarDebito), x(d.whatsapp), d.whatsapp ? d.telefone || VAZIO : VAZIO, x(d.tarifa), // 4–8
    ...seg.flatMap((p) => (p ? [p.nome, p.cpf] : [VAZIO, VAZIO])), // 9–16 nome/CPF dos proponentes do seguro
    ...seg.map((p) => x(!!p)), // 17–20 "Desconheço possuir as doenças/síndromes acima"
    VAZIO, VAZIO, VAZIO, VAZIO, // 21–24 "Declaro possuir…" — nunca marcado pelo CRM
    `${d.local} ${d.data}`, // 25 local e data
    ...par.flatMap((p) => (p ? [p.nome, p.cpf] : [VAZIO, VAZIO])), // 26–33 assinaturas (nome / CPF)
  ];
}

/** Preenche os campos FORMTEXT do Word na ordem (troca só o texto do resultado; a formatação fica). Pura. */
export async function preencherDocx(modelo: Buffer, valores: string[]): Promise<{ docx: Buffer; campos: number }> {
  const zip = await JSZip.loadAsync(modelo);
  const s = await zip.file('word/document.xml')!.async('string');
  const runs = [...s.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)];
  const trocas: { ini: number; fim: number; novo: string }[] = [];
  let campo = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i][0];
    if (!/w:fldCharType="begin"/.test(r)) continue;
    let j = i, sep = -1;
    while (j < runs.length && !/w:fldCharType="end"/.test(runs[j][0])) { if (/w:fldCharType="separate"/.test(runs[j][0])) sep = j; j++; }
    const instr = runs.slice(i, sep < 0 ? j : sep).map((m) => m[0]).join('');
    if (/FORMTEXT/.test(instr) && sep >= 0) {
      const v = xml(campo < valores.length ? valores[campo] : VAZIO);
      let primeiro = true;
      for (let k = sep + 1; k < j; k++) {
        const rk = runs[k][0];
        if (!/<w:t[ >]/.test(rk)) continue;
        const novo = rk.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/, primeiro ? `<w:t xml:space="preserve">${v}</w:t>` : '<w:t></w:t>');
        trocas.push({ ini: runs[k].index!, fim: runs[k].index! + rk.length, novo });
        primeiro = false;
      }
      campo++;
    }
    i = j;
  }
  let out = '';
  let pos = 0;
  for (const t of trocas) { out += s.slice(pos, t.ini) + t.novo; pos = t.fim; }
  out += s.slice(pos);
  zip.file('word/document.xml', caberNaPagina(out));
  return { docx: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), campos: campo };
}

/** Tabela mais larga que a área do texto (a da declaração de saúde tem 11332 de 9887 — no PDF do Drive a coluna do 4º proponente saía cortada, 23/11):
 *  encolhe as colunas na proporção. Pura. */
export function caberNaPagina(doc: string): string {
  const sz = [...doc.matchAll(/<w:pgSz [^>]*w:w="(\d+)"/g)].pop();
  const mg = [...doc.matchAll(/<w:pgMar [^>]*\/>/g)].pop();
  if (!sz || !mg) return doc;
  const num = (re: RegExp) => Number((re.exec(mg[0]) || [])[1] || 0);
  const largura = Number(sz[1]) - num(/w:left="(\d+)"/) - num(/w:right="(\d+)"/);
  if (largura <= 0) return doc;
  return doc.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (t) => {
    const w = Number((/<w:tblW w:w="(\d+)" w:type="dxa"\/>/.exec(t) || [])[1] || 0);
    if (!w || w <= largura) return t;
    const f = largura / w;
    const esc = (_m: string, a: string, n: string, b: string) => `${a}${Math.floor(Number(n) * f)}${b}`;
    return t.replace(/(<w:tblW w:w=")(\d+)(" w:type="dxa"\/>)/, esc).replace(/(<w:gridCol w:w=")(\d+)(")/g, esc).replace(/(<w:tcW w:w=")(\d+)(" w:type="dxa")/g, esc);
  });
}

/** Word → PDF pelo próprio Drive (vira Google Doc temporário, exporta PDF e apaga). */
async function docxParaPdf(accountId: string, docx: Buffer, nome: string): Promise<Buffer> {
  const { getDrive } = await import('./google.service');
  const drive = await getDrive(accountId);
  let tmp: string | undefined;
  try {
    const c = await drive.files.create({ requestBody: { name: `__mo30844_tmp_${Date.now()}_${nome}`, mimeType: 'application/vnd.google-apps.document' }, media: { mimeType: DOCX, body: Readable.from(docx) }, fields: 'id', supportsAllDrives: true });
    tmp = c.data.id || undefined;
    if (!tmp) throw new Error('o Drive não converteu o Word');
    const pdf = await drive.files.export({ fileId: tmp, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
    return Buffer.from(pdf.data as ArrayBuffer);
  } finally {
    if (tmp) await drive.files.delete({ fileId: tmp, supportsAllDrives: true }).catch(() => {});
  }
}

/** Monta os dados do card. Erro em texto. */
export async function dadosDoCard(leadId: string, accountId: string, contaInformada?: string): Promise<DadosMo30844 | string> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, contact: { select: { phone: true } } } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const prod = (require('./caixa-produtos.service') as typeof import('./caixa-produtos.service'));
  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const st = cf._caixaProdutos || {};
  const t = prod.titularDosProdutos(cf, st.ordem);
  if ('erro' in t) return t.erro;
  const numero = String(contaInformada || st.numeroConta || '').trim();
  if (!numero) return 'a conta CAIXA do proponente ainda não tem nº (abra/encaminhe a conta primeiro)';
  const { agencia, conta } = agenciaEConta(numero);
  const ps = cc.participantesDa(cf) as any[];
  const q = cc.participantesDaAvaliacao(ps);
  const titular = ps.find((p) => p.ordem === t.ordem) || {};
  const tel = String(titular.telefone || cf[`telefone_${t.ordem}`] || '').trim() || String(l.contact?.phone || '');
  const pessoa = (p: any) => ({ nome: String(p.nome || '').toUpperCase(), cpf: fmtCpf(p.cpf) });
  const seguro = [q.tomador, ...q.incluir].filter((p) => p && so(p.cpf).length === 11).slice(0, 4).map(pessoa);
  const participantes = ps.filter((p) => so(p.cpf).length === 11).slice(0, 4).map(pessoa);
  // Local = cidade/UF (Fabio 23/11), o mesmo dos outros formulários da CAIXA.
  const { localDaAssinatura, textoDoLocal } = require('./endereco-imovel.service') as typeof import('./endereco-imovel.service');
  const localCard = textoDoLocal(await localDaAssinatura(leadId, cf, [])).toUpperCase();
  const cidade = semAcento(String(cf.cidade_imovel || cf.cidade || 'BRASILIA')).toUpperCase().trim();
  const uf = String(cf.uf_imovel || cf.uf || 'DF').toUpperCase().trim().slice(0, 2);
  return { cliente: String(t.nome).toUpperCase(), cpf: fmtCpf(t.cpf), agencia, conta, telefone: fmtFone(tel), debito: true, cancelarDebito: false, whatsapp: true, tarifa: false, seguro, participantes, local: localCard || `${cidade}/${uf}`, data: hojeBR() };
}

/** Gera o MO30844 do card e guarda na pasta FORMULARIOS (o anterior vai pra FORMULARIOS ANTIGOS). Erro em texto. */
export async function gerarMo30844(accountId: string, leadId: string, opts: { conta?: string; por?: string } = {}): Promise<string | null> {
  const d = await dadosDoCard(leadId, accountId, opts.conta);
  if (typeof d === 'string') return d;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const link = String(((l?.customFields || {}) as Cf).link_pasta_drive || '').trim();
  if (!link) return 'O card não tem a pasta do Drive';
  const { docx, campos } = await preencherDocx(fs.readFileSync(MODELO), valoresDosCampos(d));
  if (campos !== 34) return `o modelo do MO30844 mudou (${campos} campos, esperava 34) — não preenchi`;
  const nome = `MO30844 AUTORIZACAO FORMA DE PAGAMENTO CAIXA - ${d.cliente}.pdf`;
  const pdf = await docxParaPdf(accountId, docx, nome);
  if (pdf.length < 1000 || pdf.subarray(0, 4).toString('latin1') !== '%PDF') return 'o Drive não devolveu o PDF do MO30844';
  const google = await import('./google.service');
  const pasta = await google.createFolder(accountId, 'FORMULARIOS', google.extractFolderId(link));
  await google.arquivarFormulariosAntigos(accountId, pasta.id, nome).catch(() => 0);
  const up = await google.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', parentId: pasta.id, data: pdf });
  const sql = JSON.stringify({ id: up.id, nome, em: new Date().toISOString(), conta: `${d.agencia} / ${d.conta}` });
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaMo30844}', ${sql}::jsonb, true) WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📄 MO30844 (Autorização da Forma de Pagamento) preenchido${opts.por ? ` a pedido de ${opts.por}` : ''} e salvo na pasta FORMULARIOS (${nome}) — o cliente precisa assinar.\nTitular: ${d.cliente} · agência ${d.agencia} · conta ${d.conta}\nDébito em conta (X) · boleto por WhatsApp (X) ${d.telefone || '(sem celular)'} · tarifa de avaliação: em branco\nSeguro: ${d.seguro.map((p) => p.nome).join(', ') || '—'} ("Desconheço possuir as doenças" marcado) · assinam: ${d.participantes.map((p) => p.nome).join(', ')} · ${d.local} ${d.data}` } }).catch(() => {});
  return null;
}
