import { useCallback, useEffect, useRef, useState } from "react";

interface LightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/** 图片点击缩放：滚轮缩放、拖拽平移、双击复位、Esc 关闭 */
export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reset]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(12, Math.max(0.15, s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    },
    [offset],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
      onWheel={onWheel}
    >
      <div className="absolute right-3 top-3 z-10 flex gap-2">
        <span className="rounded bg-black/60 px-2 py-1 text-xs text-white/90">
          {(scale * 100).toFixed(0)}% · 滚轮缩放 / 拖拽平移 / 双击复位 / Esc 关闭
        </span>
      </div>
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="max-w-[92vw] max-h-[92vh] select-none"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: dragRef.current ? "none" : "transform 80ms ease-out",
          cursor: dragRef.current ? "grabbing" : "grab",
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={reset}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {alt && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-xs text-white/90">
          {alt}
        </div>
      )}
    </div>
  );
}
