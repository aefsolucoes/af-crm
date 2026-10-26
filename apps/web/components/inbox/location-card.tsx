'use client';

/* Localização que o cliente manda pelo WhatsApp, desenhada como no próprio WhatsApp (Fabio 26/10): mapa com o pino e, embaixo, nome e endereço.
 * O backend grava a mensagem como texto ("📍 Localização: nome — endereço" + link do Google Maps com lat,lng); aqui esse texto vira o cartão.
 * O mapa é montado com os quadrinhos do OpenStreetMap (sem chave de API), centralizado no ponto; tocar no cartão abre o Google Maps. */

export type ParsedLocation = { lat: number; lng: number; name: string; address: string; url: string };

/** "📍 Localização: Edifício RAFA — SRIA II…\nhttps://www.google.com/maps?q=-15.8,-47.9" → dados do cartão. null se não for localização. */
export function parseLocationMessage(content: string): ParsedLocation | null {
  const t = String(content || '');
  if (!t.startsWith('📍 Localização')) return null;
  const m = /https:\/\/www\.google\.com\/maps\?q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const first = t.split('\n')[0].replace(/^📍 Localização:?\s*/, '').trim();
  const [a, ...rest] = first.split(' — ');
  const name = rest.length ? a.trim() : '';
  const address = rest.length ? rest.join(' — ').trim() : a.trim();
  return { lat, lng, name, address, url: m[0] };
}

const TILE = 256;
const ZOOM = 16;
const W = 280;
const H = 150;

/** Pixel global do ponto no zoom dado (projeção Web Mercator dos mapas de quadrinhos). */
function toPixel(lat: number, lng: number, z: number) {
  const n = TILE * 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function LocationCard({ loc }: { loc: ParsedLocation }) {
  const { x, y } = toPixel(loc.lat, loc.lng, ZOOM);
  const left = x - W / 2;
  const top = y - H / 2;
  const tiles: { tx: number; ty: number }[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) tiles.push({ tx, ty });
  }
  return (
    <a href={loc.url} target="_blank" rel="noreferrer" className="block -mx-1 -mt-0.5 mb-1 rounded-md overflow-hidden" style={{ width: W, maxWidth: '100%' }} title="Abrir no Google Maps">
      <div className="relative overflow-hidden bg-[#1f2c34]" style={{ width: W, maxWidth: '100%', height: H }}>
        {tiles.map(({ tx, ty }) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${tx}-${ty}`}
            src={`https://tile.openstreetmap.org/${ZOOM}/${tx}/${ty}.png`}
            alt=""
            draggable={false}
            className="absolute select-none pointer-events-none"
            style={{ left: tx * TILE - left, top: ty * TILE - top, width: TILE, height: TILE }}
          />
        ))}
        {/* pino */}
        <svg className="absolute pointer-events-none" style={{ left: W / 2 - 12, top: H / 2 - 30 }} width="24" height="32" viewBox="0 0 24 32" aria-hidden>
          <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="#ef4444" />
          <circle cx="12" cy="12" r="4.5" fill="#fff" />
        </svg>
        <span className="absolute right-1 bottom-0.5 text-[9px] text-slate-600 bg-white/70 px-1 rounded">© OpenStreetMap</span>
      </div>
      <div className="px-2 py-1.5 bg-black/10">
        {loc.name && <p className="text-sm font-medium text-[#e9edef] leading-snug [overflow-wrap:anywhere]">{loc.name}</p>}
        {loc.address ? <p className="text-xs text-[#8696a0] leading-snug [overflow-wrap:anywhere]">{loc.address}</p> : !loc.name && <p className="text-xs text-[#8696a0]">📍 Localização</p>}
      </div>
    </a>
  );
}
