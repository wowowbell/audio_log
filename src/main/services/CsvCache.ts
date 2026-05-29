import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  decode24BitSignedLe,
  mapCsvRow,
  parseHexBytes,
  parseLenBytes,
  parseTimeUs,
  splitCsvLine,
  TOTAL_PHASE_COLUMNS
} from "./csvFormat";
import type {
  AudioPoint,
  AudioWindow,
  FileSummary,
  GlitchMarker,
  GoToGlitchRequest,
  RowDetail,
  TimelineData
} from "../../shared/types";

type FileRecord = {
  id: number;
  path: string;
  name: string;
  size: number;
  mtime_ms: number;
  duration_us: number;
  row_count: number;
  audio_packet_count: number;
  glitch_count: number;
  detected_format: string;
};

type AudioPacketRow = {
  time_us: number;
  endpoint: string;
  len_bytes: number;
  data_hex: string;
  first_frame: number;
  frame_count: number;
};

type RowRecord = {
  time_us: number;
  row_json: string;
};

const DEFAULT_FORMAT = "48kHz / 24-bit signed LE / stereo";
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 3;
const WINDOW_US = 10_000_000;
const MIN_VISIBLE_US = 20;
const MAX_ZOOM = WINDOW_US / MIN_VISIBLE_US;
const PACKET_MARGIN_US = 250;

export class CsvCache {
  private db: Database.Database;

  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    this.db = new Database(path.join(userDataDir, "audio-log-cache.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  async openCsv(filePath: string): Promise<FileSummary> {
    const stat = fs.statSync(filePath);
    const existing = this.db.prepare(
      "SELECT * FROM files WHERE path = ? AND size = ? AND mtime_ms = ?"
    ).get(filePath, stat.size, stat.mtimeMs) as FileRecord | undefined;

    if (existing) return toSummary(existing, true);

    const deleteOld = this.db.transaction(() => {
      const oldRows = this.db.prepare("SELECT id FROM files WHERE path = ?").all(filePath) as { id: number }[];
      for (const row of oldRows) this.deleteFileData(row.id);
    });
    deleteOld();

    const insert = this.db.prepare(
      "INSERT INTO files (path, name, size, mtime_ms, duration_us, row_count, audio_packet_count, glitch_count, detected_format) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)"
    );
    const info = insert.run(filePath, path.basename(filePath), stat.size, stat.mtimeMs, DEFAULT_FORMAT);
    const fileId = Number(info.lastInsertRowid);

    await this.parseIntoCache(fileId, filePath);
    const record = this.db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as FileRecord;
    return toSummary(record, false);
  }

  getTimeline(fileId: number): TimelineData {
    const file = this.getFile(fileId);
    const glitches = this.db.prepare(
      "SELECT id, time_us, expected_interval_us, actual_interval_us, severity FROM glitches WHERE file_id = ? ORDER BY time_us"
    ).all(fileId) as Array<{
      id: number;
      time_us: number;
      expected_interval_us: number;
      actual_interval_us: number;
      severity: number;
    }>;

    return {
      durationUs: file.duration_us,
      glitches: glitches.map((row) => ({
        id: row.id,
        timeUs: row.time_us,
        expectedIntervalUs: row.expected_interval_us,
        actualIntervalUs: row.actual_interval_us,
        severity: row.severity
      }))
    };
  }

  loadWindow(fileId: number, centerUs: number, zoom: number): AudioWindow {
    const file = this.getFile(fileId);
    const clampedZoom = Math.max(1, Math.min(MAX_ZOOM, zoom || 1));
    const visibleUs = Math.max(MIN_VISIBLE_US, WINDOW_US / clampedZoom);
    const startUs = Math.max(0, Math.round(centerUs - visibleUs / 2));
    const endUs = Math.min(file.duration_us, Math.round(centerUs + visibleUs / 2));
    const bucketUs = Math.max(1, Math.ceil((endUs - startUs) / 2000));

    const packets = this.db.prepare(
      "SELECT time_us, endpoint, len_bytes, data_hex, first_frame, frame_count FROM audio_packets WHERE file_id = ? AND time_us BETWEEN ? AND ? ORDER BY time_us"
    ).all(fileId, Math.max(0, startUs - PACKET_MARGIN_US), endUs + PACKET_MARGIN_US) as AudioPacketRow[];

    const points = buildAudioPoints(packets, bucketUs);
    const glitchIndex = this.glitchIndexAt(fileId, centerUs);

    return {
      centerUs,
      startUs,
      endUs,
      zoom: clampedZoom,
      points,
      packets: packets.length,
      glitchIndex,
      glitchCount: file.glitch_count
    };
  }

  getRowDetail(fileId: number, timeUs: number): RowDetail | null {
    const before = this.db.prepare(
      "SELECT time_us, row_json FROM rows WHERE file_id = ? AND time_us <= ? ORDER BY time_us DESC LIMIT 1"
    ).get(fileId, timeUs) as RowRecord | undefined;
    const after = this.db.prepare(
      "SELECT time_us, row_json FROM rows WHERE file_id = ? AND time_us >= ? ORDER BY time_us ASC LIMIT 1"
    ).get(fileId, timeUs) as RowRecord | undefined;

    const chosen = chooseNearest(before, after, timeUs);
    if (!chosen) return null;

    const row = JSON.parse(chosen.row_json) as Record<string, string>;
    const audio = this.db.prepare(
      "SELECT endpoint, len_bytes, first_frame, frame_count FROM audio_packets WHERE file_id = ? AND time_us = ? LIMIT 1"
    ).get(fileId, chosen.time_us) as
      | { endpoint: string; len_bytes: number; first_frame: number; frame_count: number }
      | undefined;

    return {
      timeUs: chosen.time_us,
      row,
      audio: audio
        ? {
            endpoint: audio.endpoint,
            lenBytes: audio.len_bytes,
            frameCount: audio.frame_count,
            firstFrame: audio.first_frame
          }
        : undefined
    };
  }

  goToGlitch(request: GoToGlitchRequest): GlitchMarker | null {
    let row:
      | { id: number; time_us: number; expected_interval_us: number; actual_interval_us: number; severity: number }
      | undefined;

    if (typeof request.index === "number") {
      row = this.db.prepare(
        "SELECT id, time_us, expected_interval_us, actual_interval_us, severity FROM glitches WHERE file_id = ? ORDER BY time_us LIMIT 1 OFFSET ?"
      ).get(request.fileId, Math.max(0, request.index)) as typeof row;
    } else if (request.direction === "previous") {
      row = this.db.prepare(
        "SELECT id, time_us, expected_interval_us, actual_interval_us, severity FROM glitches WHERE file_id = ? AND time_us < ? ORDER BY time_us DESC LIMIT 1"
      ).get(request.fileId, request.currentTimeUs) as typeof row;
    } else {
      row = this.db.prepare(
        "SELECT id, time_us, expected_interval_us, actual_interval_us, severity FROM glitches WHERE file_id = ? AND time_us > ? ORDER BY time_us ASC LIMIT 1"
      ).get(request.fileId, request.currentTimeUs) as typeof row;
    }

    if (!row) return null;
    return {
      id: row.id,
      timeUs: row.time_us,
      expectedIntervalUs: row.expected_interval_us,
      actualIntervalUs: row.actual_interval_us,
      severity: row.severity
    };
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        duration_us INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        audio_packet_count INTEGER NOT NULL,
        glitch_count INTEGER NOT NULL,
        detected_format TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_lookup ON files(path, size, mtime_ms);

      CREATE TABLE IF NOT EXISTS rows (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        time_us INTEGER NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rows_time ON rows(file_id, time_us);

      CREATE TABLE IF NOT EXISTS audio_packets (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        time_us INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        len_bytes INTEGER NOT NULL,
        data_hex TEXT NOT NULL,
        first_frame INTEGER NOT NULL,
        frame_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audio_packets_time ON audio_packets(file_id, time_us);

      CREATE TABLE IF NOT EXISTS pcm_tiles (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        bucket_us INTEGER NOT NULL,
        time_us INTEGER NOT NULL,
        left_min REAL NOT NULL,
        left_max REAL NOT NULL,
        right_min REAL NOT NULL,
        right_max REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pcm_tiles_time ON pcm_tiles(file_id, bucket_us, time_us);

      CREATE TABLE IF NOT EXISTS glitches (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        time_us INTEGER NOT NULL,
        expected_interval_us INTEGER NOT NULL,
        actual_interval_us INTEGER NOT NULL,
        severity REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS glitches_time ON glitches(file_id, time_us);
    `);
  }

  private async parseIntoCache(fileId: number, filePath: string) {
    const insertRow = this.db.prepare("INSERT INTO rows (file_id, time_us, row_json) VALUES (?, ?, ?)");
    const insertAudio = this.db.prepare(
      "INSERT INTO audio_packets (file_id, time_us, endpoint, len_bytes, data_hex, first_frame, frame_count) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    const insertMany = this.db.transaction((rows: Array<{ timeUs: number; json: string }>, packets: AudioPacketRow[]) => {
      for (const row of rows) insertRow.run(fileId, row.timeUs, row.json);
      for (const packet of packets) {
        insertAudio.run(
          fileId,
          packet.time_us,
          packet.endpoint,
          packet.len_bytes,
          packet.data_hex,
          packet.first_frame,
          packet.frame_count
        );
      }
    });

    let columns = TOTAL_PHASE_COLUMNS;
    let sawHeader = false;
    let rowCount = 0;
    let audioCount = 0;
    let durationUs = 0;
    let frameCursor = 0;
    const batchRows: Array<{ timeUs: number; json: string }> = [];
    const batchPackets: AudioPacketRow[] = [];

    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!sawHeader) {
        if (line.startsWith("# Level,")) {
          columns = splitCsvLine(line.slice(2).trim());
          sawHeader = true;
        }
        continue;
      }

      if (!line || line.startsWith("#")) continue;
      const parsed = mapCsvRow(columns, line);
      const timeUs = parseTimeUs(parsed.values["m:s.ms.us"] ?? "");
      durationUs = Math.max(durationUs, timeUs);
      rowCount += 1;
      batchRows.push({ timeUs, json: JSON.stringify(parsed.values) });

      const record = parsed.values.Record ?? "";
      const data = parsed.values.Data ?? "";
      const bytes = parseHexBytes(data);
      if (record === "OUT txn" && bytes.length > 0) {
        const lenBytes = parseLenBytes(parsed.values.Len ?? "");
        const frameCount = Math.floor(bytes.length / (CHANNELS * BYTES_PER_SAMPLE));
        batchPackets.push({
          time_us: timeUs,
          endpoint: parsed.values.Ep ?? "",
          len_bytes: lenBytes || bytes.length,
          data_hex: data,
          first_frame: frameCursor,
          frame_count: frameCount
        });
        frameCursor += frameCount;
        audioCount += 1;
      }

      if (batchRows.length >= 5000) {
        insertMany(batchRows, batchPackets);
        batchRows.length = 0;
        batchPackets.length = 0;
      }
    }

    if (!sawHeader) throw new Error("This does not look like a Total Phase CSV export.");
    if (batchRows.length || batchPackets.length) insertMany(batchRows, batchPackets);

    this.rebuildGlitches(fileId);
    const glitchCount = (this.db.prepare("SELECT COUNT(*) AS count FROM glitches WHERE file_id = ?").get(fileId) as { count: number }).count;
    this.db.prepare(
      "UPDATE files SET duration_us = ?, row_count = ?, audio_packet_count = ?, glitch_count = ?, detected_format = ? WHERE id = ?"
    ).run(durationUs, rowCount, audioCount, glitchCount, DEFAULT_FORMAT, fileId);
  }

  private rebuildGlitches(fileId: number) {
    this.db.prepare("DELETE FROM glitches WHERE file_id = ?").run(fileId);
    const rows = this.db.prepare(
      "SELECT time_us FROM audio_packets WHERE file_id = ? ORDER BY time_us"
    ).all(fileId) as { time_us: number }[];
    if (rows.length < 3) return;

    const intervals: number[] = [];
    for (let i = 1; i < Math.min(rows.length, 20_000); i += 1) {
      const delta = rows[i].time_us - rows[i - 1].time_us;
      if (delta > 0 && delta < 10_000) intervals.push(delta);
    }
    const expected = median(intervals) || 125;
    const threshold = Math.max(expected * 1.8, expected + 50);
    const insert = this.db.prepare(
      "INSERT INTO glitches (file_id, time_us, expected_interval_us, actual_interval_us, severity) VALUES (?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction(() => {
      for (let i = 1; i < rows.length; i += 1) {
        const delta = rows[i].time_us - rows[i - 1].time_us;
        if (delta > threshold || delta <= 0) {
          const severity = delta <= 0 ? 999 : delta / expected;
          insert.run(fileId, rows[i].time_us, Math.round(expected), delta, severity);
        }
      }
    });
    tx();
  }

  private deleteFileData(fileId: number) {
    this.db.prepare("DELETE FROM rows WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM audio_packets WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM pcm_tiles WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM glitches WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  }

  private getFile(fileId: number): FileRecord {
    const file = this.db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as FileRecord | undefined;
    if (!file) throw new Error(`Unknown file id: ${fileId}`);
    return file;
  }

  private glitchIndexAt(fileId: number, timeUs: number) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM glitches WHERE file_id = ? AND time_us <= ?").get(fileId, timeUs) as {
      count: number;
    };
    return row.count;
  }
}

function buildAudioPoints(packets: AudioPacketRow[], bucketUs: number): AudioPoint[] {
  const buckets = new Map<number, AudioPoint>();

  for (const packet of packets) {
    const bytes = parseHexBytes(packet.data_hex);
    const frameCount = Math.floor(bytes.length / 6);
    if (frameCount === 0) continue;

    for (let frame = 0; frame < frameCount; frame += 1) {
      const offset = frame * 6;
      const t = packet.time_us + Math.round((frame / Math.max(1, frameCount)) * 125);
      const bucket = Math.floor(t / bucketUs) * bucketUs;
      const left = decode24BitSignedLe(bytes, offset);
      const right = decode24BitSignedLe(bytes, offset + 3);
      const point = buckets.get(bucket) ?? {
        timeUs: bucket,
        leftMin: 1,
        leftMax: -1,
        rightMin: 1,
        rightMax: -1
      };
      point.leftMin = Math.min(point.leftMin, left);
      point.leftMax = Math.max(point.leftMax, left);
      point.rightMin = Math.min(point.rightMin, right);
      point.rightMax = Math.max(point.rightMax, right);
      buckets.set(bucket, point);
    }
  }

  return [...buckets.values()].sort((a, b) => a.timeUs - b.timeUs);
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function chooseNearest(before: RowRecord | undefined, after: RowRecord | undefined, targetUs: number) {
  if (!before) return after;
  if (!after) return before;
  return targetUs - before.time_us <= after.time_us - targetUs ? before : after;
}

function toSummary(record: FileRecord, cacheHit: boolean): FileSummary {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    size: record.size,
    mtimeMs: record.mtime_ms,
    durationUs: record.duration_us,
    rowCount: record.row_count,
    audioPacketCount: record.audio_packet_count,
    glitchCount: record.glitch_count,
    detectedFormat: record.detected_format,
    cacheHit
  };
}
