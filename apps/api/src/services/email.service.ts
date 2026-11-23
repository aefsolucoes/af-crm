import nodemailer, { Transporter } from 'nodemailer';
import { DadosEmpresa, dadosDaConta } from '../lib/empresa';

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
// Nome, telefone, site e endereço vêm dos dados da empresa da conta (lib/empresa.ts — plano do piloto 23/11). Campo não gravado = a linha não aparece
// (Fabio 23/11: "sem nada gravado, fica sem"); com tudo gravado (A&F), sai igual a antes.

/** Assinatura da empresa (HTML) — reaproveitada pela caixa de e-mail do CRM
 *  quando o envio sai da caixa comercial@. */
export function companySignatureHtml(e: DadosEmpresa): string {
  const tel = `+55${e.telefone.replace(/\D/g, '')}`;
  const linhas = [
    e.nomeAssinatura && `<p style="font-size:13px;font-weight:700;letter-spacing:0.5px;color:#0d2545;margin:0 0 6px">${escapeHtml(e.nomeAssinatura.toUpperCase())}</p>`,
    e.telefone && `<p style="font-size:12px;color:#475569;margin:0 0 3px">Telefone: <a href="tel:${tel}" style="color:#3b82f6;text-decoration:none">${escapeHtml(e.telefone)}</a></p>`,
    e.site && `<p style="font-size:12px;color:#475569;margin:0 0 3px">Site: <a href="https://${escapeHtml(e.site)}" style="color:#3b82f6;text-decoration:none">${escapeHtml(e.site)}</a></p>`,
    e.endereco && `<p style="font-size:12px;color:#475569;margin:0">Endereço: ${escapeHtml(e.endereco)}</p>`,
  ].filter(Boolean);
  return `
  <p style="font-size:14px;color:#334155;margin:28px 0 12px">Atenciosamente,</p>${linhas.length ? `
  <div style="border-left:3px solid #3b82f6;padding-left:14px">${linhas.map((l) => `
    ${l}`).join('')}
  </div>` : ''}`;
}

/** Linhas da assinatura em texto (só as que a conta tem). */
const linhasTexto = (e: DadosEmpresa, nome: string) => [nome, e.telefone && `Telefone: ${e.telefone}`, e.site && `Site: ${e.site}`, e.endereco && `Endereço: ${e.endereco}`].filter(Boolean).join('\n');

/** Mesma assinatura em texto — ponto de partida quando alguém vai editar a
 *  assinatura da caixa comercial@ na página E-mail. */
export function companySignatureText(e: DadosEmpresa): string {
  return linhasTexto(e, e.nomeAssinatura.toUpperCase());
}

/** E-mail com corpo livre (automações de follow-up) — cada linha em branco
 *  vira um parágrafo, igual quem escreveu enxerga no campo de texto. `accountId` escolhe os dados da empresa (nome, assinatura). */
export async function sendGenericEmail(to: string, subject: string, bodyText: string, htmlPronto?: string, accountId?: string | null): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) throw new Error('E-mail não configurado');

  const e = await dadosDaConta(accountId);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const paragraphs = bodyText
    .split('\n')
    .map((line) => line.trim() ? `<p style="margin:0 0 14px">${escapeHtml(line)}</p>` : '')
    .join('');

  await transporter.sendMail({
    from: e.nome ? `${e.nome} <${from}>` : String(from),
    to,
    subject,
    text: linhasTexto(e, e.nomeAssinatura) ? `${bodyText}\n\n--\n${linhasTexto(e, e.nomeAssinatura)}` : bodyText,
    html: htmlPronto || `
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1e293b">
${e.marca ? `  <div style="margin-bottom:24px">
    <div style="display:inline-block;background:#0d2545;color:#fff;font-weight:800;padding:10px 16px;border-radius:10px;font-size:18px">${escapeHtml(e.marca)}</div>
  </div>
` : ''}  <div style="font-size:14px;line-height:1.5;color:#334155">${paragraphs}</div>
  ${companySignatureHtml(e)}
</div>`,
  });
}

/** E-mail dos lembretes (Fabio 28/10: "refaz novos e-mails mais chamativos") — faixa azul da A&F, título grande, caixa de destaque e botão (padrão: WhatsApp
 *  da API Oficial, 61 8172-1313; o Follow Up passa o link da proposta). Usado pelos loops de Aguardando Documentação e de Follow Up. */
export function emailLembreteDocs(p: { nome: string; titulo: string; paragrafos: string[]; destaque: string; cta?: { texto: string; url: string; rodape?: string } }, e: DadosEmpresa): string {
  // Sem WhatsApp gravado na conta, o e-mail sai sem o botão (só o "responda este e-mail").
  const cta = p.cta || (e.whatsappLink ? { texto: '📲 Enviar documentos pelo WhatsApp', url: e.whatsappLink, rodape: 'ou responda este e-mail com os arquivos' } : null);
  return `
<div style="background:#eef2f7;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(13,37,69,.10)">
    <div style="background:linear-gradient(135deg,#0d2545,#1d4f91);padding:22px 28px">
      ${e.marca ? `<span style="display:inline-block;background:#ffffff;color:#0d2545;font-weight:800;padding:6px 12px;border-radius:8px;font-size:16px">${escapeHtml(e.marca)}</span>` : ''}
      ${e.marcaSubtitulo ? `<span style="color:#cfe0ff;font-size:13px;margin-left:10px">${escapeHtml(e.marcaSubtitulo)}</span>` : ''}
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 6px;color:#64748b;font-size:14px">Olá, ${escapeHtml(p.nome)}!</p>
      <h1 style="margin:0 0 18px;color:#0d2545;font-size:22px;line-height:1.3">${escapeHtml(p.titulo)}</h1>
      ${p.paragrafos.map((t) => `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.6">${escapeHtml(t)}</p>`).join('')}
      <div style="margin:20px 0;padding:14px 16px;background:#fff7e6;border-left:4px solid #f59e0b;border-radius:8px;color:#7c4a03;font-size:14px;line-height:1.5">📌 ${escapeHtml(p.destaque)}</div>
      ${cta ? `<div style="text-align:center;margin:26px 0 8px">
        <a href="${cta.url}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px">${escapeHtml(cta.texto)}</a>
      </div>` : '<p style="margin:12px 0 0;text-align:center;color:#94a3b8;font-size:12px">Responda este e-mail com os arquivos</p>'}
      ${cta?.rodape ? `<p style="margin:12px 0 0;text-align:center;color:#94a3b8;font-size:12px">${escapeHtml(cta.rodape)}</p>` : ''}
    </div>
    <div style="padding:0 28px 24px">${companySignatureHtml(e)}</div>
  </div>
</div>`;
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
