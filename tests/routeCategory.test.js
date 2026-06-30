import { describe, it, expect } from 'vitest';

import {
  CATEGORIES,
  classifyRoute,
  cleanLongName,
  applyCategory,
  getAllCategories,
} from '../src/assemble/merge/routeCategory.js';

describe('classifyRoute — pattern → category', () => {
  it('classifies TE-prefixed school buses as "Transport Elevi"', () => {
    expect(classifyRoute({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'TE14' })).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'TE-OG' })).toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('classifies M7x school buses whose long_name starts with "TE\\d+ Floresti" as "Transport Elevi"', () => {
    // The M75A-M79C family is numbered with the metroline M prefix
    // because they go to Floresti, but their long_name carries the
    // school destination. The long_name check catches them.
    expect(classifyRoute({
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({
      route_short_name: 'M75B',
      route_long_name: 'TE1F',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('classifies *U suffix + "(untold)" annotation as "Untold"', () => {
    expect(classifyRoute({ route_short_name: '30U', route_long_name: 'Grigorescu - IRA' }))
      .toEqual({ id: 'festival', label: 'Untold' });
    expect(classifyRoute({
      route_short_name: 'M26U',
      route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)',
    })).toEqual({ id: 'festival', label: 'Untold' });
  });

  it('classifies *N suffix + "Noapte" long_name as "Night service"', () => {
    expect(classifyRoute({ route_short_name: '25N', route_long_name: 'Str. Bucium - Str. Unirii' }))
      .toEqual({ id: 'night', label: 'Night service' });
    expect(classifyRoute({ route_short_name: '5N', route_long_name: 'Noapte Traian Vuia' }))
      .toEqual({ id: 'night', label: 'Night service' });
  });

  it('classifies A1 / Aeroport long_name as "Aeroport Express"', () => {
    expect(classifyRoute({ route_short_name: 'A1', route_long_name: 'Piata Mihai Viteazu - Aeroport' }))
      .toEqual({ id: 'airport', label: 'Aeroport Express' });
    expect(classifyRoute({ route_short_name: '99', route_long_name: 'Some Route Aeroport Express' }))
      .toEqual({ id: 'airport', label: 'Aeroport Express' });
  });

  it('classifies D* prefix as "Commuter"', () => {
    expect(classifyRoute({ route_short_name: 'D51', route_long_name: 'D51' }))
      .toEqual({ id: 'commuter', label: 'Commuter' });
  });

  it('classifies M* (non-school) as "Metroline"', () => {
    expect(classifyRoute({ route_short_name: 'M11', route_long_name: 'P-ta Cipariu - Feleacu' }))
      .toEqual({ id: 'metroline', label: 'Metroline' });
    expect(classifyRoute({ route_short_name: 'M26', route_long_name: 'Floresti - Cluj Napoca' }))
      .toEqual({ id: 'metroline', label: 'Metroline' });
  });

  it('classifies CS as "Cursa Speciala"', () => {
    expect(classifyRoute({ route_short_name: 'CS', route_long_name: 'CURSA SPECIALA' }))
      .toEqual({ id: 'special', label: 'Cursa Speciala' });
  });

  it('returns null for regular urban routes that match no category', () => {
    expect(classifyRoute({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toBeNull();
    expect(classifyRoute({ route_short_name: '24', route_long_name: 'Str. Unirii - Str. Bucium' }))
      .toBeNull();
    expect(classifyRoute({ route_short_name: '101', route_long_name: 'Tram line 101' }))
      .toBeNull();
  });

  it('respects priority — CS wins over Metroline for M-classified specials', () => {
    // Edge case: if "CS" had M prefix it would be special first. This
    // pins the documented priority order so future category additions
    // don't accidentally reorder.
    expect(CATEGORIES[0].id).toBe('special');
    expect(CATEGORIES[1].id).toBe('school');
    expect(CATEGORIES[2].id).toBe('festival');
  });

  it('treats missing/undefined short_name and long_name as empty strings', () => {
    // Defensive: feed upstream may produce sparse rows.
    expect(() => classifyRoute({})).not.toThrow();
    expect(classifyRoute({})).toBeNull();
  });
});

describe('cleanLongName — start-end format', () => {
  it('strips trailing parenthetical annotations', () => {
    expect(cleanLongName({ route_short_name: 'M26U', route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)' }))
      .toBe('Uzinei Electrice - Floresti / Cetate');
    expect(cleanLongName({ route_short_name: '88A', route_long_name: 'Floresti Cetate - Emerson (traseu M21)' }))
      .toBe('Floresti Cetate - Emerson');
    expect(cleanLongName({ route_short_name: 'M26N', route_long_name: 'Floresti - Cluj Napoca' }))
      .toBe('Floresti - Cluj Napoca'); // no annotation — unchanged
  });

  it('strips "Transport Elevi -" / "Transport Elevi " prefix for school routes', () => {
    expect(cleanLongName({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toBe('Manastur');
    expect(cleanLongName({ route_short_name: 'TE6', route_long_name: 'Transport Elevi-Manastur - Kogalniceanu' }))
      .toBe('Manastur - Kogalniceanu');
    expect(cleanLongName({ route_short_name: 'TE7', route_long_name: 'Transport Elevi-Bucium - Kogalniceanu' }))
      .toBe('Bucium - Kogalniceanu');
  });

  it('strips "TE\\d+ Floresti" prefix from M7x school routes', () => {
    expect(cleanLongName({ route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului' }))
      .toBe('str. Somesului');
    expect(cleanLongName({ route_short_name: 'M79A', route_long_name: 'TE5 Floresti Tauti Floresti' }))
      .toBe('Tauti Floresti');
  });

  it('clears long_name for CS (no fixed endpoints to describe)', () => {
    expect(cleanLongName({ route_short_name: 'CS', route_long_name: 'CURSA SPECIALA' })).toBe('');
  });

  it('returns start-end unchanged when already clean', () => {
    expect(cleanLongName({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toBe('Str. Bucium - P-ta 1 Mai');
    expect(cleanLongName({ route_short_name: '25', route_long_name: 'Str. Bucium - Str. Unirii' }))
      .toBe('Str. Bucium - Str. Unirii');
  });

  it('handles empty/undefined long_name gracefully', () => {
    expect(cleanLongName({ route_short_name: '1' })).toBe('');
    expect(cleanLongName({ route_short_name: '1', route_long_name: '' })).toBe('');
  });

  it('trims whitespace', () => {
    expect(cleanLongName({ route_short_name: '1', route_long_name: '  Str. Bucium - P-ta 1 Mai  ' }))
      .toBe('Str. Bucium - P-ta 1 Mai');
  });
});

describe('applyCategory — combined classification + cleanup', () => {
  it('mutates route_long_name to cleaned form AND sets route_desc to category label', () => {
    const row = {
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului - Liceul D. Tautan',
      route_desc: 'old noise',
    };
    const result = applyCategory(row);
    expect(result.category).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(result.longNameChanged).toBe(true);
    expect(row.route_long_name).toBe('str. Somesului - Liceul D. Tautan');
    expect(row.route_desc).toBe('Transport Elevi');
  });

  it('clears route_desc for regular urban routes (no category)', () => {
    const row = {
      route_short_name: '1',
      route_long_name: 'Str. Bucium - P-ta 1 Mai',
      route_desc: 'Str. Bucium - P-ta 1 Mai', // noise that was already there
    };
    const result = applyCategory(row);
    expect(result.category).toBeNull();
    expect(result.longNameChanged).toBe(false);
    expect(row.route_long_name).toBe('Str. Bucium - P-ta 1 Mai');
    expect(row.route_desc).toBe('');
  });

  it('classifies against the cleaned long_name (school M7x case)', () => {
    // Regression: if we classified against the original long_name
    // ("TE2 Floresti ..."), school match works either way; but the
    // pattern is also robust when classification runs on already-cleaned
    // text. Pin both.
    const row = {
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti', // cleaned would become ''
      route_desc: '',
    };
    const result = applyCategory(row);
    expect(result.category.id).toBe('school');
  });
});

describe('getAllCategories — networks emission input', () => {
  it('returns the full category list with id + label', () => {
    const all = getAllCategories();
    expect(all.length).toBe(CATEGORIES.length);
    for (const c of all) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('label');
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
    }
  });

  it('exposes the categories neary will need to render (school, festival, night, etc.)', () => {
    const all = getAllCategories();
    const ids = all.map((c) => c.id);
    expect(ids).toContain('school');
    expect(ids).toContain('festival');
    expect(ids).toContain('night');
    expect(ids).toContain('airport');
    expect(ids).toContain('commuter');
    expect(ids).toContain('metroline');
    expect(ids).toContain('special');
  });
});