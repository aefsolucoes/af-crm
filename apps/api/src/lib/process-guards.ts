/**
 * Guarda global contra queda do servidor por falha momentânea de banco/rede.
 *
 * Incidente 2026-10-09 (21:52 → 22:17 BRT): uma consulta da bolha "Dúvidas da
 * IA" estourou o pool de conexões do Prisma ("Timed out fetching a new
 * connection from the connection pool"). A rota era async sem try/catch, o erro
 * virou unhandledRejection e DERRUBOU o servidor inteiro; o Railway religou
 * 3 vezes, todas falharam (banco ainda inacessível) e ele desistiu — 24 min
 * fora do ar. Agora:
 *  - unhandledRejection: só registra no log e segue (nunca mais derruba);
 *  - uncaughtException de falha momentânea de banco/rede: registra e segue;
 *  - qualquer outro uncaughtException (bug de verdade, estado possivelmente
 *    corrompido): registra e sai com código 1 — o Railway religa sozinho
 *    (restartPolicy ALWAYS, apps/api/railway.json).
 */

const TRANSIENT_CODES = new Set([
  'P1001', 'P1002', 'P1008', 'P1017', 'P2024', // Prisma: sem acesso ao banco, timeout, conexão fechada, pool esgotado
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
]);

/** Erro de conexão com banco/rede que costuma passar sozinho. */
export function isTransientError(err: unknown): boolean {
  const e = err as any;
  const code = e?.code ?? e?.cause?.code;
  if (code && TRANSIENT_CODES.has(String(code))) return true;
  return /Can't reach database server|Timed out fetching a new connection|connection pool|Connection (terminated|reset|refused|closed)|ECONNRESET|ETIMEDOUT|server closed the connection/i.test(String(e?.message || ''));
}

export function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`[Erro não tratado${isTransientError(reason) ? ' — falha momentânea de banco/rede' : ''}] o servidor segue de pé:`, reason);
  });
  process.on('uncaughtException', (err) => {
    if (isTransientError(err)) {
      console.error('[Erro não capturado — falha momentânea de banco/rede] o servidor segue de pé:', err);
      return;
    }
    console.error('[Erro fatal não capturado] reiniciando o servidor:', err);
    setTimeout(() => process.exit(1), 500); // deixa o log sair; o Railway religa
  });
}
