'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { extractTopLevelFunctionSource } = require('./source-scan-helpers');

const appSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');

test('only the latest History refresh can update History and Activity', async (t) => {
  for (const outcome of ['success', 'error']) {
    await t.test(`older request settles with ${outcome}`, async () => {
      const requests = [];
      const historyRenders = [];
      const activityRenders = [];
      let completeScan;
      const context = vm.createContext({
        window: { electronAPI: {
          listMeetings: () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); }),
          scanRecordings: () => new Promise((resolve) => { completeScan = resolve; }),
        } },
        document: { getElementById: () => null },
        console: { error: () => assert.fail('Superseded error was logged') },
        meetings: [],
        meetingHistoryRequestEpoch: 0,
        meetingSearchQueryNormalized: '',
        currentMeetingId: null,
        meetingList: {},
        addLog() {},
        setPlaceholder: () => assert.fail('Superseded error replaced History'),
        renderMeetingList: () => historyRenders.push(context.meetings),
        renderActivityList: () => activityRenders.push(context.meetings),
      });
      vm.runInContext(extractTopLevelFunctionSource(appSource, 'loadMeetingHistory'), context);

      const older = context.loadMeetingHistory();
      const newer = context.loadMeetingHistory();
      const current = [{ id: 'kept', transcriptionStatus: 'completed' }];
      requests[1].resolve(current);
      await newer;

      if (outcome === 'success') {
        requests[0].resolve([{ id: 'removed' }, { id: 'kept', transcriptionStatus: 'pending' }]);
      } else {
        requests[0].reject(new Error('Older list failed'));
      }
      await older;
      assert.equal(context.meetings, current);
      assert.deepEqual(historyRenders, [current]);
      assert.deepEqual(activityRenders, [current]);

      if (outcome === 'success') {
        const scanningRefresh = context.loadMeetingHistory({ scan: true });
        const refreshDuringScan = context.loadMeetingHistory();
        requests[2].resolve(current);
        await refreshDuringScan;
        completeScan({ added: 1 });
        await new Promise((resolve) => setImmediate(resolve));
        const afterScan = [...current, { id: 'recovered' }];
        requests[3].resolve(afterScan);
        await scanningRefresh;
        assert.equal(context.meetings, afterScan);
      }
    });
  }
});
