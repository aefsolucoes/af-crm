/**
 * Prévia da assinatura de e-mail com site, e-mail e telefone como link —
 * mesma regra do servidor (linkifySignatureLine em
 * apps/api/src/services/email-inbox.service.ts). Devolve HTML já escapado.
 */
const SIGNATURE_LINK_RE = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(https?:\/\/[^\s<]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|br|io|app|site|online)(?:\.br)?(?:\/[^\s<]*)?)|(\(?\d{2}\)?\s?\d[\d.\s-]{7,}\d)/gi;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function signatureLineHtml(line: string): string {
  const whatsapp = /whats\s*app|wpp|zap/i.test(line); // número abre no WhatsApp (wa.me), não liga
  return escapeHtml(line).replace(SIGNATURE_LINK_RE, (m, email, url, phone) => {
    const a = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline">${text}</a>`;
    if (email) return a(`mailto:${email}`, email);
    if (url) return a(/^https?:/i.test(url) ? url : `https://${url}`, url);
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      const full = digits.length <= 11 ? `55${digits}` : digits;
      return a(whatsapp ? `https://wa.me/${full}` : `tel:+${full}`, phone);
    }
    return m;
  });
}
