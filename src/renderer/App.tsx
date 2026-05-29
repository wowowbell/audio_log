import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AudioPoint, AudioWindow, FileSummary, GlitchMarker, RowDetail, TimelineData } from "../shared/types";
import "./styles.css";

const INITIAL_CENTER_US = 5_000_000;
const WINDOW_US = 10_000_000;

function App() {
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [audioWindow, setAudioWindow] = useState<AudioWindow | null>(null);
  const [detail, setDetail] = useState<RowDetail | null>(null);
  const [centerUs, setCenterUs] = useState(INITIAL_CENTER_US);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Open a Total Phase CSV to begin.");

  const loadWindow = useCallback(
    async (nextCenterUs: number, nextZoom = zoom) => {
      if (!summary) return;
      const clampedCenter = Math.max(0, Math.min(summary.durationUs, nextCenterUs));
      const data = await window.audioLog.loadWindow(summary.id, clampedCenter, nextZoom);
      const rowDetail = await window.audioLog.getRowDetail(summary.id, clampedCenter);
      setCenterUs(clampedCenter);
      setZoom(data.zoom);
      setAudioWindow(data);
      setDetail(rowDetail);
    },
    [summary, zoom]
  );

  const openCsv = async () => {
    setLoading(true);
    setMessage("Parsing CSV and building cache...");
    const result = await window.audioLog.openCsv();
    if (!result.ok) {
      setLoading(false);
      setMessage(result.error);
      return;
    }

    setSummary(result.summary);
    setTimeline(result.timeline);
    const nextCenter = Math.min(INITIAL_CENTER_US, result.summary.durationUs);
    setCenterUs(nextCenter);
    setZoom(1);
    const data = await window.audioLog.loadWindow(result.summary.id, nextCenter, 1);
    const rowDetail = await window.audioLog.getRowDetail(result.summary.id, nextCenter);
    setAudioWindow(data);
    setDetail(rowDetail);
    setMessage(result.summary.cacheHit ? "Loaded from cache." : "Cache built.");
    setLoading(false);
  };

  const goGlitch = async (direction: "previous" | "next") => {
    if (!summary) return;
    const glitch = await window.audioLog.goToGlitch({
      fileId: summary.id,
      direction,
      currentTimeUs: centerUs
    });
    if (glitch) await loadWindow(glitch.timeUs, zoom);
  };

  const selectedGlitchText = useMemo(() => {
    if (!audioWindow || audioWindow.glitchCount === 0) return "0 / 0";
    const current = Math.max(1, Math.min(audioWindow.glitchIndex, audioWindow.glitchCount));
    return `${current} / ${audioWindow.glitchCount}`;
  }, [audioWindow]);

  return (
    <main className="shell">
      <header className="topbar">
        <button className="primary" type="button" onClick={openCsv} disabled={loading}>
          Open CSV
        </button>
        <div className="status">{loading ? "Working..." : message}</div>
      </header>

      <SummaryPanel summary={summary} />

      <section className="audio-section" aria-label="Audio data">
        <div className="section-head">
          <div>
            <h2>Audio Data</h2>
            <span>{audioWindow ? `${formatTime(audioWindow.startUs)} to ${formatTime(audioWindow.endUs)}` : "No file loaded"}</span>
          </div>
          <div className="glitch-nav">
            <button type="button" onClick={() => goGlitch("previous")} disabled={!summary || !audioWindow?.glitchCount} title="Previous glitch">
              Prev
            </button>
            <span>{selectedGlitchText}</span>
            <button type="button" onClick={() => goGlitch("next")} disabled={!summary || !audioWindow?.glitchCount} title="Next glitch">
              Next
            </button>
          </div>
        </div>
        <WaveformCanvas
          audioWindow={audioWindow}
          onZoom={(nextZoom, anchorUs) => {
            if (!summary) return;
            void loadWindow(anchorUs, nextZoom);
          }}
          onPick={(timeUs) => {
            if (!summary) return;
            void loadWindow(timeUs, zoom);
          }}
        />
      </section>

      <Timeline
        timeline={timeline}
        centerUs={centerUs}
        onPick={(timeUs) => {
          if (summary) void loadWindow(timeUs, zoom);
        }}
      />

      <DetailPanel detail={detail} />
    </main>
  );
}

function SummaryPanel({ summary }: { summary: FileSummary | null }) {
  const items = summary
    ? [
        ["File", summary.name],
        ["Size", formatBytes(summary.size)],
        ["Duration", formatTime(summary.durationUs)],
        ["Rows", summary.rowCount.toLocaleString()],
        ["Audio packets", summary.audioPacketCount.toLocaleString()],
        ["PCM", summary.detectedFormat],
        ["Glitches", summary.glitchCount.toLocaleString()],
        ["Cache", summary.cacheHit ? "Hit" : "Built"]
      ]
    : [
        ["File", "-"],
        ["Size", "-"],
        ["Duration", "-"],
        ["Rows", "-"],
        ["Audio packets", "-"],
        ["PCM", "-"],
        ["Glitches", "-"],
        ["Cache", "-"]
      ];

  return (
    <section className="summary-grid" aria-label="CSV summary">
      {items.map(([label, value]) => (
        <div className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function WaveformCanvas({
  audioWindow,
  onZoom,
  onPick
}: {
  audioWindow: AudioWindow | null;
  onZoom: (zoom: number, anchorUs: number) => void;
  onPick: (timeUs: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const audioWindowRef = useRef<AudioWindow | null>(audioWindow);
  const onZoomRef = useRef(onZoom);

  useEffect(() => {
    audioWindowRef.current = audioWindow;
    onZoomRef.current = onZoom;
  }, [audioWindow, onZoom]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.scale(dpr, dpr);
    drawWaveform(ctx, rect.width, rect.height, audioWindow);
  }, [audioWindow]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const currentWindow = audioWindowRef.current;
      if (!currentWindow) return;
      const anchorUs = timeFromPoint(canvas, event.clientX, currentWindow);
      const factor = event.deltaY < 0 ? 1.35 : 1 / 1.35;
      const nextZoom = Math.max(1, Math.min(64, currentWindow.zoom * factor));
      onZoomRef.current(nextZoom, anchorUs);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  const timeFromEvent = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!audioWindow) return 0;
    return timeFromPoint(event.currentTarget, event.clientX, audioWindow);
  };

  return <canvas ref={ref} className="waveform" onClick={(event) => onPick(timeFromEvent(event))} />;
}

function timeFromPoint(canvas: HTMLCanvasElement, clientX: number, audioWindow: AudioWindow) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return audioWindow.startUs + ratio * (audioWindow.endUs - audioWindow.startUs);
}

function Timeline({
  timeline,
  centerUs,
  onPick
}: {
  timeline: TimelineData | null;
  centerUs: number;
  onPick: (timeUs: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.scale(dpr, dpr);
    drawTimeline(ctx, rect.width, rect.height, timeline, centerUs);
  }, [timeline, centerUs]);

  return (
    <section className="timeline-section" aria-label="Timeline">
      <div className="section-head">
        <div>
          <h2>Timeline</h2>
          <span>{timeline ? `0 to ${formatTime(timeline.durationUs)}` : "No file loaded"}</span>
        </div>
        <strong>{formatTime(centerUs)}</strong>
      </div>
      <canvas
        ref={ref}
        className="timeline"
        onClick={(event) => {
          if (!timeline) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          onPick(ratio * timeline.durationUs);
        }}
      />
    </section>
  );
}

function DetailPanel({ detail }: { detail: RowDetail | null }) {
  const entries = detail ? Object.entries(detail.row) : [];
  return (
    <section className="detail-section" aria-label="CSV row detail">
      <div className="section-head">
        <div>
          <h2>Detail</h2>
          <span>{detail ? `Nearest row at ${formatTime(detail.timeUs)}` : "No row selected"}</span>
        </div>
        {detail?.audio && (
          <strong>
            EP {detail.audio.endpoint} · {detail.audio.lenBytes} B · {detail.audio.frameCount} frames
          </strong>
        )}
      </div>
      <div className="detail-grid">
        {entries.length === 0 ? (
          <div className="empty">Open a CSV and click the timeline or waveform.</div>
        ) : (
          entries.map(([key, value]) => (
            <div className="field" key={key}>
              <span>{key}</span>
              <code>{value || "-"}</code>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function drawWaveform(ctx: CanvasRenderingContext2D, width: number, height: number, audioWindow: AudioWindow | null) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#15191d";
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height);

  if (!audioWindow || audioWindow.points.length === 0) {
    ctx.fillStyle = "#7d8791";
    ctx.font = "14px system-ui";
    ctx.fillText("No audio data in this time window", 24, height / 2);
    return;
  }

  drawChannel(ctx, width, height, audioWindow.points, audioWindow.startUs, audioWindow.endUs, "left", "#60a5fa", height * 0.28);
  drawChannel(ctx, width, height, audioWindow.points, audioWindow.startUs, audioWindow.endUs, "right", "#34d399", height * 0.72);
}

function drawChannel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: AudioPoint[],
  startUs: number,
  endUs: number,
  channel: "left" | "right",
  color: string,
  baseline: number
) {
  const amp = height * 0.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const point of points) {
    const x = ((point.timeUs - startUs) / Math.max(1, endUs - startUs)) * width;
    const min = channel === "left" ? point.leftMin : point.rightMin;
    const max = channel === "left" ? point.leftMax : point.rightMax;
    ctx.moveTo(x, baseline - max * amp);
    ctx.lineTo(x, baseline - min * amp);
  }
  ctx.stroke();
  ctx.fillStyle = "#aab4be";
  ctx.font = "12px system-ui";
  ctx.fillText(channel === "left" ? "L" : "R", 12, baseline - amp - 8);
}

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeline: TimelineData | null,
  centerUs: number
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#15191d";
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height);
  if (!timeline || timeline.durationUs <= 0) return;

  ctx.strokeStyle = "#64707d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 1;
  for (const glitch of timeline.glitches) {
    const x = (glitch.timeUs / timeline.durationUs) * width;
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, height - 12);
    ctx.stroke();
  }

  const start = Math.max(0, centerUs - WINDOW_US / 2);
  const end = Math.min(timeline.durationUs, centerUs + WINDOW_US / 2);
  const x = (start / timeline.durationUs) * width;
  const w = Math.max(8, ((end - start) / timeline.durationUs) * width);
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, 10, w, height - 20);
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.strokeStyle = "#232a31";
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i += 1) {
    const x = (width / 10) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function formatTime(us: number) {
  const totalSeconds = us / 1_000_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

createRoot(document.getElementById("root")!).render(<App />);
