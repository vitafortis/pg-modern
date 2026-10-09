import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnNameFrom, csvRecords, detectDelimiter, detectHeader, inferType, parseCsv, sqlTypeFor, valueKind } from '../src/lib/csv.ts';

test('plain fields, CRLF / LF / CR line endings, blank lines skipped', () => {
	assert.deepEqual(parseCsv('a,b\r\n1,2\n3,4\r5,6\n\n'), [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
	assert.deepEqual(parseCsv(''), []);
	assert.deepEqual(parseCsv('x'), [['x']]);
});

test('quoted fields: delimiters, newlines and doubled quotes inside', () => {
	const rows = parseCsv('id,text\n1,"a, b"\n2,"line1\nline2"\n3,"she said ""hi"""\n4,""\n');
	assert.deepEqual(rows, [['id', 'text'], ['1', 'a, b'], ['2', 'line1\nline2'], ['3', 'she said "hi"'], ['4', '']]);
});

test('empty fields and trailing delimiters', () => {
	assert.deepEqual(parseCsv('a,,c,\n,,,\n'), [['a', '', 'c', ''], ['', '', '', '']]);
});

test('BOM is stripped; other delimiters', () => {
	assert.deepEqual(parseCsv('﻿a;b\n1;2', ';'), [['a', 'b'], ['1', '2']]);
	assert.deepEqual(parseCsv('a\tb\n"x\ty"\t2', '\t'), [['a', 'b'], ['x\ty', '2']]);
});

test('record line numbers account for quoted newlines', () => {
	const lines = [...csvRecords('h\n"a\nb"\nc\r\n\r\nd')].map((r) => r.line);
	assert.deepEqual(lines, [1, 2, 4, 6]);
});

test('unterminated quote is an error with its line', () => {
	assert.throws(() => parseCsv('a\n"open\nmore'), (err: Error & { line?: number }) => err.line === 2);
});

test('stray quotes in unquoted fields are kept', () => {
	assert.deepEqual(parseCsv('5" screen,x\n"q"tail,y'), [['5" screen', 'x'], ['qtail', 'y']]);
});

test('detects the delimiter', () => {
	assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
	assert.equal(detectDelimiter('a;b;c\n1,5;2;3\n'), ';');
	assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t');
	assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
	assert.equal(detectDelimiter('"x,y";z\n"1,2";3\n'), ';');
	assert.equal(detectDelimiter('single\ncolumn'), ',');
});

test('detects a header row', () => {
	assert.ok(detectHeader([['id', 'name'], ['1', 'Ann']]));
	assert.ok(!detectHeader([['1', 'Ann'], ['2', 'Bob']]));
	assert.ok(!detectHeader([['id', ''], ['1', 'x']]));
	assert.ok(!detectHeader([['a', 'a'], ['1', '2']]));
	assert.ok(!detectHeader([['2024-01-01', 'x'], ['2024-01-02', 'y']]));
	assert.ok(detectHeader([['created', 'x'], ['2024-01-02', 'y']]));
});

test('value kinds', () => {
	assert.equal(valueKind('42'), 'integer');
	assert.equal(valueKind('-2147483648'), 'bigint');
	assert.equal(valueKind('9223372036854775808'), 'decimal');
	assert.equal(valueKind('3.14'), 'decimal');
	assert.equal(valueKind('1e10'), 'double');
	assert.equal(valueKind('TRUE'), 'boolean');
	assert.equal(valueKind('2024-02-29'), 'date');
	assert.equal(valueKind('2023-02-29'), 'text');
	assert.equal(valueKind('2024-01-01 10:00:00.123'), 'timestamp');
	assert.equal(valueKind('2024-01-01T10:00:00Z'), 'timestamptz');
	assert.equal(valueKind('550e8400-e29b-41d4-a716-446655440000'), 'uuid');
	assert.equal(valueKind('{"a":1}'), 'json');
	assert.equal(valueKind('{nope'), 'text');
	assert.equal(valueKind('hello'), 'text');
});

test('type inference widens across values and tracks NULLs', () => {
	assert.equal(inferType(['1', '2', '']).kind, 'integer');
	assert.equal(inferType(['1', '2', '']).nullable, true);
	assert.equal(inferType(['1', '3000000000']).kind, 'bigint');
	const dec = inferType(['1', '12.345', '-0.5']);
	assert.equal(dec.kind, 'decimal');
	assert.equal(dec.intDigits, 2);
	assert.equal(dec.scale, 3);
	assert.equal(inferType(['1.5', '2e3']).kind, 'double');
	assert.equal(inferType(['2024-01-01', '2024-01-01 12:00']).kind, 'timestamp');
	assert.equal(inferType(['1', 'x']).kind, 'text');
	assert.equal(inferType(['true', '1']).kind, 'text');
	assert.equal(inferType([]).kind, 'text');
	assert.equal(inferType(['', '']).kind, 'text');
});

test('SQL types per engine', () => {
	const t = (values: string[]) => inferType(values);
	assert.equal(sqlTypeFor('postgres', t(['1'])), 'integer');
	assert.equal(sqlTypeFor('postgres', t(['1.25'])), 'numeric');
	assert.equal(sqlTypeFor('postgres', t(['{"a":1}'])), 'jsonb');
	assert.equal(sqlTypeFor('postgres', t(['2024-01-01T00:00:00+02:00'])), 'timestamptz');
	assert.equal(sqlTypeFor('mysql', t(['1.25', '100.5'])), 'decimal(5,2)');
	assert.equal(sqlTypeFor('mysql', t(['yes', 'no'])), 'tinyint(1)');
	assert.equal(sqlTypeFor('mysql', t(['2024-01-01 10:00:00.5'])), 'datetime(6)');
	assert.equal(sqlTypeFor('mysql', t(['x'.repeat(300)])), 'text');
	assert.equal(sqlTypeFor('mysql', t(['short'])), 'varchar(255)');
	assert.equal(sqlTypeFor('mysql', t(['550e8400-e29b-41d4-a716-446655440000'])), 'char(36)');
	assert.equal(sqlTypeFor('sqlite', t(['1'])), 'INTEGER');
});

test('column names from headers', () => {
	assert.equal(columnNameFrom(' First Name ', 0), 'first_name');
	assert.equal(columnNameFrom('orderID', 0), 'order_id');
	assert.equal(columnNameFrom('2024 total', 0), 'c_2024_total');
	assert.equal(columnNameFrom('***', 4), 'column_5');
	assert.equal(columnNameFrom('Größe', 0), 'größe');
});
