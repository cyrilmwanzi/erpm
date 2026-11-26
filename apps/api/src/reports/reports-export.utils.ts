import { ReportDomain, ReportFormat, ReportFrequency } from "@scace/db";

export interface ReportTableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  widthChars?: number;
}

export interface GeneratedReportResult {
  organizationId: string;
  organizationName: string;
  domain: ReportDomain;
  title: string;
  generatedAt: string;
  filters: Record<string, unknown>;
  summaryKpis: Record<string, number | string>;
  columns: ReportTableColumn[];
  rows: Array<Record<string, unknown>>;
}

function normalizeRawCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Neutralizes spreadsheet formula injection (CSV/Excel/Calc/Sheets DDE & formulas)
 * by prefixing an apostrophe when a string cell begins with =, +, -, @, \t, or \r,
 * and RFC 4180 quoting any cell containing commas, quotes, or newlines.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  let text = normalizeRawCell(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function renderReportCsv(report: GeneratedReportResult): string {
  const headerLine = report.columns
    .map((col) => sanitizeCsvCell(col.label))
    .join(",");

  const rowLines = report.rows.map((row) =>
    report.columns.map((col) => sanitizeCsvCell(row[col.key])).join(","),
  );

  return [headerLine, ...rowLines].join("\r\n");
}

function sanitizePdfText(input: string): string {
  return input
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncatePdfText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  if (maxChars <= 3) return input.slice(0, maxChars);
  return `${input.slice(0, maxChars - 3)}...`;
}

class MultiPagePdfBuilder {
  private pages: string[][] = [[]];
  private currentPageIdx = 0;
  private y = 780;
  private readonly minY = 56;

  private currentOps(): string[] {
    return this.pages[this.currentPageIdx]!;
  }

  newPage(): void {
    this.pages.push([]);
    this.currentPageIdx = this.pages.length - 1;
    this.y = 780;
  }

  ensureSpace(requiredHeight: number): boolean {
    if (this.y - requiredHeight < this.minY) {
      this.newPage();
      return true;
    }
    return false;
  }

  cursorY(): number {
    return this.y;
  }

  advance(dy: number): void {
    this.y -= dy;
  }

  text(
    x: number,
    y: number,
    value: string,
    opts?: { size?: number; bold?: boolean },
  ): void {
    const font = opts?.bold ? "/F2" : "/F1";
    const size = opts?.size ?? 9;
    this.currentOps().push(
      `BT ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${sanitizePdfText(value)}) Tj ET`,
    );
  }

  rightText(
    rightX: number,
    y: number,
    value: string,
    opts?: { size?: number; bold?: boolean },
  ): void {
    const size = opts?.size ?? 9;
    const approxWidth = value.length * size * 0.52;
    this.text(Math.max(36, rightX - approxWidth), y, value, opts);
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width = 0.6,
  ): void {
    this.currentOps().push(
      `q ${width} w 0.80 0.82 0.85 RG ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`,
    );
  }

  divider(gapBefore = 4, gapAfter = 10, width = 0.75): void {
    this.y -= gapBefore;
    this.line(40, this.y, 555, this.y, width);
    this.y -= gapAfter;
  }

  toBuffer(): Buffer {
    const totalPages = this.pages.length;
    for (let i = 0; i < totalPages; i += 1) {
      this.pages[i]!.push(
        `BT /F1 8 Tf 1 0 0 1 40.00 28.00 Tm (${sanitizePdfText(`Scace ERP Reporting Engine`)}) Tj ET`,
        `BT /F1 8 Tf 1 0 0 1 495.00 28.00 Tm (${sanitizePdfText(`Page ${i + 1} of ${totalPages}`)}) Tj ET`,
      );
    }

    // Object numbering:
    // 1: Catalog
    // 2: Pages
    // 3: Font F1 (Helvetica)
    // 4: Font F2 (Helvetica-Bold)
    // Page i (0-based): pageObjId = 5 + i * 2, contentObjId = 6 + i * 2
    const pageObjectIds: number[] = [];
    const dynamicObjects: string[] = [];

    for (let i = 0; i < totalPages; i += 1) {
      const pageObjId = 5 + i * 2;
      const contentObjId = 6 + i * 2;
      pageObjectIds.push(pageObjId);

      const stream = this.pages[i]!.join("\n");
      const streamBytes = Buffer.byteLength(stream, "latin1");

      dynamicObjects.push(
        `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
        `${contentObjId} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream\nendobj\n`,
      );
    }

    const objects: string[] = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${totalPages} >>\nendobj\n`,
      "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
      ...dynamicObjects,
    ];

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [0];
    for (const obj of objects) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += obj;
    }

    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += "0000000000 65535 f \n";
    for (let i = 1; i < offsets.length; i += 1) {
      const off = String(offsets[i]).padStart(10, "0");
      pdf += `${off} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
  }
}

export function renderReportPdf(report: GeneratedReportResult): Buffer {
  const pdf = new MultiPagePdfBuilder();

  pdf.text(40, pdf.cursorY(), truncatePdfText(report.title, 70), {
    size: 16,
    bold: true,
  });
  pdf.advance(18);
  pdf.text(
    40,
    pdf.cursorY(),
    `Organization: ${truncatePdfText(report.organizationName, 45)} | Domain: ${report.domain}`,
    { size: 9 },
  );
  pdf.rightText(555, pdf.cursorY(), `Generated: ${report.generatedAt.slice(0, 19).replace("T", " ")}Z`, {
    size: 8.5,
  });
  pdf.advance(8);
  pdf.divider(4, 12, 1.1);

  // KPI Section (2 columns)
  pdf.text(40, pdf.cursorY(), "KEY METRICS", { size: 8.5, bold: true });
  pdf.advance(14);
  const kpiEntries = Object.entries(report.summaryKpis);
  for (let i = 0; i < kpiEntries.length; i += 2) {
    pdf.ensureSpace(16);
    const [k1, v1] = kpiEntries[i]!;
    pdf.text(40, pdf.cursorY(), truncatePdfText(`${k1}: ${String(v1)}`, 46), {
      size: 9,
    });
    if (kpiEntries[i + 1]) {
      const [k2, v2] = kpiEntries[i + 1]!;
      pdf.text(305, pdf.cursorY(), truncatePdfText(`${k2}: ${String(v2)}`, 46), {
        size: 9,
      });
    }
    pdf.advance(13);
  }

  pdf.divider(4, 12, 0.75);

  const visibleCols = report.columns.slice(0, 6);
  const totalWidth = 515;
  const colWeights = visibleCols.map((c) => c.widthChars ?? 16);
  const sumWeight = colWeights.reduce((a, b) => a + b, 0) || 1;
  const colPositions: Array<{
    col: ReportTableColumn;
    x: number;
    widthPx: number;
    maxChars: number;
  }> = [];

  let cursorX = 40;
  for (let i = 0; i < visibleCols.length; i += 1) {
    const col = visibleCols[i]!;
    const widthPx = (colWeights[i]! / sumWeight) * totalWidth;
    const maxChars = Math.max(8, Math.floor(widthPx / 5.1));
    colPositions.push({ col, x: cursorX, widthPx, maxChars });
    cursorX += widthPx;
  }

  const drawTableHeader = () => {
    pdf.ensureSpace(22);
    const y = pdf.cursorY();
    for (const pos of colPositions) {
      const label = truncatePdfText(pos.col.label.toUpperCase(), pos.maxChars);
      if (pos.col.align === "right") {
        pdf.rightText(pos.x + pos.widthPx - 4, y, label, {
          size: 7.5,
          bold: true,
        });
      } else {
        pdf.text(pos.x, y, label, { size: 7.5, bold: true });
      }
    }
    pdf.advance(5);
    pdf.divider(0, 10, 0.5);
  };

  drawTableHeader();

  if (report.rows.length === 0) {
    pdf.text(40, pdf.cursorY(), "No records matched the selected report filters.", {
      size: 9,
    });
    pdf.advance(14);
  } else {
    for (const row of report.rows) {
      const flipped = pdf.ensureSpace(16);
      if (flipped) {
        drawTableHeader();
      }
      const y = pdf.cursorY();
      for (const pos of colPositions) {
        const rawText = normalizeRawCell(row[pos.col.key]);
        const cellText = truncatePdfText(rawText, pos.maxChars);
        if (pos.col.align === "right") {
          pdf.rightText(pos.x + pos.widthPx - 4, y, cellText, { size: 8 });
        } else {
          pdf.text(pos.x, y, cellText, { size: 8 });
        }
      }
      pdf.advance(14);
    }
  }

  return pdf.toBuffer();
}

export function sanitizeReportFilename(
  domain: ReportDomain,
  format: ReportFormat,
  date = new Date(),
): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const day = date.toISOString().slice(0, 10);
  const ext =
    format === ReportFormat.CSV
      ? "csv"
      : format === ReportFormat.PDF
        ? "pdf"
        : "json";
  return `scace-report-${slug}-${day}.${ext}`;
}

export function computeNextRunAt(
  frequency: ReportFrequency,
  cronHourUtc = 6,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
  fromDate = new Date(),
): Date {
  const hour = Math.min(Math.max(Math.floor(cronHourUtc), 0), 23);

  if (frequency === ReportFrequency.DAILY) {
    const next = new Date(
      Date.UTC(
        fromDate.getUTCFullYear(),
        fromDate.getUTCMonth(),
        fromDate.getUTCDate(),
        hour,
        0,
        0,
        0,
      ),
    );
    if (next.getTime() <= fromDate.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  if (frequency === ReportFrequency.WEEKLY) {
    const targetDow =
      dayOfWeek !== undefined && dayOfWeek !== null
        ? Math.min(Math.max(Math.floor(dayOfWeek), 0), 6)
        : 1;
    const next = new Date(
      Date.UTC(
        fromDate.getUTCFullYear(),
        fromDate.getUTCMonth(),
        fromDate.getUTCDate(),
        hour,
        0,
        0,
        0,
      ),
    );
    const currentDow = next.getUTCDay();
    let deltaDays = (targetDow - currentDow + 7) % 7;
    next.setUTCDate(next.getUTCDate() + deltaDays);
    if (next.getTime() <= fromDate.getTime()) {
      next.setUTCDate(next.getUTCDate() + 7);
    }
    return next;
  }

  // MONTHLY
  const targetDom =
    dayOfMonth !== undefined && dayOfMonth !== null
      ? Math.min(Math.max(Math.floor(dayOfMonth), 1), 28)
      : 1;
  const next = new Date(
    Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      targetDom,
      hour,
      0,
      0,
      0,
    ),
  );
  if (next.getTime() <= fromDate.getTime()) {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
}
