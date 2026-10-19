import { csvSafe, toCsv } from './sheet';

describe('Export CSV', () => {
  it('neutralise les formules saisies, sans toucher aux nombres', () => {
    expect(csvSafe('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")');
    expect(csvSafe('+33 6')).toBe("'+33 6");
    expect(csvSafe('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvSafe('-1500')).toBe('-1500');
    expect(csvSafe('-12,5')).toBe('-12,5');
    expect(csvSafe('Boutique Awa')).toBe('Boutique Awa');
  });

  it('les cellules texte du fichier sont protégées', () => {
    const csv = toCsv({
      name: 'Test',
      columns: [
        { header: 'Nom', kind: 'text' },
        { header: 'Montant', kind: 'integer' },
      ],
      rows: [['=1+1', -200]],
    } as never).toString('utf8');
    expect(csv).toContain("'=1+1;-200");
  });
});
