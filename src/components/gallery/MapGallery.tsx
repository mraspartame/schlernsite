import { useEffect, useRef } from 'react';
import type { GalleryLocation } from '../../data/gallery/locations';

interface Props {
  locations: GalleryLocation[];
}

export default function MapGallery({ locations }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Dynamically import leaflet to avoid SSR issues
    import('leaflet').then((L) => {
      import('leaflet/dist/leaflet.css');

      // Fix Leaflet's default icon paths broken by bundlers
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });

      const map = L.map(mapRef.current!).setView([48, 15], 4);
      mapInstanceRef.current = map;

      // OpenTopoMap — free, no API key, great for landscape photography
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution:
          '© <a href="https://opentopomap.org">OpenTopoMap</a> contributors, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 17,
      }).addTo(map);

      // Custom marker style matching the brutal aesthetic
      const brutalIcon = (label: string) =>
        L.divIcon({
          html: `<div style="
            background: #fff;
            border: 3px solid #000;
            padding: 4px 8px;
            font-family: 'Poppins', sans-serif;
            font-weight: 700;
            font-size: 12px;
            white-space: nowrap;
            box-shadow: 3px 3px 0 #000;
            cursor: pointer;
          ">${label}</div>`,
          className: '',
          iconAnchor: [0, 0],
        });

      locations.forEach((loc) => {
        const marker = L.marker(loc.coordinates, {
          icon: brutalIcon(loc.name),
        }).addTo(map);

        marker.bindPopup(`
          <div style="font-family: sans-serif; min-width: 200px;">
            <strong style="font-size: 16px;">${loc.name}</strong>
            <p style="color: #666; margin: 2px 0 8px;">${loc.region}</p>
            <p style="font-size: 13px; margin-bottom: 10px;">${loc.description}</p>
            <a href="/gallery/${loc.slug}/"
              style="
                display: inline-block;
                background: #000;
                color: #fff;
                padding: 6px 12px;
                text-decoration: none;
                font-weight: bold;
                font-size: 13px;
              ">
              View photos &rarr;
            </a>
          </div>
        `);
      });

      // If no locations, show a helpful message
      if (locations.length === 0) {
        const noDataDiv = document.createElement('div');
        noDataDiv.style.cssText =
          'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1000;background:#fff;border:3px solid #000;padding:24px;font-family:sans-serif;box-shadow:4px 4px 0 #000;';
        noDataDiv.innerHTML =
          '<strong>No locations yet.</strong><br><small>Add entries to <code>src/data/gallery/locations.ts</code></small>';
        mapRef.current!.style.position = 'relative';
        mapRef.current!.appendChild(noDataDiv);
      }
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={mapRef}
      style={{ width: '100%', height: '100%', background: '#e8e4e0' }}
    />
  );
}
