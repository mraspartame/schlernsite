import { useState, useEffect, useCallback } from 'react';

interface Photo {
  src: string;
  thumb: string;
  caption?: string;
}

interface Props {
  photos: Photo[];
}

export default function Lightbox({ photos }: Props) {
  const [active, setActive] = useState<number | null>(null);

  const open = (idx: number) => setActive(idx);
  const close = () => setActive(null);
  const prev = useCallback(() => {
    if (active === null) return;
    setActive((active - 1 + photos.length) % photos.length);
  }, [active, photos.length]);
  const next = useCallback(() => {
    if (active === null) return;
    setActive((active + 1) % photos.length);
  }, [active, photos.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (active === null) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, prev, next]);

  // Prevent body scroll when lightbox is open
  useEffect(() => {
    document.body.style.overflow = active !== null ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [active]);

  return (
    <>
      {/* Thumbnail grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: '16px',
        }}
      >
        {photos.map((photo, idx) => (
          <button
            key={idx}
            onClick={() => open(idx)}
            style={{
              border: '3px solid #000',
              background: '#000',
              padding: 0,
              cursor: 'pointer',
              display: 'block',
              boxShadow: '4px 4px 0 #000',
              overflow: 'hidden',
              aspectRatio: '4/3',
            }}
          >
            <img
              src={photo.thumb}
              alt={photo.caption ?? `Photo ${idx + 1}`}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
                transition: 'transform 0.2s',
              }}
              onMouseOver={(e) =>
                ((e.currentTarget as HTMLImageElement).style.transform = 'scale(1.04)')
              }
              onMouseOut={(e) =>
                ((e.currentTarget as HTMLImageElement).style.transform = 'scale(1)')
              }
            />
          </button>
        ))}
      </div>

      {/* Lightbox overlay */}
      {active !== null && (
        <div
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.92)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Main image */}
          <img
            src={photos[active].src}
            alt={photos[active].caption ?? `Photo ${active + 1}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '90vw',
              maxHeight: '85vh',
              objectFit: 'contain',
              border: '4px solid #fff',
              boxShadow: '0 0 60px rgba(0,0,0,0.8)',
            }}
          />

          {/* Caption */}
          {photos[active].caption && (
            <div
              style={{
                position: 'absolute',
                bottom: 24,
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#000',
                color: '#fff',
                padding: '8px 16px',
                fontFamily: 'sans-serif',
                fontSize: 14,
                border: '2px solid #fff',
                maxWidth: '80vw',
                textAlign: 'center',
              }}
            >
              {photos[active].caption}
            </div>
          )}

          {/* Counter */}
          <div
            style={{
              position: 'absolute',
              top: 16,
              left: 16,
              background: '#000',
              color: '#fff',
              padding: '4px 10px',
              fontFamily: 'monospace',
              fontSize: 13,
              border: '2px solid #fff',
            }}
          >
            {active + 1} / {photos.length}
          </div>

          {/* Close */}
          <button
            onClick={close}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              background: '#fff',
              border: '3px solid #000',
              width: 40,
              height: 40,
              fontSize: 20,
              fontWeight: 'bold',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '3px 3px 0 #000',
            }}
          >
            ×
          </button>

          {/* Prev */}
          {photos.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); prev(); }}
              style={{
                position: 'absolute',
                left: 16,
                top: '50%',
                transform: 'translateY(-50%)',
                background: '#fff',
                border: '3px solid #000',
                width: 48,
                height: 48,
                fontSize: 22,
                fontWeight: 'bold',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '3px 3px 0 #000',
              }}
            >
              ‹
            </button>
          )}

          {/* Next */}
          {photos.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); next(); }}
              style={{
                position: 'absolute',
                right: 16,
                top: '50%',
                transform: 'translateY(-50%)',
                background: '#fff',
                border: '3px solid #000',
                width: 48,
                height: 48,
                fontSize: 22,
                fontWeight: 'bold',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '3px 3px 0 #000',
              }}
            >
              ›
            </button>
          )}
        </div>
      )}
    </>
  );
}
