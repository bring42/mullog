import { describe, expect, it } from 'vitest';
import { applyFilters, buildFacets, emptyFilters } from './filters';
import { parseFixture, withoutEofRow } from './__fixtures__/load';

describe('search over merged rows', () => {
  const { rows } = parseFixture('java-stacktrace.log');

  it('matches text that only appears in a continuation line', () => {
    const matches = applyFilters(rows, { ...emptyFilters, search: 'nullpointerexception' });
    expect(matches.map((row) => row.lineNumber)).toEqual([2]);
  });

  it('matches a stack frame', () => {
    const matches = applyFilters(rows, { ...emptyFilters, search: 'OrderController.java:17' });
    expect(matches.map((row) => row.lineNumber)).toEqual([2]);
  });
});

describe('buildFacets', () => {
  it('counts each merged entry once per category', () => {
    const rows = withoutEofRow(parseFixture('java-stacktrace.log').rows);
    expect(buildFacets(rows).categories).toEqual([
      { value: 'http', count: 2 },
      { value: 'orders', count: 1 }
    ]);
  });
});
