import crypto from 'crypto';

/**
 * Criptografia simétrica (AES-256-GCM) pra segredo que precisa ser LIDO de
 * volta — hoje, a senha das caixas de e-mail pessoais (EmailAccount). A
 * chave vem de EMAIL_SECRET_KEY, ou do JWT_SECRET se ela não existir
 * (trocar a chave invalida as senhas salvas: aí é só reconectar a caixa).
 * Formato gravado: base64(iv[12] | tag[16] | dados).
 */
function key(): Buffer {
  const base = process.env.EMAIL_SECRET_KEY || process.env.JWT_SECRET;
  if (!base) throw new Error('Sem chave pra criptografar (EMAIL_SECRET_KEY/JWT_SECRET)');
  return crypto.createHash('sha256').update(`af-crm-secret-box:${base}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function openSecret(sealed: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
