const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');

const source = stripTypeScriptTypes(readFileSync('supabase/functions/admin-dashboard/index.ts', 'utf8')
  .replace(/^import .*;\r?\n/gm, ''));

function handler({ valid = false, admin = false } = {}) {
  let handle;
  const client = {
    auth: { getUser: async () => ({ data: { user: valid ? { id: 'test' } : null } }) },
    from(table) {
      if (table !== 'admin_users') assert.ok(valid && admin, 'data requires authorized admin');
      return { select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: admin ? { user_id: 'test' } : null }; },
        async order() { return { data: table === 'protocol_references'
          ? [{ id: 'ref', code: 'TEST', meaning: 'Test', is_active: true }]
          : [{ id: 'session', reference_id: 'ref', current_stage: 7, completed_stages: [1,2,3], last_seen_at: '2026-09-20' }] }; }
      };
    },
  };
  vm.runInNewContext(source, { Request, Response, createClient: () => client,
    Deno: { env: { get: () => 'test' }, serve: fn => { handle = fn; } } });
  return handle;
}

test('rejects missing and invalid tokens', async () => {
  assert.equal((await handler()(new Request('https://test'))).status, 401);
  assert.equal((await handler()(new Request('https://test', { headers: { Authorization: 'Bearer invalid' } }))).status, 401);
});
test('authenticated non-admin cannot read dashboard', async () => {
  assert.equal((await handler({ valid: true })(new Request('https://test', { headers: { Authorization: 'Bearer test' } }))).status, 403);
});
test('authorized response does not count entering stage 7 as completion', async () => {
  const response = await handler({ valid: true, admin: true })(new Request('https://test', { headers: { Authorization: 'Bearer test' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.summary.sessionCount, 1);
  assert.equal(body.summary.completedSessions, 0);
});
