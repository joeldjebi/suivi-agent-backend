import {
  FieldType,
  type MissionField,
  OUTLET_STATUS_LABELS,
  OutletStatus,
} from '@suivi/shared';
import ExcelJS from 'exceljs';
import { badRequest } from '../common/business.exception';
import { normalizePhone } from '../common/phone';

export interface ImportRow {
  /** Numéro de ligne dans le fichier (en-tête = 1) */
  line: number;
  name: string;
  category: string | null;
  managerName: string | null;
  phone: string | null;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
  status: OutletStatus;
  data: Record<string, unknown>;
}

export interface Skipped {
  row: number;
  name: string | null;
  reason: string;
}

const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** En-têtes reconnus (sans accents ni casse) pour chaque information de base. */
const BASE: Record<string, string[]> = {
  name: [
    'nom',
    'nom du point de vente',
    'point de vente',
    'enseigne',
    'commerce',
  ],
  category: ['type', 'categorie', 'type de commerce'],
  managerName: ['gerant', 'nom du gerant', 'responsable', 'contact'],
  phone: ['telephone', 'tel', 'contact telephone', 'numero'],
  landmark: ['repere', 'adresse', 'localisation', 'indication'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'lng', 'lon', 'long'],
  status: ['statut', 'etat'],
};

const STATUS_BY_TEXT = new Map<string, OutletStatus>(
  Object.entries(OUTLET_STATUS_LABELS).flatMap(([code, label]) => [
    [plain(code), code as OutletStatus],
    [plain(label), code as OutletStatus],
  ]),
);
STATUS_BY_TEXT.set('actif', OutletStatus.Active);
STATUS_BY_TEXT.set('client', OutletStatus.Active);
STATUS_BY_TEXT.set('ferme', OutletStatus.Closed);

type Raw = string | number | boolean | Date | null;

/** Lit un fichier Excel (.xlsx) ou CSV (« ; » ou « , ») en lignes validées. */
export async function parseOutletSheet(
  file: Express.Multer.File,
  fields: MissionField[],
): Promise<{ rows: ImportRow[]; skipped: Skipped[] }> {
  const table =
    /\.csv$/i.test(file.originalname) || file.mimetype.includes('csv')
      ? readCsv(file.buffer)
      : await readXlsx(file.buffer);
  const [header, ...lines] = table;
  if (!header?.length) throw badRequest('EMPTY_FILE', 'Le fichier est vide');
  const columns = header.map((h) => plain(String(h ?? '')));
  const indexOf = (names: string[]) =>
    columns.findIndex((c) => names.includes(c));
  const base = Object.fromEntries(
    Object.entries(BASE).map(([key, names]) => [key, indexOf(names)]),
  ) as Record<keyof typeof BASE, number>;
  if (base.name < 0)
    throw badRequest(
      'MISSING_COLUMN',
      'Colonne « Nom » introuvable : utilisez le modèle d’import',
    );
  const custom = fields.map((f) => ({
    field: f,
    index: columns.findIndex((c) => c === plain(f.label) || c === f.key),
  }));

  const rows: ImportRow[] = [];
  const skipped: Skipped[] = [];
  lines.forEach((cells, i) => {
    const line = i + 2;
    const text = (index: number) => {
      const v = index >= 0 ? cells[index] : null;
      if (v === null || v === undefined) return null;
      const s = (v instanceof Date ? v.toISOString() : String(v)).trim();
      return s || null;
    };
    if (cells.every((c) => c === null || String(c).trim() === '')) return;
    const name = text(base.name);
    const fail = (reason: string) => skipped.push({ row: line, name, reason });
    if (!name) return fail('Nom manquant');
    if (name.length > 120)
      return fail('Nom trop long (120 caractères au plus)');

    const rawPhone = text(base.phone);
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) return fail(`Téléphone invalide : ${rawPhone}`);

    const lat = number(base.lat >= 0 ? cells[base.lat] : null);
    const lng = number(base.lng >= 0 ? cells[base.lng] : null);
    if ((lat === null) !== (lng === null))
      return fail('Latitude et longitude vont ensemble');
    if (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng!) > 180))
      return fail('Coordonnées GPS invalides');

    const rawStatus = text(base.status);
    const status = rawStatus
      ? STATUS_BY_TEXT.get(plain(rawStatus))
      : OutletStatus.New;
    if (!status) return fail(`Statut inconnu : ${rawStatus}`);

    const data: Record<string, unknown> = {};
    for (const { field, index } of custom) {
      if (index < 0) continue;
      const raw = cells[index];
      if (raw === null || raw === undefined || String(raw).trim() === '')
        continue;
      const value = convert(field, raw);
      if (value === undefined)
        return fail(`Valeur invalide pour « ${field.label} » : ${String(raw)}`);
      data[field.key] = value;
    }
    rows.push({
      line,
      name,
      category: text(base.category)?.slice(0, 60) ?? null,
      managerName: text(base.managerName)?.slice(0, 120) ?? null,
      phone,
      landmark: text(base.landmark)?.slice(0, 200) ?? null,
      lat,
      lng,
      status,
      data,
    });
  });
  return { rows, skipped };
}

function number(v: Raw | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Valeur d'un champ de la fiche ; `undefined` si elle ne convient pas. */
function convert(field: MissionField, raw: Raw): unknown {
  const s = raw instanceof Date ? '' : String(raw).trim();
  switch (field.type) {
    case FieldType.Text:
      return s.slice(0, 1000);
    case FieldType.Number:
      return number(raw) ?? undefined;
    case FieldType.Boolean: {
      if (typeof raw === 'boolean') return raw;
      const p = plain(s);
      if (['oui', 'o', 'yes', 'vrai', 'true', '1', 'x'].includes(p))
        return true;
      if (['non', 'n', 'no', 'faux', 'false', '0'].includes(p)) return false;
      return undefined;
    }
    case FieldType.Select:
      return field.options?.find((o) => plain(o) === plain(s));
    case FieldType.Date: {
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (fr)
        return `${fr[3]}-${fr[2].padStart(2, '0')}-${fr[1].padStart(2, '0')}`;
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
    }
    default:
      return undefined;
  }
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
