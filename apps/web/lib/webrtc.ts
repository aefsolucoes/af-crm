/** Espera a coleta de candidatos ICE terminar antes de usar o SDP local —
 *  sem isso, o SDP mandado pra Meta (pre-accept/accept/connect) não tem
 *  NENHUM candidato ainda (createAnswer()/createOffer() + setLocalDescription()
 *  retornam antes da coleta assíncrona terminar), a Meta não acha como
 *  alcançar o navegador e a chamada nunca conecta de verdade. Usado pelos
 *  dois lados (atender uma ligação recebida e fazer uma ligação) — mesma
 *  exigência da Meta nos dois casos. Timeout de segurança: em redes que
 *  nunca fecham a coleta (raro), segue com o que já foi juntado em vez de
 *  travar pra sempre. */
export function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => {
      console.log('[Calling] iceGatheringState:', pc.iceGatheringState);
      if (pc.iceGatheringState === 'complete') finish();
    };
    // Já tendo o endereço público (candidato "srflx" do STUN), não precisa
    // esperar o resto: a Meta conecta com ele (e descobre o caminho na hora,
    // como se viu no diagnóstico — "prflx"). Antes esperava até 4s aqui, o
    // que atrasava o celular começar a tocar.
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate && / typ srflx /.test(` ${e.candidate.candidate} `)) setTimeout(finish, 250);
    };
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
    setTimeout(finish, 2000);
  });
}
