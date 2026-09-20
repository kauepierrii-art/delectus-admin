const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');

const source = stripTypeScriptTypes(readFileSync('supabase/functions/protocol-session/index.ts', 'utf8')
  .replace(/^import .*;\r?\n/gm, ''));

function handler({ active = true, resume = false } = {}) {
  let handle;
  const calls = { sessions: 0, accessEvents: 0, completionEvents: 0 };
  const db = {
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        update() { return this; },
        insert(value) {
          if (table === 'protocol_sessions') {
            calls.sessions++;
            return { select() { return { single: async () => ({ data: { id: 'session-1', current_stage: 0 }, error: null }) }; } };
          }
          if (table === 'protocol_progress_events') {
            if (value.event_type === 'access') calls.accessEvents++;
            if (value.event_type === 'stage_completed') calls.completionEvents++;
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
        async maybeSingle() {
          if (table === 'protocol_reference_aliases') return { data: { reference_id: 'ref-1' }, error: null };
          if (table === 'protocol_references') return { data: { id: 'ref-1', is_active: active }, error: null };
          if (table === 'protocol_sessions') return {
            data: resume ? { id: 'session-1', current_stage: 3 } : null,
            error: null,
          };
          return { data: null, error: null };
        },
        then(resolve) { return resolve({ error: null }); },
      };
      return query;
    },
  };
  vm.runInNewContext(source, {
    Request, Response, TextEncoder, crypto, console,
    createClient: () => db,
    Deno: { env: { get: () => 'test' }, serve: (fn) => { handle = fn; } },
  });
  return { handle, calls };
}

test('accepts BOLADO as an ordinary active participant session', async () => {
  const { handle, calls } = handler();
  const response = await handle(new Request('https://test', {
    method: 'POST', body: JSON.stringify({ action: 'open', reference: '  BoLaDo  ' }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reference, 'BOLADO');
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.equal(calls.sessions, 1);
  assert.equal(calls.accessEvents, 1);
});

test('does not create an access event when a session token is resumed', async () => {
  const { handle, calls } = handler({ resume: true });
  const response = await handle(new Request('https://test', {
    method: 'POST', body: JSON.stringify({
      action: 'open', reference: 'BOLADO', token: 'a'.repeat(64),
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.sessions, 0);
  assert.equal(calls.accessEvents, 0);
});

test('rejects an inactive reference without creating a session', async () => {
  const { handle, calls } = handler({ active: false });
  const response = await handle(new Request('https://test', {
    method: 'POST', body: JSON.stringify({ action: 'open', reference: 'Ignis sacer' }),
  }));
  assert.equal(response.status, 401);
  assert.equal(calls.sessions, 0);
  assert.equal(calls.accessEvents, 0);
});

test('rejects malformed completion telemetry', async () => {
  const { handle } = handler();
  const response = await handle(new Request('https://test', {
    method: 'POST', body: JSON.stringify({ action: 'complete', token: 'not-a-token', stage: 8 }),
  }));
  assert.equal(response.status, 400);
});

