import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate } from './calibration.js';

test('billing sanity bound: billed reads per request sit near the counted runner mix', () => {
  const r = calibrate();
  // 0.18 requests and 4.24 reads per idle session-second under the deployed protocol (no-report /wait, 19 reads).
  assert.ok(Math.abs(r.perSession.requests - 0.18) < 1e-9 && Math.abs(r.perSession.reads - 4.24) < 1e-9);
  // 41.6M reads over 1.53M requests ≈ 27.1 per request against ≈23.6 counted per runner request (≈1.15×).
  assert.ok(Math.abs(r.billedReadsPerRequest - 27.142) < 0.001);
  assert.ok(Math.abs(r.readRatio - 1.15) < 0.01);
  // With the no-report /wait writing contact once per 60 s, writes per request are ≈1.09 counted against 0.86 billed.
  assert.ok(Math.abs(r.writeRatio - 0.79) < 0.01);
  // Both imply about four connected idle sessions; their ratio equals readRatio, so this is one check.
  assert.ok(r.impliedSessionsFromRequests > 3.5 && r.impliedSessionsFromRequests < 4.5);
  assert.ok(r.impliedSessionsFromReads > 3.5 && r.impliedSessionsFromReads < 4.5);
  // After the free tier, Firestore at the workbook's Tel Aviv prices is about $14.5 for the period.
  assert.ok(Math.abs(r.firestoreUsdAtWorkbookPrices - 14.52) < 0.01);
});
