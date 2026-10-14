import ExcelJS from 'exceljs';
import { badRequest } from './business.exception';

/** Lecture des fichiers d'import (Excel .xlsx ou CSV) : un tableau de cellules par ligne. */

/** Sans accents ni casse ni ponctuation : pour reconnaître les en-têtes et les valeurs. */
export const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export type Raw = string | number | boolean | Date | null;

/** Nombre saisi en français (« 1 234,5 ») ou en cellule numérique ; null s'il n'y en a pas. */
export function number(v: Raw | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Fichier Excel (.xlsx) ou CSV, selon son nom ou son type. */
export async function readSheet(file: Express.Multer.File): Promise<Raw[][]> {
  return /\.csv$/i.test(file.originalname) || file.mimetype.includes('csv')
    ? readCsv(file.buffer)
    : readXlsx(file.buffer);
}

async function readXlsx(buffer: Buffer): Promise<Raw[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw badRequest(
      'FILE_FORMAT',
      'Fichier illisible : envoyez un fichier Excel (.xlsx) ou CSV',
    );
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: Raw[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: Raw[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      let v = row.getCell(c).value as unknown;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as {
          text?: string;
          result?: unknown;
          richText?: { text: string }[];
        };
        v = o.richText
          ? o.richText.map((t) => t.text).join('')
          : (o.result ?? o.text ?? null);
      }
      cells.push((v ?? null) as Raw);
    }
    out.push(cells);
  });
  return out;
}

/** CSV d'Excel en français (« ; ») ou international (« , »), guillemets gérés. */
function readCsv(buffer: Buffer): Raw[][] {
  const text = buffer
    .toString('utf8')
    .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : ',';
  const rows: Raw[][] = [];
  let row: Raw[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
