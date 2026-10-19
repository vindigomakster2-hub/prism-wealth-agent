import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Smooth path through points (Catmull-Rom converted to cubic Béziers, mild tension). */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

export interface Series {
  name: string;
  values: number[];
  color: string;
  dashed?: boolean;
}

export function LineChart({
  labels,
  series,
  height = 200,
  format,
  yFormat,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  format: (v: number) => string;
  yFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 46;
  const padR = 14;
  const padT = 44;
  const padB = 26;
  const all = series.flatMap((s) => s.values);
  const minV = Math.min(...all);
  const maxV = Math.max(...all);
  const ticks = niceTicks(minV - (maxV - minV) * 0.08, maxV + (maxV - minV) * 0.05);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const W = Math.max(width, 200);
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, labels.length - 1);
  const y = (v: number) => padT + (1 - (v - y0) / (y1 - y0 || 1)) * (height - padT - padB);

  const paths = useMemo(
    () => series.map((s) => smoothPath(s.values.map((v, i) => [x(i), y(v)] as [number, number]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, W, height, y0, y1],
  );

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - padL) / (W - padL - padR)) * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, i)));
  };

  const hi = hover ?? labels.length - 1;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {width > 0 && (
        <svg width={W} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${series.map((s) => s.name).join(" and ")} by month`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.06)" />
              <text x={padL - 10} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#a9a2a7" className="num">
                {(yFormat ?? format)(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            labels.length <= 8 || i % 2 === (labels.length - 1) % 2 ? (
              <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize="11.5" fill={i === hi ? "#f6f3ee" : "#a9a2a7"}>
                {l}
              </text>
            ) : null,
          )}
          {/* hover capsule, after the reference's "50" marker */}
          <rect x={x(hi) - 13} y={padT - 6} width={26} height={height - padT - padB + 6} rx={13} fill="rgba(255,255,255,0.10)" />
          {paths.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={series[i].color} strokeWidth={2} strokeDasharray={series[i].dashed ? "5 5" : undefined} strokeLinecap="round" />
          ))}
          {series.map((s, i) => (
            <circle key={i} cx={x(hi)} cy={y(s.values[hi])} r={5} fill={s.color} stroke="#2b282d" strokeWidth={2} />
          ))}
        </svg>
      )}
      {width > 0 && (
        <div
          style={{
            position: "absolute",
            left: Math.min(Math.max(x(hi), 70), W - 70),
            top: 0,
            transform: "translateX(-50%)",
            pointerEvents: "none",
          }}
        >
          <div className="tooltip-pill num" style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "#a9a2a7" }}>{labels[hi]}</span>
            {series.map((s) => (
              <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <i className="dot" style={{ background: s.color }} />
                {format(s.values[hi])}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, color = "#e3f56b", width = 110, height = 34 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => [(i * width) / (values.length - 1), 4 + (1 - (v - min) / (max - min || 1)) * (height - 8)] as [number, number]);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export interface Slice {
  label: string;
  value: number;
  color: string;
}

export function Donut({ slices, size = 190, center }: { slices: Slice[]; size?: number; center?: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  const gap = 3;
  let acc = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Allocation by asset group">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((s, i) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={hover === i ? 22 : 18}
                strokeDasharray={`${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}`}
                strokeDashoffset={-acc}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width .15s", cursor: "default" }}
              >
                <title>{`${s.label}: ${((s.value / total) * 100).toFixed(1)}%`}</title>
              </circle>
            );
            acc += len;
            return el;
          })}
        </g>
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", pointerEvents: "none" }}>
        {hover !== null ? (
          <div>
            <div className="big-num" style={{ fontSize: 24 }}>{((slices[hover].value / total) * 100).toFixed(0)}%</div>
            <div className="muted" style={{ fontSize: 12, maxWidth: 110 }}>{slices[hover].label}</div>
          </div>
        ) : (
          center
        )}
      </div>
    </div>
  );
}

/** Semicircle gauge. `marks` are tick positions on the same scale (e.g. tier thresholds). */
export function Gauge({
  value,
  min,
  max,
  color,
  size = 240,
  marks = [],
  children,
}: {
  value: number;
  min: number;
  max: number;
  color: string;
  size?: number;
  marks?: Array<{ at: number; label: string }>;
  children?: ReactNode;
}) {
  const r = size / 2 - 16;
  const cx = size / 2;
  const cy = size / 2;
  const f = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const arc = (from: number, to: number) => {
    const a0 = Math.PI * (1 - from);
    const a1 = Math.PI * (1 - to);
    const p0 = [cx + r * Math.cos(a0), cy - r * Math.sin(a0)];
    const p1 = [cx + r * Math.cos(a1), cy - r * Math.sin(a1)];
    return `M${p0[0]},${p0[1]} A${r},${r} 0 0 1 ${p1[0]},${p1[1]}`;
  };
  return (
    <div style={{ position: "relative", width: size, height: size / 2 + 22, margin: "0 auto" }}>
      <svg width={size} height={size / 2 + 22} role="img" aria-label={`Gauge at ${value}`}>
        <path d={arc(0, 1)} stroke="rgba(255,255,255,0.09)" strokeWidth={14} fill="none" strokeLinecap="round" />
        {f > 0.001 && <path d={arc(0, f)} stroke={color} strokeWidth={14} fill="none" strokeLinecap="round" />}
        {marks.map((m) => {
          const t = (m.at - min) / (max - min);
          const a = Math.PI * (1 - t);
          const x1 = cx + (r - 12) * Math.cos(a);
          const y1 = cy - (r - 12) * Math.sin(a);
          const x2 = cx + (r + 12) * Math.cos(a);
          const y2 = cy - (r + 12) * Math.sin(a);
          return (
            <g key={m.label}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#1c1a1e" strokeWidth={3} />
              <text x={cx + (r - 26) * Math.cos(a)} y={cy - (r - 26) * Math.sin(a) + 4} fontSize="10" fill="#a9a2a7" textAnchor="middle">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 4, textAlign: "center" }}>{children}</div>
    </div>
  );
}

export function BarRow({ label, value, max, color, display }: { label: ReactNode; value: number; max: number; color: string; display: string }) {
  return (
    <div className="bar-row">
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>{label}</div>
      <div className="meter">
        <i style={{ width: `${Math.max(0, Math.min(100, (value / (max || 1)) * 100))}%`, background: color }} />
      </div>
      <div className="v">{display}</div>
    </div>
  );
}

/** Deterministic pseudo-history for decorative sparklines, seeded by id, ending at the current value. */
export function seededTrend(seed: string, end: number, n = 12, vol = 0.04): number[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 2 ** 32 - 0.5;
  };
  const out = [end];
  for (let i = 1; i < n; i++) out.unshift(out[0] * (1 - rnd() * vol * 2));
  return out;
}
