import test from 'node:test';
import assert from 'node:assert/strict';
import { mongoDatabaseName, mongoUriOption, mongoUriWithDatabase } from '../src/core/mongo-uri.js';

test('derives isolated audit database from Atlas SRV URI while preserving options', () => {
  const source = 'mongodb+srv://user:pass@cluster.example/classic-mart?retryWrites=true&w=majority';
  const audit = mongoUriWithDatabase(source, 'classic-mart-audit-test');
  assert.equal(audit, 'mongodb+srv://user:pass@cluster.example/classic-mart-audit-test?retryWrites=true&w=majority');
  assert.equal(mongoDatabaseName(audit), 'classic-mart-audit-test');
});

test('supports multi-host replica-set MongoDB URIs without WHATWG URL parsing', () => {
  const source = 'mongodb://user:pass@db1.example:27017,db2.example:27017/classic-mart?replicaSet=prod-rs&retryWrites=true';
  const audit = mongoUriWithDatabase(source, 'classic-mart-audit-test');
  assert.equal(audit, 'mongodb://user:pass@db1.example:27017,db2.example:27017/classic-mart-audit-test?replicaSet=prod-rs&retryWrites=true');
  assert.equal(mongoUriOption(source, 'replicaSet'), 'prod-rs');
});

test('rejects non-MongoDB URIs and unsafe database names', () => {
  assert.throws(() => mongoUriWithDatabase('https://example.com/db', 'audit-test'), /MongoDB URI/);
  assert.throws(() => mongoUriWithDatabase('mongodb://localhost/source', '../audit-test'), /database name/i);
});
