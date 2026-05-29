export type ParsedCsvRow = {
  values: Record<string, string>;
  raw: string;
};

export const TOTAL_PHASE_COLUMNS = [
  "Level",
  "Sp",
  "Index",
  "m:s.ms.us",
  "Dur",
  "Len",
  "Err",
  "Dev",
  "Ep",
  "Record",
  "Data",
  "Summary",
  "ASCII"
];

export function parseTimeUs(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2})\.(\d{3})\.(\d{3})$/);
  if (!match) return 0;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const millis = Number(match[3]);
  const micros = Number(match[4]);
  return ((minutes * 60 + seconds) * 1_000_000) + millis * 1000 + micros;
}

export function parseLenBytes(value: string): number {
  const match = value.trim().match(/^(\d+)\s+B$/i);
  return match ? Number(match[1]) : 0;
}

export function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

export function mapCsvRow(columns: string[], line: string): ParsedCsvRow {
  const parts = splitCsvLine(line);
  const values: Record<string, string> = {};
  columns.forEach((column, index) => {
    values[column] = parts[index] ?? "";
  });
  return { values, raw: line };
}

export function parseHexBytes(value: string): number[] {
  if (!value.trim()) return [];
  const bytes: number[] = [];
  for (const token of value.trim().split(/\s+/)) {
    const byte = Number.parseInt(token, 16);
    if (Number.isFinite(byte)) bytes.push(byte & 0xff);
  }
  return bytes;
}

export function decode24BitSignedLe(bytes: number[], offset: number): number {
  const raw = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
  return signed / 0x800000;
}
