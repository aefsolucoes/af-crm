import { prisma } from './prisma';

/* DADOS DA EMPRESA POR CONTA (plano do piloto, Fabio 23/11: "abrir o CRM para outras pessoas"). O que antes estava fixo no código com os dados da A&F
 * (nome, assinatura dos e-mails, telefone, site, endereço, WhatsApp, link de avaliação, convênio da CAIXA…) passa a vir de Account.empresa (JSON).
 * Campo vazio ou conta sem nada gravado = o valor da A&F (EMPRESA_AF) — assim, pra A&F, nada muda. Uma conta nova (cópia de outro correspondente)
 * grava os dela em Configurações → Empresa (GET/PUT /api/settings/empresa). */

export type DadosEmpresa = {
  /** Nome comercial completo — remetente dos e-mails e telas ("A&F Soluções Financeiras"). */
  nome: string;
  /** Selo curto (cabeçalho dos e-mails, telas) — "A&F". */
  marca: string;
  /** Texto ao lado do selo — "Soluções Financeiras". */
  marcaSubtitulo: string;
  /** Nome na assinatura dos e-mails — "A & F Soluções Financeiras" (em maiúsculas na assinatura institucional). */
  nomeAssinatura: string;
  /** Telefone da assinatura, como aparece — "(61) 9.9957-9754". */
  telefone: string;
  /** Site, sem https — "aefsolucoesfinanceiras.com.br". */
  site: string;
  endereco: string;
  /** Link do WhatsApp da API oficial (botão dos e-mails de lembrete). */
  whatsappLink: string;
  /** E-mail comercial (declarante do ITBI etc.). */
  emailComercial: string;
  /** Telefone de contato que os portais pedem (declarante do ITBI). */
  telefoneContato: string;
  /** Link de avaliação no Google (pesquisa de satisfação do processo concluído). */
  avaliacaoGoogle: string;
  /** Código do convênio de correspondente na CAIXA (Caixa Aqui) — "00077001-9". */
  caixaConvenio: string;
  /** Agência de relacionamento da CAIXA usada no cadastro — "3444". */
  caixaAgencia: string;
};

export const EMPRESA_AF: DadosEmpresa = {
  nome: 'A&F Soluções Financeiras',
  marca: 'A&F',
  marcaSubtitulo: 'Soluções Financeiras',
  nomeAssinatura: 'A & F Soluções Financeiras',
  telefone: '(61) 9.9957-9754',
  site: 'aefsolucoesfinanceiras.com.br',
  endereco: 'SCS Q. 1 Bloco M Sala 714 Ed. Gilberto Salomão — Asa Sul, Brasília',
  whatsappLink: 'https://wa.me/556181721313',
  emailComercial: 'comercial@aefsolucoesfinanceiras.com.br',
  telefoneContato: '61981721313',
  avaliacaoGoogle: 'https://g.page/r/CY5BwOMS2SDhEAI/review',
  caixaConvenio: '00077001-9',
  caixaAgencia: '3444',
};

export const CAMPOS_EMPRESA = Object.keys(EMPRESA_AF) as (keyof DadosEmpresa)[];

/** Junta o que a conta gravou com o padrão (só texto não vazio vale). Pura. */
export function juntarEmpresa(gravado: unknown): DadosEmpresa {
  const g = (gravado && typeof gravado === 'object' ? gravado : {}) as Record<string, unknown>;
  const out = { ...EMPRESA_AF };
  for (const k of CAMPOS_EMPRESA) {
    const v = g[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { em: number; dados: DadosEmpresa }>();

/** Dados da empresa da conta (cache de 5 min). Sem conta, ou se o banco falhar, devolve o padrão. */
export async function dadosDaConta(accountId?: string | null): Promise<DadosEmpresa> {
  if (!accountId) return EMPRESA_AF;
  const c = cache.get(accountId);
  if (c && Date.now() - c.em < CACHE_MS) return c.dados;
  const conta = await prisma.account.findUnique({ where: { id: accountId }, select: { empresa: true } }).catch(() => null);
  const dados = juntarEmpresa(conta?.empresa);
  cache.set(accountId, { em: Date.now(), dados });
  return dados;
}

/** Grava (só os campos conhecidos; texto vazio = volta ao padrão) e limpa o cache. */
export async function gravarDadosDaConta(accountId: string, novos: Record<string, unknown>): Promise<DadosEmpresa> {
  const conta = await prisma.account.findUnique({ where: { id: accountId }, select: { empresa: true } });
  const atual = (conta?.empresa && typeof conta.empresa === 'object' ? conta.empresa : {}) as Record<string, string>;
  const prox: Record<string, string> = { ...atual };
  for (const k of CAMPOS_EMPRESA) {
    if (!(k in novos)) continue;
    const v = novos[k];
    if (typeof v === 'string' && v.trim()) prox[k] = v.trim().slice(0, 300);
    else delete prox[k];
  }
  await prisma.account.update({ where: { id: accountId }, data: { empresa: prox } });
  cache.delete(accountId);
  return juntarEmpresa(prox);
}
