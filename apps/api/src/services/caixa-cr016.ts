import { prisma } from '../lib/prisma';

/* Normativo da CAIXA CR016 (constatação de renda). Fabio 31/10: "para conhecimento do CRM sobre análise de rendas" e "coloca para o CRM quando for usar a
 * extensão da CAIXA". O normativo é confidencial da CAIXA, então o texto NÃO fica no código: o PDF e um resumo das regras de renda estão na Base de
 * Conhecimento do Drive, e o resumo (arquivo com "CR016" e "resumo" no nome) é lido aqui na hora e entra na ficha de cadastro e na conferência da tela da
 * CAIXA. Sem o arquivo (ou com o Drive fora), os prompts seguem só com as regras da A&F. */

const CACHE_MS = 30 * 60_000;
const CACHE_VAZIO_MS = 5 * 60_000; // ainda não sincronizado: tenta de novo logo
const cache = new Map<string, { at: number; texto: string }>();

export async function regrasRendaCaixa(accountId: string): Promise<string> {
  const c = cache.get(accountId);
  if (c && Date.now() - c.at < (c.texto ? CACHE_MS : CACHE_VAZIO_MS)) return c.texto;
  let texto = '';
  try {
    const f = await prisma.knowledgeFile.findFirst({
      where: { accountId, AND: [{ name: { contains: 'CR016', mode: 'insensitive' } }, { name: { contains: 'resumo', mode: 'insensitive' } }] },
      orderBy: { updatedAt: 'desc' },
      select: { driveFileId: true, mimeType: true, name: true },
    });
    if (f) {
      const { downloadDriveFile } = await import('./google.service');
      const { extractDocumentText } = await import('./knowledge.service');
      texto = (await extractDocumentText(await downloadDriveFile(accountId, f.driveFileId, f.mimeType), f.mimeType, f.name)).trim().slice(0, 12000);
    }
  } catch (e: any) {
    console.error('[CR016] resumo da Base de Conhecimento:', e?.message);
  }
  cache.set(accountId, { at: Date.now(), texto });
  return texto;
}

/** Põe o resumo antes do "Responda SOMENTE com JSON" do prompt, com a instrução de uso. Sem resumo, o prompt fica igual. Pura. */
export function comRegrasCaixa(system: string, regras: string, uso: string): string {
  if (!regras) return system;
  const bloco = `NORMATIVO DA CAIXA — CR016 (resumo das regras de renda, da Base de Conhecimento). Quando uma regra da A&F deste prompt disser outra coisa, vale a da A&F.\n${regras}\n${uso}\n`;
  return system.includes('Responda SOMENTE com JSON') ? system.replace('Responda SOMENTE com JSON', () => `${bloco}Responda SOMENTE com JSON`) : `${system}\n${bloco}`;
}

const chaveFonte = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/).slice(0, 2).join(' ');
const mesNum = (cmp: unknown): number | null => { const m = /(\d{1,2})\/(\d{4})/.exec(String(cmp || '')); return m ? Number(m[2]) * 12 + Number(m[1]) - 1 : null; };

/** Fonte de renda da ficha sem comprovante dentro do prazo da CAIXA — competência de até 2 meses antes do mês corrente (a CAIXA recusa com "A data de
 *  referência do comprovante de renda deve ser limitada aos 2 últimos meses"). Mesma janela da extensão (fontesDeRenda). Lucros pelo IR (dezembro do
 *  ano-calendário) e contracheque sem competência lida ficam de fora. Pura. */
export function rendaForaDoPrazo(p: any, agora = new Date()): string[] {
  if (!p || p.semRenda || p.rendaInformal) return [];
  const [, m, a] = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/').map(Number);
  const hoje = a * 12 + m - 1;
  const porFonte = new Map<string, { nome: string; meses: number[] }>();
  for (const c of Array.isArray(p.contracheques) ? p.contracheques : []) {
    if (!c || /lucro/i.test(String(c.tipo || '')) || !(Number(c.bruto) > 0 || Number(c.liquido) > 0)) continue;
    const n = mesNum(c.competencia);
    if (n === null) continue;
    const nome = String(c.empregador || p.trabalho?.empregador || 'fonte de renda');
    const f = porFonte.get(chaveFonte(nome)) || { nome, meses: [] };
    f.meses.push(n);
    porFonte.set(chaveFonte(nome), f);
  }
  return [...porFonte.values()]
    .filter((f) => !f.meses.some((n) => hoje - n >= 0 && hoje - n <= 2))
    .map((f) => { const u = Math.max(...f.meses); return `comprovante de renda de até 2 meses de ${f.nome} (o mais recente é ${String((u % 12) + 1).padStart(2, '0')}/${Math.floor(u / 12)} — a CAIXA não aceita, CR016)`; });
}
