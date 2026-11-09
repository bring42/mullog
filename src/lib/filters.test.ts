import { describe, expect, it } from 'vitest';
import { applyFilters, buildFacets, clearFilterToken, describeActiveFilters, emptyFilters, filterTokenLabel } from './filters';
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
    expect(buildFacets(rows, emptyFilters, []).categories).toEqual([
      { value: 'http', count: 2 },
      { value: 'orders', count: 1 }
    ]);
  });
});

describe('filter tokens', () => {
  const filters = {
    ...emptyFilters,
    search: '  timeout ',
    from: '2024-03-05T08:00',
    columnFilters: { severity: ['ERROR', 'WARN'], host: [] }
  };

  it('describes each active filter as a structured token', () => {
    expect(describeActiveFilters(filters)).toEqual([
      { kind: 'search', value: 'timeout' },
      { kind: 'from', value: '2024-03-05T08:00' },
      { kind: 'column', column: 'severity', value: 'ERROR' },
      { kind: 'column', column: 'severity', value: 'WARN' }
    ]);
  });

  it('labels tokens for people, not parsers', () => {
    const labels = describeActiveFilters(filters).map((token) => {
      const { key, value } = filterTokenLabel(token);
      return [key, value].filter(Boolean).join(' ');
    });
    expect(labels).toEqual(['“timeout”', 'From 2024-03-05 08:00', 'severity: ERROR', 'severity: WARN']);
  });

  it('removes exactly the clicked token, even when values contain colons', () => {
    const withColon = { ...emptyFilters, columnFilters: { url: ['http://a:8080', 'http://b'] } };
    const [first] = describeActiveFilters(withColon);
    expect(clearFilterToken(withColon, first).columnFilters.url).toEqual(['http://b']);
    const [search] = describeActiveFilters(filters);
    expect(clearFilterToken(filters, search).search).toBe('');
  });
});
