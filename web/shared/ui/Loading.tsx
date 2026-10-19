import { useEffect, useRef, useState } from "react";

export interface LoadingProps {
  variant?: "scene" | "inline";
  label?: string;
  size?: number;
  className?: string;
}

export function Loading({ variant = "scene", label, size, className }: LoadingProps) {
  const root = useRef<HTMLSpanElement>(null);
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let visible = false;
    const update = () => setPaused(document.hidden || !visible);
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; update(); });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <span ref={root} className={`loading loading--${variant}${className ? ` ${className}` : ""}`}
    role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-paused={paused}
    style={size === undefined ? undefined : { width: size, height: variant === "inline" ? size : size * .8 }}>
    {variant === "inline" ? <svg className="loading-art" viewBox="0 0 48 48" aria-hidden="true">
      <path className="loading-compact-steam loading-animated" d="M19 21c-6-5 4-8 0-12" />
      <path className="loading-compact-steam loading-second loading-animated" d="M28 21c-6-5 4-8 0-12" />
      <g className="loading-line"><path className="loading-face" d="M34 27q12-3 10 4-1 7-11 5" /><path className="loading-face" d="M10 26h25l-2 10q-2 6-10 6-8 0-10-6Z" /><path d="M8 44h31" fill="none" /></g>
      <path d="M16 29h13" stroke="var(--loading-tea)" strokeWidth="2" strokeLinecap="round" />
    </svg> : <svg className="loading-art loading-animated" viewBox="0 0 400 320" aria-hidden="true">
        <ellipse className="loading-ground" cx="181" cy="291" rx="121" ry="4" opacity=".8"/>

        {/* 先画两段袖子的外边，再统一填色，遮住肘部内部的重叠线。 */}
        <path className="loading-arm-outline" d="M152 198q-29 22-58 23"/>
        <g className="loading-pour-arm loading-animated"><path className="loading-arm-outline" d="m94 221-14-33"/></g>
        <path className="loading-arm-fill" d="M152 198q-29 22-58 23"/>
        <g className="loading-pour-arm loading-animated"><path className="loading-arm-fill" d="m94 221-14-33"/></g>
        <g transform="translate(75 0)">
        <path className="loading-line loading-shell" d="M101 178l-15 5q-16 7-15 31l11 64q45 14 99 2l-1-8 23-18q9-6 3-17l-18-31q-9-16-29-23l-14-5Z"/>
        <path className="loading-line loading-shirt" d="m107 179 19 8 17-8 10 101q-23 4-47 0Z"/>
        <path className="loading-soft-line" d="m105 181-13 22 21 12-9 12 19 25m22-71 16 21-17 13 10 11-18 28"/>
        <path className="loading-line loading-face" d="M111 169h28v16l-14 9-14-9Z"/>
        <path className="loading-line loading-shirt" d="m110 179 15 13-9 12-11-22m35-3-15 13 11 12 10-21"/>
        <g className="loading-line" strokeWidth="1.9">
          <path className="loading-accent" d="M125 190q-7-8-17-7-3 9 0 18 9 0 17-7Z"/>
          <path className="loading-accent" d="M129 190q7-8 17-7 3 9 0 18-9 0-17-7Z"/>
          <rect className="loading-accent" x="122" y="188" width="9" height="9" rx="3"/>
        </g>
        <path d="m110 188 9 4-9 4m33-8-9 4 9 4" fill="none" stroke="var(--loading-bow-shadow)" strokeWidth="1.5" strokeLinecap="round"/>
        <circle className="loading-ink" cx="129" cy="222" r="2.3"/>
        <circle className="loading-ink" cx="131" cy="244" r="2.3"/>
        <path className="loading-soft-line" d="m83 265 13 3m52 4 20-2"/>

        <g className="loading-head loading-animated">
          <path className="loading-line" d="M125 64V44" fill="none"/>
          <circle className="loading-line loading-shell" cx="125" cy="37" r="7"/>
          <path className="loading-soft-line" d="M118 63h14"/>
          <rect className="loading-line loading-shell" x="47" y="102" width="18" height="42" rx="9"/>
          <rect className="loading-line loading-shell" x="190" y="102" width="18" height="42" rx="9"/>
          <rect className="loading-line loading-shell" x="57" y="63" width="141" height="111" rx="44"/>
          <rect className="loading-line loading-face" x="67" y="73" width="121" height="91" rx="35" strokeWidth="2"/>
          <path className="loading-soft-line" d="M85 87q12-8 28-8" opacity=".8"/>
          <g className="loading-gaze loading-animated">
            <g className="loading-eyes loading-animated">
              <ellipse className="loading-ink" cx="105" cy="118" rx="5.3" ry="8.5"/>
              <ellipse className="loading-ink" cx="148" cy="118" rx="5.3" ry="8.5"/>
            </g>
          </g>
          <path className="loading-line" d="M114 140q12 12 26 0" strokeWidth="3" fill="none"/>
          <path className="loading-soft-line" d="M83 135h8m72 0h8" opacity=".5"/>
          <path className="loading-soft-line" d="M53 112v22m149-22v22"/>
        </g>
        </g>

        {/* 右袖与外套共用连续外轮廓，腋下至袖口只保留内侧折线。 */}
        <path className="loading-line" d="M248 216q4 11 15 26 2 3-2 6l-30 20m24 4-14 10" fill="none"/>
        <path className="loading-line loading-shirt" d="m234 263 12 10-9 12-12-11Z"/>
        <path className="loading-line loading-face" d="m225 274-7 2h-21q-4 0-4 3 0 3 5 4l18 2q9 2 21 0Z"/>
        <path className="loading-soft-line" d="M218 278q5-2 10 1"/>

        {/* 茶流只在茶壶保持倾斜时出现，起点对应旋转后的壶嘴。 */}
        <path className="loading-stream loading-animated" d="M162.2 195.42Q164 216 164 239"/>

        <g className="loading-pour-arm loading-animated">
          <path className="loading-line loading-shirt" d="m70 185 14-6 3 7-14 6Z"/>

          {/* 壶、把手和握持的手共用一个旋转组，避免动作中脱离。 */}
          <g transform="translate(-124 0)">
          <path className="loading-line" d="M214 166c-23-11-26 21-1 19" fill="none"/>
          <path className="loading-line loading-face" d="M216 158q-6 9-5 22 2 15 22 15 20-1 22-15l-4-22Z"/>
          <path className="loading-line loading-face" d="M251 171q8 3 12-8l6 6q-1 13-17 16"/>
          <path className="loading-line loading-shell" d="M212 158q20-12 41 0-17 7-41 0Z"/>
          <path className="loading-line" d="M233 152v-4" fill="none"/>
          <ellipse className="loading-line loading-shell" cx="233" cy="146" rx="4.5" ry="2.5"/>
          <path className="loading-soft-line" d="M219 169q-3 13 6 17"/>
          <path className="loading-soft-line" d="M224 159h17"/>
          <path className="loading-line loading-face" d="M198 187q-4-5-3-11 0-5 4-5 4 0 6 4l4 1q3 1 1 5-1 5-5 7Z"/>
          <path className="loading-soft-line" d="M204 176q0 4-4 4"/>
          </g>
        </g>

        <g className="loading-line" transform="translate(-110 0)">
          <path className="loading-shell" d="M218 269h110l-6 6h-97Z"/>
          <ellipse className="loading-face" cx="274" cy="265" rx="28" ry="4"/>
          <path className="loading-face" d="M288 241q16-4 14 6-2 10-14 7l1-6q8 2 8-3-1-3-8 0"/>
          <path className="loading-face" d="M258 239h32l-3 14q-2 8-13 8-11 0-13-8Z"/>
          <ellipse className="loading-face" cx="274" cy="239" rx="16" ry="3.3"/>
        </g>
        <path className="loading-tea-surface" d="M154 240q10 2 20 0"/>
        <path className="loading-soft-line" d="M156 248q1 7 7 8" opacity=".7"/>
        <path className="loading-steam loading-animated" d="M158 228c-8-7 5-10-1-17"/>
        <path className="loading-steam loading-steam-two loading-animated" d="M170 228c-8-6 5-10 0-16"/>

    </svg>}
  </span>;
}
