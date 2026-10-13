/** Fecha neste aparelho as notificações "Ligação recebida" (push com requireInteraction fica no ar até alguém
 *  mexer). Chamado quando a ligação é atendida, recusada, perdida ou atendida por outra pessoa/aba. */
export async function closeCallNotifications(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    (await reg.getNotifications()).filter((n) => (n.tag || '').startsWith('af-crm-call-')).forEach((n) => n.close());
  } catch { /* melhor esforço */ }
}
