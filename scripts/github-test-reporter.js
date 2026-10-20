'use strict';

const { inspect } = require('node:util');

function escapeAnnotation(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// Keep the normal spec reporter alongside this one. Publishing actual failure
// details as annotations makes them available through the Checks API even when
// an execution environment cannot reach Actions' separate log-storage host.
module.exports = async function* githubTestReporter(events) {
  for await (const event of events) {
    if (event.type !== 'test:fail' || process.env.GITHUB_ACTIONS !== 'true') continue;
    const { name, details } = event.data;
    const diagnostic = inspect(details.error, { depth: 5, maxStringLength: 12000 }).slice(0, 20000);
    yield `::error title=JavaScript regression failure::${escapeAnnotation(`${name}\n${diagnostic}`)}\n`;
  }
};
