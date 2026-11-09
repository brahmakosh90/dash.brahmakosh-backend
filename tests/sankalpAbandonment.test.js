import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAbandonmentCheck, countConsecutiveMissed } from '../services/sankalpAbandonment.js';

const day = (offset) => { const d = new Date('2026-11-09T00:00:00'); d.setDate(d.getDate() + offset); return d; };
const missed3 = () => [-1, -2, -3].map((o) => ({ date: day(o), status: 'not_reported' }));
const silent = { warn() {}, error() {}, log() {} };

const make = (docs) => {
  const logs = [];
  const sent = [];
  return {
    logs, sent,
    deps: {
      UserSankalp: { find: () => ({ populate: async () => docs }) },
      notificationService: { sendAbandonmentNotification: async (...a) => { sent.push(a); } },
      CronJobLog: { create: async (x) => { logs.push(x); } },
      now: day(0),
      logger: silent,
    },
  };
};
const sk = (id, extra = {}) => ({ _id: id, status: 'active', userId: { _id: 'u' + id }, sankalpId: { title: 'T' + id }, dailyReports: missed3(), save: async function () {}, ...extra });

test('countConsecutiveMissed stops at first reported day', () => {
  const reports = [{ date: day(-1), status: 'not_reported' }, { date: day(-2), status: 'yes' }, { date: day(-3), status: 'not_reported' }];
  assert.equal(countConsecutiveMissed(reports, day(0)), 1);
});

test('abandons after 3 missed days and sends notification with the title', async () => {
  const doc = sk('1');
  const { deps, sent, logs } = make([doc]);
  const r = await runAbandonmentCheck(deps);
  assert.equal(doc.status, 'abandoned');
  assert.deepEqual(sent[0], ['u1', '1', 'T1']);
  assert.equal(r.abandoned, 1);
  assert.equal(logs[0].jobName, 'sankalp-abandonment');
});

test('skips records whose populate returned null without crashing', async () => {
  const { deps } = make([sk('1', { sankalpId: null }), sk('2', { userId: null }), sk('3')]);
  const r = await runAbandonmentCheck(deps);
  assert.equal(r.processed, 1);
  assert.equal(r.abandoned, 1);
  assert.equal(r.failed, 0);
});

test('one failing record does not abort the batch', async () => {
  const bad = sk('1', { save: async () => { throw new Error('boom'); } });
  const good = sk('2');
  const { deps, logs } = make([bad, good]);
  const r = await runAbandonmentCheck(deps);
  assert.equal(good.status, 'abandoned');
  assert.equal(r.failed, 1);
  assert.equal(logs[0].errors[0].ref, '1');
});

test('a failing query is logged to CronJobLog instead of throwing', async () => {
  const { deps, logs } = make([]);
  deps.UserSankalp = { find: () => ({ populate: async () => { throw new Error('db down'); } }) };
  const r = await runAbandonmentCheck(deps);
  assert.equal(r.failed, 1);
  assert.equal(logs[0].errors[0].ref, 'query');
});
