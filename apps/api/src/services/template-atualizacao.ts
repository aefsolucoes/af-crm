import { prisma } from '../lib/prisma';

// Template "Temos uma atualização sobre o seu processo…" (conversa de 24 h fechada) da ÁREA do card — os dois aprovados na Meta (Fabio 12/11, cliente
// de construção recebeu o do Home Equity: "o certo seria financiamento imobiliário, usar o mesmo template do FH").
export function templateAtualizacao(area: string | null | undefined, saudacao: string): { templateName: string; language: string; bodyParams: string[]; previewText: string } {
  const fh = /habita/i.test(area || '');
  const assunto = fh ? 'financiamento habitacional' : 'crédito com garantia de imóvel';
  return {
    templateName: fh ? 'atualizacao_processo_habitacional' : 'atualizacao_processo_credito',
    language: 'pt_BR',
    bodyParams: [saudacao],
    previewText: `Oi ${saudacao}, tudo bem? Temos uma atualização sobre o seu processo de ${assunto}. Responda esta mensagem para que a gente possa te passar os detalhes.`,
  };
}

/** Mesmo que templateAtualizacao, lendo a área (departamento do funil) do card. */
export async function templateAtualizacaoDoLead(leadId: string, saudacao: string) {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { pipeline: { select: { department: { select: { name: true } } } } } });
  return templateAtualizacao(l?.pipeline?.department?.name, saudacao);
}
