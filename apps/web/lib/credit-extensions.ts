import type { Bank } from '@/components/credit/shared';

/** Avisa as extensões do Chrome (Santander/Creditas/Inter) que há pedido novo, sem esperar o alarme de 1 minuto.
 *  Só funciona no Chrome onde as extensões estão instaladas; fora dele (ou se a extensão for antiga) não faz nada
 *  e a extensão pega o pedido no próximo minuto, como antes. */
export function pingExtensions(ext: Partial<Record<Bank, { extId?: string | null }>> | undefined, banks: Bank[]) {
  try {
    const c = (window as any).chrome;
    if (!c?.runtime?.sendMessage || !ext) return;
    for (const b of banks) {
      const id = ext[b]?.extId;
      if (!id) continue;
      c.runtime.sendMessage(id, { type: 'poll-now' }, () => void c.runtime.lastError);
    }
  } catch { /* sem Chrome/extensão: segue pelo alarme */ }
}
