const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');

const source = stripTypeScriptTypes(readFileSync('supabase/functions/admin-dashboard/index.ts', 'utf8')
  .replace(/^import .*;\r?\n/gm, ''));

function handler({ valid = false, admin = false } = {}) {
  let handle;
  const calls = { resets: [] };
  const client = {
    auth: { getUser: async () => ({ data: { user: valid ? { id: 'test' } : null } }) },
    from(table) {
      if (table !== 'admin_users') assert.ok(valid && admin, 'data requires authorized admin');
      return { select() { return this; }, eq() { return this; },
        update(value) { if (table === 'protocol_sessions') calls.resets.push(value); return this; },
        async maybeSingle() {
          if (table === 'protocol_sessions') return { data: { id: '00000000-0000-4000-8000-000000000001' } };
          return { data: admin ? { user_id: 'test' } : null };
        },
        async order() { return { data: table === 'protocol_references'
          ? [{ id: 'ref', code: 'TEST', meaning: 'Test', is_active: true }]
          : [{ id: 'session', reference_id: 'ref', current_stage: 7, completed_stages: [1,2,3], last_seen_at: '2026-09-20' }] }; }
      };
    },
  };
  vm.runInNewContext(source, { Request, Response, createClient: () => client,
    Deno: { env: { get: () => 'test' }, serve: fn => { handle = fn; } } });
  return { handle, calls };
}

test('rejects missing and invalid tokens', async () => {
  assert.equal((await handler().handle(new Request('https://test'))).status, 401);
  assert.equal((await handler().handle(new Request('https://test', { headers: { Authorization: 'Bearer invalid' } }))).status, 401);
});
test('authenticated non-admin cannot read dashboard', async () => {
  assert.equal((await handler({ valid: true }).handle(new Request('https://test', { headers: { Authorization: 'Bearer test' } }))).status, 403);
});
test('authorized response does not count entering stage 7 as completion', async () => {
  const response = await handler({ valid: true, admin: true }).handle(new Request('https://test', { headers: { Authorization: 'Bearer test' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.summary.sessionCount, 1);
  assert.equal(body.summary.completedSessions, 0);
});
test('authorized admin can reset one protocol session without deleting it', async () => {
  const testHandler = handler({ valid: true, admin: true });
  const response = await testHandler.handle(new Request('https://test', {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reset-session', sessionId: '00000000-0000-4000-8000-000000000001' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(testHandler.calls.resets.length, 1);
  assert.equal(testHandler.calls.resets[0].completed_stages.length, 0);
  assert.equal(testHandler.calls.resets[0].current_stage, 0);
});

