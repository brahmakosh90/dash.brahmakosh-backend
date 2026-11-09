import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossValidatePaksha, extractTithiNumber, normalizePaksha } from '../utils/panchangValidation.js';

const adv = (tithiNumber, paksha, extra = {}) => ({ paksha, tithi: { details: { tithi_number: tithiNumber } }, ...extra });

test('normalizePaksha recognises both pakshas', () => {
  assert.equal(normalizePaksha('Krishna Paksha'), 'Krishna');
  assert.equal(normalizePaksha('shukla'), 'Shukla');
  assert.equal(normalizePaksha(''), null);
});

test('consistent API data produces no discrepancy', () => {
  assert.equal(crossValidatePaksha(adv(8, 'Shukla Paksha')).discrepancy, null);
  assert.equal(crossValidatePaksha(adv(23, 'Krishna Paksha')).discrepancy, null);
});

test('the Nov-4 failure: tithi 16-30 with API "Shukla" is corrected and flagged CRITICAL', () => {
  const r = crossValidatePaksha(adv(19, 'Shukla Paksha'));
  assert.equal(r.value, 'Krishna Paksha');
  assert.equal(r.discrepancy.severity, 'CRITICAL');
  assert.equal(r.discrepancy.resolution, 'used_calculated');
});

test('tithi 1-15 with API "Krishna" is flagged but not overridden (per-paksha numbering is possible)', () => {
  const r = crossValidatePaksha(adv(7, 'Krishna Paksha'));
  assert.equal(r.value, 'Krishna Paksha');
  assert.equal(r.discrepancy.resolution, 'kept_api_flagged');
});

test('missing paksha is filled from the tithi', () => {
  assert.equal(crossValidatePaksha(adv(3, '')).value, 'Shukla Paksha');
});

test('very late moonrise on a Shukla day yields a warning only', () => {
  const r = crossValidatePaksha(adv(5, 'Shukla Paksha', { moonrise: '22:15:00' }));
  assert.equal(r.value, 'Shukla Paksha');
  assert.equal(r.warnings.length, 1);
});

test('extractTithiNumber tolerates other shapes and junk', () => {
  assert.equal(extractTithiNumber({ tithi: { tithi_number: 12 } }), 12);
  assert.equal(extractTithiNumber({ tithi: { details: { tithi_number: 99 } } }), null);
  assert.equal(extractTithiNumber({}), null);
});
