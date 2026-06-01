export type FileSummary = {
  id: number;
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  durationUs: number;
  rowCount: number;
  audioPacketCount: number;
  glitchCount: number;
  detectedFormat: string;
  cachePath: string;
  cacheHit: boolean;
};

export type TimelineData = {
  durationUs: number;
  glitches: GlitchMarker[];
};

export type GlitchMarker = {
  id: number;
  timeUs: number;
  expectedIntervalUs: number;
  actualIntervalUs: number;
  severity: number;
};

export type AudioPoint = {
  timeUs: number;
  leftMin: number;
  leftMax: number;
  rightMin: number;
  rightMax: number;
};

export type AudioWindow = {
  centerUs: number;
  startUs: number;
  endUs: number;
  zoom: number;
  points: AudioPoint[];
  packets: number;
  glitchIndex: number;
  glitchCount: number;
};

export type RowDetail = {
  timeUs: number;
  row: Record<string, string>;
  audio?: {
    endpoint: string;
    lenBytes: number;
    frameCount: number;
    firstFrame: number;
  };
};

export type GoToGlitchRequest = {
  fileId: number;
  direction?: "previous" | "next";
  index?: number;
  currentTimeUs: number;
};

export type OpenCsvResult =
  | { ok: true; summary: FileSummary; timeline: TimelineData }
  | { ok: false; error: string };

export type ViewerApi = {
  openCsv: () => Promise<OpenCsvResult>;
  loadWindow: (fileId: number, centerUs: number, zoom: number) => Promise<AudioWindow>;
  getTimeline: (fileId: number) => Promise<TimelineData>;
  getRowDetail: (fileId: number, timeUs: number) => Promise<RowDetail | null>;
  goToGlitch: (request: GoToGlitchRequest) => Promise<GlitchMarker | null>;
};
