// Baileys QR Code service — placeholder
// Railway environment does not support Baileys native modules.
// QR Code connection will be implemented via an external microservice.

type ConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'unavailable';

export function setBaileysIO(_io: any) {}

export function getQRStatus(_accountId: string) {
  return { status: 'unavailable' as ConnectionStatus, qr: null };
}

export async function startQRConnection(_accountId: string): Promise<void> {
  throw new Error('QR connection not available in this environment');
}

export async function sendBaileysMessage(_to: string, _text: string, _accountId: string): Promise<boolean> {
  return false;
}

export async function disconnectQR(_accountId: string): Promise<void> {}
