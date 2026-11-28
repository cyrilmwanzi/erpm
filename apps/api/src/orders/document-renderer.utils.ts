export interface PrintableLineItem {
  sku?: string | null;
  description: string;
  unitOfMeasure?: string | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  lineTotalCents: number;
}

export interface PrintableParty {
  name: string;
  companyName?: string | null;
  code?: string | null;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  addressLines?: string[];
}

export interface PrintableInvoiceDocument {
  invoiceNumber: string;
  orderNumber?: string | null;
  customerPoNumber?: string | null;
  paymentTermsDays?: number | null;
  status: string;
  currency: string;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  subtotalCents: number;
  discountTotalCents: number;
  taxCents: number;
  totalCents: number;
  paidAmountCents: number;
  balanceDueCents: number;
  notes?: string | null;
  organization: PrintableParty;
  customer: PrintableParty | null;
  lines: PrintableLineItem[];
}

export interface PrintableReceiptDocument {
  receiptNumber: string;
  paymentNumber: string;
  orderNumber: string;
  invoiceNumber?: string | null;
  channel: string;
  paymentMethod: string;
  reference?: string | null;
  mpesaReceiptNumber?: string | null;
  phoneNumber?: string | null;
  currency: string;
  issuedAt: string;
  locationName?: string | null;
  locationCode?: string | null;
  subtotalCents: number;
  discountTotalCents: number;
  taxCents: number;
  totalCents: number;
  amountAppliedCents: number;
  cashTenderedCents: number;
  changeGivenCents: number;
  notes?: string | null;
  organization: PrintableParty;
  customer: PrintableParty | null;
  lines: PrintableLineItem[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatMoney(cents: number, currency: string): string {
  const code = (currency || "USD").toUpperCase();
  const amount = (cents / 100).toFixed(2);
  return `${code} ${amount}`;
}

function formatDateLabel(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatDateTimeLabel(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function renderInvoiceHtml(doc: PrintableInvoiceDocument): string {
  const orgLines = [
    doc.organization.companyName || doc.organization.name,
    ...(doc.organization.addressLines ?? []),
    doc.organization.email ? `Email: ${doc.organization.email}` : null,
    doc.organization.phone ? `Phone: ${doc.organization.phone}` : null,
    doc.organization.taxId ? `Tax ID: ${doc.organization.taxId}` : null,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));

  const customerLines = doc.customer
    ? [
        doc.customer.companyName
          ? `${doc.customer.companyName} (${doc.customer.name})`
          : doc.customer.name,
        doc.customer.code ? `Customer Code: ${doc.customer.code}` : null,
        ...(doc.customer.addressLines ?? []),
        doc.customer.email ? `Email: ${doc.customer.email}` : null,
        doc.customer.phone ? `Phone: ${doc.customer.phone}` : null,
        doc.customer.taxId ? `Tax ID: ${doc.customer.taxId}` : null,
      ].filter((v): v is string => Boolean(v && v.trim().length > 0))
    : ["Walk-in / Retail Customer"];

  const rowsHtml = doc.lines
    .map(
      (line) => `
        <tr>
          <td>
            <div class="item-title">${escapeHtml(line.description)}</div>
            ${line.sku ? `<div class="item-sku">SKU: ${escapeHtml(line.sku)}</div>` : ""}
          </td>
          <td class="num">${line.quantity}${line.unitOfMeasure ? ` ${escapeHtml(line.unitOfMeasure)}` : ""}</td>
          <td class="num">${escapeHtml(formatMoney(line.unitPriceCents, doc.currency))}</td>
          <td class="num">${escapeHtml(formatMoney(line.discountCents, doc.currency))}</td>
          <td class="num">${escapeHtml(formatMoney(line.lineTotalCents, doc.currency))}</td>
        </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(doc.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; margin: 0; padding: 32px; background: #f9fafb; }
    .sheet { max-width: 820px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 36px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111827; padding-bottom: 20px; margin-bottom: 24px; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 12px; font-weight: 700; border-radius: 4px; background: #f3f4f6; color: #111827; border: 1px solid #d1d5db; }
    .meta { text-align: right; font-size: 13px; line-height: 1.6; color: #374151; }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
    .party-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 6px; }
    .party-lines { font-size: 13px; line-height: 1.55; color: #1f2937; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 10px 8px; }
    td { padding: 12px 8px; border-bottom: 1px solid #f3f4f6; font-size: 13px; vertical-align: top; }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .item-title { font-weight: 600; color: #111827; }
    .item-sku { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .totals { width: 320px; margin-left: auto; font-size: 13px; }
    .total-row { display: flex; justify-content: space-between; padding: 6px 0; color: #374151; }
    .total-row.grand { border-top: 2px solid #111827; border-bottom: 1px solid #e5e7eb; padding: 10px 0; margin-top: 6px; font-size: 15px; font-weight: 700; color: #111827; }
    .total-row.due { font-weight: 700; color: #111827; padding-top: 8px; }
    .notes { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #4b5563; line-height: 1.5; }
    @media print { body { background: #ffffff; padding: 0; } .sheet { border: none; border-radius: 0; padding: 16px; max-width: none; } }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div>
        <h1>INVOICE</h1>
        <span class="badge">${escapeHtml(doc.status)}</span>
      </div>
      <div class="meta">
        <div><strong>Invoice #:</strong> ${escapeHtml(doc.invoiceNumber)}</div>
        ${doc.orderNumber ? `<div><strong>Order #:</strong> ${escapeHtml(doc.orderNumber)}</div>` : ""}
        ${doc.customerPoNumber ? `<div><strong>Customer PO #:</strong> ${escapeHtml(doc.customerPoNumber)}</div>` : ""}
        ${doc.paymentTermsDays !== undefined && doc.paymentTermsDays !== null && doc.paymentTermsDays > 0 ? `<div><strong>Terms:</strong> Net ${doc.paymentTermsDays} Days</div>` : ""}
        <div><strong>Issued:</strong> ${escapeHtml(formatDateLabel(doc.issuedAt))}</div>
        <div><strong>Due:</strong> ${escapeHtml(formatDateLabel(doc.dueAt))}</div>
        ${doc.paidAt ? `<div><strong>Paid:</strong> ${escapeHtml(formatDateLabel(doc.paidAt))}</div>` : ""}
      </div>
    </div>

    <div class="parties">
      <div>
        <div class="party-label">From</div>
        <div class="party-lines">${orgLines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>
      </div>
      <div>
        <div class="party-label">Bill To</div>
        <div class="party-lines">${customerLines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Item / Description</th>
          <th class="num">Qty</th>
          <th class="num">Unit Price</th>
          <th class="num">Discount</th>
          <th class="num">Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <div class="totals">
      <div class="total-row"><span>Subtotal</span><span>${escapeHtml(formatMoney(doc.subtotalCents, doc.currency))}</span></div>
      <div class="total-row"><span>Discounts</span><span>-${escapeHtml(formatMoney(doc.discountTotalCents, doc.currency))}</span></div>
      <div class="total-row"><span>Tax</span><span>${escapeHtml(formatMoney(doc.taxCents, doc.currency))}</span></div>
      <div class="total-row grand"><span>Total</span><span>${escapeHtml(formatMoney(doc.totalCents, doc.currency))}</span></div>
      <div class="total-row"><span>Cash Paid</span><span>${escapeHtml(formatMoney(doc.paidAmountCents, doc.currency))}</span></div>
      <div class="total-row due"><span>Balance Due</span><span>${escapeHtml(formatMoney(doc.balanceDueCents, doc.currency))}</span></div>
    </div>

    ${doc.notes ? `<div class="notes"><strong>Notes:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  </div>
</body>
</html>`;
}

export function renderReceiptHtml(doc: PrintableReceiptDocument): string {
  const customerName = doc.customer
    ? doc.customer.companyName
      ? `${doc.customer.companyName} (${doc.customer.name})`
      : doc.customer.name
    : "Walk-in Customer";

  const rowsHtml = doc.lines
    .map(
      (line) => `
        <tr>
          <td>
            <div class="item-title">${escapeHtml(line.description)}</div>
            <div class="item-sub">${line.quantity} x ${escapeHtml(formatMoney(line.unitPriceCents, doc.currency))}${line.sku ? ` · ${escapeHtml(line.sku)}` : ""}</div>
          </td>
          <td class="num">${escapeHtml(formatMoney(line.lineTotalCents, doc.currency))}</td>
        </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt ${escapeHtml(doc.receiptNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #111827; margin: 0; padding: 24px; background: #f3f4f6; }
    .ticket { max-width: 420px; margin: 0 auto; background: #ffffff; border: 1px dashed #9ca3af; padding: 24px; }
    .center { text-align: center; }
    .org { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
    .sub { font-size: 12px; color: #4b5563; line-height: 1.45; }
    .divider { border-top: 1px dashed #9ca3af; margin: 14px 0; }
    .meta { font-size: 12px; line-height: 1.55; }
    .meta-row { display: flex; justify-content: space-between; gap: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 6px 0; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .item-title { font-weight: 600; }
    .item-sub { font-size: 11px; color: #6b7280; }
    .summary { font-size: 12px; line-height: 1.6; }
    .summary-row { display: flex; justify-content: space-between; }
    .summary-row.bold { font-weight: 700; font-size: 14px; margin-top: 4px; }
    .footer { text-align: center; font-size: 11px; color: #6b7280; margin-top: 16px; }
    @media print { body { background: #ffffff; padding: 0; } .ticket { border: none; max-width: 80mm; padding: 8px; } }
  </style>
</head>
<body>
  <div class="ticket">
    <div class="center">
      <div class="org">${escapeHtml(doc.organization.companyName || doc.organization.name)}</div>
      ${doc.locationName ? `<div class="sub">${escapeHtml(doc.locationName)}${doc.locationCode ? ` (${escapeHtml(doc.locationCode)})` : ""}</div>` : ""}
      ${doc.organization.phone ? `<div class="sub">Tel: ${escapeHtml(doc.organization.phone)}</div>` : ""}
      ${doc.organization.taxId ? `<div class="sub">Tax ID: ${escapeHtml(doc.organization.taxId)}</div>` : ""}
    </div>

    <div class="divider"></div>

    <div class="meta">
      <div class="meta-row"><span>Receipt #:</span><strong>${escapeHtml(doc.receiptNumber)}</strong></div>
      <div class="meta-row"><span>Payment #:</span><span>${escapeHtml(doc.paymentNumber)}</span></div>
      <div class="meta-row"><span>Order #:</span><span>${escapeHtml(doc.orderNumber)}</span></div>
      ${doc.invoiceNumber ? `<div class="meta-row"><span>Invoice #:</span><span>${escapeHtml(doc.invoiceNumber)}</span></div>` : ""}
      <div class="meta-row"><span>Channel:</span><span>${escapeHtml(doc.channel)}</span></div>
      <div class="meta-row"><span>Customer:</span><span>${escapeHtml(customerName)}</span></div>
      <div class="meta-row"><span>Issued:</span><span>${escapeHtml(formatDateTimeLabel(doc.issuedAt))}</span></div>
    </div>

    <div class="divider"></div>

    <table>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <div class="divider"></div>

    <div class="summary">
      <div class="summary-row"><span>Order Subtotal</span><span>${escapeHtml(formatMoney(doc.subtotalCents, doc.currency))}</span></div>
      <div class="summary-row"><span>Discounts</span><span>-${escapeHtml(formatMoney(doc.discountTotalCents, doc.currency))}</span></div>
      <div class="summary-row"><span>Tax</span><span>${escapeHtml(formatMoney(doc.taxCents, doc.currency))}</span></div>
      <div class="summary-row bold"><span>Order Total</span><span>${escapeHtml(formatMoney(doc.totalCents, doc.currency))}</span></div>
      <div class="divider"></div>
      <div class="summary-row"><span>Payment Method</span><span>${escapeHtml(doc.paymentMethod)}</span></div>
      ${doc.mpesaReceiptNumber ? `<div class="summary-row"><span>M-Pesa Receipt #</span><strong>${escapeHtml(doc.mpesaReceiptNumber)}</strong></div>` : doc.reference ? `<div class="summary-row"><span>Reference</span><span>${escapeHtml(doc.reference)}</span></div>` : ""}
      ${doc.phoneNumber ? `<div class="summary-row"><span>Phone</span><span>${escapeHtml(doc.phoneNumber)}</span></div>` : ""}
      <div class="summary-row"><span>Amount Applied</span><span>${escapeHtml(formatMoney(doc.amountAppliedCents, doc.currency))}</span></div>
      <div class="summary-row"><span>Cash Tendered</span><span>${escapeHtml(formatMoney(doc.cashTenderedCents, doc.currency))}</span></div>
      <div class="summary-row bold"><span>Change Given</span><span>${escapeHtml(formatMoney(doc.changeGivenCents, doc.currency))}</span></div>
    </div>

    ${doc.notes ? `<div class="divider"></div><div class="sub">${escapeHtml(doc.notes)}</div>` : ""}
    <div class="footer">Thank you for your business</div>
  </div>
</body>
</html>`;
}

// ==========================================
// Pure TypeScript PDF 1.4 Generator (Zero Native Dependencies)
// ==========================================

function toPdfAscii(text: string): string {
  const normalized = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
  return normalized
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

class PdfPageBuilder {
  private readonly pages: string[][] = [[]];
  private y = 760;
  private readonly pageWidth = 595;
  private readonly margin = 44;

  private currentOps(): string[] {
    return this.pages[this.pages.length - 1]!;
  }

  private ensureSpace(neededHeight: number): void {
    if (this.y - neededHeight < 52) {
      this.pages.push([]);
      this.y = 760;
    }
  }

  text(
    x: number,
    y: number,
    content: string,
    opts?: { size?: number; bold?: boolean },
  ): void {
    const size = opts?.size ?? 10;
    const font = opts?.bold ? "/F2" : "/F1";
    this.currentOps().push(
      `BT ${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${toPdfAscii(content)}) Tj ET`,
    );
  }

  rightText(
    rightX: number,
    y: number,
    content: string,
    opts?: { size?: number; bold?: boolean },
  ): void {
    const size = opts?.size ?? 10;
    const approxWidth = content.length * size * 0.52;
    const x = Math.max(this.margin, Math.round(rightX - approxWidth));
    this.text(x, y, content, opts);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.75): void {
    this.currentOps().push(`${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  cursorY(): number {
    return this.y;
  }

  advance(delta: number): void {
    this.y -= delta;
    this.ensureSpace(0);
  }

  nextLine(
    content: string,
    opts?: { x?: number; size?: number; bold?: boolean; gap?: number },
  ): void {
    const size = opts?.size ?? 10;
    const gap = opts?.gap ?? size + 5;
    this.ensureSpace(gap);
    this.text(opts?.x ?? this.margin, this.y, content, {
      size,
      bold: opts?.bold,
    });
    this.y -= gap;
  }

  divider(gapBefore = 6, gapAfter = 12, width = 0.75): void {
    this.ensureSpace(gapBefore + gapAfter);
    this.y -= gapBefore;
    this.line(this.margin, this.y, this.pageWidth - this.margin, this.y, width);
    this.y -= gapAfter;
  }

  tableRow(
    cols: Array<{
      text: string;
      x: number;
      align?: "left" | "right";
      maxChars?: number;
    }>,
    opts?: { size?: number; bold?: boolean; gap?: number },
  ): void {
    const size = opts?.size ?? 9.5;
    const gap = opts?.gap ?? 16;
    this.ensureSpace(gap);
    for (const col of cols) {
      const val = col.maxChars
        ? truncateText(col.text, col.maxChars)
        : col.text;
      if (col.align === "right") {
        this.rightText(col.x, this.y, val, { size, bold: opts?.bold });
      } else {
        this.text(col.x, this.y, val, { size, bold: opts?.bold });
      }
    }
    this.y -= gap;
  }

  toBuffer(): Buffer {
    // Object layout:
    // 1: Catalog
    // 2: Pages
    // 3: Font F1 (Helvetica)
    // 4: Font F2 (Helvetica-Bold)
    // For each page i (0..N-1): Page obj = 5 + i*2, Content obj = 6 + i*2
    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");

    const pageObjIds = this.pages.map((_, idx) => 5 + idx * 2);
    objects.push(
      `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pages.length} >>`,
    );
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

    for (let i = 0; i < this.pages.length; i += 1) {
      const pageObjId = 5 + i * 2;
      const contentObjId = pageObjId + 1;
      const streamBody = this.pages[i]!.join("\n");
      const streamBytes = Buffer.byteLength(streamBody, "latin1");
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>`,
      );
      objects.push(
        `<< /Length ${streamBytes} >>\nstream\n${streamBody}\nendstream`,
      );
    }

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [0];
    for (let i = 0; i < objects.length; i += 1) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
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

export function renderInvoicePdf(doc: PrintableInvoiceDocument): Buffer {
  const pdf = new PdfPageBuilder();
  const orgName = doc.organization.companyName || doc.organization.name;

  pdf.text(44, 770, "INVOICE", { size: 20, bold: true });
  pdf.text(44, 750, `Status: ${doc.status}`, { size: 10, bold: true });

  pdf.rightText(551, 772, `Invoice #: ${doc.invoiceNumber}`, {
    size: 10,
    bold: true,
  });
  let topY = 758;
  if (doc.orderNumber) {
    pdf.rightText(551, topY, `Order #: ${doc.orderNumber}`, { size: 9.5 });
    topY -= 14;
  }
  if (doc.customerPoNumber) {
    pdf.rightText(551, topY, `PO #: ${doc.customerPoNumber}`, { size: 9.5 });
    topY -= 14;
  }
  if (doc.paymentTermsDays !== undefined && doc.paymentTermsDays !== null && doc.paymentTermsDays > 0) {
    pdf.rightText(551, topY, `Terms: Net ${doc.paymentTermsDays} Days`, { size: 9.5 });
    topY -= 14;
  }
  pdf.rightText(551, topY, `Issued: ${formatDateLabel(doc.issuedAt)}`, {
    size: 9.5,
  });
  topY -= 14;
  pdf.rightText(551, topY, `Due: ${formatDateLabel(doc.dueAt)}`, { size: 9.5 });

  pdf.advance(46);
  pdf.divider(4, 14, 1.2);

  const partyStartY = pdf.cursorY();
  pdf.text(44, partyStartY, "FROM", { size: 8.5, bold: true });
  pdf.text(310, partyStartY, "BILL TO", { size: 8.5, bold: true });

  const fromLines = [
    orgName,
    ...(doc.organization.addressLines ?? []),
    doc.organization.email ? `Email: ${doc.organization.email}` : null,
    doc.organization.phone ? `Phone: ${doc.organization.phone}` : null,
    doc.organization.taxId ? `Tax ID: ${doc.organization.taxId}` : null,
  ].filter((v): v is string => Boolean(v));

  const billLines = doc.customer
    ? [
        doc.customer.companyName
          ? `${doc.customer.companyName} (${doc.customer.name})`
          : doc.customer.name,
        doc.customer.code ? `Code: ${doc.customer.code}` : null,
        ...(doc.customer.addressLines ?? []),
        doc.customer.email ? `Email: ${doc.customer.email}` : null,
        doc.customer.phone ? `Phone: ${doc.customer.phone}` : null,
        doc.customer.taxId ? `Tax ID: ${doc.customer.taxId}` : null,
      ].filter((v): v is string => Boolean(v))
    : ["Walk-in / Retail Customer"];

  const maxPartyLines = Math.max(fromLines.length, billLines.length);
  for (let i = 0; i < maxPartyLines; i += 1) {
    const rowY = partyStartY - 14 - i * 13;
    if (fromLines[i]) {
      pdf.text(44, rowY, truncateText(fromLines[i]!, 42), { size: 9.5 });
    }
    if (billLines[i]) {
      pdf.text(310, rowY, truncateText(billLines[i]!, 42), { size: 9.5 });
    }
  }

  pdf.advance(18 + maxPartyLines * 13);
  pdf.divider(4, 12, 0.75);

  pdf.tableRow(
    [
      { text: "DESCRIPTION", x: 44 },
      { text: "QTY", x: 315, align: "right" },
      { text: "UNIT PRICE", x: 400, align: "right" },
      { text: "DISC", x: 470, align: "right" },
      { text: "TOTAL", x: 551, align: "right" },
    ],
    { size: 8.5, bold: true, gap: 12 },
  );
  pdf.divider(0, 10, 0.5);

  for (const line of doc.lines) {
    const label = line.sku ? `${line.description} [${line.sku}]` : line.description;
    pdf.tableRow(
      [
        { text: label, x: 44, maxChars: 42 },
        { text: String(line.quantity), x: 315, align: "right" },
        {
          text: formatMoney(line.unitPriceCents, doc.currency),
          x: 400,
          align: "right",
        },
        {
          text: formatMoney(line.discountCents, doc.currency),
          x: 470,
          align: "right",
        },
        {
          text: formatMoney(line.lineTotalCents, doc.currency),
          x: 551,
          align: "right",
        },
      ],
      { size: 9.5, gap: 16 },
    );
  }

  pdf.divider(6, 14, 0.75);

  const summaryRows: Array<[string, string, boolean?]> = [
    ["Subtotal", formatMoney(doc.subtotalCents, doc.currency)],
    ["Discounts", `-${formatMoney(doc.discountTotalCents, doc.currency)}`],
    ["Tax", formatMoney(doc.taxCents, doc.currency)],
    ["Invoice Total", formatMoney(doc.totalCents, doc.currency), true],
    ["Cash Paid", formatMoney(doc.paidAmountCents, doc.currency)],
    ["Balance Due", formatMoney(doc.balanceDueCents, doc.currency), true],
  ];

  for (const [label, val, bold] of summaryRows) {
    pdf.tableRow(
      [
        { text: label, x: 350 },
        { text: val, x: 551, align: "right" },
      ],
      { size: bold ? 10.5 : 9.5, bold, gap: 16 },
    );
  }

  if (doc.notes) {
    pdf.divider(8, 12, 0.5);
    pdf.nextLine(`Notes: ${truncateText(doc.notes, 90)}`, { size: 9 });
  }

  return pdf.toBuffer();
}

export function renderReceiptPdf(doc: PrintableReceiptDocument): Buffer {
  const pdf = new PdfPageBuilder();
  const orgName = doc.organization.companyName || doc.organization.name;
  const customerName = doc.customer
    ? doc.customer.companyName
      ? `${doc.customer.companyName} (${doc.customer.name})`
      : doc.customer.name
    : "Walk-in Customer";

  pdf.nextLine("PAYMENT RECEIPT", { size: 18, bold: true, gap: 20 });
  pdf.nextLine(orgName, { size: 11, bold: true, gap: 14 });
  if (doc.locationName) {
    pdf.nextLine(
      `Location: ${doc.locationName}${doc.locationCode ? ` (${doc.locationCode})` : ""}`,
      { size: 9.5, gap: 13 },
    );
  }
  if (doc.organization.taxId) {
    pdf.nextLine(`Tax ID: ${doc.organization.taxId}`, { size: 9, gap: 13 });
  }

  pdf.divider(4, 12, 1);

  pdf.tableRow(
    [
      { text: `Receipt #: ${doc.receiptNumber}`, x: 44 },
      { text: `Issued: ${formatDateTimeLabel(doc.issuedAt)}`, x: 551, align: "right" },
    ],
    { size: 9.5, bold: true, gap: 14 },
  );
  pdf.tableRow(
    [
      { text: `Payment #: ${doc.paymentNumber}`, x: 44 },
      { text: `Method: ${doc.paymentMethod}`, x: 551, align: "right" },
    ],
    { size: 9.5, gap: 14 },
  );
  pdf.tableRow(
    [
      { text: `Order #: ${doc.orderNumber} (${doc.channel})`, x: 44 },
      {
        text: doc.invoiceNumber ? `Invoice #: ${doc.invoiceNumber}` : "",
        x: 551,
        align: "right",
      },
    ],
    { size: 9.5, gap: 14 },
  );
  pdf.nextLine(`Customer: ${truncateText(customerName, 75)}`, {
    size: 9.5,
    gap: 14,
  });

  pdf.divider(4, 12, 0.75);

  pdf.tableRow(
    [
      { text: "ITEM", x: 44 },
      { text: "QTY", x: 340, align: "right" },
      { text: "UNIT PRICE", x: 445, align: "right" },
      { text: "TOTAL", x: 551, align: "right" },
    ],
    { size: 8.5, bold: true, gap: 12 },
  );
  pdf.divider(0, 10, 0.5);

  for (const line of doc.lines) {
    const label = line.sku ? `${line.description} [${line.sku}]` : line.description;
    pdf.tableRow(
      [
        { text: label, x: 44, maxChars: 48 },
        { text: String(line.quantity), x: 340, align: "right" },
        {
          text: formatMoney(line.unitPriceCents, doc.currency),
          x: 445,
          align: "right",
        },
        {
          text: formatMoney(line.lineTotalCents, doc.currency),
          x: 551,
          align: "right",
        },
      ],
      { size: 9.5, gap: 15 },
    );
  }

  pdf.divider(6, 12, 0.75);

  const totals: Array<[string, string, boolean?]> = [
    ["Order Subtotal", formatMoney(doc.subtotalCents, doc.currency)],
    ["Discounts", `-${formatMoney(doc.discountTotalCents, doc.currency)}`],
    ["Tax", formatMoney(doc.taxCents, doc.currency)],
    ["Order Total", formatMoney(doc.totalCents, doc.currency), true],
    ...(doc.mpesaReceiptNumber
      ? [["M-Pesa Receipt #", doc.mpesaReceiptNumber] as [string, string]]
      : doc.reference
        ? [["Reference", doc.reference] as [string, string]]
        : []),
    ...(doc.phoneNumber
      ? [["Phone", doc.phoneNumber] as [string, string]]
      : []),
    ["Amount Applied", formatMoney(doc.amountAppliedCents, doc.currency)],
    ["Cash Tendered", formatMoney(doc.cashTenderedCents, doc.currency)],
    ["Change Given", formatMoney(doc.changeGivenCents, doc.currency), true],
  ];

  for (const [label, val, bold] of totals) {
    pdf.tableRow(
      [
        { text: label, x: 340 },
        { text: val, x: 551, align: "right" },
      ],
      { size: bold ? 10.5 : 9.5, bold, gap: 15 },
    );
  }

  if (doc.notes) {
    pdf.divider(8, 12, 0.5);
    pdf.nextLine(`Notes: ${truncateText(doc.notes, 90)}`, { size: 9 });
  }

  return pdf.toBuffer();
}
