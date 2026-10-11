import { useEffect, useRef } from 'react';
import 'pannellum/build/pannellum.js';
import 'pannellum/build/pannellum.css';

export function PanoViewer({ url }: { url: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A fresh element per viewer keeps StrictMode's mount/unmount/mount cycle from reusing a destroyed one.
    const element = document.createElement('div');
    element.className = 'viewer-inner';
    container.current!.appendChild(element);
    const viewer = window.pannellum.viewer(element, {
      type: 'equirectangular',
      panorama: url,
      autoLoad: true,
      hfov: 100,
      minHfov: 30,
      maxHfov: 120,
      showFullscreenCtrl: true,
      mouseZoom: true,
    });
    return () => {
      viewer.destroy();
      element.remove();
    };
  }, [url]);

  return <div ref={container} className="viewer" />;
}
