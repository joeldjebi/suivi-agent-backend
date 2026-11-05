import PDFDocument from 'pdfkit';

export interface ReceiptData {
  company: string;
  companyPhone: string | null;
  reference: string;
  kindLabel: string;
  date: string;
  outletName: string;
  outletPhone: string | null;
  agentName: string;
  lines: {
    name: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    amount: number;
  }[];
  total: number;
  paid: number;
  due: number;
  payments: { label: string; amount: number }[];
  /** Ce que le client doit encore en tout (toutes commandes) */
  balance: number | null;
  currency: string;
  cancelled: boolean;
}

/** Les polices PDF de base ne connaissent pas les espaces fines de la mise en forme française. */
const clean = (s: string) =>
  s.replace(/[\u202f\u00a0]/g, ' ').replace(/\u2019/g, "'");

const amount = (n: number, currency: string) =>
  clean(
    new Intl.NumberFormat('fr-FR', {
      maximumFractionDigits: 2,
    }).format(n) + (currency === 'XOF' ? ' F CFA' : ` ${currency}`),
  );

const qty = (n: number) =>
  clean(new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(n));

/**
 * Reçu d'une vente ou d'une commande, au format ticket (80 mm) : lisible sur un téléphone
 * quand il est partagé par WhatsApp, et imprimable plus tard sur une imprimante thermique.
 * La hauteur est mesurée par un premier rendu, pour un ticket sans blanc inutile.
 */
export async function receiptPdf(r: ReceiptData): Promise<Buffer> {
  const measured = await render(r, 2000);
  return (await render(r, Math.ceil(measured.height))).pdf;
}

const WIDTH = 226; // 80 mm
const MARGIN = 12;
const INNER = WIDTH - MARGIN * 2;

function render(
  r: ReceiptData,
  pageHeight: number,
): Promise<{ pdf: Buffer; height: number }> {
  const doc = new PDFDocument({
    size: [WIDTH, pageHeight],
    margin: MARGIN,
    info: { Title: `Reçu ${r.reference}`, Author: clean(r.company) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  let height = 0;
  const done = new Promise<{ pdf: Buffer; height: number }>((resolve) =>
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), height })),
  );

  // Toujours depuis la marge gauche : une colonne de droite ne décale pas la suite.
  const line = (
    text: string,
    font: 'Helvetica' | 'Helvetica-Bold',
    size: number,
    align: 'left' | 'center' = 'left',
  ) =>
    doc
      .font(font)
      .fontSize(size)
      .text(clean(text), MARGIN, doc.y, { width: INNER, align });
  const rule = () => {
    doc.moveDown(0.4);
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(WIDTH - MARGIN, doc.y)
      .dash(2, { space: 2 })
      .strokeColor('#999999')
      .stroke()
      .undash();
    doc.moveDown(0.5);
  };
  const row = (left: string, right: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9.5 : 8.5);
    doc.text(clean(left), MARGIN, y, { width: INNER * 0.6 });
    const after = doc.y;
    doc.text(clean(right), MARGIN + INNER * 0.4, y, {
      width: INNER * 0.6,
      align: 'right',
    });
    doc.y = Math.max(after, doc.y);
  };

  line(r.company, 'Helvetica-Bold', 12, 'center');
  if (r.companyPhone) line(r.companyPhone, 'Helvetica', 8, 'center');
  doc.moveDown(0.3);
  line(`${r.kindLabel} ${r.reference}`, 'Helvetica-Bold', 9, 'center');
  line(r.date, 'Helvetica', 8, 'center');
  if (r.cancelled) {
    doc.moveDown(0.3).fillColor('#b91c1c');
    line('ANNULÉE', 'Helvetica-Bold', 10, 'center');
    doc.fillColor('#000000');
  }
  rule();
  line(`Client : ${r.outletName}`, 'Helvetica', 8.5);
  if (r.outletPhone) line(`Tél. : ${r.outletPhone}`, 'Helvetica', 8.5);
  line(`Vendeur : ${r.agentName}`, 'Helvetica', 8.5);
  rule();
  for (const l of r.lines) {
    line(l.name, 'Helvetica-Bold', 8.5);
    row(
      `Qté ${qty(l.quantity)} x ${amount(l.unitPrice, r.currency)}`,
      amount(l.amount, r.currency),
    );
    doc.moveDown(0.2);
  }
  rule();
  row('TOTAL', amount(r.total, r.currency), true);
  for (const p of r.payments) row(p.label, amount(p.amount, r.currency));
  if (r.due > 0) row('Reste à payer', amount(r.due, r.currency), true);
  if (r.balance != null && r.balance > 0) {
    doc.moveDown(0.3);
    row('Total dû par le client', amount(r.balance, r.currency));
  }
  rule();
  line('Merci de votre confiance.', 'Helvetica', 8, 'center');
  height = doc.y + MARGIN;
  doc.end();
  return done;
}
