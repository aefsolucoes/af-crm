import nodemailer, { Transporter } from 'nodemailer';

// Envio de e-mail via SMTP genérico. Configure no ambiente (Railway):
//   SMTP_HOST   ex.: smtp.gmail.com
//   SMTP_PORT   ex.: 465 (SSL) ou 587 (STARTTLS)
//   SMTP_USER   ex.: seuemail@gmail.com
//   SMTP_PASS   senha de app do provedor (no Gmail: "Senha de app")
//   SMTP_FROM   (opcional) remetente exibido; padrão = SMTP_USER
//
// Enquanto essas variáveis não estiverem definidas, o envio fica desligado —
// e o login por código também (o sistema volta a entrar só com senha). Isso
// evita trancar alguém para fora antes do e-mail estar configurado.

let cached: Transporter | null = null;
let cachedKey = '';

function getTransporter(): Transporter | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  const key = `${SMTP_HOST}:${SMTP_PORT}:${SMTP_USER}`;
  if (cached && cachedKey === key) return cached;

  const port = parseInt(SMTP_PORT || '465', 10);
  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = SSL; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Sem isso o nodemailer usa o timeout padrão (bem longo) e uma falha de
    // rede/porta bloqueada fica "pendurada" minutos antes de dar erro —
    // 15s é mais que suficiente pra um handshake SMTP de verdade.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });
  cachedKey = key;
  return cached;
}

export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Assinatura institucional (sem nome de pessoa — vai em e-mail automático,
// não em nome de um consultor específico). Pedido do usuário: telefone,
// site e endereço, no mesmo estilo do cartão de assinatura pessoal que ele
// já usa, só sem o nome.
const COMPANY_PHONE = '(61) 9.9957-9754';
const COMPANY_SITE = 'aefsolucoesfinanceiras.com.br';
const COMPANY_ADDRESS = 'SCS Q. 1 Bloco M Sala 714 Ed. Gilberto Salomão — Asa Sul, Brasília';
const COMPANY_SIGNATURE_HTML = `
  <p style="font-size:14px;color:#334155;margin:28px 0 12px">Atenciosamente,</p>
  <div style="border-left:3px solid #3b82f6;padding-left:14px">
    <p style="font-size:13px;font-weight:700;letter-spacing:0.5px;color:#0d2545;margin:0 0 6px">A &amp; F SOLUÇÕES FINANCEIRAS</p>
    <p style="font-size:12px;color:#475569;margin:0 0 3px">Telefone: <a href="tel:+5561999579754" style="color:#3b82f6;text-decoration:none">${COMPANY_PHONE}</a></p>
    <p style="font-size:12px;color:#475569;margin:0 0 3px">Site: <a href="https://${COMPANY_SITE}" style="color:#3b82f6;text-decoration:none">${COMPANY_SITE}</a></p>
    <p style="font-size:12px;color:#475569;margin:0">Endereço: ${COMPANY_ADDRESS}</p>
  </div>`;

/** Assinatura da empresa (HTML) — reaproveitada pela caixa de e-mail do CRM
 *  quando o envio sai da caixa comercial@. */
export function companySignatureHtml(): string {
  return COMPANY_SIGNATURE_HTML;
}

/** Mesma assinatura em texto — ponto de partida quando alguém vai editar a
 *  assinatura da caixa comercial@ na página E-mail. */
export function companySignatureText(): string {
  return `A & F SOLUÇÕES FINANCEIRAS\nTelefone: ${COMPANY_PHONE}\nSite: ${COMPANY_SITE}\nEndereço: ${COMPANY_ADDRESS}`;
}

/** E-mail com corpo livre (automações de follow-up) — cada linha em branco
 *  vira um parágrafo, igual quem escreveu enxerga no campo de texto. */
export async function sendGenericEmail(to: string, subject: string, bodyText: string): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) throw new Error('E-mail não configurado');

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const paragraphs = bodyText
    .split('\n')
    .map((line) => line.trim() ? `<p style="margin:0 0 14px">${escapeHtml(line)}</p>` : '')
    .join('');

  await transporter.sendMail({
    from: `A&F Soluções Financeiras <${from}>`,
    to,
    subject,
    text: `${bodyText}\n\n--\nA & F Soluções Financeiras\nTelefone: ${COMPANY_PHONE}\nSite: ${COMPANY_SITE}\nEndereço: ${COMPANY_ADDRESS}`,
    html: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1e293b">
  <div style="margin-bottom:24px">
    <div style="display:inline-block;background:#0d2545;color:#fff;font-weight:800;padding:10px 16px;border-radius:10px;font-size:18px">A&amp;F</div>
  </div>
  <div style="font-size:14px;line-height:1.5;color:#334155">${paragraphs}</div>
  ${COMPANY_SIGNATURE_HTML}
</div>`,
  });
}

export async function sendLoginCodeEmail(to: string, name: string, code: string): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) throw new Error('E-mail não configurado');

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const firstName = (name || '').split(' ')[0] || 'olá';

  await transporter.sendMail({
    from: `AF CRM <${from}>`,
    to,
    subject: `Seu código de acesso: ${code}`,
    text: `Olá ${firstName}, seu código de acesso ao AF CRM é ${code}. Ele expira em 10 minutos. Se não foi você que tentou entrar, ignore este e-mail.`,
    html: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1e293b">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#0d2545;color:#fff;font-weight:800;padding:10px 16px;border-radius:10px;font-size:18px">A&amp;F</div>
  </div>
  <h2 style="font-size:18px;color:#0d2545;margin:0 0 8px">Seu código de acesso</h2>
  <p style="font-size:14px;color:#475569;margin:0 0 20px">Olá ${firstName}, use o código abaixo para entrar no AF CRM:</p>
  <div style="text-align:center;background:#f1f5f9;border-radius:12px;padding:18px;margin-bottom:20px">
    <span style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0d2545">${code}</span>
  </div>
  <p style="font-size:13px;color:#64748b;margin:0 0 6px">O código expira em <b>10 minutos</b>.</p>
  <p style="font-size:12px;color:#94a3b8;margin:16px 0 0">Se não foi você que tentou entrar, ignore este e-mail — sua conta continua segura.</p>
</div>`,
  });
}

/** Link de "Esqueci minha senha" — vale 30 minutos, uso único. */
export async function sendPasswordResetEmail(to: string, name: string, link: string): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) throw new Error('E-mail não configurado');
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const firstName = (name || '').split(' ')[0] || 'olá';

  await transporter.sendMail({
    from: `AF CRM <${from}>`,
    to,
    subject: 'Redefinir sua senha do AF CRM',
    text: `Olá ${firstName}, recebemos um pedido pra redefinir a sua senha do AF CRM. Pra criar uma senha nova, abra este link (vale por 30 minutos): ${link}\n\nSe não foi você, ignore este e-mail — sua senha continua a mesma.`,
    html: `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1e293b">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#0d2545;color:#fff;font-weight:800;padding:10px 16px;border-radius:10px;font-size:18px">A&amp;F</div>
  </div>
  <h2 style="font-size:18px;color:#0d2545;margin:0 0 8px">Redefinir sua senha</h2>
  <p style="font-size:14px;color:#475569;margin:0 0 20px">Olá ${firstName}, recebemos um pedido pra redefinir a sua senha do AF CRM. Clique no botão abaixo pra criar uma senha nova:</p>
  <div style="text-align:center;margin-bottom:20px">
    <a href="${link}" style="display:inline-block;background:#2261a8;color:#fff;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:15px">Criar senha nova</a>
  </div>
  <p style="font-size:13px;color:#64748b;margin:0 0 6px">O link vale por <b>30 minutos</b> e só pode ser usado uma vez.</p>
  <p style="font-size:12px;color:#94a3b8;margin:16px 0 0">Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.</p>
</div>`,
  });
}
