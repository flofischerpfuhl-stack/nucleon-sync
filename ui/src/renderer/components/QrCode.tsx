// SPDX-License-Identifier: GPL-3.0-or-later
/** QR code as inline SVG (qrcode-generator, pure JS, offline). */
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++)
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { path: d, n: count + 8 };
  }, [text]);
  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
