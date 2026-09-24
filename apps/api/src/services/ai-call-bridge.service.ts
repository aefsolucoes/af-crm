import dgram from 'dgram';
import crypto from 'crypto';

type StunResult = { server: string; mapped: string | null; error?: string };

function stunBinding(socket: dgram.Socket, host: string, port: number, timeoutMs = 4000): Promise<StunResult> {
  const server = `${host}:${port}`;
  return new Promise((resolve) => {
    const tid = crypto.randomBytes(12);
    const msg = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]);
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve({ server, mapped: null, error: 'timeout' });
    }, timeoutMs);
    function onMessage(m: Buffer) {
      if (m.length < 20 || !m.subarray(8, 20).equals(tid)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      let i = 20;
      let mapped: string | null = null;
      while (i + 4 <= m.length) {
        const type = m.readUInt16BE(i);
        const len = m.readUInt16BE(i + 2);
        if (type === 0x0020 && len >= 8) {
          const p = m.readUInt16BE(i + 6) ^ 0x2112;
          const ip = [0, 1, 2, 3].map((k) => m[i + 8 + k] ^ [0x21, 0x12, 0xa4, 0x42][k]).join('.');
          mapped = `${ip}:${p}`;
        }
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      resolve({ server, mapped });
    }
    socket.on('message', onMessage);
    socket.send(msg, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve({ server, mapped: null, error: err.message });
      }
    });
  });
}

// Diagnóstico de boot: a ligação feita pela IA precisa que o servidor troque
// áudio com a Meta por UDP (WebRTC). Confirma se o Railway deixa sair UDP e
// se o NAT mantém a mesma porta pra destinos diferentes.
export async function probeUdpEgress(): Promise<void> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve) => socket.bind(0, resolve));
    const a = await stunBinding(socket, 'stun.l.google.com', 19302);
    const b = await stunBinding(socket, 'stun.cloudflare.com', 3478);
    const natType = a.mapped && b.mapped ? (a.mapped === b.mapped ? 'mesma porta (NAT amigável)' : 'porta muda por destino (NAT simétrico)') : 'indeterminado';
    console.log(`[AI-Call][UDP] ${a.server} -> ${a.mapped || a.error} | ${b.server} -> ${b.mapped || b.error} | ${natType}`);
  } catch (err) {
    console.error('[AI-Call][UDP] falha no diagnóstico:', err);
  } finally {
    socket.close();
  }
}
