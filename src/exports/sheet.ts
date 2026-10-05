import ExcelJS from 'exceljs';

/** Type d'une colonne : le format Excel et l'écriture CSV en dépendent. */
export type ColumnKind =
  | 'text'
  /** Nombre affiché tel quel (réponses des formulaires) */
  | 'general'
  | 'number'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'time';

export interface SheetColumn {
  header: string;
  kind: ColumnKind;
  width?: number;
}

/** Valeur d'une cellule ; les dates sont l'heure locale de la structure, « AAAA-MM-JJ[ HH:MM] ». */
export type Cell = string | number | null;

export interface Sheet {
  title: string;
  columns: SheetColumn[];
  rows: Cell[][];
}

/** Marque UTF-8 : Excel reconnaît ainsi les accents du CSV. */
const BOM = String.fromCharCode(0xfeff);

const NUMBER_FORMAT: Partial<Record<ColumnKind, string>> = {
  number: '0',
  decimal: '0.00',
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm',
  time: 'hh:mm',
};

/** Heure locale « AAAA-MM-JJ HH:MM » → date Excel affichant cette heure-là. */
function excelDate(value: string): Date {
  const [d, t = '00:00'] = value.split(' ');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, h, min));
}

/** Classeur Excel : en-tête en gras et figé, filtres, colonnes typées. */
export async function toXlsx(sheet: Sheet, author: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = author;
  wb.created = new Date();
  const ws = wb.addWorksheet(sheet.title.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = sheet.columns.map((c) => ({
    header: c.header,
    width: c.width ?? Math.min(40, Math.max(12, c.header.length + 2)),
    style: NUMBER_FORMAT[c.kind] ? { numFmt: NUMBER_FORMAT[c.kind] } : {},
  }));
  for (const row of sheet.rows) {
    ws.addRow(
      row.map((v, i) => {
        const kind = sheet.columns[i].kind;
        if (v === null || v === '') return null;
        if ((kind === 'date' || kind === 'datetime') && typeof v === 'string')
          return excelDate(v);
        if (kind === 'time' && typeof v === 'string')
          return excelDate(`1899-12-30 ${v}`);
        return v;
      }),
    );
  }
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFF4FF' },
  };
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length },
  };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV pour Excel en français : « ; », virgule décimale, BOM UTF-8, dates JJ/MM/AAAA. */
export function toCsv(sheet: Sheet): Buffer {
  const escape = (v: string) =>
    /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const format = (v: Cell, kind: ColumnKind): string => {
    if (v === null) return '';
    if (typeof v === 'number')
      return (kind === 'decimal' ? v.toFixed(2) : String(v)).replace('.', ',');
    if (kind === 'date' || kind === 'datetime') {
      const [d, t] = v.split(' ');
      const [y, m, day] = d.split('-');
      return `${day}/${m}/${y}${t ? ` ${t}` : ''}`;
    }
    return v;
  };
  const lines = [
    sheet.columns.map((c) => escape(c.header)).join(';'),
    ...sheet.rows.map((r) =>
      r.map((v, i) => escape(format(v, sheet.columns[i].kind))).join(';'),
    ),
  ];
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}
