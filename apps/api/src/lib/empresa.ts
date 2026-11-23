import { prisma } from './prisma';

/* DADOS DA EMPRESA POR CONTA (plano do piloto, Fabio 23/11: "abrir o CRM para outras pessoas"). O que antes estava fixo no código com os dados da A&F
 * (nome, assinatura dos e-mails, telefone, site, endereço, WhatsApp, link de avaliação, convênio da CAIXA…) vem de Account.empresa (JSON).
 * SEM NADA GRAVADO, FICA SEM (Fabio 23/11) — nunca cai nos dados da A&F: os da A&F estão gravados na conta dela (migração 20261123200000_account_empresa_af).
 * Edição: GET/PUT /api/settings/empresa. */

export type DadosEmpresa = {
  /** Nome comercial completo — remetente dos e-mails e telas ("A&F Soluções Financeiras"). */
  nome: string;
  /** Nome curto da barra lateral ("A&F Soluções"). */
  nomeCurto: string;
  /** Selo curto (cabeçalho dos e-mails) — "A&F". */
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

export const EMPRESA_VAZIA: DadosEmpresa = {
  nome: '', nomeCurto: '', marca: '', marcaSubtitulo: '', nomeAssinatura: '', telefone: '', site: '', endereco: '',
  whatsappLink: '', emailComercial: '', telefoneContato: '', avaliacaoGoogle: '', caixaConvenio: '', caixaAgencia: '',
};

export const CAMPOS_EMPRESA = Object.keys(EMPRESA_VAZIA) as (keyof DadosEmpresa)[];

/** Só o que a conta gravou (texto não vazio); o resto fica vazio. Pura. */
export function juntarEmpresa(gravado: unknown): DadosEmpresa {
  const g = (gravado && typeof gravado === 'object' ? gravado : {}) as Record<string, unknown>;
  const out = { ...EMPRESA_VAZIA };
  for (const k of CAMPOS_EMPRESA) {
    const v = g[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { em: number; dados: DadosEmpresa }>();

/** Dados da empresa da conta (cache de 5 min). Sem conta, ou se o banco falhar, vem vazio. */
export async function dadosDaConta(accountId?: string | null): Promise<DadosEmpresa> {
  if (!accountId) return EMPRESA_VAZIA;
  const c = cache.get(accountId);
  if (c && Date.now() - c.em < CACHE_MS) return c.dados;
  const conta = await prisma.account.findUnique({ where: { id: accountId }, select: { empresa: true } }).catch(() => null);
  const dados = juntarEmpresa(conta?.empresa);
  if (conta) cache.set(accountId, { em: Date.now(), dados });
  return dados;
}

/** Grava (só os campos conhecidos; texto vazio = apaga o campo) e limpa o cache. */
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
  contaPrincipalCache = null;
  return juntarEmpresa(prox);
}

/* Conta "dona" desta cópia do CRM — o nome que aparece no login, antes de alguém entrar (cada correspondente tem a sua cópia):
 * EMPRESA_CONTA_ID no ambiente ou, sem ela, a conta mais antiga que tem dados da empresa gravados. */
let contaPrincipalCache: { em: number; id: string | null } | null = null;
export async function dadosDaContaPrincipal(): Promise<DadosEmpresa> {
  if (!contaPrincipalCache || Date.now() - contaPrincipalCache.em > CACHE_MS) {
    let id: string | null = process.env.EMPRESA_CONTA_ID || null;
    if (!id) {
      const r = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Account" WHERE "empresa" IS NOT NULL ORDER BY "createdAt" ASC LIMIT 1`.catch(() => []);
      id = r[0]?.id || null;
    }
    contaPrincipalCache = { em: Date.now(), id };
  }
  return dadosDaConta(contaPrincipalCache.id);
}
