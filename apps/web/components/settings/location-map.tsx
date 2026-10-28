'use client';
import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

/* Mapa do trajeto da equipe (Fabio 28/10: "cadê o mapa?"). Leaflet + OpenStreetMap (sem chave). Leaflet mexe com window, então é importado só no
 * navegador (dynamic import no efeito; o app é export estático e pré-renderiza no build). Usa circleMarker pra não depender das imagens de ícone. */

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  label: string; // quem
  sub: string; // quando · o quê
  order: number; // pra ligar os pontos na ordem do dia
  href: string; // abrir no mapa do celular (Google Maps)
}

export function LocationMap({ points, route }: { points: MapPoint[]; route: boolean }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    import('leaflet').then((mod) => {
      const L: any = (mod as any).default || mod;
      if (cancelled || !elRef.current) return;
      if (!mapRef.current) {
        mapRef.current = L.map(elRef.current, { scrollWheelZoom: false }).setView([-15.78, -47.93], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapRef.current);
      }
      const map = mapRef.current;
      if (layerRef.current) map.removeLayer(layerRef.current);
      const group = L.layerGroup().addTo(map);
      layerRef.current = group;

      const ordered = [...points].sort((a, b) => a.order - b.order);
      const latlngs = ordered.map((p) => [p.lat, p.lng] as [number, number]);
      if (route && latlngs.length > 1) L.polyline(latlngs, { color: '#1e4fd8', weight: 3, opacity: 0.45 }).addTo(group);
      ordered.forEach((p, i) => {
        L.circleMarker([p.lat, p.lng], { radius: 6, color: '#1e4fd8', fillColor: route && i === ordered.length - 1 ? '#16a34a' : '#1e4fd8', fillOpacity: 0.9, weight: 2 })
          .bindPopup(`<b>${p.label}</b><br>${p.sub}<br><a href="${p.href}" target="_blank" rel="noreferrer">Abrir no mapa do celular ↗</a>`)
          .addTo(group);
      });
      if (latlngs.length) map.fitBounds(latlngs as any, { padding: [30, 30], maxZoom: 16 });
      setTimeout(() => map.invalidateSize(), 120);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [points, route]);

  // tira o mapa da memória ao sair
  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);

  if (!points.length) return null;
  return <div ref={elRef} className="h-72 w-full rounded-xl border border-af-border overflow-hidden" style={{ zIndex: 0 }} />;
}
