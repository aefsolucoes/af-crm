/**
 * E-mail de COMISSÃO nunca vai pro card de cliente (Fabio 18/11: "e-mails de comissão não devem ir para card de clientes").
 * Caso real (16/11): "Dados para emissão da NF de comissão – processos de outubro/2026" (fabio@ → Inter, cc andreia@) caiu no card da Andreia (cc dela
 * = contato do card) e a resposta da Vilmara (Inter) caiu no card do Adilson — o leitor do Inter achou "proposta 005661735" no texto — com nota e push.
 * O e-mail continua na caixa (página E-mail); só não liga a card, não entra na conversa, na leitura da IA nem no balão. A provisão/nota de comissão
 * do Financeiro não lê e-mail (a nota é anexada à mão), então nada muda lá.
 *
 * Pelo ASSUNTO (o "Re:/ENC:" do fio carrega) e, no texto NOVO do e-mail (sem a citação), só frases de nota/pagamento de comissão.
 * "Comissão do corretor"/corretagem (compra e venda do FH) é assunto do cliente e não conta. Pura (testável).
 */
const CORRETOR = /corretor|corretagem|imobili[aá]ria/i;

const ASSUNTO = [
  /comiss(?:[aã]o|[oõ]es|ionamento)/i,
  /\b(?:dados\s+(?:para|da|de)\s+)?emiss[aã]o\s+d[ae]\s+(?:NFS?-?e?|nota)\b/i,
  /\b(?:NFS?-?e?|nota\s+fiscal)\b[^\n]{0,40}\b(?:processos|produ[cç][aã]o|repasse|pagamento\s+(?:ao|do)\s+(?:correspondente|parceiro))/i,
  // Só repasse/produção: "demonstrativo/extrato de pagamento" é contracheque e extrato do INSS do cliente (documento de renda).
  /\b(?:demonstrativo|extrato|relat[oó]rio)\s+de\s+(?:repasse|produ[cç][aã]o)\b/i,
  /\bremunera[cç][aã]o\s+(?:d[oa]s?\s+)?(?:correspondente|parceiro|corban)/i,
];

const TEXTO = [
  /\b(?:NFS?-?e?|nota\s+fiscal)\b[^.\n]{0,60}\bcomiss/i,
  /\bcomiss(?:[aã]o|[oõ]es)\b[^.\n]{0,60}\b(?:a\s+receber|a\s+pagar|dos\s+processos|do\s+correspondente|do\s+parceiro|referente\s+ao?s?\s+m[eê]s|de\s+(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))/i,
  /\bdados\s+(?:para|da|de)\s+emiss[aã]o\s+d[ae]\s+(?:NFS?-?e?|nota)\b/i,
  /\bemiss[aã]o\s+correta\s+da\s+(?:NFS?-?e?|nota)\b/i,
];

export function isCommissionEmail(e: { subject?: string | null; text?: string | null }): boolean {
  const assunto = String(e.subject || '');
  if (ASSUNTO.some((re) => re.test(assunto)) && !CORRETOR.test(assunto)) return true;
  const texto = String(e.text || '').slice(0, 20_000);
  return TEXTO.some((re) => {
    const m = re.exec(texto);
    return !!m && !CORRETOR.test(texto.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80));
  });
}

/** Mensagem da conversa (channel EMAIL) que veio de e-mail de comissão: "📧 assunto\ncorpo". Pra quem lê a conversa (IA). Pura (testável). */
export function isCommissionConversationEmail(content: string | null | undefined): boolean {
  const c = String(content || '');
  if (!/^📧/.test(c)) return false;
  const [primeira, ...resto] = c.split('\n');
  return isCommissionEmail({ subject: primeira.replace(/^📧\s*/, ''), text: resto.join('\n') });
}
