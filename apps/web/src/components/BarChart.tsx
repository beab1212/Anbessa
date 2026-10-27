// A small grouped bar chart in plain SVG (no chart library): one group per day, one bar per series.

import { barHeight, niceMax } from "../lib/reports";

export interface BarSeries {
  key: string;
  label: string;
  color: string;
}

export function BarChart<T>({
  rows, series, value, label, format = (v) => String(v), height = 180, title,
}: {
  rows: T[];
  series: BarSeries[];
  value: (row: T, key: string) => number;
  label: (row: T) => string;
  format?: (v: number) => string;
  height?: number;
  title: string;
}) {
  const max = niceMax(Math.max(0, ...rows.flatMap((r) => series.map((s) => value(r, s.key)))));
  const groupW = Math.max(18, series.length * 10 + 8);
  const left = 56;
  const bottom = 22;
  const width = left + rows.length * groupW + 8;
  const barW = (groupW - 8) / series.length;
  const ticks = [0, max / 2, max];
  // label every n-th day so long ranges stay readable
  const every = Math.max(1, Math.ceil(rows.length / 14));

  return (
    <figure style={{ margin: 0 }}>
      <div className="row xs muted" style={{ gap: "1rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
        {series.map((s) => (
          <span key={s.key} className="row" style={{ gap: "0.35rem" }}>
            <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
            {s.label}
          </span>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg role="img" aria-label={title} width={Math.max(width, 240)} height={height + bottom + 8} style={{ display: "block", fontFamily: "var(--font)" }}>
          {ticks.map((t) => {
            const y = 4 + height - barHeight(t, max, height);
            return (
              <g key={t}>
                <line x1={left} x2={width} y1={y} y2={y} stroke="var(--border)" />
                <text x={left - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{format(t)}</text>
              </g>
            );
          })}
          {rows.map((r, i) => {
            const x0 = left + i * groupW + 4;
            return (
              <g key={i}>
                {series.map((s, j) => {
                  const v = value(r, s.key);
                  const h = barHeight(v, max, height);
                  return (
                    <rect key={s.key} x={x0 + j * barW} y={4 + height - h} width={Math.max(1, barW - 1)} height={h} fill={s.color} rx="1.5">
                      <title>{`${label(r)} · ${s.label}: ${format(v)}`}</title>
                    </rect>
                  );
                })}
                {i % every === 0 ? (
                  <text x={x0 + (groupW - 8) / 2} y={height + bottom} textAnchor="middle" fontSize="10" fill="var(--muted)">{label(r)}</text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
