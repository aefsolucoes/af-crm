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
  });
  cachedKey = key;
  return cached;
}

export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
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
